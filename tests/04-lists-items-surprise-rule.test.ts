import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { withFamilyContext } from '../src/db/index.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { setupBaseWorld } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 4: Lists, Items & the Surprise Rule', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';
  let aliceUserId = '';
  let bobCookie = '';
  let bobCsrf = '';
  let aliceListId = '';
  let espressoItemId = '';
  let oledItemId = '';
  let socksItemId = '';
  let posterItemId = '';
  let bobClaimId = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, aliceCookie, aliceCsrf, aliceUserId, bobCookie, bobCsrf } = await setupBaseWorld(app));
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 4: Lists, Items, Price Filter, Catch-All Item, and The Surprise Rule
  // =========================================================================
  describe('4. Lists, Items, Price Filter, Catch-All Item, and The Surprise Rule', () => {
    it('Alice creates a wish list for herself, verifying automatic catch-all item creation', async () => {
      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: "Alice's Birthday 2026",
          eventDate: '2026-12-25',
        });

      expect(res.status).toBe(201);
      expect(res.body.list).toBeDefined();
      expect(res.body.list.name).toBe("Alice's Birthday 2026");
      expect(res.body.list.recipient_user_id).toBe(aliceUserId);

      aliceListId = res.body.list.id;

      // Verify the automatic catch-all item is present
      const listDetails = await request(app)
        .get(`/api/families/${familyAlphaId}/lists/${aliceListId}`)
        .set('Cookie', aliceCookie);

      expect(listDetails.status).toBe(200);
      const items = listDetails.body.items;
      const catchAll = items.find((i: any) => i.is_catch_all === true);
      expect(catchAll).toBeDefined();
      expect(catchAll.name).toContain('Anything else');
    });

    it('Alice adds regular, group gift, and multi-quantity items to the list', async () => {
      // 1. Regular single-quantity item
      const item1 = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'Espresso Machine',
          priceCents: 35000,
          priority: 'really_want',
          storeUrl: 'https://example.com/espresso',
          storeName: 'Coffee Boutique',
        });
      expect(item1.status).toBe(201);
      espressoItemId = item1.body.item.id;

      // 2. Expensive item for group gifting
      const item2 = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'OLED TV',
          priceCents: 120000,
          priority: 'really_want',
          storeUrl: 'https://example.com/oled',
          storeName: 'Electro World',
        });
      expect(item2.status).toBe(201);
      oledItemId = item2.body.item.id;

      // 3. Multi-quantity item allowing duplicates
      const item3 = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'Wool Socks',
          priceCents: 1500,
          priority: 'nice_to_have',
          quantity: 4,
          allowDuplicates: true,
          storeUrl: 'https://example.com/socks',
          storeName: 'Winter Gear',
        });
      expect(item3.status).toBe(201);
      socksItemId = item3.body.item.id;

      // 4. Temporary item for testing delete notification
      const item4 = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'Vintage Poster',
          priceCents: 2500,
          priority: 'nice_to_have',
        });
      expect(item4.status).toBe(201);
      posterItemId = item4.body.item.id;
    });

    it('verifies price filtering on wish list items', async () => {
      // Filter for items between $300.00 (30000) and $500.00 (50000)
      const res = await request(app)
        .get(`/api/families/${familyAlphaId}/lists/${aliceListId}?minPriceCents=30000&maxPriceCents=50000`)
        .set('Cookie', bobCookie);

      expect(res.status).toBe(200);
      const names = res.body.items.map((i: any) => i.name);
      expect(names).toContain('Espresso Machine'); // 35000
      expect(names).not.toContain('OLED TV'); // 120000
      expect(names).not.toContain('Wool Socks'); // 1500
    });

    it('Bob claims Espresso Machine and pledges toward OLED TV', async () => {
      // Bob claims Espresso Machine
      const claimRes = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${espressoItemId}/claim`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({ quantity: 1 });

      expect(claimRes.status).toBe(201);
      bobClaimId = claimRes.body.claim.id;
      expect(claimRes.body.claim.claimer_first_name).toBe('Bob');

      // Bob pledges $500.00 (50000 cents) toward OLED TV ($1200.00)
      const pledgeRes = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${oledItemId}/pledge`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({
          amountCents: 50000,
          note: 'Happy Birthday Alice! Hope you enjoy the OLED!',
        });

      expect(pledgeRes.status).toBe(201);
      expect(pledgeRes.body.pledge.amount_cents).toBe(50000);
    });

    it('CRITICAL SURPRISE RULE: Bob sees claims, pledges, and taken givers; Alice sees ZERO giver info', async () => {
      // View 1: Bob (giver) views Alice's list
      const bobView = await request(app)
        .get(`/api/families/${familyAlphaId}/lists/${aliceListId}`)
        .set('Cookie', bobCookie);

      expect(bobView.status).toBe(200);
      expect(bobView.body.alreadyTakenItems).toBeDefined();

      const bobEspresso = bobView.body.items.find((i: any) => i.id === espressoItemId);
      expect(bobEspresso.is_taken).toBe(true);
      expect(bobEspresso.taken_by_names).toContain('Bob');
      expect(bobEspresso.claims.length).toBe(1);

      const bobOled = bobView.body.items.find((i: any) => i.id === oledItemId);
      expect(bobOled.total_pledged_cents).toBe(50000);
      expect(bobOled.pledge_progress_percent).toBe(42);
      expect(bobOled.pledges.length).toBe(1);

      // View 2: Alice (recipient AND family_admin) views her own list
      const aliceView = await request(app)
        .get(`/api/families/${familyAlphaId}/lists/${aliceListId}`)
        .set('Cookie', aliceCookie);

      expect(aliceView.status).toBe(200);
      expect(aliceView.body.alreadyTakenItems).toBeUndefined();

      for (const item of aliceView.body.items) {
        expect(item.claims).toBeUndefined();
        expect(item.pledges).toBeUndefined();
        expect(item.assignments).toBeUndefined();
        expect(item.claimed_count).toBeUndefined();
        expect(item.is_taken).toBeUndefined();
        expect(item.taken_by_names).toBeUndefined();
      }

      // Claiming an item MUST NOT touch item.updated_at
      const espressoRow = await withFamilyContext(familyAlphaId, async (client) => {
        const res = await client.query('SELECT created_at, updated_at FROM items WHERE id = $1', [
          espressoItemId,
        ]);
        return res.rows[0];
      });
      expect(new Date(espressoRow.updated_at).getTime()).toBe(
        new Date(espressoRow.created_at).getTime()
      );
    });

    it('Alice is blocked (403) from claiming items on her own wish list', async () => {
      // Attempt to claim already claimed item
      const claim1 = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${espressoItemId}/claim`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ quantity: 1 });

      expect(claim1.status).toBe(403);
      expect(claim1.body.error).toMatch(/cannot claim items on your own wish list/i);

      // Attempt to claim unclaimed item
      const claim2 = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${socksItemId}/claim`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ quantity: 1 });

      expect(claim2.status).toBe(403);
      expect(claim2.body.error).toMatch(/cannot claim items on your own wish list/i);
    });

    it('Alice (family_admin) viewing audit logs does NOT see claims/pledges targeting her own list', async () => {
      const logsRes = await request(app)
        .get(`/api/families/${familyAlphaId}/audit-logs`)
        .set('Cookie', aliceCookie);

      expect(logsRes.status).toBe(200);
      const actions = logsRes.body.auditLogs.map((l: any) => l.action);
      // Alice must NOT see ITEM_CLAIMED or ITEM_PLEDGED for her list
      expect(actions).not.toContain('ITEM_CLAIMED');
      expect(actions).not.toContain('ITEM_PLEDGED');
    });

    it('Alice edits an item Bob claimed: edit succeeds without leaking surprise, while Bob is notified', async () => {
      const editRes = await request(app)
        .patch(`/api/families/${familyAlphaId}/lists/${aliceListId}/items/${espressoItemId}`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ notes: 'Silver or matte black color preferred!' });

      expect(editRes.status).toBe(200);
      // Zero indication to Alice that item was claimed
      expect(editRes.body.item.claims).toBeUndefined();

      // Bob receives notification in notifications endpoint
      const notifsRes = await request(app)
        .get(`/api/families/${familyAlphaId}/notifications`)
        .set('Cookie', bobCookie);

      expect(notifsRes.status).toBe(200);
      const messages = notifsRes.body.notifications.map((n: any) => n.message);
      expect(messages.some((m: string) => m.includes('Espresso Machine') && m.includes('updated'))).toBe(
        true
      );
    });

    it('Alice deletes an item Bob claimed: succeeds normally while Bob is notified', async () => {
      // Bob claims Vintage Poster first
      await request(app)
        .post(`/api/families/${familyAlphaId}/items/${posterItemId}/claim`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({ quantity: 1 });

      // Alice deletes it
      const delRes = await request(app)
        .delete(`/api/families/${familyAlphaId}/lists/${aliceListId}/items/${posterItemId}`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf);

      expect(delRes.status).toBe(200);
      expect(delRes.body.deleted).toBe(true);

      // Bob receives notification about the deletion
      const notifsRes = await request(app)
        .get(`/api/families/${familyAlphaId}/notifications`)
        .set('Cookie', bobCookie);

      expect(notifsRes.status).toBe(200);
      const messages = notifsRes.body.notifications.map((n: any) => n.message);
      expect(messages.some((m: string) => m.includes('Vintage Poster') && (m.includes('removed') || m.includes('deleted')))).toBe(
        true
      );
    });
  });

});
