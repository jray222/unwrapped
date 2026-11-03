import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireFamilyAccess } from '../../security/middleware.js';
import { generateShoppingCardPdf, generateShoppingCardPng } from '../../services/shopping-card.js';
import {
  getShoppingCardData,
  parseShoppingCardQuery,
} from '../../services/shopping-card-data.js';

const router = Router();

function shoppingCardRoute(
  path: string,
  contentType: string,
  filename: string,
  generate: (params: NonNullable<Awaited<ReturnType<typeof getShoppingCardData>>>) => Promise<Buffer>
): void {
  router.get(
    path,
    requireFamilyAccess(['family_admin', 'member']),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { familyId } = req.params;
        const { assignmentIds, itemIds, fallbackAssigneeFirstName } = parseShoppingCardQuery(
          req.query
        );

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

        const buffer = await generate(cardParams);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.send(buffer);
      } catch (err) {
        next(err);
      }
    }
  );
}

/** GET /families/:familyId/shopping-card.pdf - offline printable PDF shopping card. */
shoppingCardRoute(
  '/families/:familyId/shopping-card.pdf',
  'application/pdf',
  'shopping-card.pdf',
  generateShoppingCardPdf
);

/** GET /families/:familyId/shopping-card.png - offline PNG shopping card. */
shoppingCardRoute(
  '/families/:familyId/shopping-card.png',
  'image/png',
  'shopping-card.png',
  generateShoppingCardPng
);

export default router;
