import { Router } from 'express';
import { requireCsrf, requirePreMfaUser } from '../../security/middleware.js';
import sessionRoutes from './session.js';
import inviteRoutes from './invite.js';
import googleRoutes from './google.js';
import totpRoutes from './totp.js';
import passkeyRoutes from './passkeys.js';
import assistedRoutes from './assisted.js';

const router = Router();

// Public / session routes: GET /me, POST /login, POST /logout
router.use(sessionRoutes);

// Invite preview and local registration from invite
router.use(inviteRoutes);

// Google OAuth / OIDC
router.use(googleRoutes);

// All MFA verification / enrollment endpoints below require an active pre-MFA user session and CSRF token
router.use('/mfa', requirePreMfaUser);
router.use('/mfa', requireCsrf);

// TOTP setup/enable/verify and recovery codes (under /mfa)
router.use(totpRoutes);

// Passkey registration (/mfa/passkey/*, /passkey/*) and passkey login
router.use(passkeyRoutes);

// Admin-assisted enrollment
router.use(assistedRoutes);

export default router;
