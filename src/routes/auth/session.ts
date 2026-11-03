import { Router } from 'express';
import { withSystemContext } from '../../db/index.js';
import { verifyPassword } from '../../security/crypto.js';
import { authRateLimiter, setSessionCookie, clearSessionCookie } from '../../security/middleware.js';
import { createUserSession } from '../../services/sessions.js';
import type { AuthenticatedRequest } from '../../types.js';

const router = Router();

/**
 * GET /api/auth/me
 * Returns current authentication and authorization context.
 */
router.get('/me', (req: AuthenticatedRequest, res) => {
  if (!req.auth) {
    res.json({ authenticated: false });
    return;
  }

  if (req.auth.kind === 'instance_admin') {
    res.json({
      authenticated: true,
      kind: 'instance_admin',
      csrfToken: req.auth.csrfToken,
    });
    return;
  }

  if (req.auth.kind === 'user' && req.auth.user) {
    res.json({
      authenticated: true,
      kind: 'user',
      csrfToken: req.auth.csrfToken,
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        first_name: req.auth.user.first_name,
        last_name: req.auth.user.last_name,
        totp_enabled: req.auth.user.totp_enabled,
        passkey_enrolled: req.auth.user.passkey_enrolled,
        mfa_enrolled: req.auth.user.mfa_enrolled,
      },
      memberships: req.auth.memberships || [],
    });
    return;
  }

  if (req.auth.kind === 'guest' && req.auth.guestLink) {
    res.json({
      authenticated: true,
      kind: 'guest',
      csrfToken: req.auth.csrfToken,
      guestLink: req.auth.guestLink,
    });
    return;
  }

  if (req.auth.kind === 'assignment' && req.auth.assignmentLink) {
    res.json({
      authenticated: true,
      kind: 'assignment',
      csrfToken: req.auth.csrfToken,
      assignmentLink: req.auth.assignmentLink,
    });
    return;
  }

  res.json({ authenticated: false });
});

/**
 * POST /api/auth/login
 * Local password login. Issues a pre-MFA session (mfa_verified = false).
 */
router.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const user = await withSystemContext(async (client) => {
      const result = await client.query(
        `SELECT id, email, first_name, last_name, password_hash, totp_enabled, passkey_enrolled
         FROM users
         WHERE email = $1`,
        [normalizedEmail]
      );
      return result.rows[0] || null;
    });

    if (!user || !user.password_hash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const session = await withSystemContext(async (client) =>
      createUserSession(client, user.id, false)
    );

    setSessionCookie(res, session.rawSessionToken, session.maxAgeMs);

    const hasMfa = Boolean(user.totp_enabled || user.passkey_enrolled);

    res.json({
      sessionToken: session.rawSessionToken,
      csrfToken: session.csrfToken,
      mfaRequired: hasMfa,
      mfaEnrollmentRequired: !hasMfa,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Destroys session and clears cookie.
 */
router.post('/logout', async (req: AuthenticatedRequest, res, next) => {
  try {
    if (req.auth?.sessionId) {
      await withSystemContext(async (client) => {
        await client.query('DELETE FROM sessions WHERE id = $1', [req.auth!.sessionId]);
      });
    }

    clearSessionCookie(res);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
