import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Response, NextFunction } from 'express';
import { config } from '../config.js';
import type { AuthenticatedRequest } from '../types.js';
import { withFamilyContext, withSystemContext, recordAuditLog } from '../db/index.js';
import {
  requireFamilyAccess,
  requireCsrf,
} from '../security/middleware.js';
import {
  extractFirstName,
  serializeItem,
  type RawItemRow,
  type RawClaimRow,
  type RawPledgeRow,
  type RawAssignmentRow,
} from '../security/surprise.js';
import {
  generateShoppingCardPdf,
  generateShoppingCardPng,
  type ShoppingCardParams,
  type ShoppingCardItem,
} from '../services/shopping-card.js';

interface DbClaimRow extends RawClaimRow {
  list_id: string;
  family_id: string;
}

const router = Router();

/**
 * POST /families/:familyId/items/:itemId/store-click
 * Store click confirmation prompt. Prompts "Buy anyway?" if taken, or "Are you getting this?".
 */
router.post(
  '/families/:familyId/items/:itemId/store-click',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, itemId } = req.params;

      const clickInfo = await withFamilyContext(familyId, async (client) => {
        const itemRes = await client.query<RawItemRow>(
          `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
          [itemId, familyId]
        );
        if (itemRes.rows.length === 0) return null;
        const item = itemRes.rows[0];

        const claimSumRes = await client.query(
          `SELECT COALESCE(SUM(quantity), 0)::int as sum FROM claims WHERE item_id = $1`,
          [itemId]
        );
        const pledgeSumRes = await client.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::int as sum FROM pledges WHERE item_id = $1`,
          [itemId]
        );

        const claimedCount = claimSumRes.rows[0].sum;
        const pledgedCents = pledgeSumRes.rows[0].sum;
        const isFullyPledged = Boolean(
          item.price_cents && item.price_cents > 0 && pledgedCents >= item.price_cents
        );
        const isTaken =
          !item.allow_duplicates &&
          !item.is_catch_all &&
          (claimedCount >= item.quantity || isFullyPledged);

        return {
          storeUrl: item.store_url,
          promptType: isTaken ? 'BUY_ANYWAY_CONFIRM' : 'ARE_YOU_GETTING_THIS',
          message: isTaken
            ? 'This item is already claimed. Buy anyway?'
            : 'Are you getting this?',
        };
      });

      if (!clickInfo) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.json(clickInfo);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /families/:familyId/items/:itemId/claim
 * Claim an item. Critical Surprise Rule: Recipient claiming check MUST happen before claimed check.
 */
router.post(
  '/families/:familyId/items/:itemId/claim',
  requireFamilyAccess(['family_admin', 'member'], true),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, itemId } = req.params;

      const claim = await withFamilyContext(familyId, async (client) => {
        const itemRes = await client.query<RawItemRow>(
          `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
          [itemId, familyId]
        );
        if (itemRes.rows.length === 0) return null;
        const item = itemRes.rows[0];

        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [item.list_id, familyId]
        );
        if (listRes.rows.length === 0) return null;
        const list = listRes.rows[0];

        // CRITICAL SURPRISE RULE: Recipient cannot claim items on their own wish list
        if (req.auth?.user && list.recipient_user_id === req.auth.user.id) {
          const forbiddenErr = new Error('Cannot claim items on your own wish list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        // Guest list restriction check
        if (
          req.auth?.kind === 'guest' &&
          req.auth.guestLink?.allowed_list_ids &&
          req.auth.guestLink.allowed_list_ids.length > 0 &&
          !req.auth.guestLink.allowed_list_ids.includes(list.id)
        ) {
          return null;
        }

        const quantity = Math.max(1, parseInt(String(req.body.quantity), 10) || 1);

        if (!item.allow_duplicates && !item.is_catch_all) {
          const claimCountRes = await client.query(
            `SELECT COALESCE(SUM(quantity), 0)::int as count FROM claims WHERE item_id = $1`,
            [itemId]
          );
          const currentClaimed = claimCountRes.rows[0].count;
          if (currentClaimed + quantity > item.quantity) {
            const conflictErr = new Error('Item is already claimed');
            (conflictErr as any).status = 409;
            throw conflictErr;
          }
        }

        let claimerUserId: string | null = null;
        let claimerGuestLinkId: string | null = null;
        let claimerFirstName = 'Someone';

        if (req.auth?.kind === 'user' && req.auth.user) {
          claimerUserId = req.auth.user.id;
          claimerFirstName = extractFirstName(req.auth.user.first_name);
        } else if (req.auth?.kind === 'guest' && req.auth.guestLink) {
          claimerGuestLinkId = req.auth.guestLink.id;
          claimerFirstName = extractFirstName(req.auth.guestLink.guest_first_name);
        }

        const claimId = randomUUID();
        const bought = Boolean(req.body.bought);

        const insertRes = await client.query<RawClaimRow>(
          `INSERT INTO claims (
            id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
            assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, false, NOW())
          RETURNING *`,
          [
            claimId,
            familyId,
            list.id,
            itemId,
            claimerUserId,
            claimerGuestLinkId,
            claimerFirstName,
            quantity,
            bought,
          ]
        );

        await recordAuditLog(client, {
          familyId,
          actorUserId: claimerUserId,
          actorLabel: claimerFirstName,
          action: 'ITEM_CLAIMED',
          targetRecipientUserId: list.recipient_user_id,
          isSurpriseSensitive: true,
          metadata: { itemId, listId: list.id, quantity, bought },
        });

        return insertRes.rows[0];
      });

      if (!claim) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(201).json({ claim });
    } catch (err: any) {
      if (err.status === 403 || err.status === 409) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /families/:familyId/claims/:claimId/release
 * Release (delete) an existing claim.
 */
const releaseClaimHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    let { familyId, claimId } = req.params;

    if (!familyId && claimId) {
      await withSystemContext(async (sysClient) => {
        const cRes = await sysClient.query('SELECT family_id FROM claims WHERE id = $1', [claimId]);
        if (cRes.rows.length > 0) familyId = cRes.rows[0].family_id;
      });
    }

    if (!familyId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const released = await withFamilyContext(familyId, async (client) => {
      const claimRes = await client.query<DbClaimRow>(
        `SELECT * FROM claims WHERE id = $1 AND family_id = $2`,
        [claimId, familyId]
      );
      if (claimRes.rows.length === 0) return null;
      const claim = claimRes.rows[0];

      const listRes = await client.query(
        `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
        [claim.list_id, familyId]
      );
      if (listRes.rows.length === 0) return null;
      const list = listRes.rows[0];

      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );
      const isOwnerUser =
        req.auth?.kind === 'user' && req.auth.user && claim.claimer_user_id === req.auth.user.id;
      const isOwnerGuest =
        req.auth?.kind === 'guest' &&
        req.auth.guestLink &&
        claim.claimer_guest_link_id === req.auth.guestLink.id;

      if (!isFamilyAdmin && !isOwnerUser && !isOwnerGuest) {
        const forbiddenErr = new Error('Not authorized to release this claim');
        (forbiddenErr as any).status = 403;
        throw forbiddenErr;
      }

      if (claim.assignment_id) {
        await client.query(
          `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1`,
          [claim.assignment_id]
        );
      }

      await client.query(`DELETE FROM claims WHERE id = $1`, [claimId]);

      const actorLabel =
        req.auth?.kind === 'user' && req.auth.user
          ? extractFirstName(req.auth.user.first_name)
          : req.auth?.kind === 'guest' && req.auth.guestLink
            ? extractFirstName(req.auth.guestLink.guest_first_name)
            : 'Someone';

      await recordAuditLog(client, {
        familyId,
        actorUserId: req.auth?.user?.id ?? null,
        actorLabel,
        action: 'ITEM_RELEASED',
        targetRecipientUserId: list.recipient_user_id,
        isSurpriseSensitive: true,
        metadata: { claimId, itemId: claim.item_id },
      });

      return true;
    });

    if (!released) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({ released: true });
  } catch (err: any) {
    if (err.status === 403) {
      res.status(403).json({ error: err.message });
      return;
    }
    next(err);
  }
};

router.post(
  '/families/:familyId/claims/:claimId/release',
  requireFamilyAccess(['family_admin', 'member'], true),
  requireCsrf,
  releaseClaimHandler
);
router.delete(
  '/families/:familyId/claims/:claimId',
  requireFamilyAccess(['family_admin', 'member'], true),
  requireCsrf,
  releaseClaimHandler
);
router.delete(
  '/claims/:claimId',
  requireCsrf,
  releaseClaimHandler
);

/**
 * PATCH /families/:familyId/claims/:claimId
 * Update bought status on a claim.
 */
router.patch(
  '/families/:familyId/claims/:claimId',
  requireFamilyAccess(['family_admin', 'member'], true),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, claimId } = req.params;
      const bought = Boolean(req.body.bought);

      const claim = await withFamilyContext(familyId, async (client) => {
        const claimRes = await client.query<DbClaimRow>(
          `SELECT * FROM claims WHERE id = $1 AND family_id = $2`,
          [claimId, familyId]
        );
        if (claimRes.rows.length === 0) return null;
        const c = claimRes.rows[0];

        const isFamilyAdmin = req.auth?.memberships?.some(
          (m) => m.family_id === familyId && m.role === 'family_admin'
        );
        const isOwnerUser =
          req.auth?.kind === 'user' && req.auth.user && c.claimer_user_id === req.auth.user.id;
        const isOwnerGuest =
          req.auth?.kind === 'guest' &&
          req.auth.guestLink &&
          c.claimer_guest_link_id === req.auth.guestLink.id;

        if (!isFamilyAdmin && !isOwnerUser && !isOwnerGuest) {
          const forbiddenErr = new Error('Not authorized to update this claim');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        const updRes = await client.query<RawClaimRow>(
          `UPDATE claims SET bought = $1 WHERE id = $2 RETURNING *`,
          [bought, claimId]
        );

        if (c.assignment_id) {
          await client.query(
            `UPDATE assignments SET status = $1, updated_at = NOW() WHERE id = $2`,
            [bought ? 'bought' : 'assigned', c.assignment_id]
          );
        }

        return updRes.rows[0];
      });

      if (!claim) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ claim });
    } catch (err: any) {
      if (err.status === 403) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /families/:familyId/items/:itemId/pledge
 * Group gifting pledge. Critical Surprise Rule: Recipient cannot pledge toward own wish list.
 */
router.post(
  '/families/:familyId/items/:itemId/pledge',
  requireFamilyAccess(['family_admin', 'member'], true),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, itemId } = req.params;
      const rawAmount = req.body?.amountCents ?? req.body?.amount_cents;
      const amountCents = parseInt(String(rawAmount), 10);

      if (isNaN(amountCents) || amountCents <= 0) {
        res.status(400).json({ error: 'Valid amount in cents is required' });
        return;
      }

      const result = await withFamilyContext(familyId, async (client) => {
        const itemRes = await client.query<RawItemRow>(
          `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
          [itemId, familyId]
        );
        if (itemRes.rows.length === 0) return null;
        const item = itemRes.rows[0];

        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [item.list_id, familyId]
        );
        if (listRes.rows.length === 0) return null;
        const list = listRes.rows[0];

        // CRITICAL SURPRISE RULE: Recipient cannot pledge toward items on their own wish list
        if (req.auth?.user && list.recipient_user_id === req.auth.user.id) {
          const forbiddenErr = new Error('Cannot pledge toward items on your own wish list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        let pledgerUserId: string | null = null;
        let pledgerGuestLinkId: string | null = null;
        let pledgerFirstName = 'Someone';

        if (req.auth?.kind === 'user' && req.auth.user) {
          pledgerUserId = req.auth.user.id;
          pledgerFirstName = extractFirstName(req.auth.user.first_name);
        } else if (req.auth?.kind === 'guest' && req.auth.guestLink) {
          pledgerGuestLinkId = req.auth.guestLink.id;
          pledgerFirstName = extractFirstName(req.auth.guestLink.guest_first_name);
        }

        const pledgeId = randomUUID();
        const note = req.body.note ? String(req.body.note).trim() : '';

        const insertRes = await client.query<RawPledgeRow>(
          `INSERT INTO pledges (
            id, family_id, list_id, item_id, pledger_user_id, pledger_guest_link_id,
            pledger_first_name, amount_cents, note, thank_you_sent, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW())
          RETURNING *`,
          [
            pledgeId,
            familyId,
            list.id,
            itemId,
            pledgerUserId,
            pledgerGuestLinkId,
            pledgerFirstName,
            amountCents,
            note,
          ]
        );

        const sumRes = await client.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::int as total FROM pledges WHERE item_id = $1`,
          [itemId]
        );
        const totalPledgedCents = sumRes.rows[0].total;

        await recordAuditLog(client, {
          familyId,
          actorUserId: pledgerUserId,
          actorLabel: pledgerFirstName,
          action: 'ITEM_PLEDGED',
          targetRecipientUserId: list.recipient_user_id,
          isSurpriseSensitive: true,
          metadata: { itemId, listId: list.id, amountCents, note },
        });

        return {
          pledge: insertRes.rows[0],
          totalPledgedCents,
          priceCents: item.price_cents,
        };
      });

      if (!result) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(201).json(result);
    } catch (err: any) {
      if (err.status === 403) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /families/:familyId/assignments
 * Assign one or more items to a giver (e.g. Grandma/Grandpa) and immediately create linked claims.
 */
router.post(
  '/families/:familyId/assignments',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const itemIds = req.body?.itemIds ?? req.body?.item_ids;
      const assigneeFirstName = req.body?.assigneeFirstName ?? req.body?.assignee_first_name;
      const assignmentLinkId = req.body?.assignmentLinkId ?? req.body?.assignment_link_id;

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        res.status(400).json({ error: 'itemIds array is required' });
        return;
      }

      if (!assigneeFirstName || typeof assigneeFirstName !== 'string' || !assigneeFirstName.trim()) {
        res.status(400).json({ error: 'assigneeFirstName is required' });
        return;
      }

      const cleanAssigneeName = extractFirstName(assigneeFirstName.trim());
      const currentUser = req.auth!.user!;

      const createdAssignments = await withFamilyContext(familyId, async (client) => {
        const assignmentsOut: RawAssignmentRow[] = [];

        for (const itemId of itemIds) {
          const itemRes = await client.query<RawItemRow>(
            `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
            [itemId, familyId]
          );
          if (itemRes.rows.length === 0) continue;
          const item = itemRes.rows[0];

          const listRes = await client.query(
            `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
            [item.list_id, familyId]
          );
          if (listRes.rows.length === 0) continue;
          const list = listRes.rows[0];

          // Cannot assign items on own wish list
          if (list.recipient_user_id === currentUser.id) {
            const forbiddenErr = new Error('Cannot assign items on your own wish list');
            (forbiddenErr as any).status = 403;
            throw forbiddenErr;
          }

          const assignmentId = randomUUID();
          const assignRes = await client.query<RawAssignmentRow>(
            `INSERT INTO assignments (
              id, family_id, list_id, item_id, assigner_user_id, assignment_link_id,
              assignee_first_name, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'assigned', NOW(), NOW())
            RETURNING *`,
            [
              assignmentId,
              familyId,
              list.id,
              itemId,
              currentUser.id,
              assignmentLinkId || null,
              cleanAssigneeName,
            ]
          );

          // Immediately create linked claim in that person's name right away so no one else buys it
          const claimId = randomUUID();
          await client.query(
            `INSERT INTO claims (
              id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
              assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
            ) VALUES ($1, $2, $3, $4, $5, null, $6, $7, 1, false, false, NOW())`,
            [
              claimId,
              familyId,
              list.id,
              itemId,
              currentUser.id,
              assignmentId,
              cleanAssigneeName,
            ]
          );

          await recordAuditLog(client, {
            familyId,
            actorUserId: currentUser.id,
            actorLabel: extractFirstName(currentUser.first_name),
            action: 'ITEM_ASSIGNED',
            targetRecipientUserId: list.recipient_user_id,
            isSurpriseSensitive: true,
            metadata: { assignmentId, itemId, listId: list.id, assigneeFirstName: cleanAssigneeName },
          });

          assignmentsOut.push(assignRes.rows[0]);
        }

        return assignmentsOut;
      });

      res.status(201).json({ assignments: createdAssignments });
    } catch (err: any) {
      if (err.status === 403) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * PATCH /families/:familyId/assignments/:assignmentId
 * Update assignment status (e.g. bought or couldn't get it / reassign).
 */
const updateAssignmentHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    let { familyId, assignmentId } = req.params;
    if (!familyId && assignmentId) {
      await withSystemContext(async (sysClient) => {
        const aRes = await sysClient.query('SELECT family_id FROM assignments WHERE id = $1', [assignmentId]);
        if (aRes.rows.length > 0) familyId = aRes.rows[0].family_id;
      });
    }

    if (!familyId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const status = req.body?.status;
    const reassignToFirstName = req.body?.reassignToFirstName ?? req.body?.reassign_to_first_name;

    if (!status || !['assigned', 'bought', 'couldnt_get_it'].includes(status)) {
      res.status(400).json({ error: 'Valid status is required' });
      return;
    }

    const assignment = await withFamilyContext(familyId, async (client) => {
      const aRes = await client.query(
        `SELECT a.*, l.recipient_user_id
         FROM assignments a
         JOIN lists l ON l.id = a.list_id
         WHERE a.id = $1 AND a.family_id = $2`,
        [assignmentId, familyId]
      );
      if (aRes.rows.length === 0) return null;
      const assignRow = aRes.rows[0];

      let authorized = false;
      let actorLabel = 'Assignee';
      let actorUserId: string | null = null;

      if (req.auth!.kind === 'user' && req.auth!.user) {
        const isFamilyAdmin = req.auth!.memberships?.some(
          (m) => m.family_id === familyId && m.role === 'family_admin'
        );
        if (assignRow.assigner_user_id === req.auth!.user.id || isFamilyAdmin) {
          authorized = true;
          actorUserId = req.auth!.user.id;
          actorLabel = extractFirstName(req.auth!.user.first_name);
        }
      } else if (req.auth!.kind === 'assignment' && req.auth!.assignmentLink) {
        if (
          req.auth!.assignmentLink.family_id === familyId &&
          req.auth!.assignmentLink.id === assignRow.assignment_link_id
        ) {
          authorized = true;
          actorLabel = extractFirstName(req.auth!.assignmentLink.assignee_first_name);
        }
      }

      if (!authorized) {
        const forbiddenErr = new Error('Access denied');
        (forbiddenErr as any).status = 403;
        throw forbiddenErr;
      }

      let updatedAssignment: RawAssignmentRow;

      if (status === 'bought') {
        const updRes = await client.query<RawAssignmentRow>(
          `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [assignmentId]
        );
        updatedAssignment = updRes.rows[0];
        await client.query(`UPDATE claims SET bought = true WHERE assignment_id = $1`, [
          assignmentId,
        ]);
      } else if (status === 'couldnt_get_it') {
        if (reassignToFirstName && typeof reassignToFirstName === 'string' && reassignToFirstName.trim()) {
          const cleanName = extractFirstName(reassignToFirstName.trim());
          const updRes = await client.query<RawAssignmentRow>(
            `UPDATE assignments SET assignee_first_name = $1, status = 'assigned', updated_at = NOW() WHERE id = $2 RETURNING *`,
            [cleanName, assignmentId]
          );
          updatedAssignment = updRes.rows[0];
          await client.query(
            `UPDATE claims SET claimer_first_name = $1, bought = false WHERE assignment_id = $2`,
            [cleanName, assignmentId]
          );
        } else {
          const updRes = await client.query<RawAssignmentRow>(
            `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [assignmentId]
          );
          updatedAssignment = updRes.rows[0];
          // Immediately release linked claim back to available
          await client.query(`DELETE FROM claims WHERE assignment_id = $1`, [assignmentId]);
        }
      } else {
        // status === 'assigned'
        const updRes = await client.query<RawAssignmentRow>(
          `UPDATE assignments SET status = 'assigned', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [assignmentId]
        );
        updatedAssignment = updRes.rows[0];
        await client.query(`UPDATE claims SET bought = false WHERE assignment_id = $1`, [
          assignmentId,
        ]);
      }

      await recordAuditLog(client, {
        familyId,
        actorUserId,
        actorLabel,
        action: 'ASSIGNMENT_UPDATED',
        targetRecipientUserId: assignRow.recipient_user_id,
        isSurpriseSensitive: true,
        metadata: { assignmentId, status, reassignToFirstName },
      });

      return updatedAssignment;
    });

    if (!assignment) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({ assignment });
  } catch (err: any) {
    if (err.status === 403) {
      res.status(403).json({ error: err.message });
      return;
    }
    next(err);
  }
};

router.patch(
  '/families/:familyId/assignments/:assignmentId',
  requireCsrf,
  updateAssignmentHandler
);
router.put(
  '/families/:familyId/assignments/:assignmentId',
  requireCsrf,
  updateAssignmentHandler
);
router.put(
  '/families/:familyId/assignments/:assignmentId/status',
  requireCsrf,
  updateAssignmentHandler
);
router.put(
  '/assignments/:assignmentId/status',
  requireCsrf,
  updateAssignmentHandler
);

/**
 * GET /families/:familyId/assignments
 * Lists assignments created by the current user in this family.
 */
router.get(
  '/families/:familyId/assignments',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const currentUser = req.auth!.user!;

      const assignments = await withFamilyContext(familyId, async (client) => {
        const queryRes = await client.query(
          `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at, a.updated_at,
                  i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url, i.notes AS item_notes,
                  l.name AS list_name, l.event_date, l.recipient_first_name
           FROM assignments a
           JOIN items i ON i.id = a.item_id
           JOIN lists l ON l.id = a.list_id
           WHERE a.family_id = $1 AND a.assigner_user_id = $2
           ORDER BY a.created_at DESC`,
          [familyId, currentUser.id]
        );

        return queryRes.rows.map((r) => ({
          id: r.id,
          itemId: r.item_id,
          listId: r.list_id,
          name: r.item_name,
          itemName: r.item_name,
          storeUrl: r.store_url,
          storeName: r.store_name,
          priceCents: r.price_cents,
          imageUrl: r.image_url,
          notes: r.item_notes,
          status: r.status,
          listName: r.list_name,
          recipientFirstName: extractFirstName(r.recipient_first_name),
          assigneeFirstName: extractFirstName(r.assignee_first_name),
          eventDate: r.event_date,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
      });

      res.json({ assignments });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /families/:familyId/assignments/reminders
 * Upcoming assignment reminders for events within reminderDaysBeforeEvent.
 */
router.get(
  '/families/:familyId/assignments/reminders',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const currentUser = req.auth!.user!;

      const reminders = await withFamilyContext(familyId, async (client) => {
        const queryRes = await client.query(
          `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at,
                  i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url,
                  l.name AS list_name, l.event_date, l.recipient_first_name
           FROM assignments a
           JOIN items i ON i.id = a.item_id
           JOIN lists l ON l.id = a.list_id
           WHERE a.family_id = $1
             AND a.assigner_user_id = $2
             AND a.status = 'assigned'
             AND l.event_date IS NOT NULL
             AND l.event_date <= (CURRENT_DATE + ($3 || ' days')::interval)
           ORDER BY l.event_date ASC, a.created_at ASC`,
          [familyId, currentUser.id, String(config.reminderDaysBeforeEvent)]
        );

        return queryRes.rows.map((r) => ({
          ...r,
          recipient_first_name: extractFirstName(r.recipient_first_name),
          assignee_first_name: extractFirstName(r.assignee_first_name),
        }));
      });

      res.json({ reminders });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Helper to fetch items and context for shopping card generation.
 */
async function getShoppingCardData(
  familyId: string,
  assignmentIds: string[],
  itemIds: string[],
  fallbackAssigneeFirstName: string
): Promise<ShoppingCardParams | null> {
  return withFamilyContext(familyId, async (client) => {
    const famRes = await client.query('SELECT name FROM families WHERE id = $1', [familyId]);
    const familyName = famRes.rows.length > 0 ? famRes.rows[0].name : 'Family';

    if (assignmentIds.length > 0) {
      const assignsRes = await client.query(
        `SELECT a.id AS assignment_id, a.assignee_first_name,
                i.id AS item_id, i.name, i.store_name, i.price_cents, i.notes, i.priority, i.quantity,
                l.name AS list_name, l.event_date, l.recipient_first_name
         FROM assignments a
         JOIN items i ON i.id = a.item_id
         JOIN lists l ON l.id = a.list_id
         WHERE a.family_id = $1 AND a.id = ANY($2)
         ORDER BY a.created_at ASC`,
        [familyId, assignmentIds]
      );
      if (assignsRes.rows.length === 0) return null;

      const firstRow = assignsRes.rows[0];
      const items: ShoppingCardItem[] = assignsRes.rows.map((row) => ({
        name: row.name || 'Untitled Item',
        store_name: row.store_name || '',
        price_cents: row.price_cents ?? null,
        notes: row.notes || '',
        priority: row.priority || 'nice_to_have',
        quantity: row.quantity && row.quantity >= 1 ? row.quantity : 1,
      }));

      return {
        familyName,
        listName: firstRow.list_name || 'Wish List',
        assigneeFirstName: extractFirstName(firstRow.assignee_first_name || fallbackAssigneeFirstName),
        eventDate: firstRow.event_date ? String(firstRow.event_date).slice(0, 10) : null,
        items,
      };
    }

    if (itemIds.length > 0) {
      const itemsRes = await client.query(
        `SELECT i.id AS item_id, i.name, i.store_name, i.price_cents, i.notes, i.priority, i.quantity,
                l.name AS list_name, l.event_date, l.recipient_first_name
         FROM items i
         JOIN lists l ON l.id = i.list_id
         WHERE i.family_id = $1 AND i.id = ANY($2) AND i.deleted_by_recipient = false
         ORDER BY i.created_at ASC`,
        [familyId, itemIds]
      );
      if (itemsRes.rows.length === 0) return null;

      const firstRow = itemsRes.rows[0];
      const items: ShoppingCardItem[] = itemsRes.rows.map((row) => ({
        name: row.name || 'Untitled Item',
        store_name: row.store_name || '',
        price_cents: row.price_cents ?? null,
        notes: row.notes || '',
        priority: row.priority || 'nice_to_have',
        quantity: row.quantity && row.quantity >= 1 ? row.quantity : 1,
      }));

      return {
        familyName,
        listName: firstRow.list_name || 'Wish List',
        assigneeFirstName: extractFirstName(fallbackAssigneeFirstName || 'Family'),
        eventDate: firstRow.event_date ? String(firstRow.event_date).slice(0, 10) : null,
        items,
      };
    }

    return null;
  });
}

/**
 * GET /families/:familyId/shopping-card.pdf
 * Generates an offline printable PDF shopping card.
 */
router.get(
  '/families/:familyId/shopping-card.pdf',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const assignmentIds = req.query.assignmentIds
        ? String(req.query.assignmentIds).split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const itemIds = req.query.itemIds
        ? String(req.query.itemIds).split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const fallbackAssigneeFirstName = req.query.assigneeFirstName
        ? String(req.query.assigneeFirstName).trim()
        : 'Assignee';

      const cardParams = await getShoppingCardData(
        familyId,
        assignmentIds,
        itemIds,
        fallbackAssigneeFirstName
      );

      if (!cardParams) {
        res.status(404).json({ error: 'No items found for shopping card' });
        return;
      }

      const pdfBuffer = await generateShoppingCardPdf(cardParams);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="shopping-card.pdf"');
      res.send(pdfBuffer);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /families/:familyId/shopping-card.png
 * Generates an offline PNG shopping card.
 */
router.get(
  '/families/:familyId/shopping-card.png',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const assignmentIds = req.query.assignmentIds
        ? String(req.query.assignmentIds).split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const itemIds = req.query.itemIds
        ? String(req.query.itemIds).split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const fallbackAssigneeFirstName = req.query.assigneeFirstName
        ? String(req.query.assigneeFirstName).trim()
        : 'Assignee';

      const cardParams = await getShoppingCardData(
        familyId,
        assignmentIds,
        itemIds,
        fallbackAssigneeFirstName
      );

      if (!cardParams) {
        res.status(404).json({ error: 'No items found for shopping card' });
        return;
      }

      const pngBuffer = await generateShoppingCardPng(cardParams);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline; filename="shopping-card.png"');
      res.send(pngBuffer);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /guest/view
 * Dedicated view for guests. Returns allowed lists with only first names of givers.
 */
router.get(
  '/guest/view',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth || req.auth.kind !== 'guest' || !req.auth.guestLink) {
        res.status(401).json({ error: 'Guest session required' });
        return;
      }

      const {
        id: guestLinkId,
        family_id: familyId,
        guest_first_name: guestFirstName,
        allowed_list_ids: allowedListIds,
      } = req.auth.guestLink;

      const data = await withFamilyContext(familyId, async (client) => {
        const famRes = await client.query('SELECT name FROM families WHERE id = $1', [familyId]);
        const familyName = famRes.rows.length > 0 ? famRes.rows[0].name : 'Family';

        let listsSql = 'SELECT * FROM lists WHERE family_id = $1';
        const params: any[] = [familyId];

        if (Array.isArray(allowedListIds) && allowedListIds.length > 0) {
          listsSql += ' AND id = ANY($2)';
          params.push(allowedListIds);
        }
        listsSql += ' ORDER BY created_at ASC';

        const listsRes = await client.query(listsSql, params);
        const serializedLists = [];

        for (const list of listsRes.rows) {
          const itemsRes = await client.query<RawItemRow>(
            'SELECT * FROM items WHERE list_id = $1 AND deleted_by_recipient = false ORDER BY created_at ASC, id ASC',
            [list.id]
          );
          const claimsRes = await client.query<RawClaimRow>(
            'SELECT * FROM claims WHERE list_id = $1 ORDER BY created_at ASC',
            [list.id]
          );
          const pledgesRes = await client.query<RawPledgeRow>(
            'SELECT * FROM pledges WHERE list_id = $1 ORDER BY created_at ASC',
            [list.id]
          );
          const assignsRes = await client.query<RawAssignmentRow>(
            'SELECT * FROM assignments WHERE list_id = $1 ORDER BY created_at ASC',
            [list.id]
          );

          const serializedItems = itemsRes.rows.map((item) => {
            const itemClaims = claimsRes.rows.filter((c) => c.item_id === item.id);
            const itemPledges = pledgesRes.rows.filter((p) => p.item_id === item.id);
            const itemAssigns = assignsRes.rows.filter((a) => a.item_id === item.id);

            return serializeItem({
              item,
              claims: itemClaims,
              pledges: itemPledges,
              assignments: itemAssigns,
              surpriseProtected: false,
              viewerUserId: null,
              viewerGuestLinkId: guestLinkId,
            });
          });

          const availableItems = serializedItems.filter((i: any) => !i.is_taken);
          const alreadyTakenItems = serializedItems.filter((i: any) => Boolean(i.is_taken));

          serializedLists.push({
            ...list,
            recipient_first_name: extractFirstName(list.recipient_first_name),
            items: serializedItems,
            availableItems,
            alreadyTakenItems,
          });
        }

        return {
          guestFirstName: extractFirstName(guestFirstName),
          familyId,
          familyName,
          lists: serializedLists,
        };
      });

      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /assignment/view
 * Dedicated view for an assignment recipient using their assignment link.
 */
router.get(
  '/assignment/view',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth || req.auth.kind !== 'assignment' || !req.auth.assignmentLink) {
        res.status(401).json({ error: 'Assignment session required' });
        return;
      }

      const {
        id: assignmentLinkId,
        family_id: familyId,
        assignee_first_name: assigneeFirstName,
      } = req.auth.assignmentLink;

      const data = await withFamilyContext(familyId, async (client) => {
        const assignsRes = await client.query(
          `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at, a.updated_at,
                  i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url, i.notes AS item_notes,
                  l.name AS list_name, l.recipient_first_name, l.event_date
           FROM assignments a
           JOIN items i ON i.id = a.item_id
           JOIN lists l ON l.id = a.list_id
           WHERE a.family_id = $1 AND a.assignment_link_id = $2
           ORDER BY a.created_at ASC`,
          [familyId, assignmentLinkId]
        );

        const assignments = assignsRes.rows.map((row) => ({
          id: row.id,
          itemId: row.item_id,
          listId: row.list_id,
          name: row.item_name,
          itemName: row.item_name,
          storeUrl: row.store_url,
          storeName: row.store_name,
          priceCents: row.price_cents,
          imageUrl: row.image_url,
          notes: row.item_notes,
          status: row.status,
          listName: row.list_name,
          recipientFirstName: extractFirstName(row.recipient_first_name),
          eventDate: row.event_date,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        return {
          assigneeFirstName: extractFirstName(assigneeFirstName),
          familyId,
          assignments,
        };
      });

      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /families/:familyId/notifications
 * Retrieve notifications for the current user or guest link.
 */
router.get(
  '/families/:familyId/notifications',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;

      const notifications = await withFamilyContext(familyId, async (client) => {
        if (req.auth?.kind === 'user' && req.auth.user) {
          const nRes = await client.query(
            `SELECT * FROM notifications WHERE family_id = $1 AND target_user_id = $2 ORDER BY created_at DESC`,
            [familyId, req.auth.user.id]
          );
          return nRes.rows;
        } else if (req.auth?.kind === 'guest' && req.auth.guestLink) {
          const nRes = await client.query(
            `SELECT * FROM notifications WHERE family_id = $1 AND target_guest_link_id = $2 ORDER BY created_at DESC`,
            [familyId, req.auth.guestLink.id]
          );
          return nRes.rows;
        }
        return [];
      });

      res.json({ notifications });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /offline/sync
 * Queued offline synchronization for members, guests, and assignment links.
 */
router.post(
  '/offline/sync',
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
      const results: Array<{ type: string; success: boolean; error?: string }> = [];
      let syncedCount = 0;

      for (const action of actions) {
        try {
          if (!action || typeof action !== 'object') {
            results.push({ type: 'UNKNOWN', success: false, error: 'Invalid action payload' });
            continue;
          }

          if (action.type === 'MARK_BOUGHT') {
            if (action.claimId) {
              let fId = action.familyId;
              if (!fId) {
                await withSystemContext(async (sysClient) => {
                  const cRes = await sysClient.query('SELECT family_id FROM claims WHERE id = $1', [
                    action.claimId,
                  ]);
                  if (cRes.rows.length > 0) fId = cRes.rows[0].family_id;
                });
              }
              if (!fId) throw new Error('Claim not found or missing familyId');

              await withFamilyContext(fId, async (client) => {
                const cRes = await client.query<RawClaimRow>('SELECT * FROM claims WHERE id = $1', [
                  action.claimId,
                ]);
                if (cRes.rows.length === 0) throw new Error('Claim not found');
                const claim = cRes.rows[0];

                await client.query('UPDATE claims SET bought = true WHERE id = $1', [
                  action.claimId,
                ]);
                if (claim.assignment_id) {
                  await client.query(
                    `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
                    [claim.assignment_id]
                  );
                }
              });
              syncedCount++;
              results.push({ type: action.type, success: true });
            } else if (action.assignmentId) {
              let fId = action.familyId;
              if (!fId) {
                await withSystemContext(async (sysClient) => {
                  const aRes = await sysClient.query(
                    'SELECT family_id FROM assignments WHERE id = $1',
                    [action.assignmentId]
                  );
                  if (aRes.rows.length > 0) fId = aRes.rows[0].family_id;
                });
              }
              if (!fId) throw new Error('Assignment not found or missing familyId');

              await withFamilyContext(fId, async (client) => {
                await client.query(
                  `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
                  [action.assignmentId]
                );
                await client.query('UPDATE claims SET bought = true WHERE assignment_id = $1', [
                  action.assignmentId,
                ]);
              });
              syncedCount++;
              results.push({ type: action.type, success: true });
            } else {
              throw new Error('MARK_BOUGHT requires claimId or assignmentId');
            }
          } else if (action.type === 'CLAIM_ITEM') {
            const { itemId, familyId } = action;
            if (!itemId || !familyId) {
              throw new Error('CLAIM_ITEM requires itemId and familyId');
            }

            await withFamilyContext(familyId, async (client) => {
              const itemRes = await client.query<RawItemRow>(
                'SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false',
                [itemId, familyId]
              );
              if (itemRes.rows.length === 0) throw new Error('Item not found');
              const item = itemRes.rows[0];

              const listRes = await client.query(
                'SELECT * FROM lists WHERE id = $1 AND family_id = $2',
                [item.list_id, familyId]
              );
              if (listRes.rows.length === 0) throw new Error('List not found');
              const list = listRes.rows[0];

              if (req.auth?.user && list.recipient_user_id === req.auth.user.id) {
                throw new Error('Cannot claim items on your own wish list');
              }

              const quantity = Math.max(1, parseInt(String(action.quantity), 10) || 1);
              if (!item.allow_duplicates && !item.is_catch_all) {
                const claimSumRes = await client.query(
                  'SELECT COALESCE(SUM(quantity), 0)::int as count FROM claims WHERE item_id = $1',
                  [itemId]
                );
                if (claimSumRes.rows[0].count + quantity > item.quantity) {
                  throw new Error('Item is already claimed');
                }
              }

              let claimerUserId: string | null = null;
              let claimerGuestLinkId: string | null = null;
              let claimerFirstName = 'Someone';

              if (req.auth?.kind === 'user' && req.auth.user) {
                claimerUserId = req.auth.user.id;
                claimerFirstName = extractFirstName(req.auth.user.first_name);
              } else if (req.auth?.kind === 'guest' && req.auth.guestLink) {
                claimerGuestLinkId = req.auth.guestLink.id;
                claimerFirstName = extractFirstName(req.auth.guestLink.guest_first_name);
              }

              const claimId = randomUUID();
              await client.query(
                `INSERT INTO claims (
                  id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
                  assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, false, NOW())`,
                [
                  claimId,
                  familyId,
                  list.id,
                  itemId,
                  claimerUserId,
                  claimerGuestLinkId,
                  claimerFirstName,
                  quantity,
                  Boolean(action.bought),
                ]
              );

              await recordAuditLog(client, {
                familyId,
                actorUserId: claimerUserId,
                actorLabel: claimerFirstName,
                action: 'ITEM_CLAIMED',
                targetRecipientUserId: list.recipient_user_id,
                isSurpriseSensitive: true,
                metadata: { itemId, listId: list.id, quantity, offline: true },
              });
            });

            syncedCount++;
            results.push({ type: action.type, success: true });
          } else if (action.type === 'UPDATE_ASSIGNMENT') {
            const { assignmentId, status } = action;
            if (!assignmentId || !status) {
              throw new Error('UPDATE_ASSIGNMENT requires assignmentId and status');
            }

            let fId = action.familyId;
            if (!fId) {
              await withSystemContext(async (sysClient) => {
                const aRes = await sysClient.query(
                  'SELECT family_id FROM assignments WHERE id = $1',
                  [assignmentId]
                );
                if (aRes.rows.length > 0) fId = aRes.rows[0].family_id;
              });
            }
            if (!fId) throw new Error('Assignment not found or missing familyId');

            await withFamilyContext(fId, async (client) => {
              const aRes = await client.query(
                `SELECT a.*, l.recipient_user_id
                 FROM assignments a
                 JOIN lists l ON l.id = a.list_id
                 WHERE a.id = $1 AND a.family_id = $2`,
                [assignmentId, fId]
              );
              if (aRes.rows.length === 0) throw new Error('Assignment not found');
              const assignment = aRes.rows[0];

              if (status === 'bought') {
                await client.query(
                  `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
                  [assignmentId]
                );
                await client.query('UPDATE claims SET bought = true WHERE assignment_id = $1', [
                  assignmentId,
                ]);
              } else if (status === 'couldnt_get_it') {
                await client.query(
                  `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1`,
                  [assignmentId]
                );
                await client.query('DELETE FROM claims WHERE assignment_id = $1', [assignmentId]);
              } else if (status === 'assigned') {
                await client.query(
                  `UPDATE assignments SET status = 'assigned', updated_at = NOW() WHERE id = $1`,
                  [assignmentId]
                );
                await client.query('UPDATE claims SET bought = false WHERE assignment_id = $1', [
                  assignmentId,
                ]);
              } else {
                throw new Error(`Invalid assignment status: ${status}`);
              }

              await recordAuditLog(client, {
                familyId: fId,
                actorUserId: req.auth?.user?.id ?? null,
                actorLabel:
                  req.auth?.kind === 'user' && req.auth.user
                    ? extractFirstName(req.auth.user.first_name)
                    : 'Assignee',
                action: 'ASSIGNMENT_UPDATED',
                targetRecipientUserId: assignment.recipient_user_id,
                isSurpriseSensitive: true,
                metadata: { assignmentId, status, offline: true },
              });
            });

            syncedCount++;
            results.push({ type: action.type, success: true });
          } else {
            results.push({
              type: action.type || 'UNKNOWN',
              success: false,
              error: 'Unknown action type',
            });
          }
        } catch (err: any) {
          results.push({
            type: action?.type || 'UNKNOWN',
            success: false,
            error: err.message || 'Action failed',
          });
        }
      }

      res.json({ syncedCount, results });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
