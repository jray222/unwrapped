import type { Router, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { withFamilyContext } from '../../db/index.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import { sanitizeImageBuffer } from '../../services/image-sanitizer.js';
import { storeSanitizedImage } from '../../services/image-store.js';

export function registerImageRoutes(router: Router): void {
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
        const imageId = await storeSanitizedImage(familyId, currentUser.id, sanitized);

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
}
