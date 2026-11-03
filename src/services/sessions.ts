import { randomUUID } from 'node:crypto';
import type { DbClient } from '../db/index.js';
import { generateToken, hashToken } from '../security/crypto.js';

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  rawSessionToken: string;
  csrfToken: string;
  maxAgeMs: number;
}

/**
 * Creates a `user` session row. Only the SHA-256 hash of the session token is stored.
 * mfaVerified = false yields a pre-MFA session.
 */
export async function createUserSession(
  client: DbClient,
  userId: string,
  mfaVerified: boolean
): Promise<CreatedSession> {
  const rawSessionToken = generateToken(32);
  const csrfToken = generateToken(32);
  const sessionTokenHash = hashToken(rawSessionToken);
  const sessionId = randomUUID();
  const maxAgeMs = SESSION_MAX_AGE_MS;
  const expiresAt = new Date(Date.now() + maxAgeMs);

  const sql = mfaVerified
    ? `INSERT INTO sessions (id, token_hash, csrf_token, kind, user_id, mfa_verified, expires_at, created_at)
         VALUES ($1, $2, $3, 'user', $4, TRUE, $5, NOW())`
    : `INSERT INTO sessions (id, token_hash, csrf_token, kind, user_id, mfa_verified, expires_at, created_at)
         VALUES ($1, $2, $3, 'user', $4, FALSE, $5, NOW())`;
  await client.query(sql, [sessionId, sessionTokenHash, csrfToken, userId, expiresAt]);

  return { rawSessionToken, csrfToken, maxAgeMs };
}
