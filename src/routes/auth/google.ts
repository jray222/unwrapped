import { Router } from 'express';
import { generateToken } from '../../security/crypto.js';
import { authRateLimiter, setSessionCookie } from '../../security/middleware.js';
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  isGoogleConfigured,
  buildGoogleAuthUrl,
  fetchGoogleProfile,
  signInWithGoogleProfile,
  signInWithGoogleIdentity,
} from '../../services/google-auth.js';

const router = Router();

/**
 * GET /api/auth/google
 * Initiates Google OAuth 2.0 / OIDC redirect flow.
 */
router.get('/google', authRateLimiter, (req, res) => {
  if (!isGoogleConfigured()) {
    res.redirect(303, '/?error=google_not_configured');
    return;
  }
  const stateToken = generateToken(24);
  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, stateToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(302, buildGoogleAuthUrl(stateToken));
});

/**
 * GET /api/auth/google/callback
 * Completes Google OAuth 2.0 code exchange and signs in or accepts pending invite.
 */
router.get('/google/callback', authRateLimiter, async (req, res, next) => {
  try {
    const { code, state } = req.query;
    const cookieState = req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE];
    res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: '/' });

    if (!code || typeof code !== 'string' || !state || state !== cookieState) {
      res.redirect(303, '/?error=google_oauth_state_mismatch');
      return;
    }

    const fetched = await fetchGoogleProfile(code);
    if ('errorCode' in fetched) {
      res.redirect(303, `/?error=${fetched.errorCode}`);
      return;
    }

    const pendingInviteToken = req.cookies?.unwrapped_pending_invite || null;
    const sessionResult = await signInWithGoogleProfile(fetched.profile, pendingInviteToken);

    setSessionCookie(res, sessionResult.rawSessionToken, sessionResult.maxAgeMs);
    res.clearCookie('unwrapped_pending_invite', { path: '/' });
    res.redirect(303, '/');
  } catch (err: any) {
    if (err?.code) {
      res.redirect(303, `/?error=${encodeURIComponent(err.code)}`);
      return;
    }
    next(err);
  }
});

/**
 * POST /api/auth/google
 * Handles Google OIDC / ID Token verification.
 * Pre-verifies email and attaches to invite or existing account.
 */
router.post('/google', authRateLimiter, async (req, res, next) => {
  try {
    const inviteToken = req.body?.inviteToken ?? req.body?.invite_token;
    const email = req.body?.email;
    const emailVerified = req.body?.emailVerified ?? req.body?.email_verified;
    const googleSub = req.body?.googleSub ?? req.body?.google_sub;
    const firstName = req.body?.firstName ?? req.body?.first_name;
    const lastName = req.body?.lastName ?? req.body?.last_name;

    if (emailVerified !== true) {
      res.status(403).json({ error: 'Email must be verified by Google' });
      return;
    }

    if (!email || !googleSub) {
      res.status(400).json({ error: 'Missing required Google credentials' });
      return;
    }

    const result = await signInWithGoogleIdentity({
      inviteToken,
      email,
      googleSub,
      firstName,
      lastName,
    });

    setSessionCookie(res, result.sessionToken, result.maxAgeMs);
    res.clearCookie('unwrapped_pending_invite', { path: '/' });

    res.json({
      user: result.user,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
    });
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

export default router;
