import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import {
  initDb,
  withInstanceAdminContext,
  withFamilyContext,
  withSystemContext,
} from '../src/db/index.js';
import {
  SESSION_COOKIE_NAME,
  resetRateLimiters,
  getRecentRedactedLogs,
} from '../src/security/middleware.js';
import {
  generateTotpCode,
  normalizeRecoveryCodeHash,
  hashToken,
} from '../src/security/crypto.js';
import { isPublicIp } from '../src/services/ssrf-autofill.js';
import { sanitizeImageBuffer } from '../src/services/image-sanitizer.js';

describe('Unwrapped v2 — Comprehensive Integration & Security Verification Suite', () => {
  const app = createApp();

  // Helper to extract session cookie from supertest response headers
  function extractCookie(res: request.Response): string {
    const raw = res.headers['set-cookie'];
    if (!raw) return '';
    const cookies = Array.isArray(raw) ? raw : [raw];
    const session = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    return session ? session.split(';')[0] : '';
  }

  // Shared state across the lifecycle test suite
  let instanceAdminCookie = '';
  let instanceAdminCsrf = '';

  let familyAlphaId = '';
  let alphaInviteToken = '';
  let familyBetaId = '';
  let betaInviteToken = '';

  let aliceCookie = '';
  let aliceCsrf = '';
  let aliceUserId = '';
  let aliceTotpSecret = '';
  let aliceRecoveryCodes: string[] = [];

  let betaAdminCookie = '';
  let betaAdminCsrf = '';

  let bobCookie = '';
  let bobCsrf = '';
  let bobUserId = '';

  let roseCookie = '';
  let roseCsrf = '';
  let roseUserId = '';

  let eveCookie = '';
  let eveCsrf = '';
  let eveUserId = '';

  let aliceListId = '';
  let espressoItemId = '';
  let oledItemId = '';
  let socksItemId = '';
  let posterItemId = '';
  let headphonesItemId = '';
  let trowelItemId = '';

  let bobClaimId = '';
  let claraLinkId = '';
  let claraRawToken = '';
  let claraCookie = '';
  let claraCsrf = '';

  let joeAssignmentId = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 1: Instance Admin & Content Blindness
  // =========================================================================
  describe('1. Instance Admin & Content Blindness (App + PostgreSQL Role Enforcement)', () => {
    it('rejects instance admin login with invalid token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/login')
        .send({ token: 'wrong-token' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid instance admin token/i);
    });

    it('logs in successfully with config.bootstrapInstanceAdminToken', async () => {
      const res = await request(app)
        .post('/api/instance-admin/login')
        .send({ token: config.bootstrapInstanceAdminToken });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('instance_admin');
      expect(res.body.sessionToken).toBeDefined();
      expect(res.body.csrfToken).toBeDefined();

      instanceAdminCookie = extractCookie(res);
      instanceAdminCsrf = res.body.csrfToken;
      expect(instanceAdminCookie).toContain(SESSION_COOKIE_NAME);
    });

    it('creates Family Alpha and returns single-use bootstrap family_admin invite token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie)
        .set('x-csrf-token', instanceAdminCsrf)
        .send({
          name: 'Family Alpha',
          slug: 'family-alpha',
          adminEmail: 'alice@example.com',
        });

      expect(res.status).toBe(201);
      expect(res.body.family).toBeDefined();
      expect(res.body.family.name).toBe('Family Alpha');
      expect(res.body.family.slug).toBe('family-alpha');
      expect(res.body.bootstrapInviteToken).toBeDefined();

      familyAlphaId = res.body.family.id;
      alphaInviteToken = res.body.bootstrapInviteToken;
    });

    it('creates Family Beta and returns single-use bootstrap family_admin invite token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie)
        .set('x-csrf-token', instanceAdminCsrf)
        .send({
          name: 'Family Beta',
          slug: 'family-beta',
          adminEmail: 'beta-admin@example.com',
        });

      expect(res.status).toBe(201);
      expect(res.body.family).toBeDefined();
      expect(res.body.family.name).toBe('Family Beta');
      expect(res.body.bootstrapInviteToken).toBeDefined();

      familyBetaId = res.body.family.id;
      betaInviteToken = res.body.bootstrapInviteToken;
    });

    it('lists all created families', async () => {
      const res = await request(app)
        .get('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.families)).toBe(true);
      const names = res.body.families.map((f: any) => f.name);
      expect(names).toContain('Family Alpha');
      expect(names).toContain('Family Beta');
    });

    it('blocks Instance Admin from reading family content at HTTP route layer (403)', async () => {
      const res = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/instance admin cannot access family content/i);
    });

    it('strictly enforces content blindness at the PostgreSQL role level (withInstanceAdminContext)', async () => {
      // Direct query execution with app_instance_admin role MUST throw PostgreSQL permission error
      await expect(
        withInstanceAdminContext(async (client) => {
          return client.query('SELECT * FROM lists');
        })
      ).rejects.toThrow(/permission denied for table lists/i);

      await expect(
        withInstanceAdminContext(async (client) => {
          return client.query('SELECT * FROM items');
        })
      ).rejects.toThrow(/permission denied for table items/i);

      // Verify server attempt-read-content endpoint also reports denial
      const res = await request(app)
        .get('/api/instance-admin/attempt-read-content')
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/access denied by database policy/i);
    });
  });

  // =========================================================================
  // SECTION 2: Sign-In, Single-Use Invites, Mandatory 2FA/Passkeys, Google Sign-In, Assisted Enrollment
  // =========================================================================
  describe('2. Sign-In, Single-Use Invites, Mandatory 2FA/Passkeys, Recovery Codes, Google Sign-In, & Admin-Assisted Enrollment', () => {
    it('rejects public sign-up without a valid invite token (400/404)', async () => {
      const res = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: 'fake-uninvited-token',
          firstName: 'Intruder',
          password: 'Password123!',
        });

      expect([400, 404]).toContain(res.status);
    });

    it('allows Alice (Family Alpha admin) to accept bootstrap invite via local registration', async () => {
      const res = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: alphaInviteToken,
          firstName: 'Alice',
          lastName: 'Admin',
          password: 'AliceStrongPassword123!',
        });

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe('alice@example.com');
      expect(res.body.mfaEnrollmentRequired).toBe(true);
      expect(res.body.csrfToken).toBeDefined();

      aliceCookie = extractCookie(res);
      aliceCsrf = res.body.csrfToken;
      aliceUserId = res.body.user.id;
    });

    it('blocks Alice from accessing family resources before 2FA/Passkey enrollment (MFA_REQUIRED 403)', async () => {
      const res = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', aliceCookie);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });

    it('sets up TOTP 2FA for Alice, verifies code, generates 8 recovery codes, and grants full access', async () => {
      // Step 1: Request TOTP setup
      const setupRes = await request(app)
        .post('/api/auth/mfa/totp/setup')
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf);

      expect(setupRes.status).toBe(200);
      expect(setupRes.body.secret).toBeDefined();
      expect(setupRes.body.otpauthUri).toBeDefined();
      expect(setupRes.body.qrCodeDataUrl).toContain('data:image/png;base64');

      aliceTotpSecret = setupRes.body.secret;
      const validCode = generateTotpCode(aliceTotpSecret);

      // Step 2: Enable TOTP with the generated code
      const enableRes = await request(app)
        .post('/api/auth/mfa/totp/enable')
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ code: validCode });

      expect(enableRes.status).toBe(200);
      expect(enableRes.body.enabled).toBe(true);
      expect(Array.isArray(enableRes.body.recoveryCodes)).toBe(true);
      expect(enableRes.body.recoveryCodes.length).toBe(8);

      aliceRecoveryCodes = enableRes.body.recoveryCodes;

      // Verify recovery codes are stored as SHA-256 hashes at rest in the database
      await withSystemContext(async (client) => {
        const rcRes = await client.query(
          'SELECT code_hash FROM recovery_codes WHERE user_id = $1',
          [aliceUserId]
        );
        expect(rcRes.rows.length).toBe(8);
        const storedHashes = rcRes.rows.map((r: any) => r.code_hash);
        for (const rawCode of aliceRecoveryCodes) {
          const expectedHash = normalizeRecoveryCodeHash(rawCode);
          expect(storedHashes).toContain(expectedHash);
        }
      });

      // Step 3: Verify Alice now has full member access!
      const accessRes = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', aliceCookie);

      expect(accessRes.status).toBe(200);
      expect(Array.isArray(accessRes.body.lists)).toBe(true);
    });

    it('prevents single-use invite token from being reused a second time', async () => {
      const reuseRes = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: alphaInviteToken,
          firstName: 'Alice Impersonator',
          password: 'Password123!',
        });

      expect([400, 404]).toContain(reuseRes.status);

      const previewRes = await request(app).get(`/api/auth/invite-info/${alphaInviteToken}`);
      expect(previewRes.status).toBe(404);
    });

    it('Alice invites Bob to Family Alpha and verifies Google Sign-In requirements', async () => {
      // Alice creates member invite for Bob
      const inviteRes = await request(app)
        .post(`/api/families/${familyAlphaId}/invites`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ email: 'bob@example.com', role: 'member' });

      expect(inviteRes.status).toBe(201);
      const bobInviteToken = inviteRes.body.inviteToken;
      expect(bobInviteToken).toBeDefined();

      // Case 1: Rejects unverified email
      const unverifiedRes = await request(app)
        .post('/api/auth/google')
        .send({
          inviteToken: bobInviteToken,
          email: 'bob@example.com',
          emailVerified: false,
          googleSub: 'google-sub-bob-1',
          firstName: 'Bob',
        });

      expect(unverifiedRes.status).toBe(403);
      expect(unverifiedRes.body.error).toMatch(/must be verified by google/i);

      // Case 2: Rejects mismatched email
      const mismatchedRes = await request(app)
        .post('/api/auth/google')
        .send({
          inviteToken: bobInviteToken,
          email: 'wrong@example.com',
          emailVerified: true,
          googleSub: 'google-sub-bob-1',
          firstName: 'Bob',
        });

      expect(mismatchedRes.status).toBe(403);
      expect(mismatchedRes.body.error).toMatch(/does not match invite email/i);

      // Case 3: Succeeds with verified email matching invite
      const successRes = await request(app)
        .post('/api/auth/google')
        .send({
          inviteToken: bobInviteToken,
          email: 'bob@example.com',
          emailVerified: true,
          googleSub: 'google-sub-bob-1',
          firstName: 'Bob',
          lastName: 'Builder',
        });

      expect(successRes.status).toBe(200);
      expect(successRes.body.user.email).toBe('bob@example.com');
      expect(successRes.body.user.mfa_enrolled).toBe(true);

      bobCookie = extractCookie(successRes);
      bobCsrf = successRes.body.csrfToken;
      bobUserId = successRes.body.user.id;

      // Bob can access family lists immediately because Google sign-in fulfills MFA
      const bobAccess = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', bobCookie);

      expect(bobAccess.status).toBe(200);
    });

    it('Alice issues Admin-Assisted Enrollment link for Grandma Rose, who completes one-tap Passkey enrollment', async () => {
      // Alice generates assisted enrollment link
      const assistRes = await request(app)
        .post(`/api/families/${familyAlphaId}/assisted-enrollment`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          email: 'grandma.rose@example.com',
          firstName: 'Grandma Rose',
        });

      expect(assistRes.status).toBe(201);
      expect(assistRes.body.token).toBeDefined();
      expect(assistRes.body.assistedUrl).toMatch(/\/assisted\//);
      expect(assistRes.body.qrCodeDataUrl).toContain('data:image/png;base64');

      const roseToken = assistRes.body.token;

      // Grandma Rose enrolls passkey with one tap
      const enrollRes = await request(app)
        .post('/api/auth/assisted-enroll')
        .send({
          token: roseToken,
          firstName: 'Rose',
          deviceName: "Rose's iPad",
          credentialId: 'rose-passkey-cred-id',
          publicKey: 'rose-public-key-base64',
        });

      expect(enrollRes.status).toBe(200);
      expect(enrollRes.body.user.first_name).toBe('Rose');
      expect(Array.isArray(enrollRes.body.recoveryCodes)).toBe(true);
      expect(enrollRes.body.recoveryCodes.length).toBe(8);

      roseCookie = extractCookie(enrollRes);
      roseCsrf = enrollRes.body.csrfToken;
      roseUserId = enrollRes.body.user.id;

      // Verify passkey enrollment via /api/auth/me
      const meRose = await request(app).get('/api/auth/me').set('Cookie', roseCookie);
      expect(meRose.status).toBe(200);
      expect(meRose.body.user.passkey_enrolled).toBe(true);

      // Assisted invite cannot be reused
      const secondEnroll = await request(app)
        .post('/api/auth/assisted-enroll')
        .send({ token: roseToken, firstName: 'Rose' });

      expect(secondEnroll.status).toBe(404);

      // Grandma Rose has full member access
      const roseAccess = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', roseCookie);

      expect(roseAccess.status).toBe(200);
    });

    it('supports multi-family membership: Alice accepts invite to Family Beta as regular member', async () => {
      // First, bootstrap Beta Admin so they can issue invites in Family Beta
      const betaAdminReg = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: betaInviteToken,
          firstName: 'Beta',
          lastName: 'Admin',
          password: 'BetaAdminPassword123!',
        });

      expect(betaAdminReg.status).toBe(201);
      betaAdminCookie = extractCookie(betaAdminReg);
      betaAdminCsrf = betaAdminReg.body.csrfToken;

      // Enable TOTP for Beta Admin
      const bTotpSetup = await request(app)
        .post('/api/auth/mfa/totp/setup')
        .set('Cookie', betaAdminCookie)
        .set('x-csrf-token', betaAdminCsrf);
      const bCode = generateTotpCode(bTotpSetup.body.secret);
      await request(app)
        .post('/api/auth/mfa/totp/enable')
        .set('Cookie', betaAdminCookie)
        .set('x-csrf-token', betaAdminCsrf)
        .send({ code: bCode });

      // Beta Admin invites Alice (alice@example.com) to Family Beta as member
      const aliceBetaInviteRes = await request(app)
        .post(`/api/families/${familyBetaId}/invites`)
        .set('Cookie', betaAdminCookie)
        .set('x-csrf-token', betaAdminCsrf)
        .send({ email: 'alice@example.com', role: 'member' });

      expect(aliceBetaInviteRes.status).toBe(201);
      const aliceBetaInviteToken = aliceBetaInviteRes.body.inviteToken;

      // Alice accepts invite to Family Beta
      const acceptRes = await request(app)
        .post('/api/auth/register-from-invite')
        .send({
          inviteToken: aliceBetaInviteToken,
          firstName: 'Alice',
          password: 'AliceStrongPassword123!',
        });

      expect(acceptRes.status).toBe(201);
      aliceCookie = extractCookie(acceptRes);
      aliceCsrf = acceptRes.body.csrfToken;

      // Since accepting an invite issues a session that needs MFA verification,
      // Alice verifies her TOTP on this session
      const verifyTotpRes = await request(app)
        .post('/api/auth/mfa/totp/verify')
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ code: generateTotpCode(aliceTotpSecret) });

      expect(verifyTotpRes.status).toBe(200);

      // Verify Alice has 2 distinct memberships: family_admin in Alpha, member in Beta
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', aliceCookie);

      expect(meRes.status).toBe(200);
      const memberships = meRes.body.memberships;
      expect(memberships.length).toBe(2);

      const alphaMem = memberships.find((m: any) => m.family_id === familyAlphaId);
      const betaMem = memberships.find((m: any) => m.family_id === familyBetaId);

      expect(alphaMem).toBeDefined();
      expect(alphaMem.role).toBe('family_admin');
      expect(betaMem).toBeDefined();
      expect(betaMem.role).toBe('member');

      // Alice can access both families
      const alphaAccess = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', aliceCookie);
      expect(alphaAccess.status).toBe(200);

      const betaAccess = await request(app)
        .get(`/api/families/${familyBetaId}/lists`)
        .set('Cookie', aliceCookie);
      expect(betaAccess.status).toBe(200);
    });
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

  // =========================================================================
  // SECTION 8: SSRF-Safe Product URL Auto-Fill & Image EXIF Stripping
  // =========================================================================
  describe('8. SSRF-Safe Product URL Auto-Fill & Image EXIF Stripping', () => {
    it('verifies isPublicIp rejects private, loopback, link-local, and cloud metadata IPs', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('169.254.169.254')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('::1')).toBe(false);
      expect(isPublicIp('fe80::1')).toBe(false);

      // Public IPs allowed
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('93.184.216.34')).toBe(true);
    });

    it('POST /autofill blocks loopback, private IPs, metadata IP, and localhost', async () => {
      const blockedUrls = [
        'http://127.0.0.1',
        'http://localhost',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://[::1]/',
      ];

      for (const url of blockedUrls) {
        const res = await request(app)
          .post(`/api/families/${familyAlphaId}/autofill`)
          .set('Cookie', aliceCookie)
          .set('x-csrf-token', aliceCsrf)
          .send({ url });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/could not be safely fetched/i);
      }
    });

    it('blocks guests from calling /autofill (403)', async () => {
      // Create guest link
      const gRes = await request(app)
        .post(`/api/families/${familyAlphaId}/guest-links`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ guestFirstName: 'GuestUser', expiresInDays: 7 });

      expect(gRes.status).toBe(201);
      const gCookie = extractCookie(await request(app).get(`/g/${gRes.body.token}`));
      const meRes = await request(app).get('/api/auth/me').set('Cookie', gCookie);

      const autofillRes = await request(app)
        .post(`/api/families/${familyAlphaId}/autofill`)
        .set('Cookie', gCookie)
        .set('x-csrf-token', meRes.body.csrfToken)
        .send({ url: 'https://www.target.com/p/item' });

      expect(autofillRes.status).toBe(403);
    });

    it('extracts product metadata via mockHtml, sanitizes domain, and records sanitized domain in audit_logs', async () => {
      const mockProductHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Classic Coffee Press</title>
          <meta property="og:title" content="Classic French Press 34oz" />
          <meta property="og:price:amount" content="29.99" />
          <meta property="og:site_name" content="Bodum Official Store" />
          <meta property="og:image" content="https://example.com/images/press.jpg" />
        </head>
        <body></body>
        </html>
      `;

      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/autofill`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          url: 'https://www.bodum.com/us/en/french-press?ref=tracker_123',
          mockHtml: mockProductHtml,
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Classic French Press 34oz');
      expect(res.body.price_cents).toBe(2999);
      expect(res.body.store_name).toBe('Bodum Official Store');
      expect(res.body.sanitized_domain).toBe('bodum.com');

      // Verify audit log recorded sanitized domain and did not leak query params
      await withFamilyContext(familyAlphaId, async (client) => {
        const logRes = await client.query(
          "SELECT metadata FROM audit_logs WHERE action = 'URL_AUTOFILL_FETCH' ORDER BY created_at DESC LIMIT 1"
        );
        expect(logRes.rows.length).toBe(1);
        expect(logRes.rows[0].metadata.domain).toBe('bodum.com');
      });
    });

    it('sanitizes images via sharp, strips EXIF metadata, and serves clean WebP', async () => {
      // 1. Create a dummy image with EXIF metadata
      const rawImageWithExif = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .withMetadata({
          exif: {
            IFD0: {
              Copyright: 'Sensitive Private EXIF GPS Metadata',
            },
          },
        })
        .jpeg()
        .toBuffer();

      // 2. Run through sanitizeImageBuffer directly
      const sanitizedDirect = await sanitizeImageBuffer(rawImageWithExif);
      expect(sanitizedDirect.mimeType).toBe('image/webp');
      const directMeta = await sharp(sanitizedDirect.data).metadata();
      expect(directMeta.exif).toBeUndefined();

      // 3. Upload image through POST /images endpoint
      const uploadRes = await request(app)
        .post(`/api/families/${familyAlphaId}/images`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          imageBase64: rawImageWithExif.toString('base64'),
        });

      expect(uploadRes.status).toBe(201);
      expect(uploadRes.body.imageId).toBeDefined();
      expect(uploadRes.body.imageUrl).toContain(`/api/families/${familyAlphaId}/images/`);

      const uploadedImageId = uploadRes.body.imageId;

      // 4. Retrieve clean WebP image
      const fetchRes = await request(app)
        .get(`/api/families/${familyAlphaId}/images/${uploadedImageId}`)
        .set('Cookie', aliceCookie);

      expect(fetchRes.status).toBe(200);
      expect(fetchRes.headers['content-type']).toBe('image/webp');

      const servedMeta = await sharp(fetchRes.body).metadata();
      expect(servedMeta.format).toBe('webp');
      expect(servedMeta.exif).toBeUndefined();
    });
  });
});
