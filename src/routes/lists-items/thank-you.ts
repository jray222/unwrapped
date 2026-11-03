import type { Router, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { withFamilyContext } from '../../db/index.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import { extractFirstName } from '../../security/surprise.js';
import { assertCanManageList, isFamilyAdminOf } from '../../services/list-access.js';
import { respondIfClientError } from './http.js';

export function registerThankYouRoutes(router: Router): void {
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
        const isFamilyAdmin = isFamilyAdminOf(req, familyId);

        const result = await withFamilyContext(familyId, async (client) => {
          const listRes = await client.query(
            `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
            [listId, familyId]
          );
          if (listRes.rows.length === 0) return null;
          const list = listRes.rows[0];

          assertCanManageList(
            list,
            currentUser.id,
            isFamilyAdmin,
            'Permission denied to reveal thank-you mode on this list'
          );

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
        if (respondIfClientError(err, res)) return;
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
        const isFamilyAdmin = isFamilyAdminOf(req, familyId);
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

          assertCanManageList(
            list,
            currentUser.id,
            isFamilyAdmin,
            'Permission denied to update thank-you tracking'
          );

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
        if (respondIfClientError(err, res)) return;
        next(err);
      }
    }
  );
}
