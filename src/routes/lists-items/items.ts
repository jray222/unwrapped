import type { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../types.js';
import { withFamilyContext } from '../../db/index.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import {
  isViewerSubjectToSurpriseRule,
  serializeItem,
  type RawItemRow,
} from '../../security/surprise.js';
import { HttpError } from '../../errors.js';
import { assertCanManageList, isFamilyAdminOf } from '../../services/list-access.js';
import { loadItemGivers, notifyItemGivers } from '../../services/giver-notifications.js';
import { respondIfClientError } from './http.js';

const MANAGE_ITEMS_DENIED = 'Permission denied to manage items on this list';

export function registerItemRoutes(router: Router): void {
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
        const isFamilyAdmin = isFamilyAdminOf(req, familyId);

        const item = await withFamilyContext(familyId, async (client) => {
          const listRes = await client.query(
            `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
            [listId, familyId]
          );
          if (listRes.rows.length === 0) {
            return null;
          }
          const list = listRes.rows[0];

          assertCanManageList(list, currentUser.id, isFamilyAdmin, MANAGE_ITEMS_DENIED);

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
        if (respondIfClientError(err, res)) return;
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
        const isFamilyAdmin = isFamilyAdminOf(req, familyId);

        const serialized = await withFamilyContext(familyId, async (client) => {
          const listRes = await client.query(
            `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
            [listId, familyId]
          );
          if (listRes.rows.length === 0) return null;
          const list = listRes.rows[0];

          assertCanManageList(list, currentUser.id, isFamilyAdmin, MANAGE_ITEMS_DENIED);

          const itemRes = await client.query<RawItemRow>(
            `SELECT * FROM items WHERE id = $1 AND list_id = $2 AND family_id = $3`,
            [itemId, listId, familyId]
          );
          if (itemRes.rows.length === 0) return null;
          const oldItem = itemRes.rows[0];

          const givers = await loadItemGivers(client, itemId);
          await notifyItemGivers(client, {
            familyId,
            currentUserId: currentUser.id,
            givers,
            list,
            itemName: oldItem.name,
            verb: 'updated',
          });

          if (req.body.name !== undefined && !String(req.body.name).trim()) {
            throw new HttpError(400, 'Item name cannot be empty');
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
            claims: givers.claims,
            pledges: givers.pledges,
            assignments: givers.assignments,
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
        if (respondIfClientError(err, res)) return;
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
        const isFamilyAdmin = isFamilyAdminOf(req, familyId);

        const deleted = await withFamilyContext(familyId, async (client) => {
          const listRes = await client.query(
            `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
            [listId, familyId]
          );
          if (listRes.rows.length === 0) return false;
          const list = listRes.rows[0];

          assertCanManageList(list, currentUser.id, isFamilyAdmin, MANAGE_ITEMS_DENIED);

          const itemRes = await client.query<RawItemRow>(
            `SELECT * FROM items WHERE id = $1 AND list_id = $2 AND family_id = $3`,
            [itemId, listId, familyId]
          );
          if (itemRes.rows.length === 0) return false;
          const item = itemRes.rows[0];

          const givers = await loadItemGivers(client, itemId);
          await notifyItemGivers(client, {
            familyId,
            currentUserId: currentUser.id,
            givers,
            list,
            itemName: item.name,
            verb: 'removed',
          });

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
        if (respondIfClientError(err, res)) return;
        next(err);
      }
    }
  );
}
