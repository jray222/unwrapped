import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { withFamilyContext } from '../src/db/index.js';
import { generateTotpCode } from '../src/security/crypto.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { extractCookie, setupBaseWorld } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 3: Two-Layer Tenant Isolation', () => {
  const app = createApp();

  let familyAlphaId = '';
  let familyBetaId = '';
  let aliceUserId = '';
  let betaAdminCookie = '';
  let betaAdminCsrf = '';
  let eveCookie = '';
  let eveCsrf = '';
  let eveUserId = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, familyBetaId, aliceUserId, betaAdminCookie, betaAdminCsrf } = await setupBaseWorld(app));
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 3: Two-Layer Tenant Isolation (App + PostgreSQL RLS)
  // =========================================================================
  describe('3. Two-Layer Tenant Isolation (App + PostgreSQL Row-Level Security)', () => {
    beforeAll(async () => {
      // Create user Eve who belongs ONLY to Family Beta
      const eveInviteRes = await request(app)
        .post(`/api/families/${familyBetaId}/invites`)
        .set('Cookie', betaAdminCookie)
        .set('x-csrf-token', betaAdminCsrf)
        .send({ email: 'eve@example.com', role: 'member' });

      const eveReg = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: eveInviteRes.body.inviteToken,
          firstName: 'Eve',
          lastName: 'BetaOnly',
          password: 'EvePassword123!',
        });

      eveCookie = extractCookie(eveReg);
      eveCsrf = eveReg.body.csrfToken;
      eveUserId = eveReg.body.user.id;

      // Enable TOTP for Eve
      const eveTotp = await request(app)
        .post('/api/auth/mfa/totp/setup')
        .set('Cookie', eveCookie)
        .set('x-csrf-token', eveCsrf);
      const eCode = generateTotpCode(eveTotp.body.secret);
      await request(app)
        .post('/api/auth/mfa/totp/enable')
        .set('Cookie', eveCookie)
        .set('x-csrf-token', eveCsrf)
        .send({ code: eCode });
    });

    it('returns 404 Not Found (identical to non-existent UUID) when Eve requests Family Alpha resources', async () => {
      const crossFamilyRes = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', eveCookie);

      const nonExistentRes = await request(app)
        .get('/api/families/00000000-0000-0000-0000-000000000000/lists')
        .set('Cookie', eveCookie);

      expect(crossFamilyRes.status).toBe(404);
      expect(crossFamilyRes.body).toEqual({ error: 'Not found' });
      expect(nonExistentRes.status).toBe(404);
      expect(crossFamilyRes.body).toEqual(nonExistentRes.body);
    });

    it('enforces database-level PostgreSQL RLS: withFamilyContext(familyBetaId) cannot read Family Alpha lists', async () => {
      // Create a list in Family Alpha first using withFamilyContext(familyAlphaId)
      await withFamilyContext(familyAlphaId, async (client) => {
        await client.query(
          `INSERT INTO lists (id, family_id, name, owner_user_id, recipient_user_id, recipient_first_name, created_at, updated_at)
           VALUES ('11111111-1111-1111-1111-111111111111', $1, 'Alpha Secret List', $2, $2, 'Alice', NOW(), NOW())`,
          [familyAlphaId, aliceUserId]
        );
      });

      // Query with Family Beta context — without any WHERE family_id filter!
      await withFamilyContext(familyBetaId, async (client) => {
        const result = await client.query('SELECT * FROM lists');
        const familyIds = result.rows.map((r: any) => r.family_id);
        expect(familyIds).not.toContain(familyAlphaId);
        expect(result.rows.find((r: any) => r.name === 'Alpha Secret List')).toBeUndefined();
      });
    });
  });

});
