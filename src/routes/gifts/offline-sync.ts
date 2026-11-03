import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireCsrf } from '../../security/middleware.js';
import { processOfflineActions } from '../../services/offline-sync.js';

const router = Router();

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
      const { syncedCount, results } = await processOfflineActions(req.auth, actions);

      res.json({ syncedCount, results });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
