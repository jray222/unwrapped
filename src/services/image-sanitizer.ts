import sharp from 'sharp';
import { config } from '../config.js';

export interface SanitizedImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Sanitizes, validates, resizes, and re-encodes user or remote image buffers.
 * Enforces size limits, rejects unsafe formats (e.g. SVG/HTML/executable polyglots),
 * auto-orients based on EXIF before stripping all EXIF/GPS/XMP/ICC metadata,
 * and outputs a clean, safe WebP image.
 */
export async function sanitizeImageBuffer(input: Buffer): Promise<SanitizedImage> {
  if (!input || !Buffer.isBuffer(input) || input.length === 0) {
    throw new Error('Image buffer is empty or invalid.');
  }

  if (input.length > config.autofillMaxImageBytes) {
    throw new Error(
      `Image size (${input.length} bytes) exceeds maximum limit of ${config.autofillMaxImageBytes} bytes.`
    );
  }

  const image = sharp(input, { failOn: 'error', limitInputPixels: 16_000_000 });
  const metadata = await image.metadata();

  const allowedFormats = ['jpeg', 'png', 'webp', 'gif', 'avif'];
  const format = metadata.format?.toLowerCase();
  if (!format || !allowedFormats.includes(format)) {
    throw new Error(
      `Unsupported or disallowed image format: ${format || 'unknown'}. Allowed formats: ${allowedFormats.join(', ')}.`
    );
  }

  // Auto-orient based on EXIF orientation first, resize to max 800x800 bounding box,
  // then re-encode to clean WebP without calling .withMetadata() to ensure all
  // EXIF, GPS, XMP, and ICC metadata are completely stripped.
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 16_000_000 })
    .rotate()
    .resize({
      width: 800,
      height: 800,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    mimeType: 'image/webp',
    width: info.width,
    height: info.height,
  };
}
