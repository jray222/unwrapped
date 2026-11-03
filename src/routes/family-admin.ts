import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { withFamilyContext, recordAuditLog } from '../db/index.js';
import { generateToken, hashToken } from '../security/crypto.js';
import { requireFamilyAccess, requireCsrf } from '../security/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/families/:familyId/members
 * Lists members of the family.
 * GUESTS: see ONLY { id, first_name } to protect family privacy.
 * MEMBERS/ADMINS: see { id, first_name, last_name, email, role }.
 */
router.get(
  '/members',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const isGuest = req.auth?.kind === 'guest';

      const members = await withFamilyContext(familyId, async (client) => {
        if (isGuest) {
          const result = await client.query(
            `SELECT u.id, u.first_name
             FROM family_members fm
             JOIN users u ON u.id = fm.user_id
             WHERE fm.family_id = $1
             ORDER BY u.first_name ASC`,
            [familyId]
          );
          return result.rows;
        }

        const result = await client.query(
          `SELECT u.id, u.first_name, u.last_name, u.email, fm.role, fm.created_at
           FROM family_members fm
           JOIN users u ON u.id = fm.user_id
           WHERE fm.family_id = $1
           ORDER BY fm.created_at ASC`,
          [familyId]
        );
        return result.rows;
      });

      res.json({ members });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/families/:familyId/members/:userId/role
 * Changes a family member's role (family_admin or member).
 */
router.patch(
  '/members/:userId/role',
  requireFamilyAccess(['family_admin']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { familyId, userId } = req.params;
      const { role } = req.body || {};

      if (!['family_admin', 'member'].includes(role)) {
        res.status(400).json({ error: 'Role must be either family_admin or member' });
        return;
      }

      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const updated = await withFamilyContext(familyId, async (client) => {
        const result = await client.query(
          `UPDATE family_members
           SET role = $1
           WHERE user_id = $2 AND family_id = $3`,
          [role, userId, familyId]
        );

        if (result.rowCount === 0) {
          return false;
        }

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'MEMBER_ROLE_CHANGED',
          metadata: { targetUserId: userId, newRole: role },
        });

        return true;
      });

      if (!updated) {
        res.status(404).json({ error: 'Member not found in family' });
        return;
      }

      res.json({ success: true, role });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/invites
 * Creates a single-use 7-day invite link for a new member or family admin.
 */
router.post(
  '/invites',
  requireFamilyAccess(['family_admin']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const { email, role } = req.body || {};

      if (!email || typeof email !== 'string' || !email.trim()) {
        res.status(400).json({ error: 'Email is required' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      const inviteRole = role === 'family_admin' ? 'family_admin' : 'member';
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const rawToken = generateToken(32);
      const tokenHash = hashToken(rawToken);
      const inviteId = randomUUID();
      const expiresAt = new Date(Date.now() + config.inviteExpiryDays * 24 * 60 * 60 * 1000);

      await withFamilyContext(familyId, async (client) => {
        await client.query(
          `INSERT INTO invites (id, family_id, email, role, token_hash, invited_by_user_id, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [inviteId, familyId, normalizedEmail, inviteRole, tokenHash, currentUser.id, expiresAt]
        );

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'INVITE_CREATED',
          metadata: { email: normalizedEmail, role: inviteRole },
        });
      });

      res.status(201).json({
        inviteId,
        email: normalizedEmail,
        role: inviteRole,
        expiresAt: expiresAt.toISOString(),
        inviteToken: rawToken,
        inviteUrl: `/invite/${rawToken}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/families/:familyId/invites
 * Lists pending/used invites for this family (without raw tokens).
 */
router.get(
  '/invites',
  requireFamilyAccess(['family_admin']),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;

      const invites = await withFamilyContext(familyId, async (client) => {
        const result = await client.query(
          `SELECT id, email, role, is_assisted_enrollment, expires_at, used_at, created_at
           FROM invites
           WHERE family_id = $1
           ORDER BY created_at DESC`,
          [familyId]
        );
        return result.rows;
      });

      res.json({ invites });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/assisted-enrollment
 * Generates an assisted enrollment link + QR code for a non-technical relative.
 */
router.post(
  '/assisted-enrollment',
  requireFamilyAccess(['family_admin']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const { email, firstName, lastName } = req.body || {};

      if (!email || !firstName) {
        res.status(400).json({ error: 'Email and first name are required' });
        return;
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const trimmedFirst = String(firstName).trim();
      const trimmedLast = String(lastName || '').trim();
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const rawToken = generateToken(32);
      const tokenHash = hashToken(rawToken);
      const inviteId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await withFamilyContext(familyId, async (client) => {
        // Locate or create user
        const uRes = await client.query(`SELECT id FROM users WHERE email = $1`, [normalizedEmail]);
        let targetUserId: string;

        if (uRes.rows.length > 0) {
          targetUserId = uRes.rows[0].id;
        } else {
          targetUserId = randomUUID();
          await client.query(
            `INSERT INTO users (id, email, first_name, last_name, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [targetUserId, normalizedEmail, trimmedFirst, trimmedLast]
          );
        }

        // Ensure family membership
        await client.query(
          `INSERT INTO family_members (id, family_id, user_id, role, created_at)
           VALUES ($1, $2, $3, 'member', NOW())
           ON CONFLICT (family_id, user_id) DO NOTHING`,
          [randomUUID(), familyId, targetUserId]
        );

        // Insert assisted invite
        await client.query(
          `INSERT INTO invites (
             id, family_id, email, role, token_hash, invited_by_user_id,
             is_assisted_enrollment, target_user_id, expires_at, created_at
           ) VALUES ($1, $2, $3, 'member', $4, $5, TRUE, $6, $7, NOW())`,
          [inviteId, familyId, normalizedEmail, tokenHash, currentUser.id, targetUserId, expiresAt]
        );

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'ASSISTED_ENROLLMENT_ISSUED',
          metadata: { email: normalizedEmail, targetUserId },
        });
      });

      const assistedUrl = `/assisted/${rawToken}`;
      const fullUrl = `${config.origin}${assistedUrl}`;
      const qrCodeDataUrl = await QRCode.toDataURL(fullUrl);

      res.status(201).json({
        token: rawToken,
        assistedUrl,
        qrCodeDataUrl,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/guest-links
 * Creates a guest link with a maximum 365-day lifetime, SMS href, and QR code.
 */
router.post(
  '/guest-links',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const { guestFirstName, allowedListIds, expiresInDays } = req.body || {};

      if (!guestFirstName || typeof guestFirstName !== 'string' || !guestFirstName.trim()) {
        res.status(400).json({ error: 'Guest first name is required' });
        return;
      }

      if (expiresInDays !== undefined && expiresInDays > 365) {
        res.status(400).json({ error: 'Guest link expiry cannot exceed 365 days' });
        return;
      }

      const days = Math.min(Number(expiresInDays) || 90, config.maxGuestLinkDays);
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const trimmedFirst = guestFirstName.trim();
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const rawToken = generateToken(32);
      const tokenHash = hashToken(rawToken);
      const linkId = randomUUID();
      const shareUrl = `/g/${rawToken}`;
      const fullUrl = `${config.origin}${shareUrl}`;
      const qrCodeDataUrl = await QRCode.toDataURL(fullUrl);
      const smsHref = `sms:?&body=${encodeURIComponent('Here is your wish list link: ' + fullUrl)}`;

      const allowedListsJson =
        Array.isArray(allowedListIds) && allowedListIds.length > 0
          ? JSON.stringify(allowedListIds)
          : null;

      await withFamilyContext(familyId, async (client) => {
        await client.query(
          `INSERT INTO guest_links (
             id, family_id, token_hash, guest_first_name, allowed_list_ids,
             created_by_user_id, expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [linkId, familyId, tokenHash, trimmedFirst, allowedListsJson, currentUser.id, expiresAt]
        );

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'GUEST_LINK_CREATED',
          metadata: { guestFirstName: trimmedFirst, guestLinkId: linkId },
        });
      });

      res.status(201).json({
        id: linkId,
        guestFirstName: trimmedFirst,
        expiresAt: expiresAt.toISOString(),
        token: rawToken,
        shareUrl,
        smsHref,
        qrCodeDataUrl,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/families/:familyId/guest-links
 * Lists all guest links created for this family.
 */
router.get(
  '/guest-links',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;

      const guestLinks = await withFamilyContext(familyId, async (client) => {
        const result = await client.query(
          `SELECT id, guest_first_name, allowed_list_ids, created_by_user_id,
                  revoked_at, expires_at, created_at
           FROM guest_links
           WHERE family_id = $1
           ORDER BY created_at DESC`,
          [familyId]
        );
        return result.rows;
      });

      res.json({ guestLinks });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/guest-links/:linkId/revoke
 * One-tap revocation of a guest link and termination of all associated active sessions.
 */
router.post(
  '/guest-links/:linkId/revoke',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { familyId, linkId } = req.params;
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const revoked = await withFamilyContext(familyId, async (client) => {
        const result = await client.query(
          `UPDATE guest_links
           SET revoked_at = NOW()
           WHERE id = $1 AND family_id = $2`,
          [linkId, familyId]
        );

        if (result.rowCount === 0) return false;

        // Delete active sessions for this guest link
        await client.query('DELETE FROM sessions WHERE guest_link_id = $1', [linkId]);

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'GUEST_LINK_REVOKED',
          metadata: { guestLinkId: linkId },
        });

        return true;
      });

      if (!revoked) {
        res.status(404).json({ error: 'Guest link not found' });
        return;
      }

      res.json({ success: true, message: 'Guest link revoked' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/assignment-links
 * Creates an assignment link for delegating an item claim.
 */
router.post(
  '/assignment-links',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const { assigneeFirstName, expiresInDays } = req.body || {};

      if (
        !assigneeFirstName ||
        typeof assigneeFirstName !== 'string' ||
        !assigneeFirstName.trim()
      ) {
        res.status(400).json({ error: 'Assignee first name is required' });
        return;
      }

      if (expiresInDays !== undefined && expiresInDays > 365) {
        res.status(400).json({ error: 'Assignment link expiry cannot exceed 365 days' });
        return;
      }

      const days = Math.min(Number(expiresInDays) || 90, config.maxGuestLinkDays);
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const trimmedFirst = assigneeFirstName.trim();
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const rawToken = generateToken(32);
      const tokenHash = hashToken(rawToken);
      const linkId = randomUUID();
      const shareUrl = `/a/${rawToken}`;
      const fullUrl = `${config.origin}${shareUrl}`;
      const qrCodeDataUrl = await QRCode.toDataURL(fullUrl);

      await withFamilyContext(familyId, async (client) => {
        await client.query(
          `INSERT INTO assignment_links (
             id, family_id, token_hash, assignee_first_name, created_by_user_id,
             expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [linkId, familyId, tokenHash, trimmedFirst, currentUser.id, expiresAt]
        );

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'ASSIGNMENT_LINK_CREATED',
          metadata: { assigneeFirstName: trimmedFirst, assignmentLinkId: linkId },
        });
      });

      res.status(201).json({
        id: linkId,
        assigneeFirstName: trimmedFirst,
        expiresAt: expiresAt.toISOString(),
        token: rawToken,
        shareUrl,
        qrCodeDataUrl,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/families/:familyId/assignment-links/:linkId/revoke
 * Revokes an assignment link and destroys any active sessions.
 */
router.post(
  '/assignment-links/:linkId/revoke',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { familyId, linkId } = req.params;
      const currentUser = req.auth!.user!;
      const actorLabel = `${currentUser.first_name} ${currentUser.last_name}`.trim();

      const revoked = await withFamilyContext(familyId, async (client) => {
        const result = await client.query(
          `UPDATE assignment_links
           SET revoked_at = NOW()
           WHERE id = $1 AND family_id = $2`,
          [linkId, familyId]
        );

        if (result.rowCount === 0) return false;

        // Delete active sessions for this assignment link
        await client.query('DELETE FROM sessions WHERE assignment_link_id = $1', [linkId]);

        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel,
          action: 'ASSIGNMENT_LINK_REVOKED',
          metadata: { assignmentLinkId: linkId },
        });

        return true;
      });

      if (!revoked) {
        res.status(404).json({ error: 'Assignment link not found' });
        return;
      }

      res.json({ success: true, message: 'Assignment link revoked' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/families/:familyId/audit-logs
 * Lists audit logs for the family.
 * SURPRISE RULE ENFORCEMENT:
 * Filters out all rows where is_surprise_sensitive = true AND target_recipient_user_id = req.auth.user.id
 * (unless the target list has thank_you_revealed = true), ensuring even a Family Admin
 * cannot learn who claimed/pledged/assigned items on their own wish list!
 */
router.get(
  '/audit-logs',
  requireFamilyAccess(['family_admin']),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const familyId = req.params.familyId;
      const currentUserId = req.auth!.user!.id;

      const filteredLogs = await withFamilyContext(familyId, async (client) => {
        const logsRes = await client.query(
          `SELECT id, family_id, actor_user_id, actor_label, action,
                  target_recipient_user_id, is_surprise_sensitive, metadata, created_at
           FROM audit_logs
           WHERE family_id = $1
           ORDER BY created_at DESC`,
          [familyId]
        );

        // Fetch lists that have thank_you_revealed = true
        const revealedListsRes = await client.query(
          `SELECT id FROM lists WHERE family_id = $1 AND thank_you_revealed = TRUE`,
          [familyId]
        );
        const revealedListIds = new Set(revealedListsRes.rows.map((r) => r.id));

        return logsRes.rows.filter((log) => {
          // If not surprise sensitive, always include
          if (!log.is_surprise_sensitive) return true;

          // If the target recipient is NOT the current viewing user, include
          if (log.target_recipient_user_id !== currentUserId) return true;

          // The target recipient is the viewing user!
          // Check if the list has thank_you_revealed = true
          const listId = log.metadata?.list_id;
          if (listId && revealedListIds.has(listId)) {
            return true;
          }

          // Otherwise, strictly suppress to protect the surprise!
          return false;
        });
      });

      res.json({ auditLogs: filteredLogs });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
