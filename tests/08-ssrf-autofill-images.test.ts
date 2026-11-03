import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import sharp from 'sharp';
import { withFamilyContext } from '../src/db/index.js';
import { isPublicIp, autofillProductUrl, BotWallError, FetchHttpError } from '../src/services/ssrf-autofill.js';
import { sanitizeImageBuffer } from '../src/services/image-sanitizer.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { extractCookie, setupBaseWorld } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 8: SSRF-Safe Auto-Fill & Image EXIF Stripping', () => {
  const app = createApp();

  let familyAlphaId = '';
  let aliceCookie = '';
  let aliceCsrf = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
    ({ familyAlphaId, aliceCookie, aliceCsrf } = await setupBaseWorld(app));
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 8: SSRF-Safe Product URL Auto-Fill & Image EXIF Stripping
  // =========================================================================
  describe('8. SSRF-Safe Product URL Auto-Fill & Image EXIF Stripping', () => {
    it('verifies isPublicIp rejects private, loopback, link-local, and cloud metadata IPs', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('169.254.169.254')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('::1')).toBe(false);
      expect(isPublicIp('fe80::1')).toBe(false);

      // Public IPs allowed
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('93.184.216.34')).toBe(true);
    });

    it('POST /autofill blocks loopback, private IPs, metadata IP, and localhost', async () => {
      const blockedUrls = [
        'http://127.0.0.1',
        'http://localhost',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://[::1]/',
      ];

      for (const url of blockedUrls) {
        const res = await request(app)
          .post(`/api/families/${familyAlphaId}/autofill`)
          .set('Cookie', aliceCookie)
          .set('x-csrf-token', aliceCsrf)
          .send({ url });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/for safety reasons/i);
      }
    });

    it('autofill parses only the first part of an oversized HTML page instead of failing', async () => {
      const head = '<html><head><meta property="og:title" content="Big Page Product"><meta property="product:price:amount" content="19.99"></head><body>';
      const padding = 'x'.repeat(2 * 1024 * 1024);
      const customFetch = (async () =>
        new Response(head + padding, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
      const result = await autofillProductUrl('https://example.com/p/1', {
        customResolver: async () => ['93.184.216.34'],
        customFetch,
      });
      expect(result.name).toBe('Big Page Product');
      expect(result.price_cents).toBe(1999);
    });

    it('autofill reports a bot-check page as BotWallError, not as a product', async () => {
      const html = '<html><head><title>Robot or human?</title></head><body>Activate and hold the button to confirm that you are human.</body></html>';
      await expect(
        autofillProductUrl('https://example.com/p/1', {
          customResolver: async () => ['93.184.216.34'],
          htmlOverride: html,
        })
      ).rejects.toBeInstanceOf(BotWallError);
    });

    it('autofill surfaces HTTP 403 as FetchHttpError', async () => {
      const customFetch = (async () => new Response('no', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
      await expect(
        autofillProductUrl('https://example.com/p/1', {
          customResolver: async () => ['93.184.216.34'],
          customFetch,
        })
      ).rejects.toBeInstanceOf(FetchHttpError);
    });

    it('blocks guests from calling /autofill (403)', async () => {
      // Create guest link
      const gRes = await request(app)
        .post(`/api/families/${familyAlphaId}/guest-links`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({ guestFirstName: 'GuestUser', expiresInDays: 7 });

      expect(gRes.status).toBe(201);
      const gCookie = extractCookie(await request(app).get(`/g/${gRes.body.token}`));
      const meRes = await request(app).get('/api/auth/me').set('Cookie', gCookie);

      const autofillRes = await request(app)
        .post(`/api/families/${familyAlphaId}/autofill`)
        .set('Cookie', gCookie)
        .set('x-csrf-token', meRes.body.csrfToken)
        .send({ url: 'https://www.target.com/p/item' });

      expect(autofillRes.status).toBe(403);
    });

    it('extracts product metadata via mockHtml, sanitizes domain, and records sanitized domain in audit_logs', async () => {
      const mockProductHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Classic Coffee Press</title>
          <meta property="og:title" content="Classic French Press 34oz" />
          <meta property="og:price:amount" content="29.99" />
          <meta property="og:site_name" content="Bodum Official Store" />
          <meta property="og:image" content="https://example.com/images/press.jpg" />
        </head>
        <body></body>
        </html>
      `;

      const res = await request(app)
        .post(`/api/families/${familyAlphaId}/autofill`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          url: 'https://www.bodum.com/us/en/french-press?ref=tracker_123',
          mockHtml: mockProductHtml,
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Classic French Press 34oz');
      expect(res.body.price_cents).toBe(2999);
      expect(res.body.store_name).toBe('Bodum Official Store');
      expect(res.body.sanitized_domain).toBe('bodum.com');

      // Verify audit log recorded sanitized domain and did not leak query params
      await withFamilyContext(familyAlphaId, async (client) => {
        const logRes = await client.query(
          "SELECT metadata FROM audit_logs WHERE action = 'URL_AUTOFILL_FETCH' ORDER BY created_at DESC LIMIT 1"
        );
        expect(logRes.rows.length).toBe(1);
        expect(logRes.rows[0].metadata.domain).toBe('bodum.com');
      });
    });

    it('sanitizes images via sharp, strips EXIF metadata, and serves clean WebP', async () => {
      // 1. Create a dummy image with EXIF metadata
      const rawImageWithExif = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .withMetadata({
          exif: {
            IFD0: {
              Copyright: 'Sensitive Private EXIF GPS Metadata',
            },
          },
        })
        .jpeg()
        .toBuffer();

      // 2. Run through sanitizeImageBuffer directly
      const sanitizedDirect = await sanitizeImageBuffer(rawImageWithExif);
      expect(sanitizedDirect.mimeType).toBe('image/webp');
      const directMeta = await sharp(sanitizedDirect.data).metadata();
      expect(directMeta.exif).toBeUndefined();

      // 3. Upload image through POST /images endpoint
      const uploadRes = await request(app)
        .post(`/api/families/${familyAlphaId}/images`)
        .set('Cookie', aliceCookie)
        .set('x-csrf-token', aliceCsrf)
        .send({
          imageBase64: rawImageWithExif.toString('base64'),
        });

      expect(uploadRes.status).toBe(201);
      expect(uploadRes.body.imageId).toBeDefined();
      expect(uploadRes.body.imageUrl).toContain(`/api/families/${familyAlphaId}/images/`);

      const uploadedImageId = uploadRes.body.imageId;

      // 4. Retrieve clean WebP image
      const fetchRes = await request(app)
        .get(`/api/families/${familyAlphaId}/images/${uploadedImageId}`)
        .set('Cookie', aliceCookie);

      expect(fetchRes.status).toBe(200);
      expect(fetchRes.headers['content-type']).toBe('image/webp');

      const servedMeta = await sharp(fetchRes.body).metadata();
      expect(servedMeta.format).toBe('webp');
      expect(servedMeta.exif).toBeUndefined();
    });
  });
});
