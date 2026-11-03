import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { withSystemContext } from '../db/index.js';
import { generateToken, hashToken } from '../security/crypto.js';
import {
  tokenRateLimiter,
  setSessionCookie,
  clearSessionCookie,
  isRequestSecure,
} from '../security/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

/**
 * GET /g/:token
 * Zero-footprint redemption of guest links.
 * Immediately exchanges token for an HttpOnly session cookie,
 * strips the token from the browser URL, and redirects 303 to /guest.
 */
router.get('/g/:token', tokenRateLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken) {
      res.status(404).json({ error: 'Link not found or expired' });
      return;
    }

    const tokenHash = hashToken(rawToken);

    const link = await withSystemContext(async (client) => {
      const result = await client.query(
        `SELECT id, family_id, guest_first_name, expires_at
         FROM guest_links
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      return result.rows[0] || null;
    });

    if (!link) {
      res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Link Expired or Not Found</title></head>
<body><h1>This wish list guest link is invalid or has expired.</h1></body>
</html>`);
      return;
    }

    const rawSessionToken = generateToken(32);
    const csrfToken = generateToken(32);
    const sessionTokenHash = hashToken(rawSessionToken);
    const sessionId = randomUUID();

    const remainingMs = Math.max(1000, new Date(link.expires_at).getTime() - Date.now());
    const sessionMaxAgeMs = Math.min(remainingMs, 30 * 24 * 60 * 60 * 1000);
    const sessionExpiresAt = new Date(Date.now() + sessionMaxAgeMs);

    await withSystemContext(async (client) => {
      await client.query(
        `INSERT INTO sessions (id, token_hash, csrf_token, kind, guest_link_id, mfa_verified, expires_at, created_at)
         VALUES ($1, $2, $3, 'guest', $4, TRUE, $5, NOW())`,
        [sessionId, sessionTokenHash, csrfToken, link.id, sessionExpiresAt]
      );
    });

    setSessionCookie(res, rawSessionToken, sessionMaxAgeMs);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, '/guest');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /a/:token
 * Zero-footprint redemption of assignment links.
 * Exchanges token for an HttpOnly session cookie, strips token, and redirects 303 to /assignment.
 */
router.get('/a/:token', tokenRateLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken) {
      res.status(404).json({ error: 'Link not found or expired' });
      return;
    }

    const tokenHash = hashToken(rawToken);

    const link = await withSystemContext(async (client) => {
      const result = await client.query(
        `SELECT id, family_id, assignee_first_name, expires_at
         FROM assignment_links
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      return result.rows[0] || null;
    });

    if (!link) {
      res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Link Expired or Not Found</title></head>
<body><h1>This assignment link is invalid or has expired.</h1></body>
</html>`);
      return;
    }

    const rawSessionToken = generateToken(32);
    const csrfToken = generateToken(32);
    const sessionTokenHash = hashToken(rawSessionToken);
    const sessionId = randomUUID();

    const remainingMs = Math.max(1000, new Date(link.expires_at).getTime() - Date.now());
    const sessionMaxAgeMs = Math.min(remainingMs, 30 * 24 * 60 * 60 * 1000);
    const sessionExpiresAt = new Date(Date.now() + sessionMaxAgeMs);

    await withSystemContext(async (client) => {
      await client.query(
        `INSERT INTO sessions (id, token_hash, csrf_token, kind, assignment_link_id, mfa_verified, expires_at, created_at)
         VALUES ($1, $2, $3, 'assignment', $4, TRUE, $5, NOW())`,
        [sessionId, sessionTokenHash, csrfToken, link.id, sessionExpiresAt]
      );
    });

    setSessionCookie(res, rawSessionToken, sessionMaxAgeMs);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, '/assignment');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /invite/:token
 * Zero-footprint invite link redemption.
 * Stores invite token in a short-lived HttpOnly cookie and redirects 303 to clean URL /?mode=invite.
 */
router.get('/invite/:token', tokenRateLimiter, (req, res) => {
  const rawToken = req.params.token;
  if (!rawToken) {
    res.status(404).json({ error: 'Invite token missing' });
    return;
  }

  // Clear any active instance_admin or stale session so the invite onboarding screen loads cleanly
  clearSessionCookie(res);

  res.cookie('unwrapped_pending_invite', rawToken, {
    httpOnly: true,
    secure: isRequestSecure(res),
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(303, '/?mode=invite');
});

/**
 * GET /assisted/:token
 * Zero-footprint assisted enrollment link redemption.
 * Stores token in short-lived HttpOnly cookie and redirects 303 to clean URL /?mode=assisted.
 */
router.get('/assisted/:token', tokenRateLimiter, (req, res) => {
  const rawToken = req.params.token;
  if (!rawToken) {
    res.status(404).json({ error: 'Assisted token missing' });
    return;
  }

  clearSessionCookie(res);

  res.cookie('unwrapped_pending_assisted', rawToken, {
    httpOnly: true,
    secure: isRequestSecure(res),
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(303, '/?mode=assisted');
});

/**
 * GET /api/links/pending
 * Reads the pending invite or assisted enrollment token from short-lived cookies
 * for the SPA onboarding form.
 */
router.get('/api/links/pending', (req, res) => {
  res.json({
    inviteToken: req.cookies?.unwrapped_pending_invite || null,
    assistedToken: req.cookies?.unwrapped_pending_assisted || null,
  });
});

/**
 * POST /api/links/clear-pending
 * Clears short-lived pending cookies after redemption.
 */
router.post('/api/links/clear-pending', (_req, res) => {
  res.clearCookie('unwrapped_pending_invite', { path: '/' });
  res.clearCookie('unwrapped_pending_assisted', { path: '/' });
  res.json({ success: true });
});

export default router;
