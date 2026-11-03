import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb, withFamilyContext } from '../src/db/index.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { setupBaseWorld, setupAliceList } from './helpers/fixtures.js';

// POST /api/offline/sync must apply the same family-access rules as the online routes.
describe('Unwrapped v2 — Section 9: Offline sync cannot cross family boundaries', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';
  let bobCookie = '';
  let bobCsrf = '';
  let betaAdminCookie = '';
  let betaAdminCsrf = '';
  let socksItemId = '';
  let bobClaimId = '';

  const sync = (cookie: string, csrf: string, actions: unknown[]) =>
    request(app).post('/api/offline/sync').set('Cookie', cookie).set('x-csrf-token', csrf).send({ actions });

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    const world = await setupBaseWorld(app);
    ({ familyAlphaId, aliceCookie, aliceCsrf, bobCookie, bobCsrf, betaAdminCookie, betaAdminCsrf } = world);
    ({ socksItemId } = await setupAliceList(app, { familyAlphaId, aliceCookie, aliceCsrf }));

    const claim = await request(app)
      .post(`/api/families/${familyAlphaId}/items/${socksItemId}/claim`)
      .set('Cookie', bobCookie)
      .set('x-csrf-token', bobCsrf)
      .send({ quantity: 1 });
    bobClaimId = claim.body.claim.id;
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  const claimBought = async () =>
    withFamilyContext(familyAlphaId, async (client) => {
      const r = await client.query('SELECT bought FROM claims WHERE id = $1', [bobClaimId]);
      return r.rows[0].bought as boolean;
    });

  it('rejects MARK_BOUGHT on another family\'s claim, with or without an explicit familyId', async () => {
    for (const action of [
      { type: 'MARK_BOUGHT', claimId: bobClaimId, familyId: familyAlphaId },
      { type: 'MARK_BOUGHT', claimId: bobClaimId },
    ]) {
      const res = await sync(betaAdminCookie, betaAdminCsrf, [action]);
      expect(res.status).toBe(200);
      expect(res.body.syncedCount).toBe(0);
      expect(res.body.results[0].success).toBe(false);
      expect(res.body.results[0].error).toBe('Not found');
    }
    expect(await claimBought()).toBe(false);
  });

  it('rejects CLAIM_ITEM into a family the caller does not belong to', async () => {
    const res = await sync(betaAdminCookie, betaAdminCsrf, [
      { type: 'CLAIM_ITEM', itemId: socksItemId, familyId: familyAlphaId, quantity: 1 },
    ]);
    expect(res.body.syncedCount).toBe(0);
    expect(res.body.results[0].success).toBe(false);

    await withFamilyContext(familyAlphaId, async (client) => {
      const r = await client.query('SELECT COUNT(*)::int AS n FROM claims WHERE item_id = $1', [socksItemId]);
      expect(r.rows[0].n).toBe(1); // only Bob's original claim
    });
  });

  it('rejects UPDATE_ASSIGNMENT for an unknown or foreign assignment without leaking existence', async () => {
    const res = await sync(betaAdminCookie, betaAdminCsrf, [
      { type: 'UPDATE_ASSIGNMENT', assignmentId: '00000000-0000-0000-0000-000000000000', status: 'bought' },
    ]);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toBe('Not found');
  });

  it('still lets the claimer sync MARK_BOUGHT on their own claim', async () => {
    const res = await sync(bobCookie, bobCsrf, [
      { type: 'MARK_BOUGHT', claimId: bobClaimId, familyId: familyAlphaId },
    ]);
    expect(res.body.syncedCount).toBe(1);
    expect(await claimBought()).toBe(true);
  });

  it('applies the Surprise Rule offline: a recipient cannot claim on their own list', async () => {
    const res = await sync(aliceCookie, aliceCsrf, [
      { type: 'CLAIM_ITEM', itemId: socksItemId, familyId: familyAlphaId, quantity: 1 },
    ]);
    expect(res.body.syncedCount).toBe(0);
    expect(res.body.results[0].error).toMatch(/own wish list/i);
  });
});
