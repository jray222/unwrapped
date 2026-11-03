import { randomUUID } from 'node:crypto';
import type { DbClient } from '../db/index.js';
import { extractFirstName } from '../security/surprise.js';
import type { RawClaimRow, RawPledgeRow, RawAssignmentRow } from '../security/surprise.js';

export interface ItemGiverRecords {
  claims: RawClaimRow[];
  pledges: RawPledgeRow[];
  assignments: RawAssignmentRow[];
}

/** Load claims, pledges and active assignments for an item. */
export async function loadItemGivers(client: DbClient, itemId: string): Promise<ItemGiverRecords> {
  const claimsRes = await client.query<RawClaimRow>(`SELECT * FROM claims WHERE item_id = $1`, [
    itemId,
  ]);
  const pledgesRes = await client.query<RawPledgeRow>(`SELECT * FROM pledges WHERE item_id = $1`, [
    itemId,
  ]);
  const assignsRes = await client.query<RawAssignmentRow>(
    `SELECT * FROM assignments WHERE item_id = $1 AND status != 'couldnt_get_it'`,
    [itemId]
  );
  return { claims: claimsRes.rows, pledges: pledgesRes.rows, assignments: assignsRes.rows };
}

/**
 * Notify every giver (claimer/pledger/assigner) of an item that the recipient changed it.
 * The acting user is never notified. Does nothing when the item has no givers.
 */
export async function notifyItemGivers(
  client: DbClient,
  opts: {
    familyId: string;
    currentUserId: string;
    givers: ItemGiverRecords;
    list: { recipient_first_name: string; name: string };
    itemName: string;
    verb: 'updated' | 'removed';
  }
): Promise<void> {
  const { familyId, currentUserId, givers, list, itemName, verb } = opts;
  const hasGivers =
    givers.claims.length > 0 || givers.pledges.length > 0 || givers.assignments.length > 0;
  if (!hasGivers) return;

  const affectedUserIds = new Set<string>();
  const affectedGuestLinkIds = new Set<string>();

  for (const c of givers.claims) {
    if (c.claimer_user_id) affectedUserIds.add(c.claimer_user_id);
    if (c.claimer_guest_link_id) affectedGuestLinkIds.add(c.claimer_guest_link_id);
  }
  for (const p of givers.pledges) {
    if (p.pledger_user_id) affectedUserIds.add(p.pledger_user_id);
    if (p.pledger_guest_link_id) affectedGuestLinkIds.add(p.pledger_guest_link_id);
  }
  for (const a of givers.assignments) {
    if (a.assigner_user_id) affectedUserIds.add(a.assigner_user_id);
  }

  // Do not notify current user if they changed the item
  affectedUserIds.delete(currentUserId);

  const noticeMsg = `Heads up: ${extractFirstName(list.recipient_first_name)} ${verb} the item '${itemName}' that you claimed/pledged on '${list.name}'.`;

  for (const targetUserId of affectedUserIds) {
    await client.query(
      `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
       VALUES ($1, $2, $3, null, $4, false, NOW())`,
      [randomUUID(), familyId, targetUserId, noticeMsg]
    );
  }
  for (const targetGuestLinkId of affectedGuestLinkIds) {
    await client.query(
      `INSERT INTO notifications (id, family_id, target_user_id, target_guest_link_id, message, is_read, created_at)
       VALUES ($1, $2, null, $3, $4, false, NOW())`,
      [randomUUID(), familyId, targetGuestLinkId, noticeMsg]
    );
  }
}
