import { randomUUID } from 'node:crypto';
import { withSystemContext, recordAuditLog } from '../db/index.js';
import { hashToken, hashPassword } from '../security/crypto.js';
import { HttpError } from '../errors.js';
import { createUserSession } from './sessions.js';
import { upsertFamilyMember, markInviteUsed } from './invites.js';

/** Looks up an open (unused, unexpired) invite by raw token for the public preview. */
export async function getInvitePreview(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  return withSystemContext(async (client) => {
    const result = await client.query(
      `SELECT i.id, i.email, i.role, i.is_assisted_enrollment, f.name AS family_name
         FROM invites i
         JOIN families f ON f.id = i.family_id
         WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW()`,
      [tokenHash]
    );
    return result.rows[0] || null;
  });
}

/**
 * Creates a local account (or fills in an existing one) from an invite, joins the family,
 * marks the invite used, and issues a pre-MFA session.
 */
export async function registerFromInvite(input: {
  inviteToken: string;
  firstName: unknown;
  lastName: unknown;
  password: string;
}) {
  const { inviteToken, firstName, lastName, password } = input;
  const inviteTokenHash = hashToken(inviteToken);
  const passwordHash = await hashPassword(password);
  const trimmedFirst = String(firstName).trim();
  const trimmedLast = String(lastName || '').trim();

  return withSystemContext(async (client) => {
    const inviteRes = await client.query(
      `SELECT i.id, i.family_id, i.email, i.role
         FROM invites i
         WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW()`,
      [inviteTokenHash]
    );
    if (inviteRes.rows.length === 0) {
      throw new HttpError(400, 'Invalid or expired invite');
    }
    const invite = inviteRes.rows[0];
    const normalizedEmail = invite.email.toLowerCase().trim();

    // Check if user already exists
    const userRes = await client.query(
      `SELECT id, email, first_name, last_name, password_hash FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    let userId: string;
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
      await client.query(
        `UPDATE users
           SET password_hash = COALESCE(password_hash, $1),
               first_name = COALESCE(NULLIF(first_name, ''), $2),
               last_name = COALESCE(NULLIF(last_name, ''), $3)
           WHERE id = $4`,
        [passwordHash, trimmedFirst, trimmedLast, userId]
      );
    } else {
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, first_name, last_name, password_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
        [userId, normalizedEmail, trimmedFirst, trimmedLast, passwordHash]
      );
    }

    await upsertFamilyMember(client, invite.family_id, userId, invite.role);
    await markInviteUsed(client, invite.id);

    // Record audit log
    const actorLabel = `${trimmedFirst} ${trimmedLast}`.trim();
    await recordAuditLog(client, {
      familyId: invite.family_id,
      actorUserId: userId,
      actorLabel,
      action: 'USER_JOINED_VIA_INVITE',
      metadata: { email: normalizedEmail, role: invite.role },
    });

    // Create session (mfa_verified = false, MFA enrollment required)
    const session = await createUserSession(client, userId, false);

    return {
      user: {
        id: userId,
        email: normalizedEmail,
        first_name: trimmedFirst,
        last_name: trimmedLast,
      },
      sessionToken: session.rawSessionToken,
      csrfToken: session.csrfToken,
      maxAgeMs: session.maxAgeMs,
    };
  });
}
