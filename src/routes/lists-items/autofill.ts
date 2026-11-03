import type { Router, Response } from 'express';
import { config } from '../../config.js';
import type { AuthenticatedRequest } from '../../types.js';
import { withFamilyContext, recordAuditLog } from '../../db/index.js';
import {
  requireFamilyAccess,
  requireCsrf,
  autofillRateLimiter,
} from '../../security/middleware.js';
import { extractFirstName } from '../../security/surprise.js';
import {
  autofillProductUrl,
  safeFetchBuffer,
  BotWallError,
  FetchHttpError,
  FetchTimeoutError,
} from '../../services/ssrf-autofill.js';
import { sanitizeImageBuffer } from '../../services/image-sanitizer.js';
import { storeSanitizedImage } from '../../services/image-store.js';

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

export function registerAutofillRoutes(router: Router): void {
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
            const imageId = await storeSanitizedImage(familyId, currentUser.id, sanitized);
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
}
