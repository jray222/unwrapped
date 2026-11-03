import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { setupBaseWorld, setupAliceList } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 5: Store Link Prompts', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';
  let bobCookie = '';
  let bobCsrf = '';
  let roseCookie = '';
  let roseCsrf = '';
  let aliceListId = '';
  let headphonesItemId = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, aliceCookie, aliceCsrf, bobCookie, bobCsrf, roseCookie, roseCsrf } = await setupBaseWorld(app));
    ({ aliceListId } = await setupAliceList(app, { familyAlphaId, aliceCookie, aliceCsrf }));
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 5: Store Link Prompts ("Are you getting this?" & "Buy anyway?")
  // =========================================================================
  describe('5. Store Link Prompts ("Are you getting this?" & "Buy anyway?")', () => {
    beforeAll(async () => {
      // Add a fresh item for store click testing
      const itemRes = await request(app)
        .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          name: 'Noise Cancelling Headphones',
          priceCents: 19900,
          storeUrl: 'https://example.com/headphones',
          storeName: 'AudioStore',
        });
      headphonesItemId = itemRes.body.item.id;
    });

    it('returns ARE_YOU_GETTING_THIS on an unclaimed item', async () => {
      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${headphonesItemId}/store-click`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf);

      expect(res.status).toBe(200);
      expect(res.body.promptType).toBe('ARE_YOU_GETTING_THIS');
      expect(res.body.message).toMatch(/are you getting this/i);
    });

    it('returns BUY_ANYWAY_CONFIRM on a claimed item', async () => {
      // Bob claims the headphones
      await request(app)
        .post(`/api/families/${familyAlphaId}/items/${headphonesItemId}/claim`)
        .set('Cookie', bobCookie)
        .set('x-csrf-token', bobCsrf)
        .send({ quantity: 1 });

      // Grandma Rose taps store link on the claimed item
      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/items/${headphonesItemId}/store-click`)
        .set('Cookie', roseCookie)
        .set('x-csrf-token', roseCsrf);

      expect(res.status).toBe(200);
      expect(res.body.promptType).toBe('BUY_ANYWAY_CONFIRM');
      expect(res.body.message).toMatch(/buy anyway/i);
    });
  });

});
