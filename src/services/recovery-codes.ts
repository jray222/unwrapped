import { randomUUID } from 'node:crypto';
import type { DbClient } from '../db/index.js';
import { generateRecoveryCodes } from '../security/crypto.js';

/** Generates 8 recovery codes, stores their hashes, and returns the raw codes (shown once). */
export async function issueRecoveryCodes(client: DbClient, userId: string): Promise<string[]> {
  const { rawCodes, hashedCodes } = generateRecoveryCodes(8);
  for (const hashedCode of hashedCodes) {
    await client.query(
      `INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
           VALUES ($1, $2, $3, NOW())`,
      [randomUUID(), userId, hashedCode]
    );
  }
  return rawCodes;
}
