import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Response, NextFunction } from 'express';
import { config } from '../config.js';
import type { AuthenticatedRequest } from '../types.js';
import { withFamilyContext, recordAuditLog } from '../db/index.js';
import {
  requireFamilyAccess,
  requireCsrf,
  autofillRateLimiter,
} from '../security/middleware.js';
import {
  extractFirstName,
  isViewerSubjectToSurpriseRule,
  serializeItem,
  type RawItemRow,
  type RawClaimRow,
  type RawPledgeRow,
  type RawAssignmentRow,
} from '../security/surprise.js';
import {
  autofillProductUrl,
  safeFetchBuffer,
  BotWallError,
  FetchHttpError,
  FetchTimeoutError,
} from '../services/ssrf-autofill.js';
import { sanitizeImageBuffer } from '../services/image-sanitizer.js';

const router = Router({ mergeParams: true });

/**
 * POST /lists
 * Create a new wish list for oneself or on behalf of someone else (e.g. child).
 */
router.post(
  '/lists',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const familyId = req.params.familyId;
      const name = req.body?.name;
      const eventDate = req.body?.eventDate ?? req.body?.event_date;
      const recipientUserId = req.body?.recipientUserId ?? req.body?.recipient_user_id;
      const recipientFirstName = req.body?.recipientFirstName ?? req.body?.recipient_first_name;
      const includeCatchAll = req.body?.includeCatchAll ?? req.body?.include_catch_all;

      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'List name is required' });
        return;
      }

      const currentUser = req.auth!.user!;
      let finalRecipientUserId: string | null = null;
      let finalRecipientFirstName = '';

      if (recipientUserId !== undefined && recipientUserId !== null && recipientUserId !== '') {
        finalRecipientUserId = recipientUserId;
        if (recipientFirstName && typeof recipientFirstName === 'string' && recipientFirstName.trim()) {
          finalRecipientFirstName = extractFirstName(recipientFirstName);
        } else {
          await withFamilyContext(familyId, async (client) => {
            const userRes = await client.query('SELECT first_name FROM users WHERE id = $1', [
              finalRecipientUserId,
            ]);
            if (userRes.rows.length === 0) {
              finalRecipientFirstName = 'Someone';
            } else {
              finalRecipientFirstName = extractFirstName(userRes.rows[0].first_name);
            }
          });
        }
      } else if (recipientFirstName && typeof recipientFirstName === 'string' && recipientFirstName.trim()) {
        finalRecipientUserId = null;
        finalRecipientFirstName = extractFirstName(recipientFirstName);
      } else {
        finalRecipientUserId = currentUser.id;
        finalRecipientFirstName = extractFirstName(currentUser.first_name);
      }

      const listId = randomUUID();
      const list = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `INSERT INTO lists (
            id, family_id, name, event_date, owner_user_id, recipient_user_id,
            recipient_first_name, thank_you_revealed, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW(), NOW())
          RETURNING *`,
          [
            listId,
            familyId,
            name.trim(),
            eventDate || null,
            currentUser.id,
            finalRecipientUserId,
            finalRecipientFirstName,
          ]
        );

        if (includeCatchAll !== false) {
          const catchAllId = randomUUID();
          await client.query(
            `INSERT INTO items (
              id, family_id, list_id, name, store_url, store_name, price_cents, image_url,
              notes, priority, quantity, allow_duplicates, is_catch_all, deleted_by_recipient,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, '', '', null, '', $5, 'nice_to_have', 1, true, true, false, NOW(), NOW())`,
            [
              catchAllId,
              familyId,
              listId,
              'Anything else / Surprise me',
              'Gift cards, experiences, or surprise me!',
            ]
          );
        }

        return listRes.rows[0];
      });

      res.status(201).json({ list });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /lists
 * List wish lists in the family. Guests only see recipient_first_name and filtered allowed lists.
 */
router.get(
  '/lists',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const familyId = req.params.familyId;
      const isGuest = req.auth?.kind === 'guest';
      const allowedListIds = isGuest ? req.auth?.guestLink?.allowed_list_ids : null;

      const lists = await withFamilyContext(familyId, async (client) => {
        let querySql = `SELECT * FROM lists WHERE family_id = $1`;
        const params: any[] = [familyId];

        if (isGuest && Array.isArray(allowedListIds) && allowedListIds.length > 0) {
          querySql += ` AND id = ANY($2)`;
          params.push(allowedListIds);
        }

        querySql += ` ORDER BY created_at ASC`;
        const res = await client.query(querySql, params);

        return res.rows.map((l) => ({
          ...l,
          recipient_first_name: extractFirstName(l.recipient_first_name),
        }));
      });

      res.json({ lists });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /lists/:listId
 * Load list and items strictly ordered by created_at ASC, id ASC.
 * Enforces Surprise Rule serialization.
 */
router.get(
  '/lists/:listId',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId } = req.params;
      const isGuest = req.auth?.kind === 'guest';
      const allowedListIds = isGuest ? req.auth?.guestLink?.allowed_list_ids : null;

      if (
        isGuest &&
        Array.isArray(allowedListIds) &&
        allowedListIds.length > 0 &&
        !allowedListIds.includes(listId)
      ) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const result = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) {
          return null;
        }
        const list = {
          ...listRes.rows[0],
          recipient_first_name: extractFirstName(listRes.rows[0].recipient_first_name),
        };

        const minPrice = req.query.minPriceCents
          ? parseInt(String(req.query.minPriceCents), 10)
          : null;
        const maxPrice = req.query.maxPriceCents
          ? parseInt(String(req.query.maxPriceCents), 10)
          : null;
        const priority = typeof req.query.priority === 'string' ? req.query.priority : null;

        let itemsSql = `SELECT * FROM items WHERE list_id = $1 AND deleted_by_recipient = false`;
        const itemParams: any[] = [listId];
        let pIndex = 2;

        if (minPrice !== null && !isNaN(minPrice)) {
          itemsSql += ` AND price_cents >= $${pIndex++}`;
          itemParams.push(minPrice);
        }
        if (maxPrice !== null && !isNaN(maxPrice)) {
          itemsSql += ` AND price_cents <= $${pIndex++}`;
          itemParams.push(maxPrice);
        }
        if (priority && (priority === 'really_want' || priority === 'nice_to_have')) {
          itemsSql += ` AND priority = $${pIndex++}`;
          itemParams.push(priority);
        }

        itemsSql += ` ORDER BY created_at ASC, id ASC`;
        const itemsRes = await client.query<RawItemRow>(itemsSql, itemParams);

        const claimsRes = await client.query<RawClaimRow>(
          `SELECT * FROM claims WHERE list_id = $1 ORDER BY created_at ASC`,
          [listId]
        );
        const pledgesRes = await client.query<RawPledgeRow>(
          `SELECT * FROM pledges WHERE list_id = $1 ORDER BY created_at ASC`,
          [listId]
        );
        const assignsRes = await client.query<RawAssignmentRow>(
          `SELECT * FROM assignments WHERE list_id = $1 ORDER BY created_at ASC`,
          [listId]
        );

        const surpriseProtected = isViewerSubjectToSurpriseRule({
          viewerUserId: req.auth?.user?.id ?? null,
          listRecipientUserId: list.recipient_user_id,
          thankYouRevealed: Boolean(list.thank_you_revealed),
        });

        const viewerUserId = req.auth?.kind === 'user' ? req.auth.user?.id : null;
        const viewerGuestLinkId = req.auth?.kind === 'guest' ? req.auth.guestLink?.id : null;

        const serializedItems = itemsRes.rows.map((item) => {
          const itemClaims = claimsRes.rows.filter((c) => c.item_id === item.id);
          const itemPledges = pledgesRes.rows.filter((p) => p.item_id === item.id);
          const itemAssigns = assignsRes.rows.filter((a) => a.item_id === item.id);

          return serializeItem({
            item,
            claims: itemClaims,
            pledges: itemPledges,
            assignments: itemAssigns,
            surpriseProtected,
            viewerUserId,
            viewerGuestLinkId,
          });
        });

        return { list, surpriseProtected, serializedItems };
      });

      if (!result) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      if (result.surpriseProtected) {
        res.json({ list: result.list, items: result.serializedItems });
      } else {
        const availableItems = result.serializedItems.filter((i: any) => !i.is_taken);
        const alreadyTakenItems = result.serializedItems.filter((i: any) => Boolean(i.is_taken));
        res.json({
          list: result.list,
          items: result.serializedItems,
          availableItems,
          alreadyTakenItems,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /lists/:listId/items
 * Add an item to a list. Restricted to list owner, recipient, or family_admin.
 */
router.post(
  '/lists/:listId/items',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId } = req.params;
      const name = req.body?.name;
      const storeUrl = req.body?.storeUrl ?? req.body?.store_url;
      const storeName = req.body?.storeName ?? req.body?.store_name;
      const priceCents = req.body?.priceCents ?? req.body?.price_cents;
      const imageUrl = req.body?.imageUrl ?? req.body?.image_url;
      const notes = req.body?.notes;
      const priority = req.body?.priority;
      const quantity = req.body?.quantity;
      const allowDuplicates = req.body?.allowDuplicates ?? req.body?.allow_duplicates;
      const isCatchAll = req.body?.isCatchAll ?? req.body?.is_catch_all;

      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'Item name is required' });
        return;
      }

      const currentUser = req.auth!.user!;
      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );

      const item = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) {
          return null;
        }
        const list = listRes.rows[0];

        if (
          list.owner_user_id !== currentUser.id &&
          list.recipient_user_id !== currentUser.id &&
          !isFamilyAdmin
        ) {
          const forbiddenErr = new Error('Permission denied to manage items on this list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        const itemId = randomUUID();
        const insertRes = await client.query<RawItemRow>(
          `INSERT INTO items (
            id, family_id, list_id, name, store_url, store_name, price_cents,
            image_url, notes, priority, quantity, allow_duplicates, is_catch_all,
            deleted_by_recipient, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())
          RETURNING *`,
          [
            itemId,
            familyId,
            listId,
            name.trim(),
            storeUrl || '',
            storeName || '',
            typeof priceCents === 'number' ? priceCents : null,
            imageUrl || '',
            notes || '',
            priority === 'really_want' ? 'really_want' : 'nice_to_have',
            quantity && quantity >= 1 ? quantity : 1,
            Boolean(allowDuplicates),
            Boolean(isCatchAll),
          ]
        );

        const surpriseProtected = isViewerSubjectToSurpriseRule({
          viewerUserId: currentUser.id,
          listRecipientUserId: list.recipient_user_id,
          thankYouRevealed: Boolean(list.thank_you_revealed),
        });

        return serializeItem({
          item: insertRes.rows[0],
          claims: [],
          pledges: [],
          assignments: [],
          surpriseProtected,
          viewerUserId: currentUser.id,
        });
      });

      if (!item) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(201).json({ item });
    } catch (err: any) {
      if (err.status === 403 || err.status === 400) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * PATCH /lists/:listId/items/:itemId
 * Update an item. If claimed/pledged/assigned, asynchronously creates notifications for givers,
 * while returning normal 200 response without leaking surprise.
 */
router.patch(
  '/lists/:listId/items/:itemId',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId, itemId } = req.params;
      const currentUser = req.auth!.user!;
      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );

      const serialized = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) return null;
        const list = listRes.rows[0];

        if (
          list.owner_user_id !== currentUser.id &&
          list.recipient_user_id !== currentUser.id &&
          !isFamilyAdmin
        ) {
          const forbiddenErr = new Error('Permission denied to manage items on this list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        const itemRes = await client.query<RawItemRow>(
          `SELECT * FROM items WHERE id = $1 AND list_id = $2 AND family_id = $3`,
          [itemId, listId, familyId]
        );
        if (itemRes.rows.length === 0) return null;
        const oldItem = itemRes.rows[0];

        // Check if item has any rows in claims, pledges, or active assignments
        const claimsRes = await client.query<RawClaimRow>(
          `SELECT * FROM claims WHERE item_id = $1`,
          [itemId]
        );
        const pledgesRes = await client.query<RawPledgeRow>(
          `SELECT * FROM pledges WHERE item_id = $1`,
          [itemId]
        );
        const assignsRes = await client.query<RawAssignmentRow>(
          `SELECT * FROM assignments WHERE item_id = $1 AND status != 'couldnt_get_it'`,
          [itemId]
        );

        const hasGivers =
          claimsRes.rows.length > 0 || pledgesRes.rows.length > 0 || assignsRes.rows.length > 0;

        if (hasGivers) {
          const affectedUserIds = new Set<string>();
          const affectedGuestLinkIds = new Set<string>();

          for (const c of claimsRes.rows) {
            if (c.claimer_user_id) affectedUserIds.add(c.claimer_user_id);
            if (c.claimer_guest_link_id) affectedGuestLinkIds.add(c.claimer_guest_link_id);
          }
          for (const p of pledgesRes.rows) {
            if (p.pledger_user_id) affectedUserIds.add(p.pledger_user_id);
            if (p.pledger_guest_link_id) affectedGuestLinkIds.add(p.pledger_guest_link_id);
          }
          for (const a of assignsRes.rows) {
            if (a.assigner_user_id) affectedUserIds.add(a.assigner_user_id);
          }

          // Do not notify current user if they updated the item
          affectedUserIds.delete(currentUser.id);

          const noticeMsg = `Heads up: ${extractFirstName(list.recipient_first_name)} updated the item '${oldItem.name}' that you claimed/pledged on '${list.name}'.`;

          for (const targetUserId of affectedUserIds) {
            await client.query(
              `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
               VALUES ($1, $2, $3, null, $4, false, NOW())`,
              [randomUUID(), familyId, targetUserId, noticeMsg]
            );
          }
          for (const targetGuestLinkId of affectedGuestLinkIds) {
            await client.query(
              `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
               VALUES ($1, $2, null, $3, $4, false, NOW())`,
              [randomUUID(), familyId, targetGuestLinkId, noticeMsg]
            );
          }
        }

        if (req.body.name !== undefined && !String(req.body.name).trim()) {
          const badReqErr = new Error('Item name cannot be empty');
          (badReqErr as any).status = 400;
          throw badReqErr;
        }

        const name = req.body.name !== undefined ? String(req.body.name).trim() : oldItem.name;
        const rawStoreUrl = req.body.storeUrl ?? req.body.store_url;
        const storeUrl = rawStoreUrl !== undefined ? String(rawStoreUrl) : oldItem.store_url;
        const rawStoreName = req.body.storeName ?? req.body.store_name;
        const storeName = rawStoreName !== undefined ? String(rawStoreName) : oldItem.store_name;
        const rawPrice = req.body.priceCents ?? req.body.price_cents;
        const priceCents =
          rawPrice !== undefined
            ? rawPrice === null
              ? null
              : parseInt(String(rawPrice), 10)
            : oldItem.price_cents;
        const rawImage = req.body.imageUrl ?? req.body.image_url;
        const imageUrl = rawImage !== undefined ? String(rawImage) : oldItem.image_url;
        const notes = req.body.notes !== undefined ? String(req.body.notes) : oldItem.notes;
        const priority =
          req.body.priority === 'really_want' || req.body.priority === 'nice_to_have'
            ? req.body.priority
            : oldItem.priority;
        const quantity =
          req.body.quantity !== undefined
            ? Math.max(1, parseInt(String(req.body.quantity), 10) || 1)
            : oldItem.quantity;
        const rawAllowDuplicates = req.body.allowDuplicates ?? req.body.allow_duplicates;
        const allowDuplicates =
          rawAllowDuplicates !== undefined
            ? Boolean(rawAllowDuplicates)
            : oldItem.allow_duplicates;
        const rawCatchAll = req.body.isCatchAll ?? req.body.is_catch_all;
        const isCatchAll =
          rawCatchAll !== undefined ? Boolean(rawCatchAll) : oldItem.is_catch_all;

        const updatedRes = await client.query<RawItemRow>(
          `UPDATE items
           SET name = $1, store_url = $2, store_name = $3, price_cents = $4,
               image_url = $5, notes = $6, priority = $7, quantity = $8,
               allow_duplicates = $9, is_catch_all = $10, updated_at = NOW()
           WHERE id = $11
           RETURNING *`,
          [
            name,
            storeUrl,
            storeName,
            priceCents,
            imageUrl,
            notes,
            priority,
            quantity,
            allowDuplicates,
            isCatchAll,
            itemId,
          ]
        );

        const surpriseProtected = isViewerSubjectToSurpriseRule({
          viewerUserId: currentUser.id,
          listRecipientUserId: list.recipient_user_id,
          thankYouRevealed: Boolean(list.thank_you_revealed),
        });

        return serializeItem({
          item: updatedRes.rows[0],
          claims: claimsRes.rows,
          pledges: pledgesRes.rows,
          assignments: assignsRes.rows,
          surpriseProtected,
          viewerUserId: currentUser.id,
        });
      });

      if (!serialized) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ item: serialized });
    } catch (err: any) {
      if (err.status === 403 || err.status === 400) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * DELETE /lists/:listId/items/:itemId
 * Soft-delete an item. If claimed/pledged, notifies affected givers without leaking surprise.
 */
router.delete(
  '/lists/:listId/items/:itemId',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId, itemId } = req.params;
      const currentUser = req.auth!.user!;
      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );

      const deleted = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) return false;
        const list = listRes.rows[0];

        if (
          list.owner_user_id !== currentUser.id &&
          list.recipient_user_id !== currentUser.id &&
          !isFamilyAdmin
        ) {
          const forbiddenErr = new Error('Permission denied to manage items on this list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        const itemRes = await client.query<RawItemRow>(
          `SELECT * FROM items WHERE id = $1 AND list_id = $2 AND family_id = $3`,
          [itemId, listId, familyId]
        );
        if (itemRes.rows.length === 0) return false;
        const item = itemRes.rows[0];

        const claimsRes = await client.query<RawClaimRow>(
          `SELECT * FROM claims WHERE item_id = $1`,
          [itemId]
        );
        const pledgesRes = await client.query<RawPledgeRow>(
          `SELECT * FROM pledges WHERE item_id = $1`,
          [itemId]
        );
        const assignsRes = await client.query<RawAssignmentRow>(
          `SELECT * FROM assignments WHERE item_id = $1 AND status != 'couldnt_get_it'`,
          [itemId]
        );

        const hasGivers =
          claimsRes.rows.length > 0 || pledgesRes.rows.length > 0 || assignsRes.rows.length > 0;

        if (hasGivers) {
          const affectedUserIds = new Set<string>();
          const affectedGuestLinkIds = new Set<string>();

          for (const c of claimsRes.rows) {
            if (c.claimer_user_id) affectedUserIds.add(c.claimer_user_id);
            if (c.claimer_guest_link_id) affectedGuestLinkIds.add(c.claimer_guest_link_id);
          }
          for (const p of pledgesRes.rows) {
            if (p.pledger_user_id) affectedUserIds.add(p.pledger_user_id);
            if (p.pledger_guest_link_id) affectedGuestLinkIds.add(p.pledger_guest_link_id);
          }
          for (const a of assignsRes.rows) {
            if (a.assigner_user_id) affectedUserIds.add(a.assigner_user_id);
          }

          affectedUserIds.delete(currentUser.id);

          const noticeMsg = `Heads up: ${extractFirstName(list.recipient_first_name)} removed the item '${item.name}' that you claimed/pledged on '${list.name}'.`;

          for (const targetUserId of affectedUserIds) {
            await client.query(
              `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
               VALUES ($1, $2, $3, null, $4, false, NOW())`,
              [randomUUID(), familyId, targetUserId, noticeMsg]
            );
          }
          for (const targetGuestLinkId of affectedGuestLinkIds) {
            await client.query(
              `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
               VALUES ($1, $2, null, $3, $4, false, NOW())`,
              [randomUUID(), familyId, targetGuestLinkId, noticeMsg]
            );
          }
        }

        await client.query(
          `UPDATE items SET deleted_by_recipient = true, updated_at = NOW() WHERE id = $1`,
          [itemId]
        );
        return true;
      });

      if (!deleted) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ deleted: true });
    } catch (err: any) {
      if (err.status === 403 || err.status === 400) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

function describeAutofillError(err: any, isSsrfBlocked: boolean): string {
  const manual = 'You can enter the item details manually.';
  if (isSsrfBlocked) return `That link can't be fetched for safety reasons. ${manual}`;
  if (err instanceof BotWallError || (err instanceof FetchHttpError && [401, 403, 429, 503].includes(err.status))) {
    return `That store blocks automatic lookups. ${manual}`;
  }
  if (err instanceof FetchHttpError && err.status === 404) {
    return `That page wasn't found. Please double-check the link. ${manual}`;
  }
  if (err instanceof FetchTimeoutError) return `That store took too long to respond. ${manual}`;
  if (typeof err?.message === 'string' && err.message.startsWith('No product details')) {
    return `No product details were found on that page. ${manual}`;
  }
  return `That link could not be read. ${manual}`;
}

/**
 * POST /autofill
 * SSRF-safe URL metadata extraction.
 */
router.post(
  '/autofill',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  autofillRateLimiter,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const familyId = req.params.familyId;
    const currentUser = req.auth!.user!;
    const { url, mockHtml, fetchImage } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'URL is required' });
      return;
    }

    try {
      const result = await autofillProductUrl(url.trim(), {
        htmlOverride: mockHtml,
      });
      let finalImageUrl = result.image_url || '';

      if (finalImageUrl && fetchImage) {
        try {
          const fetchRes = await safeFetchBuffer(finalImageUrl, {
            maxBytes: config.autofillMaxImageBytes,
            timeoutMs: config.autofillTimeoutMs,
          });
          const sanitized = await sanitizeImageBuffer(fetchRes.buffer);
          const imageId = randomUUID();
          await withFamilyContext(familyId, async (client) => {
            await client.query(
              `INSERT INTO images (id, family_id, mime_type, data, width, height, created_by_user_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
              [
                imageId,
                familyId,
                sanitized.mimeType,
                sanitized.data,
                sanitized.width,
                sanitized.height,
                currentUser.id,
              ]
            );
          });
          finalImageUrl = `/api/families/${familyId}/images/${imageId}`;
        } catch {
          // If image download or sanitization fails, keep raw url or leave as is
        }
      }

      await withFamilyContext(familyId, async (client) => {
        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel: extractFirstName(currentUser.first_name),
          action: 'URL_AUTOFILL_FETCH',
          isSurpriseSensitive: false,
          metadata: { domain: result.sanitized_domain, status: 'success' },
        });
      });

      res.json({
        name: result.name || '',
        title: result.name || '',
        price_cents: result.price_cents ?? null,
        priceCents: result.price_cents ?? null,
        store_name: result.store_name || '',
        storeName: result.store_name || '',
        image_url: finalImageUrl,
        imageUrl: finalImageUrl,
        sanitized_domain: result.sanitized_domain || '',
        sanitizedDomain: result.sanitized_domain || '',
      });
    } catch (err: any) {
      const isSsrfBlocked =
        err?.code === 'SSRF_BLOCKED' ||
        (typeof err?.message === 'string' && err.message.toLowerCase().includes('ssrf'));

      await withFamilyContext(familyId, async (client) => {
        await recordAuditLog(client, {
          familyId,
          actorUserId: currentUser.id,
          actorLabel: extractFirstName(currentUser.first_name),
          action: isSsrfBlocked ? 'URL_AUTOFILL_BLOCKED' : 'URL_AUTOFILL_ERROR',
          isSurpriseSensitive: false,
          metadata: {
            status: isSsrfBlocked ? 'blocked' : 'error',
            error: isSsrfBlocked ? 'SSRF blocked' : err.message || 'Fetch failed',
          },
        });
      });

      res.status(400).json({ error: describeAutofillError(err, isSsrfBlocked) });
    }
  }
);

/**
 * POST /images
 * Upload and sanitize an image buffer, saving to tenant storage.
 */
router.post(
  '/images',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const familyId = req.params.familyId;
      const currentUser = req.auth!.user!;

      let buffer: Buffer | null = null;
      if (req.body?.imageBase64 && typeof req.body.imageBase64 === 'string') {
        const base64Data = req.body.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
        buffer = Buffer.from(base64Data, 'base64');
      } else if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      }

      if (!buffer || buffer.length === 0) {
        res.status(400).json({ error: 'Image data is required' });
        return;
      }

      const sanitized = await sanitizeImageBuffer(buffer);
      const imageId = randomUUID();

      await withFamilyContext(familyId, async (client) => {
        await client.query(
          `INSERT INTO images (id, family_id, mime_type, data, width, height, created_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            imageId,
            familyId,
            sanitized.mimeType,
            sanitized.data,
            sanitized.width,
            sanitized.height,
            currentUser.id,
          ]
        );
      });

      res.status(201).json({
        imageId,
        imageUrl: `/api/families/${familyId}/images/${imageId}`,
        width: sanitized.width,
        height: sanitized.height,
        mimeType: sanitized.mimeType,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /images/:imageId
 * Serve sanitized image buffer from database.
 */
router.get(
  '/images/:imageId',
  requireFamilyAccess(['family_admin', 'member'], true),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, imageId } = req.params;

      const img = await withFamilyContext(familyId, async (client) => {
        const imgRes = await client.query(
          `SELECT mime_type, data FROM images WHERE id = $1 AND family_id = $2`,
          [imageId, familyId]
        );
        if (imgRes.rows.length === 0) return null;
        return imgRes.rows[0];
      });

      if (!img) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.setHeader('Content-Type', img.mime_type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(img.data));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /lists/:listId/reveal-thank-you
 * Enable Thank-You Mode after an event.
 */
router.post(
  ['/lists/:listId/reveal-thank-you', '/lists/:listId/thank-you-reveal'],
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId } = req.params;
      const currentUser = req.auth!.user!;
      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );

      const result = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) return null;
        const list = listRes.rows[0];

        if (
          list.owner_user_id !== currentUser.id &&
          list.recipient_user_id !== currentUser.id &&
          !isFamilyAdmin
        ) {
          const forbiddenErr = new Error('Permission denied to reveal thank-you mode on this list');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        const updatedRes = await client.query(
          `UPDATE lists SET thank_you_revealed = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [listId]
        );
        const updatedList = {
          ...updatedRes.rows[0],
          recipient_first_name: extractFirstName(updatedRes.rows[0].recipient_first_name),
        };

        const claimsRes = await client.query(
          `SELECT c.id, c.quantity, c.bought, c.thank_you_sent, c.claimer_first_name, i.name AS item_name
           FROM claims c
           JOIN items i ON i.id = c.item_id
           WHERE c.list_id = $1
           ORDER BY c.created_at ASC`,
          [listId]
        );

        const pledgesRes = await client.query(
          `SELECT p.id, p.amount_cents, p.note, p.thank_you_sent, p.pledger_first_name, i.name AS item_name
           FROM pledges p
           JOIN items i ON i.id = p.item_id
           WHERE p.list_id = $1
           ORDER BY p.created_at ASC`,
          [listId]
        );

        const thankYouSummary = [
          ...claimsRes.rows.map((c) => ({
            id: c.id,
            type: 'claim',
            claimer_first_name: extractFirstName(c.claimer_first_name),
            giverFirstName: extractFirstName(c.claimer_first_name),
            item_name: c.item_name,
            itemName: c.item_name,
            quantity: c.quantity,
            bought: c.bought,
            thank_you_sent: c.thank_you_sent,
            thankYouSent: c.thank_you_sent,
          })),
          ...pledgesRes.rows.map((p) => ({
            id: p.id,
            type: 'pledge',
            pledger_first_name: extractFirstName(p.pledger_first_name),
            giverFirstName: extractFirstName(p.pledger_first_name),
            item_name: p.item_name,
            itemName: p.item_name,
            amount_cents: p.amount_cents,
            amountCents: p.amount_cents,
            note: p.note,
            thank_you_sent: p.thank_you_sent,
            thankYouSent: p.thank_you_sent,
          })),
        ];

        return { list: updatedList, thankYouSummary };
      });

      if (!result) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.json(result);
    } catch (err: any) {
      if (err.status === 403 || err.status === 400) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * PATCH /lists/:listId/thank-you/:type/:recordId
 * Mark thank-you sent status on a claim or pledge.
 */
router.patch(
  '/lists/:listId/thank-you/:type/:recordId',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId, listId, type, recordId } = req.params;
      const currentUser = req.auth!.user!;
      const isFamilyAdmin = req.auth?.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );
      const thankYouSent = Boolean(req.body.thankYouSent ?? true);

      if (type !== 'claim' && type !== 'pledge') {
        res.status(400).json({ error: 'Invalid thank-you record type' });
        return;
      }

      const updated = await withFamilyContext(familyId, async (client) => {
        const listRes = await client.query(
          `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
          [listId, familyId]
        );
        if (listRes.rows.length === 0) return false;
        const list = listRes.rows[0];

        if (
          list.owner_user_id !== currentUser.id &&
          list.recipient_user_id !== currentUser.id &&
          !isFamilyAdmin
        ) {
          const forbiddenErr = new Error('Permission denied to update thank-you tracking');
          (forbiddenErr as any).status = 403;
          throw forbiddenErr;
        }

        if (type === 'claim') {
          const updRes = await client.query(
            `UPDATE claims SET thank_you_sent = $1 WHERE id = $2 AND list_id = $3 RETURNING id`,
            [thankYouSent, recordId, listId]
          );
          return updRes.rows.length > 0;
        } else {
          const updRes = await client.query(
            `UPDATE pledges SET thank_you_sent = $1 WHERE id = $2 AND list_id = $3 RETURNING id`,
            [thankYouSent, recordId, listId]
          );
          return updRes.rows.length > 0;
        }
      });

      if (!updated) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.json({ updated: true, thankYouSent });
    } catch (err: any) {
      if (err.status === 403 || err.status === 400) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
