// Shared, assertion-free fixtures for the split integration test files.
// Each test file calls initDb() on its own (in-memory PGlite lives in the module
// graph, and vitest isolates every test file), then builds the state it needs here.
import request from 'supertest';
import { config } from '../../src/config.js';
import { SESSION_COOKIE_NAME } from '../../src/security/middleware.js';
import { generateTotpCode } from '../../src/security/crypto.js';

type App = Parameters<typeof request>[0];

// Extract the session cookie from supertest response headers
export function extractCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  if (!raw) return '';
  const cookies = Array.isArray(raw) ? raw : [raw];
  const session = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  return session ? session.split(';')[0] : '';
}

// Prerequisite for sections 2+: instance admin session + Family Alpha and Family Beta
export async function setupFamilies(app: App) {
  const login = await request(app)
    .post('/api/instance-admin/login')
    .send({ token: config.bootstrapInstanceAdminToken });
  const instanceAdminCookie = extractCookie(login);
  const instanceAdminCsrf: string = login.body.csrfToken;

  const alpha = await request(app)
    .post('/api/instance-admin/families')
    .set('Cookie', instanceAdminCookie)
    .set('x-csrf-token', instanceAdminCsrf)
    .send({ name: 'Family Alpha', slug: 'family-alpha', adminEmail: 'alice@example.com' });
  const beta = await request(app)
    .post('/api/instance-admin/families')
    .set('Cookie', instanceAdminCookie)
    .set('x-csrf-token', instanceAdminCsrf)
    .send({ name: 'Family Beta', slug: 'family-beta', adminEmail: 'beta-admin@example.com' });

  return {
    instanceAdminCookie,
    instanceAdminCsrf,
    familyAlphaId: alpha.body.family.id as string,
    alphaInviteToken: alpha.body.bootstrapInviteToken as string,
    familyBetaId: beta.body.family.id as string,
    betaInviteToken: beta.body.bootstrapInviteToken as string,
  };
}

// Prerequisite for sections 3+: the state at the end of section 2
// (Alice = Alpha admin w/ TOTP + Beta member, Beta admin, Bob via Google, Rose via passkey)
export async function setupBaseWorld(app: App) {
  const fam = await setupFamilies(app);
  const { familyAlphaId, familyBetaId, alphaInviteToken, betaInviteToken } = fam;

  // Alice registers and enables TOTP
  const reg = await request(app).post('/api/auth/register-from-invite').send({
    inviteToken: alphaInviteToken,
    firstName: 'Alice',
    lastName: 'Admin',
    password: 'AliceStrongPassword123!',
  });
  let aliceCookie = extractCookie(reg);
  let aliceCsrf: string = reg.body.csrfToken;
  const aliceUserId: string = reg.body.user.id;
  const setup = await request(app)
    .post('/api/auth/mfa/totp/setup')
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf);
  const aliceTotpSecret: string = setup.body.secret;
  const enable = await request(app)
    .post('/api/auth/mfa/totp/enable')
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf)
    .send({ code: generateTotpCode(aliceTotpSecret) });
  const aliceRecoveryCodes: string[] = enable.body.recoveryCodes;

  // Bob via Google sign-in
  const bobInvite = await request(app)
    .post(`/api/families/${familyAlphaId}/invites`)
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf)
    .send({ email: 'bob@example.com', role: 'member' });
  const bobRes = await request(app).post('/api/auth/google').send({
    inviteToken: bobInvite.body.inviteToken,
    email: 'bob@example.com',
    emailVerified: true,
    googleSub: 'google-sub-bob-1',
    firstName: 'Bob',
    lastName: 'Builder',
  });
  const bobCookie = extractCookie(bobRes);
  const bobCsrf: string = bobRes.body.csrfToken;
  const bobUserId: string = bobRes.body.user.id;

  // Grandma Rose via admin-assisted passkey enrollment
  const assist = await request(app)
    .post(`/api/families/${familyAlphaId}/assisted-enrollment`)
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf)
    .send({ email: 'grandma.rose@example.com', firstName: 'Grandma Rose' });
  const enroll = await request(app).post('/api/auth/assisted-enroll').send({
    token: assist.body.token,
    firstName: 'Rose',
    deviceName: "Rose's iPad",
    credentialId: 'rose-passkey-cred-id',
    publicKey: 'rose-public-key-base64',
  });
  const roseCookie = extractCookie(enroll);
  const roseCsrf: string = enroll.body.csrfToken;
  const roseUserId: string = enroll.body.user.id;

  // Beta admin bootstraps, enables TOTP, and invites Alice to Family Beta
  const betaReg = await request(app).post('/api/auth/register-from-invite').send({
    inviteToken: betaInviteToken,
    firstName: 'Beta',
    lastName: 'Admin',
    password: 'BetaAdminPassword123!',
  });
  const betaAdminCookie = extractCookie(betaReg);
  const betaAdminCsrf: string = betaReg.body.csrfToken;
  const bSetup = await request(app)
    .post('/api/auth/mfa/totp/setup')
    .set('Cookie', betaAdminCookie)
    .set('x-csrf-token', betaAdminCsrf);
  await request(app)
    .post('/api/auth/mfa/totp/enable')
    .set('Cookie', betaAdminCookie)
    .set('x-csrf-token', betaAdminCsrf)
    .send({ code: generateTotpCode(bSetup.body.secret) });
  const aliceBetaInvite = await request(app)
    .post(`/api/families/${familyBetaId}/invites`)
    .set('Cookie', betaAdminCookie)
    .set('x-csrf-token', betaAdminCsrf)
    .send({ email: 'alice@example.com', role: 'member' });
  const accept = await request(app).post('/api/auth/register-from-invite').send({
    inviteToken: aliceBetaInvite.body.inviteToken,
    firstName: 'Alice',
    password: 'AliceStrongPassword123!',
  });
  aliceCookie = extractCookie(accept);
  aliceCsrf = accept.body.csrfToken;
  await request(app)
    .post('/api/auth/mfa/totp/verify')
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf)
    .send({ code: generateTotpCode(aliceTotpSecret) });

  return {
    ...fam,
    aliceCookie,
    aliceCsrf,
    aliceUserId,
    aliceTotpSecret,
    aliceRecoveryCodes,
    betaAdminCookie,
    betaAdminCsrf,
    bobCookie,
    bobCsrf,
    bobUserId,
    roseCookie,
    roseCsrf,
    roseUserId,
  };
}

interface AliceCtx {
  familyAlphaId: string;
  aliceCookie: string;
  aliceCsrf: string;
}

// Prerequisite for sections 5-7: Alice's wish list with the four section-4 items
export async function setupAliceList(app: App, ctx: AliceCtx) {
  const { familyAlphaId, aliceCookie, aliceCsrf } = ctx;
  const listRes = await request(app)
    .post(`/api/families/${familyAlphaId}/lists`)
    .set('Cookie', aliceCookie)
    .set('x-csrf-token', aliceCsrf)
    .send({ name: "Alice's Birthday 2026", eventDate: '2026-12-25' });
  const aliceListId: string = listRes.body.list.id;

  const addItem = async (body: Record<string, unknown>): Promise<string> => {
    const r = await request(app)
      .post(`/api/families/${familyAlphaId}/lists/${aliceListId}/items`)
      .set('Cookie', aliceCookie)
      .set('x-csrf-token', aliceCsrf)
      .send(body);
    return r.body.item.id;
  };
  const espressoItemId = await addItem({
    name: 'Espresso Machine',
    priceCents: 35000,
    priority: 'really_want',
    storeUrl: 'https://example.com/espresso',
    storeName: 'Coffee Boutique',
  });
  const oledItemId = await addItem({
    name: 'OLED TV',
    priceCents: 120000,
    priority: 'really_want',
    storeUrl: 'https://example.com/oled',
    storeName: 'Electro World',
  });
  const socksItemId = await addItem({
    name: 'Wool Socks',
    priceCents: 1500,
    priority: 'nice_to_have',
    quantity: 4,
    allowDuplicates: true,
    storeUrl: 'https://example.com/socks',
    storeName: 'Winter Gear',
  });
  const posterItemId = await addItem({
    name: 'Vintage Poster',
    priceCents: 2500,
    priority: 'nice_to_have',
  });
  return { aliceListId, espressoItemId, oledItemId, socksItemId, posterItemId };
}

// Prerequisite for section 7: Bob claims the Espresso Machine and pledges $500 toward the OLED TV
export async function setupBobGifts(
  app: App,
  ctx: {
    familyAlphaId: string;
    bobCookie: string;
    bobCsrf: string;
    espressoItemId: string;
    oledItemId: string;
  }
) {
  const { familyAlphaId, bobCookie, bobCsrf, espressoItemId, oledItemId } = ctx;
  const claim = await request(app)
    .post(`/api/families/${familyAlphaId}/items/${espressoItemId}/claim`)
    .set('Cookie', bobCookie)
    .set('x-csrf-token', bobCsrf)
    .send({ quantity: 1 });
  await request(app)
    .post(`/api/families/${familyAlphaId}/items/${oledItemId}/pledge`)
    .set('Cookie', bobCookie)
    .set('x-csrf-token', bobCsrf)
    .send({ amountCents: 50000, note: 'Happy Birthday Alice! Hope you enjoy the OLED!' });
  return { bobClaimId: claim.body.claim.id as string };
}
