import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import { createPledge } from '../../services/pledges.js';
import { handleRouteError } from './http.js';

const router = Router();

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

      const result = await createPledge(req.auth, familyId, itemId, amountCents, req.body);

      if (!result) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      handleRouteError(err, res, next);
    }
  }
);

export default router;
