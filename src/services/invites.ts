import { randomUUID } from 'node:crypto';
import type { DbClient } from '../db/index.js';

/** Adds (or updates the role of) a user in a family. */
export async function upsertFamilyMember(
  client: DbClient,
  familyId: string,
  userId: string,
  role: string
): Promise<void> {
  const memberId = randomUUID();
  await client.query(
    `INSERT INTO family_members (id, family_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (family_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [memberId, familyId, userId, role]
  );
}

export async function markInviteUsed(client: DbClient, inviteId: string): Promise<void> {
  await client.query(`UPDATE invites SET used_at = NOW() WHERE id = $1`, [inviteId]);
}
