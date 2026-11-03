import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { withInstanceAdminContext, withSystemContext } from '../db/index.js';
import { generateToken, hashToken } from '../security/crypto.js';
import {
  requireInstanceAdmin,
  requireCsrf,
  setSessionCookie,
  authRateLimiter,
} from '../security/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

/**
 * POST /api/instance-admin/login
 * Verifies bootstrap instance admin token and creates an instance_admin session.
 */
router.post('/login', authRateLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || token !== config.bootstrapInstanceAdminToken) {
      res.status(401).json({ error: 'Invalid instance admin token' });
      return;
    }

    const rawSessionToken = generateToken(32);
    const csrfToken = generateToken(32);
    const tokenHash = hashToken(rawSessionToken);
    const sessionId = randomUUID();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + maxAgeMs);

    await withSystemContext(async (client) => {
      await client.query(
        `INSERT INTO sessions (id, token_hash, csrf_token, kind, expires_at, created_at)
         VALUES ($1, $2, $3, 'instance_admin', $4, NOW())`,
        [sessionId, tokenHash, csrfToken, expiresAt]
      );
    });

    setSessionCookie(res, rawSessionToken, maxAgeMs);

    res.json({
      sessionToken: rawSessionToken,
      csrfToken,
      kind: 'instance_admin',
    });
  } catch (err) {
    next(err);
  }
});

// All routes below require instance admin role and valid CSRF token on mutations
router.use(requireInstanceAdmin);
router.use(requireCsrf);

/**
 * GET /api/instance-admin/families
 * Lists all families using withInstanceAdminContext.
 */
router.get('/families', async (_req: AuthenticatedRequest, res, next) => {
  try {
    const families = await withInstanceAdminContext(async (client) => {
      const result = await client.query(
        `SELECT id, name, slug, created_at FROM families ORDER BY created_at DESC`
      );
      return result.rows;
    });

    res.json({ families });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/instance-admin/families
 * Creates a family and generates a single-use 7-day bootstrap invite for initial admin.
 */
router.post('/families', async (req: AuthenticatedRequest, res, next) => {
  try {
    const name = req.body?.name;
    const slug = req.body?.slug;
    const adminEmail = req.body?.adminEmail ?? req.body?.admin_email;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Family name is required' });
      return;
    }
    if (!adminEmail || typeof adminEmail !== 'string' || !adminEmail.trim()) {
      res.status(400).json({ error: 'Admin email is required' });
      return;
    }

    const familyName = name.trim();
    const email = adminEmail.trim().toLowerCase();

    // Generate or sanitize slug
    let rawSlug =
      slug && typeof slug === 'string' && slug.trim()
        ? slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
        : familyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (!rawSlug) {
      rawSlug = `family-${generateToken(4).toLowerCase()}`;
    }

    const familyId = randomUUID();
    const rawInviteToken = generateToken(32);
    const inviteTokenHash = hashToken(rawInviteToken);
    const inviteId = randomUUID();
    const inviteExpiresAt = new Date(Date.now() + config.inviteExpiryDays * 24 * 60 * 60 * 1000);

    await withInstanceAdminContext(async (client) => {
      // Check slug uniqueness
      const existing = await client.query('SELECT id FROM families WHERE slug = $1', [rawSlug]);
      if (existing.rows.length > 0) {
        throw { status: 409, message: 'Family slug already exists' };
      }

      await client.query(
        `INSERT INTO families (id, name, slug, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [familyId, familyName, rawSlug]
      );

      await client.query(
        `INSERT INTO invites (id, family_id, email, role, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, 'family_admin', $4, $5, NOW())`,
        [inviteId, familyId, email, inviteTokenHash, inviteExpiresAt]
      );
    });

    res.status(201).json({
      family: {
        id: familyId,
        name: familyName,
        slug: rawSlug,
      },
      bootstrapInviteToken: rawInviteToken,
      inviteUrl: `/invite/${rawInviteToken}`,
    });
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * DELETE /api/instance-admin/families/:familyId
 * Deletes a family by ID.
 */
router.delete('/families/:familyId', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { familyId } = req.params;
    if (!familyId || !/^[0-9a-fA-F-]{36}$/.test(familyId)) {
      res.status(404).json({ error: 'Family not found' });
      return;
    }

    const deleted = await withInstanceAdminContext(async (client) => {
      const result = await client.query('DELETE FROM families WHERE id = $1', [familyId]);
      return result.rowCount > 0;
    });

    if (!deleted) {
      res.status(404).json({ error: 'Family not found' });
      return;
    }

    res.json({ success: true, message: 'Family deleted successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/instance-admin/attempt-read-content
 * Verification endpoint: confirms PostgreSQL RLS and role permissions deny
 * app_instance_admin from reading any family content (lists table).
 */
router.get('/attempt-read-content', async (_req: AuthenticatedRequest, res) => {
  try {
    await withInstanceAdminContext(async (client) => {
      await client.query('SELECT * FROM lists LIMIT 1');
    });
    // If query succeeded, this is an invariant violation!
    res.status(500).json({
      error: 'Security breach: instance admin should not have access to lists',
    });
  } catch (err: any) {
    // Expected PostgreSQL denial (42501 permission denied)
    res.status(403).json({
      error: 'Access denied by database policy',
      details: err.message,
    });
  }
});

export default router;
