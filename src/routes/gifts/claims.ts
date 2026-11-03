import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import {
  getStoreClickInfo,
  claimItem,
  findFamilyIdForClaim,
  releaseClaim,
  updateClaimBought,
} from '../../services/claims.js';
import { handleRouteError } from './http.js';

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
      const clickInfo = await getStoreClickInfo(familyId, itemId);

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
      const claim = await claimItem(req.auth, familyId, itemId, req.body);

      if (!claim) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(201).json({ claim });
    } catch (err) {
      handleRouteError(err, res, next);
    }
  }
);

/**
 * POST /families/:familyId/claims/:claimId/release
 * Release (delete) an existing claim.
 */
const releaseClaimHandler = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let { familyId, claimId } = req.params;

    if (!familyId && claimId) {
      familyId = (await findFamilyIdForClaim(claimId)) ?? familyId;
    }

    if (!familyId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const released = await releaseClaim(req.auth, familyId, claimId);

    if (!released) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({ released: true });
  } catch (err) {
    handleRouteError(err, res, next);
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
router.delete('/claims/:claimId', requireCsrf, releaseClaimHandler);

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

      const claim = await updateClaimBought(req.auth, familyId, claimId, bought);

      if (!claim) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ claim });
    } catch (err) {
      handleRouteError(err, res, next);
    }
  }
);

export default router;
