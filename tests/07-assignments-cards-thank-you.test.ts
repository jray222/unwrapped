import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { withFamilyContext } from '../src/db/index.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { setupBaseWorld, setupAliceList, setupBobGifts } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 7: Assignments, Shopping Cards, Offline Sync, Thank-You Mode', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';
  let bobCookie = '';
  let bobCsrf = '';
  let aliceListId = '';
  let espressoItemId = '';
  let oledItemId = '';
  let socksItemId = '';
  let trowelItemId = '';
  let joeAssignmentId = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, aliceCookie, aliceCsrf, bobCookie, bobCsrf } = await setupBaseWorld(app));
    ({ aliceListId, espressoItemId, oledItemId, socksItemId } = await setupAliceList(app, { familyAlphaId, aliceCookie, aliceCsrf }));
    await setupBobGifts(app, { familyAlphaId, bobCookie, bobCsrf, espressoItemId, oledItemId });
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 7: Assignments, Static Shopping Cards, Reminders, Offline Sync, and Post-Event Thank-You Mode
  // =========================================================================
  describe('7. Assignments, Static Shopping Cards (PDF & PNG), Reminders, Offline Sync, and Post-Event Thank-You Mode', () => {
    beforeAll(async () => {
      // Add an item for Grandpa Joe assignment
      const trowelRes = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'Gardening Trowel',
          priceCents: 2200,
          storeName: 'Garden Center',
          notes: 'Durable stainless steel',
        });
      trowelItemId = trowelRes.body.item.id;
    });

    it('Bob assigns an item to Grandpa Joe, verifying immediate linked claim in "Joe"\'s name', async () => {
      const assignRes = await request(app)
        .post(`/api/families/${familyAlphaId}/assignments`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({
          itemIds: [trowelItemId],
          assigneeFirstName: 'Joe',
        });

      expect(assignRes.status).toBe(201);
      expect(assignRes.body.assignments.length).toBe(1);

      joeAssignmentId = assignRes.body.assignments[0].id;

      // Verify in database that a claim was immediately created in Joe's name
      await withFamilyContext(familyAlphaId, async (client) => {
        const claimRes = await client.query(
          'SELECT * FROM claims WHERE assignment_id = $1',
          [joeAssignmentId]
        );
        expect(claimRes.rows.length).toBe(1);
        expect(claimRes.rows[0].claimer_first_name).toBe('Joe');
      });
    });

    it('downloads static shopping card as PDF (%PDF-) and PNG (PNG magic bytes)', async () => {
      // 1. PDF Shopping Card
      const pdfRes = await request(app)
        .get(`/api/families/${familyAlphaId}/shopping-card.pdf?itemIds=${trowelItemId}&assigneeFirstName=Joe`)
        .set('Cookie', bobCookie);

      expect(pdfRes.status).toBe(200);
      expect(pdfRes.headers['content-type']).toContain('application/pdf');
      const pdfHeader = pdfRes.body.slice(0, 5).toString('ascii');
      expect(pdfHeader).toBe('%PDF-');

      // 2. PNG Shopping Card
      const pngRes = await request(app)
        .get(`/api/families/${familyAlphaId}/shopping-card.png?itemIds=${trowelItemId}&assigneeFirstName=Joe`)
        .set('Cookie', bobCookie);

      expect(pngRes.status).toBe(200);
      expect(pngRes.headers['content-type']).toContain('image/png');
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
      expect(pngRes.body.slice(0, 4)).toEqual(pngMagic);
    });

    it('updating assignment status to "couldnt_get_it" automatically releases the linked claim', async () => {
      const updateRes = await request(app)
        .patch(`/api/families/${familyAlphaId}/assignments/${joeAssignmentId}`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({ status: 'couldnt_get_it' });

      expect(updateRes.status).toBe(200);

      // Verify the claim was deleted / released back to available
      await withFamilyContext(familyAlphaId, async (client) => {
        const claimRes = await client.query(
          'SELECT * FROM claims WHERE assignment_id = $1',
          [joeAssignmentId]
        );
        expect(claimRes.rows.length).toBe(0);
      });
    });

    it('tests queued offline sync POST /api/offline/sync for a "MARK_BOUGHT" action', async () => {
      // Bob claims Wool Socks to get a fresh claim
      const claimRes = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${socksItemId}/claim`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({ quantity: 1 });

      const syncClaimId = claimRes.body.claim.id;

      // Bob syncs offline "MARK_BOUGHT" action
      const syncRes = await request(app)
        .post('/api/offline/sync')
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({
          actions: [
            {
              type: 'MARK_BOUGHT',
              claimId: syncClaimId,
              familyId: familyAlphaId,
            },
          ],
        });

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.syncedCount).toBe(1);
      expect(syncRes.body.results[0].success).toBe(true);

      // Verify claim is marked bought in DB
      await withFamilyContext(familyAlphaId, async (client) => {
        const cRes = await client.query('SELECT bought FROM claims WHERE id = $1', [syncClaimId]);
        expect(cRes.rows[0].bought).toBe(true);
      });
    });

    it('reveals Thank-You Mode: Alice can now see who gave what after the event', async () => {
      // Alice triggers reveal-thank-you
      const revealRes = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/reveal-thank-you`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf);

      expect(revealRes.status).toBe(200);
      expect(revealRes.body.list.thank_you_revealed).toBe(true);

      // Alice fetches her list now: claims and pledges are revealed!
      const afterReveal = await request(app)
        .get(`/api/families/${familyAlphaId}/lists/${aliceListId}`)
        .set('Cookie', aliceCookie);

      expect(afterReveal.status).toBe(200);
      const espresso = afterReveal.body.items.find((i: any) => i.id === espressoItemId);
      expect(espresso.is_taken).toBe(true);
      expect(espresso.taken_by_names).toContain('Bob');
      expect(espresso.claims.length).toBeGreaterThanOrEqual(1);

      const oled = afterReveal.body.items.find((i: any) => i.id === oledItemId);
      expect(oled.total_pledged_cents).toBe(50000);
      expect(oled.pledges.length).toBeGreaterThanOrEqual(1);
      expect(oled.pledges[0].pledger_first_name).toBe('Bob');
    });
  });

});
