import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { withSystemContext, recordAuditLog } from '../db/index.js';
import { hashToken } from '../security/crypto.js';
import { HttpError } from '../errors.js';
import { createUserSession } from './sessions.js';
import { upsertFamilyMember, markInviteUsed } from './invites.js';

export const GOOGLE_OAUTH_STATE_COOKIE = 'unwrapped_oauth_state';

function googleRedirectUri(): string {
  return `${config.origin.replace(/\/$/, '')}/api/auth/google/callback`;
}

export function isGoogleConfigured(): boolean {
  return !(!config.googleClientId || config.googleClientId === 'mock-google-client-id');
}

/** Builds the Google authorization URL for the given state token. */
export function buildGoogleAuthUrl(stateToken: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state: stateToken,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchanges an auth code for a verified Google profile, or returns an error redirect code. */
export async function fetchGoogleProfile(
  code: string
): Promise<{ profile: any } | { errorCode: string }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!tokenRes.ok) {
    return { errorCode: 'google_token_exchange_failed' };
  }

  const tokenData: any = await tokenRes.json();
  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    return { errorCode: 'google_userinfo_failed' };
  }

  const profile: any = await userRes.json();
  if (profile.email_verified !== true || !profile.email || !profile.sub) {
    return { errorCode: 'google_email_unverified' };
  }
  return { profile };
}

/**
 * Signs in (or accepts a pending invite for) the verified Google profile from the redirect flow.
 * Throws HttpError with `code` for redirect-style failures.
 */
export async function signInWithGoogleProfile(profile: any, pendingInviteToken: string | null) {
  const normalizedEmail = String(profile.email).toLowerCase().trim();
  const trimmedFirst = String(profile.given_name || profile.name || 'Member').trim();
  const trimmedLast = String(profile.family_name || '').trim();

  return withSystemContext(async (client) => {
    let userId: string;
    if (pendingInviteToken) {
      const inviteTokenHash = hashToken(pendingInviteToken);
      const inviteRes = await client.query(
        `SELECT id, family_id, email, role FROM invites
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [inviteTokenHash]
      );
      if (inviteRes.rows.length === 0) {
        throw new HttpError(400, undefined, 'invalid_invite');
      }
      const invite = inviteRes.rows[0];
      if (invite.email.toLowerCase().trim() !== normalizedEmail) {
        throw new HttpError(403, undefined, 'invite_email_mismatch');
      }

      const existingUser = await client.query(`SELECT id FROM users WHERE email = $1`, [
        normalizedEmail,
      ]);
      if (existingUser.rows.length > 0) {
        userId = existingUser.rows[0].id;
        await client.query(`UPDATE users SET google_sub = $1 WHERE id = $2`, [profile.sub, userId]);
      } else {
        userId = randomUUID();
        await client.query(
          `INSERT INTO users (id, email, first_name, last_name, google_sub, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
          [userId, normalizedEmail, trimmedFirst, trimmedLast, profile.sub]
        );
      }

      await upsertFamilyMember(client, invite.family_id, userId, invite.role);
      await markInviteUsed(client, invite.id);
    } else {
      const existingUser = await client.query(
        `SELECT id, google_sub FROM users WHERE google_sub = $1 OR email = $2`,
        [profile.sub, normalizedEmail]
      );
      if (existingUser.rows.length === 0) {
        throw new HttpError(403, undefined, 'invite_required');
      }
      userId = existingUser.rows[0].id;
      if (!existingUser.rows[0].google_sub) {
        await client.query(`UPDATE users SET google_sub = $1 WHERE id = $2`, [profile.sub, userId]);
      }
    }

    const session = await createUserSession(client, userId, true);
    return { rawSessionToken: session.rawSessionToken, maxAgeMs: session.maxAgeMs };
  });
}

/**
 * Handles the Google OIDC / ID-token POST flow: attaches to an invite or an existing account
 * and issues a verified (mfa_verified = TRUE) session.
 */
export async function signInWithGoogleIdentity(input: {
  inviteToken: any;
  email: any;
  googleSub: any;
  firstName: any;
  lastName: any;
}) {
  const { inviteToken, email, googleSub, firstName, lastName } = input;
  const normalizedEmail = String(email).toLowerCase().trim();
  const trimmedFirst = String(firstName || 'User').trim();
  const trimmedLast = String(lastName || '').trim();

  return withSystemContext(async (client) => {
    let userId: string;
    let userObj: any;

    if (inviteToken) {
      const inviteTokenHash = hashToken(inviteToken);
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

      if (invite.email.toLowerCase().trim() !== normalizedEmail) {
        throw new HttpError(403, 'Google account email does not match invite email');
      }

      // Check if user already exists
      const userRes = await client.query(`SELECT id FROM users WHERE email = $1`, [
        normalizedEmail,
      ]);

      if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
        const updated = await client.query(
          `UPDATE users
             SET google_sub = $1,
                 first_name = COALESCE(NULLIF($2, ''), first_name),
                 last_name = COALESCE(NULLIF($3, ''), last_name)
             WHERE id = $4
             RETURNING id, email, first_name, last_name, totp_enabled, passkey_enrolled`,
          [googleSub, trimmedFirst, trimmedLast, userId]
        );
        userObj = updated.rows[0];
      } else {
        userId = randomUUID();
        const inserted = await client.query(
          `INSERT INTO users (id, email, first_name, last_name, google_sub, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id, email, first_name, last_name, totp_enabled, passkey_enrolled`,
          [userId, normalizedEmail, trimmedFirst, trimmedLast, googleSub]
        );
        userObj = inserted.rows[0];
      }

      await upsertFamilyMember(client, invite.family_id, userId, invite.role);
      await markInviteUsed(client, invite.id);

      // Audit log
      const actorLabel = `${userObj.first_name} ${userObj.last_name}`.trim();
      await recordAuditLog(client, {
        familyId: invite.family_id,
        actorUserId: userId,
        actorLabel,
        action: 'USER_JOINED_VIA_INVITE',
        metadata: { method: 'google', email: normalizedEmail, role: invite.role },
      });
    } else {
      // No invite token: must already exist
      const userRes = await client.query(
        `SELECT id, email, first_name, last_name, google_sub, totp_enabled, passkey_enrolled
           FROM users
           WHERE google_sub = $1 OR email = $2`,
        [googleSub, normalizedEmail]
      );
      if (userRes.rows.length === 0) {
        throw new HttpError(403, 'No account found. You must be invited to join Unwrapped.');
      }
      const existing = userRes.rows[0];
      userId = existing.id;

      if (!existing.google_sub) {
        await client.query(`UPDATE users SET google_sub = $1 WHERE id = $2`, [googleSub, userId]);
      }
      userObj = existing;
    }

    // Create verified session (Google OIDC is pre-verified MFA)
    const session = await createUserSession(client, userId, true);

    return {
      user: {
        id: userObj.id,
        email: userObj.email,
        first_name: userObj.first_name,
        last_name: userObj.last_name,
        totp_enabled: userObj.totp_enabled,
        passkey_enrolled: userObj.passkey_enrolled,
        mfa_enrolled: true,
      },
      sessionToken: session.rawSessionToken,
      csrfToken: session.csrfToken,
      maxAgeMs: session.maxAgeMs,
    };
  });
}
