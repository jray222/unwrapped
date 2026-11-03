import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireFamilyAccess } from '../../security/middleware.js';
import { getGuestViewData, getNotifications } from '../../services/guest-view.js';

const router = Router();

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

      const data = await getGuestViewData(guestLinkId, familyId, guestFirstName, allowedListIds);
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
      const notifications = await getNotifications(familyId, req.auth);
      res.json({ notifications });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
