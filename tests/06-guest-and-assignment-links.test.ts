import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { withFamilyContext } from '../src/db/index.js';
import { SESSION_COOKIE_NAME, getRecentRedactedLogs } from '../src/security/middleware.js';
import { hashToken } from '../src/security/crypto.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { extractCookie, setupBaseWorld, setupAliceList } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 6: Guest Links', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';
  let aliceListId = '';
  let socksItemId = '';
  let claraLinkId = '';
  let claraRawToken = '';
  let claraCookie = '';
  let claraCsrf = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, aliceCookie, aliceCsrf } = await setupBaseWorld(app));
    ({ aliceListId, socksItemId } = await setupAliceList(app, { familyAlphaId, aliceCookie, aliceCsrf }));
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 6: Guest & Assignment Links
  // =========================================================================
  describe('6. Guest & Assignment Links (Hashed at Rest, Clean 303 Redirect, Log Redaction, First Names Only, 1-Tap Revoke)', () => {
    it('rejects guest link creation if expiresInDays > 365 (400)', async () => {
      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/guest-links`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          guestFirstName: 'Cousin Clara',
          expiresInDays: 400,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot exceed 365 days/i);
    });

    it('creates guest link, verifies raw token is NOT in database (SHA-256 hash only)', async () => {
      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/guest-links`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          guestFirstName: 'Clara',
          expiresInDays: 60,
        });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.guestFirstName).toBe('Clara');

      claraLinkId = res.body.id;
      claraRawToken = res.body.token;

      // Verify DB storage: raw token must NOT exist; token_hash must equal hashToken(rawToken)
      await withFamilyContext(familyAlphaId, async (client) => {
        const row = await client.query('SELECT token_hash FROM guest_links WHERE id = $1', [
          claraLinkId,
        ]);
        expect(row.rows[0].token_hash).toBe(hashToken(claraRawToken));
      });
    });

    it('visiting /g/:token returns 303 See Other redirect to /guest with HttpOnly cookie and scrubbed log', async () => {
      const res = await request(app).get(`/g/${claraRawToken}`);

      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/guest');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toContain('no-store');

      claraCookie = extractCookie(res);
      expect(claraCookie).toContain(SESSION_COOKIE_NAME);

      // Verify server request logs scrubbed the raw token
      const logs = getRecentRedactedLogs();
      expect(logs.some((l) => l.includes('/g/[REDACTED]'))).toBe(true);
      expect(logs.some((l) => l.includes(claraRawToken))).toBe(false);
    });

    it('guest session can call /api/guest/view and sees only first names from /members', async () => {
      // 1. /api/guest/view returns list content
      const viewRes = await request(app)
        .get('/api/guest/view')
        .set('Cookie', claraCookie);

      expect(viewRes.status).toBe(200);
      expect(viewRes.body.familyName).toBe('Family Alpha');
      expect(Array.isArray(viewRes.body.lists)).toBe(true);

      // Fetch CSRF token for guest mutations from /api/auth/me
      const meRes = await request(app).get('/api/auth/me').set('Cookie', claraCookie);
      claraCsrf = meRes.body.csrfToken;

      // 2. /members returns ONLY first names (no last names or emails exposed)
      const membersRes = await request(app)
        .get(`/api/families/${familyAlphaId}/members`)
        .set('Cookie', claraCookie);

      expect(membersRes.status).toBe(200);
      expect(Array.isArray(membersRes.body.members)).toBe(true);
      for (const m of membersRes.body.members) {
        expect(m.first_name).toBeDefined();
        expect(m.last_name).toBeUndefined();
        expect(m.email).toBeUndefined();
      }
    });

    it('guest can claim and release items, but CANNOT create or edit items (403)', async () => {
      // Guest claims available Wool Socks
      const claimRes = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${socksItemId}/claim`)
        .set('Cookie', claraCookie)
        .set('x-csrf-token', claraCsrf)
        .send({ quantity: 1 });

      expect(claimRes.status).toBe(201);
      const guestClaimId = claimRes.body.claim.id;

      // Guest releases claim
      const releaseRes = await request(app)
        .post(`/api/families/${familyAlphaId}/claims/${guestClaimId}/release`)
        .set('Cookie', claraCookie)
        .set('x-csrf-token', claraCsrf);

      expect(releaseRes.status).toBe(200);
      expect(releaseRes.body.released).toBe(true);

      // Guest attempts to create an item -> 403
      const createRes = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', claraCookie)
        .set('x-csrf-token', claraCsrf)
        .send({ name: 'Guest Injected Item' });

      expect(createRes.status).toBe(403);

      // Guest attempts to edit an item -> 403
      const editRes = await request(app)
        .patch(`/api/families/${familyAlphaId}/lists/${aliceListId}/items/${socksItemId}`)
        .set('Cookie', claraCookie)
        .set('x-csrf-token', claraCsrf)
        .send({ name: 'Hacked Name' });

      expect(editRes.status).toBe(403);
    });

    it('one-tap revoke immediately invalidates the guest session', async () => {
      // Alice revokes Cousin Clara's guest link
      const revokeRes = await request(app)
        .post(`/api/families/${familyAlphaId}/guest-links/${claraLinkId}/revoke`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.success).toBe(true);

      // Clara's previous session cookie is now completely invalid (401)
      const afterRevoke = await request(app)
        .get('/api/guest/view')
        .set('Cookie', claraCookie);

      expect(afterRevoke.status).toBe(401);
    });
  });

});
