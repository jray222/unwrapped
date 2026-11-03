import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../types.js';
import { withFamilyContext, withSystemContext, recordAuditLog } from '../db/index.js';
import { type RawItemRow, type RawClaimRow } from '../security/surprise.js';
import { resolveGiverIdentity } from './giver-identity.js';
import { extractFirstName } from '../security/surprise.js';

export interface OfflineSyncResult {
  type: string;
  success: boolean;
  error?: string;
}

async function lookupFamilyId(table: 'claims' | 'assignments', id: string) {
  let fId: string | undefined;
  await withSystemContext(async (sysClient) => {
    const res = await sysClient.query(`SELECT family_id FROM ${table} WHERE id = $1`, [id]);
    if (res.rows.length > 0) fId = res.rows[0].family_id;
  });
  return fId;
}

async function markBought(action: any): Promise<void> {
  if (action.claimId) {
    let fId = action.familyId;
    if (!fId) fId = await lookupFamilyId('claims', action.claimId);
    if (!fId) throw new Error('Claim not found or missing familyId');

    await withFamilyContext(fId, async (client) => {
      const cRes = await client.query<RawClaimRow>('SELECT * FROM claims WHERE id = $1', [
        action.claimId,
      ]);
      if (cRes.rows.length === 0) throw new Error('Claim not found');
      const claim = cRes.rows[0];

      await client.query('UPDATE claims SET bought = true WHERE id = $1', [action.claimId]);
      if (claim.assignment_id) {
        await client.query(
          `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
          [claim.assignment_id]
        );
      }
    });
  } else if (action.assignmentId) {
    let fId = action.familyId;
    if (!fId) fId = await lookupFamilyId('assignments', action.assignmentId);
    if (!fId) throw new Error('Assignment not found or missing familyId');

    await withFamilyContext(fId, async (client) => {
      await client.query(
        `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
        [action.assignmentId]
      );
      await client.query('UPDATE claims SET bought = true WHERE assignment_id = $1', [
        action.assignmentId,
      ]);
    });
  } else {
    throw new Error('MARK_BOUGHT requires claimId or assignmentId');
  }
}

async function claimItemOffline(auth: AuthContext, action: any): Promise<void> {
  const { itemId, familyId } = action;
  if (!itemId || !familyId) {
    throw new Error('CLAIM_ITEM requires itemId and familyId');
  }

  await withFamilyContext(familyId, async (client) => {
    const itemRes = await client.query<RawItemRow>(
      'SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false',
      [itemId, familyId]
    );
    if (itemRes.rows.length === 0) throw new Error('Item not found');
    const item = itemRes.rows[0];

    const listRes = await client.query('SELECT * FROM lists WHERE id = $1 AND family_id = $2', [
      item.list_id,
      familyId,
    ]);
    if (listRes.rows.length === 0) throw new Error('List not found');
    const list = listRes.rows[0];

    if (auth.user && list.recipient_user_id === auth.user.id) {
      throw new Error('Cannot claim items on your own wish list');
    }

    const quantity = Math.max(1, parseInt(String(action.quantity), 10) || 1);
    if (!item.allow_duplicates && !item.is_catch_all) {
      const claimSumRes = await client.query(
        'SELECT COALESCE(SUM(quantity), 0)::int as count FROM claims WHERE item_id = $1',
        [itemId]
      );
      if (claimSumRes.rows[0].count + quantity > item.quantity) {
        throw new Error('Item is already claimed');
      }
    }

    const {
      userId: claimerUserId,
      guestLinkId: claimerGuestLinkId,
      firstName: claimerFirstName,
    } = resolveGiverIdentity(auth);

    const claimId = randomUUID();
    await client.query(
      `INSERT INTO claims (
        id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
        assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, false, NOW())`,
      [
        claimId,
        familyId,
        list.id,
        itemId,
        claimerUserId,
        claimerGuestLinkId,
        claimerFirstName,
        quantity,
        Boolean(action.bought),
      ]
    );

    await recordAuditLog(client, {
      familyId,
      actorUserId: claimerUserId,
      actorLabel: claimerFirstName,
      action: 'ITEM_CLAIMED',
      targetRecipientUserId: list.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { itemId, listId: list.id, quantity, offline: true },
    });
  });
}

async function updateAssignmentOffline(auth: AuthContext, action: any): Promise<void> {
  const { assignmentId, status } = action;
  if (!assignmentId || !status) {
    throw new Error('UPDATE_ASSIGNMENT requires assignmentId and status');
  }

  let fId = action.familyId;
  if (!fId) fId = await lookupFamilyId('assignments', assignmentId);
  if (!fId) throw new Error('Assignment not found or missing familyId');

  await withFamilyContext(fId, async (client) => {
    const aRes = await client.query(
      `SELECT a.*, l.recipient_user_id
       FROM assignments a
       JOIN lists l ON l.id = a.list_id
       WHERE a.id = $1 AND a.family_id = $2`,
      [assignmentId, fId]
    );
    if (aRes.rows.length === 0) throw new Error('Assignment not found');
    const assignment = aRes.rows[0];

    if (status === 'bought') {
      await client.query(
        `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1`,
        [assignmentId]
      );
      await client.query('UPDATE claims SET bought = true WHERE assignment_id = $1', [
        assignmentId,
      ]);
    } else if (status === 'couldnt_get_it') {
      await client.query(
        `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1`,
        [assignmentId]
      );
      await client.query('DELETE FROM claims WHERE assignment_id = $1', [assignmentId]);
    } else if (status === 'assigned') {
      await client.query(
        `UPDATE assignments SET status = 'assigned', updated_at = NOW() WHERE id = $1`,
        [assignmentId]
      );
      await client.query('UPDATE claims SET bought = false WHERE assignment_id = $1', [
        assignmentId,
      ]);
    } else {
      throw new Error(`Invalid assignment status: ${status}`);
    }

    await recordAuditLog(client, {
      familyId: fId,
      actorUserId: auth.user?.id ?? null,
      actorLabel:
        auth.kind === 'user' && auth.user ? extractFirstName(auth.user.first_name) : 'Assignee',
      action: 'ASSIGNMENT_UPDATED',
      targetRecipientUserId: assignment.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { assignmentId, status, offline: true },
    });
  });
}

/** Replay queued offline actions; per-action failures are reported, never thrown. */
export async function processOfflineActions(auth: AuthContext, actions: any[]) {
  const results: OfflineSyncResult[] = [];
  let syncedCount = 0;

  for (const action of actions) {
    try {
      if (!action || typeof action !== 'object') {
        results.push({ type: 'UNKNOWN', success: false, error: 'Invalid action payload' });
        continue;
      }

      if (action.type === 'MARK_BOUGHT') {
        await markBought(action);
      } else if (action.type === 'CLAIM_ITEM') {
        await claimItemOffline(auth, action);
      } else if (action.type === 'UPDATE_ASSIGNMENT') {
        await updateAssignmentOffline(auth, action);
      } else {
        results.push({
          type: action.type || 'UNKNOWN',
          success: false,
          error: 'Unknown action type',
        });
        continue;
      }

      syncedCount++;
      results.push({ type: action.type, success: true });
    } catch (err: any) {
      results.push({
        type: action?.type || 'UNKNOWN',
        success: false,
        error: err.message || 'Action failed',
      });
    }
  }

  return { syncedCount, results };
}
