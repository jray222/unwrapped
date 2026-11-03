import { withSystemContext, recordAuditLog } from '../db/index.js';
import {
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  normalizeRecoveryCodeHash,
} from '../security/crypto.js';
import { issueRecoveryCodes } from './recovery-codes.js';

/** Generates and stores a new (not yet enabled) TOTP secret for the user. */
export async function createTotpSetup(user: { id: string; email: string }) {
  const secret = generateTotpSecret();
  const otpauthUri = generateTotpUri(user.email, secret);
  return { secret, otpauthUri };
}

export async function storeTotpSecret(userId: string, secret: string): Promise<void> {
  await withSystemContext(async (client) => {
    await client.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, userId]);
  });
}

/**
 * Verifies the first TOTP code, enables TOTP, marks the session MFA-verified and issues recovery codes.
 * Returns the raw recovery codes, or null when the code is invalid.
 */
export async function enableTotp(
  userId: string,
  sessionId: string,
  code: string
): Promise<string[] | null> {
  const result = await withSystemContext(async (client) => {
    const uRes = await client.query('SELECT totp_secret FROM users WHERE id = $1', [userId]);
    const secret = uRes.rows[0]?.totp_secret;
    if (!secret || !verifyTotpCode(code, secret)) {
      return null;
    }

    await client.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [userId]);
    await client.query('UPDATE sessions SET mfa_verified = TRUE WHERE id = $1', [sessionId]);

    return issueRecoveryCodes(client, userId);
  });
  return result;
}

/** Verifies a TOTP code on subsequent logins and records MFA login audit logs. */
export async function verifyTotpLogin(
  user: { id: string; first_name: string; last_name: string },
  sessionId: string,
  code: string
): Promise<boolean> {
  return withSystemContext(async (client) => {
    const uRes = await client.query('SELECT totp_secret FROM users WHERE id = $1', [user.id]);
    const secret = uRes.rows[0]?.totp_secret;
    if (!secret || !verifyTotpCode(code, secret)) {
      return false;
    }

    await client.query('UPDATE sessions SET mfa_verified = TRUE WHERE id = $1', [sessionId]);

    // Record audit logs for all families the user belongs to
    const memRes = await client.query('SELECT family_id FROM family_members WHERE user_id = $1', [
      user.id,
    ]);
    const actorLabel = `${user.first_name} ${user.last_name}`.trim();
    for (const row of memRes.rows) {
      await recordAuditLog(client, {
        familyId: row.family_id,
        actorUserId: user.id,
        actorLabel,
        action: 'USER_LOGIN_MFA',
        metadata: { method: 'totp' },
      });
    }

    return true;
  });
}

/** Redeems a single-use recovery code and marks the session MFA-verified. */
export async function redeemRecoveryCode(
  userId: string,
  sessionId: string,
  recoveryCode: string
): Promise<boolean> {
  const normalizedHash = normalizeRecoveryCodeHash(recoveryCode);

  return withSystemContext(async (client) => {
    const result = await client.query(
      `SELECT id FROM recovery_codes
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, normalizedHash]
    );
    if (result.rows.length === 0) return false;

    const codeId = result.rows[0].id;
    await client.query('UPDATE recovery_codes SET used_at = NOW() WHERE id = $1', [codeId]);
    await client.query('UPDATE sessions SET mfa_verified = TRUE WHERE id = $1', [sessionId]);
    return true;
  });
}
