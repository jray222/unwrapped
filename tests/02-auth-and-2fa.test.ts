import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { withSystemContext } from '../src/db/index.js';
import { generateTotpCode, normalizeRecoveryCodeHash } from '../src/security/crypto.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { extractCookie, setupFamilies } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 2: Sign-In, Invites, 2FA/Passkeys', () => {
  const app = createApp();

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

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ instanceAdminCookie, instanceAdminCsrf, familyAlphaId, alphaInviteToken, familyBetaId, betaInviteToken } = await setupFamilies(app));
  });

  beforeEach(() => {
    resetRateLimiters();
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

});
