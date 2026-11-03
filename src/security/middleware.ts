import type { Response, NextFunction } from 'express';
import helmet from 'helmet';
import { config } from '../config.js';
import { withSystemContext } from '../db/index.js';
import { hashToken } from './crypto.js';
import type { AuthenticatedRequest, FamilyRole } from '../types.js';

export const SESSION_COOKIE_NAME = 'unwrapped_session';

/**
 * Redacts any raw invite, guest, or assignment tokens from URL paths before logging.
 */
export function redactPathForLog(rawUrl: string): string {
  return rawUrl
    .replace(/\/(g|a|invite|assisted)\/[A-Za-z0-9_-]+/g, '/$1/[REDACTED]')
    .replace(/([?&](?:token|code|secret)=)[^&]+/gi, '$1[REDACTED]');
}

const recentRequestLog: string[] = [];
export function getRecentRedactedLogs(): string[] {
  return [...recentRequestLog];
}

export function requestLoggerMiddleware(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const safePath = redactPathForLog(req.originalUrl || req.url);
  const entry = `${new Date().toISOString()} ${req.method} ${safePath}`;
  recentRequestLog.push(entry);
  if (recentRequestLog.length > 200) recentRequestLog.shift();
  next();
}

export const securityHeadersMiddleware = [
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  }),
  (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  },
];

// Simple in-memory sliding window rate limiter
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function resetRateLimiters(): void {
  rateBuckets.clear();
}

export function createRateLimiter(options: {
  bucketPrefix: string;
  windowMs: number;
  max: number;
}) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const key = `${options.bucketPrefix}:${req.ip || 'local'}`;
    const now = Date.now();
    const existing = rateBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (existing.count >= options.max) {
      res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
      return;
    }
    existing.count += 1;
    next();
  };
}

export const authRateLimiter = createRateLimiter({
  bucketPrefix: 'auth',
  windowMs: 60_000,
  max: 25,
});

export const tokenRateLimiter = createRateLimiter({
  bucketPrefix: 'token',
  windowMs: 60_000,
  max: 30,
});

export const autofillRateLimiter = createRateLimiter({
  bucketPrefix: 'autofill',
  windowMs: 60_000,
  max: 15,
});

export function setSessionCookie(res: Response, rawToken: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
  });
}

export async function attachAuthContext(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
    const authHeader = req.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const rawToken = cookieToken || bearerToken;

    if (!rawToken) {
      next();
      return;
    }

    const tokenHash = hashToken(rawToken);

    await withSystemContext(async (client) => {
      const sessionRes = await client.query(
        `SELECT id, csrf_token, kind, user_id, guest_link_id, assignment_link_id, mfa_verified, expires_at
         FROM sessions
         WHERE token_hash = $1 AND expires_at > NOW()`,
        [tokenHash]
      );
      if (sessionRes.rows.length === 0) return;
      const sess = sessionRes.rows[0];

      if (sess.kind === 'instance_admin') {
        req.auth = {
          sessionId: sess.id,
          csrfToken: sess.csrf_token,
          kind: 'instance_admin',
        };
        return;
      }

      if (sess.kind === 'user' && sess.user_id) {
        const userRes = await client.query(
          `SELECT id, email, first_name, last_name, password_hash, google_sub,
                  totp_secret, totp_enabled, passkey_enrolled, created_at
           FROM users WHERE id = $1`,
          [sess.user_id]
        );
        if (userRes.rows.length === 0) return;
        const u = userRes.rows[0];
        const mfaEnrolled = Boolean(u.google_sub || u.totp_enabled || u.passkey_enrolled);

        const memRes = await client.query(
          `SELECT fm.family_id, f.name AS family_name, f.slug AS family_slug, fm.role
           FROM family_members fm
           JOIN families f ON f.id = fm.family_id
           WHERE fm.user_id = $1
           ORDER BY f.name ASC`,
          [u.id]
        );

        req.auth = {
          sessionId: sess.id,
          csrfToken: sess.csrf_token,
          kind: 'user',
          user: {
            ...u,
            mfa_enrolled: mfaEnrolled && Boolean(sess.mfa_verified),
          },
          memberships: memRes.rows,
        };
        return;
      }

      if (sess.kind === 'guest' && sess.guest_link_id) {
        const guestRes = await client.query(
          `SELECT id, family_id, guest_first_name, allowed_list_ids, created_by_user_id, expires_at
           FROM guest_links
           WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
          [sess.guest_link_id]
        );
        if (guestRes.rows.length === 0) return;
        req.auth = {
          sessionId: sess.id,
          csrfToken: sess.csrf_token,
          kind: 'guest',
          guestLink: guestRes.rows[0],
        };
        return;
      }

      if (sess.kind === 'assignment' && sess.assignment_link_id) {
        const assignRes = await client.query(
          `SELECT id, family_id, assignee_first_name, created_by_user_id, expires_at
           FROM assignment_links
           WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
          [sess.assignment_link_id]
        );
        if (assignRes.rows.length === 0) return;
        req.auth = {
          sessionId: sess.id,
          csrfToken: sess.csrf_token,
          kind: 'assignment',
          assignmentLink: assignRes.rows[0],
        };
      }
    });

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Enforces CSRF token verification on state-changing requests authenticated via cookies.
 */
export function requireCsrf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method.toUpperCase())) {
    next();
    return;
  }
  // If authenticated via cookie session, require matching X-CSRF-Token header
  if (req.cookies?.[SESSION_COOKIE_NAME] && req.auth) {
    const headerToken = req.headers['x-csrf-token'];
    if (!headerToken || headerToken !== req.auth.csrfToken) {
      res.status(403).json({ error: 'Invalid or missing CSRF token' });
      return;
    }
  }
  next();
}

export function requireInstanceAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth || req.auth.kind !== 'instance_admin') {
    res.status(403).json({ error: 'Instance admin access required' });
    return;
  }
  next();
}

export function requirePreMfaUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth || req.auth.kind !== 'user' || !req.auth.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Requires a fully authenticated user who has completed MFA (TOTP, Passkey, or verified Google Sign-In).
 * Local accounts without 2FA or a Passkey enrolled are blocked from accessing family resources.
 */
export function requireAuthenticatedMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth || req.auth.kind !== 'user' || !req.auth.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!req.auth.user.mfa_enrolled) {
    res.status(403).json({
      error: 'Multi-factor authentication (Passkey or 2FA) enrollment and verification required',
      code: 'MFA_REQUIRED',
    });
    return;
  }
  next();
}

/**
 * Verifies the user (or guest/assignment link) has access to `:familyId`.
 * IMPORTANT: Requests for another family's data return 404 Not Found (`{ error: 'Not found' }`)
 * so they are indistinguishable from requests for non-existent resources.
 */
export function requireFamilyAccess(allowedRoles?: FamilyRole[], allowGuest = false) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const familyId = req.params.familyId;
    if (!familyId || !/^[0-9a-fA-F-]{36}$/.test(familyId)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Instance admin MUST NEVER read family content
    if (req.auth.kind === 'instance_admin') {
      res.status(403).json({ error: 'Instance admin cannot access family content' });
      return;
    }

    if (req.auth.kind === 'guest' && allowGuest && req.auth.guestLink) {
      if (req.auth.guestLink.family_id !== familyId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      next();
      return;
    }

    if (req.auth.kind !== 'user' || !req.auth.user) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!req.auth.user.mfa_enrolled) {
      res.status(403).json({
        error: 'Multi-factor authentication (Passkey or 2FA) enrollment and verification required',
        code: 'MFA_REQUIRED',
      });
      return;
    }

    const membership = req.auth.memberships?.find((m) => m.family_id === familyId);
    if (!membership) {
      // Cross-tenant isolation: return 404 Not Found identical to missing resources
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (allowedRoles && !allowedRoles.includes(membership.role)) {
      res.status(403).json({ error: 'Insufficient role permissions in this family' });
      return;
    }

    next();
  };
}
