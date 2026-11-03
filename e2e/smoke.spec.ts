import { test, expect, type Page } from '@playwright/test';
import { generateTotpCode } from '../src/security/crypto';

const ADMIN_TOKEN = 'dev-instance-admin-bootstrap-token';
const EMAIL = 'alice@example.com';
const PASSWORD = 'AliceStrongPassword123!';

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/js/') && r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
  });
  return problems;
}

test.describe.configure({ mode: 'serial' });

test('app shell loads with no console errors, CSP violations, or missing modules', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/');
  await expect(page.locator('#view-auth')).toBeVisible();
  await expect(page.locator('#form-login')).toBeVisible();
  // main.js is an ES module; a click handler it binds proves the module graph executed.
  await page.locator('#btn-show-instance-admin').click();
  await expect(page.locator('#modal-instance-login')).toBeVisible();
  expect(problems).toEqual([]);
});

test('sign in with password + 2FA, create a list, add an item, and use autofill', async ({
  page,
  playwright,
  baseURL,
}) => {
  const problems = collectProblems(page);

  // ---- Seed via API: a family and a user with TOTP enrolled ----
  const adminApi = await playwright.request.newContext({ baseURL });
  const login = await adminApi.post('/api/instance-admin/login', { data: { token: ADMIN_TOKEN } });
  expect(login.ok()).toBeTruthy();
  const adminCsrf = (await login.json()).csrfToken;
  const fam = await adminApi.post('/api/instance-admin/families', {
    headers: { 'x-csrf-token': adminCsrf },
    data: { name: 'Smoke Family', slug: 'smoke-family', adminEmail: EMAIL },
  });
  expect(fam.ok()).toBeTruthy();
  const famBody = await fam.json();

  const userApi = await playwright.request.newContext({ baseURL });
  const reg = await userApi.post('/api/auth/register-from-invite', {
    data: {
      inviteToken: famBody.bootstrapInviteToken,
      firstName: 'Alice',
      lastName: 'Admin',
      password: PASSWORD,
    },
  });
  expect(reg.ok()).toBeTruthy();
  const csrf = (await reg.json()).csrfToken;
  const setup = await userApi.post('/api/auth/mfa/totp/setup', { headers: { 'x-csrf-token': csrf } });
  const totpSecret: string = (await setup.json()).secret;
  const enable = await userApi.post('/api/auth/mfa/totp/enable', {
    headers: { 'x-csrf-token': csrf },
    data: { code: generateTotpCode(totpSecret) },
  });
  expect(enable.ok()).toBeTruthy();

  // ---- Real UI login ----
  await page.goto('/');
  await page.fill('#input-email', EMAIL);
  await page.fill('#input-password', PASSWORD);
  await page.click('#btn-submit-login');
  await expect(page.locator('#mfa-step')).toBeVisible();
  await page.fill('#input-totp-code', generateTotpCode(totpSecret));
  await page.click('#btn-verify-mfa');
  await expect(page.locator('#view-dashboard')).toBeVisible();

  // ---- Create a list ----
  await page.click('#btn-open-create-list-modal');
  await page.fill('#list-name', 'Smoke Test List');
  await page.selectOption('#list-recipient-type', 'myself');
  await page.locator('#form-create-wishlist button[type="submit"]').click();
  await expect(page.locator('#lists-tabs-bar')).toContainText('Smoke Test List');

  // ---- Autofill: stub the network response; assert UI wiring and the request body ----
  await page.locator('#accordion-add-item > summary').click();
  let autofillBody: unknown = null;
  await page.route('**/api/families/*/autofill', async (route) => {
    autofillBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Cozy Slippers',
        price_cents: 3999,
        store_name: 'Example Store',
        image_url: '',
      }),
    });
  });
  await page.fill('#input-autofill-url', 'https://example.com/slippers');
  await page.click('#btn-autofill');
  await expect(page.locator('#item-name')).toHaveValue('Cozy Slippers');
  await expect(page.locator('#item-price')).toHaveValue('39.99');
  await expect(page.locator('#item-store-name')).toHaveValue('Example Store');
  expect(autofillBody).toMatchObject({ url: 'https://example.com/slippers', fetchImage: true });

  // ---- Submit the item and see it listed ----
  await page.click('#btn-submit-item');
  await expect(page.locator('#active-list-container')).toContainText('Cozy Slippers');

  expect(problems).toEqual([]);
});
