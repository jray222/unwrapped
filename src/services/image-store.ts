import { randomUUID } from 'node:crypto';
import { withFamilyContext } from '../db/index.js';

export interface SanitizedImageRecord {
  mimeType: string;
  data: Buffer;
  width: number;
  height: number;
}

/** Persist a sanitized image under the family's tenant context; returns the new image id. */
export async function storeSanitizedImage(
  familyId: string,
  userId: string,
  sanitized: SanitizedImageRecord
): Promise<string> {
  const imageId = randomUUID();
  await withFamilyContext(familyId, async (client) => {
    await client.query(
      `INSERT INTO images (id, family_id, mime_type, data, width, height, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        imageId,
        familyId,
        sanitized.mimeType,
        sanitized.data,
        sanitized.width,
        sanitized.height,
        userId,
      ]
    );
  });
  return imageId;
}
