import { randomUUID } from 'node:crypto';
import { withSystemContext, recordAuditLog } from '../db/index.js';
import { generateToken, hashToken } from '../security/crypto.js';
import { HttpError } from '../errors.js';
import { createUserSession } from './sessions.js';
import { markInviteUsed } from './invites.js';
import { issueRecoveryCodes } from './recovery-codes.js';

/**
 * Redeems an admin-assisted enrollment token: enrolls a passkey, marks the invite used,
 * creates a verified session and returns recovery codes.
 */
export async function redeemAssistedEnrollment(input: {
  token: string;
  firstName: any;
  deviceName: any;
  credentialId: any;
  publicKey: any;
}) {
  const { token, firstName, deviceName, credentialId, publicKey } = input;
  const tokenHash = hashToken(token);

  return withSystemContext(async (client) => {
    const inviteRes = await client.query(
      `SELECT id, family_id, email, target_user_id
         FROM invites
         WHERE token_hash = $1 AND is_assisted_enrollment = TRUE AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (inviteRes.rows.length === 0) {
      throw new HttpError(404, 'Assisted enrollment link not found or expired');
    }

    const invite = inviteRes.rows[0];
    const normalizedEmail = invite.email.toLowerCase().trim();

    let userId = invite.target_user_id;
    let userRecord: any;

    if (userId) {
      const uRes = await client.query(
        `SELECT id, email, first_name, last_name FROM users WHERE id = $1`,
        [userId]
      );
      userRecord = uRes.rows[0];
    } else {
      const uRes = await client.query(
        `SELECT id, email, first_name, last_name FROM users WHERE email = $1`,
        [normalizedEmail]
      );
      userRecord = uRes.rows[0];
    }

    if (!userRecord) {
      userId = randomUUID();
      const fName = String(firstName || 'Relative').trim();
      const inserted = await client.query(
        `INSERT INTO users (id, email, first_name, last_name, passkey_enrolled, created_at)
           VALUES ($1, $2, $3, '', TRUE, NOW())
           RETURNING id, email, first_name, last_name`,
        [userId, normalizedEmail, fName]
      );
      userRecord = inserted.rows[0];
    } else {
      userId = userRecord.id;
      if (firstName && typeof firstName === 'string' && firstName.trim()) {
        const updated = await client.query(
          `UPDATE users SET first_name = $1 WHERE id = $2 RETURNING id, email, first_name, last_name`,
          [firstName.trim(), userId]
        );
        userRecord = updated.rows[0];
      }
    }

    // Ensure membership in family
    await client.query(
      `INSERT INTO family_members (id, family_id, user_id, role, created_at)
         VALUES ($1, $2, $3, 'member', NOW())
         ON CONFLICT (family_id, user_id) DO NOTHING`,
      [randomUUID(), invite.family_id, userId]
    );

    // Enroll passkey if provided or set passkey_enrolled = true
    const credId = credentialId || generateToken(16);
    const pubKey = publicKey || generateToken(32);
    const devName = deviceName && typeof deviceName === 'string' ? deviceName.trim() : 'Passkey';

    await client.query(
      `INSERT INTO passkey_credentials (id, user_id, public_key, device_name, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO UPDATE SET public_key = EXCLUDED.public_key`,
      [credId, userId, pubKey, devName]
    );

    await client.query('UPDATE users SET passkey_enrolled = TRUE WHERE id = $1', [userId]);

    // Mark invite used
    await markInviteUsed(client, invite.id);

    // Generate 8 recovery codes
    const rawCodes = await issueRecoveryCodes(client, userId);

    // Create verified session
    const session = await createUserSession(client, userId, true);

    // Audit log
    const actorLabel = `${userRecord.first_name} ${userRecord.last_name}`.trim();
    await recordAuditLog(client, {
      familyId: invite.family_id,
      actorUserId: userId,
      actorLabel,
      action: 'ADMIN_ASSISTED_ENROLLMENT_COMPLETED',
      metadata: { email: normalizedEmail, credentialId: credId },
    });

    return {
      sessionToken: session.rawSessionToken,
      csrfToken: session.csrfToken,
      maxAgeMs: session.maxAgeMs,
      user: {
        id: userRecord.id,
        email: userRecord.email,
        first_name: userRecord.first_name,
        last_name: userRecord.last_name,
      },
      recoveryCodes: rawCodes,
    };
  });
}
