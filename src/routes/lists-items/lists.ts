import type { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../types.js';
import { withFamilyContext } from '../../db/index.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import {
  extractFirstName,
  isViewerSubjectToSurpriseRule,
  serializeItem,
  type RawItemRow,
  type RawClaimRow,
  type RawPledgeRow,
  type RawAssignmentRow,
} from '../../security/surprise.js';

export function registerListRoutes(router: Router): void {
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
}
