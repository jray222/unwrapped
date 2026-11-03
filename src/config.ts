import crypto from 'node:crypto';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL || 'pglite://memory',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  bootstrapInstanceAdminToken:
    process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN || 'dev-instance-admin-bootstrap-token',
  rpName: process.env.WEBAUTHN_RP_NAME || 'Unwrapped Family Wish List',
  rpID: process.env.WEBAUTHN_RP_ID || 'localhost',
  origin: process.env.APP_ORIGIN || 'http://localhost:3000',
  googleClientId: process.env.GOOGLE_CLIENT_ID || 'mock-google-client-id',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock-google-client-secret',
  maxGuestLinkDays: 365,
  inviteExpiryDays: 7,
  reminderDaysBeforeEvent: 5,
  autofillTimeoutMs: 10000,
  autofillMaxHtmlBytes: 1024 * 1024, // 1 MB
  autofillMaxImageBytes: 5 * 1024 * 1024, // 5 MB
  autofillMaxRedirects: 3,
};
