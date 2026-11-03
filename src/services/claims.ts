import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../types.js';
import { withFamilyContext, withSystemContext, recordAuditLog } from '../db/index.js';
import { HttpError } from '../errors.js';
import {
  extractFirstName,
  type RawItemRow,
  type RawClaimRow,
} from '../security/surprise.js';
import { resolveGiverIdentity, canManageClaim } from './giver-identity.js';

interface DbClaimRow extends RawClaimRow {
  list_id: string;
  family_id: string;
}

/** Returns null when the item does not exist (caller responds 404). */
export async function getStoreClickInfo(familyId: string, itemId: string) {
  return withFamilyContext(familyId, async (client) => {
    const itemRes = await client.query<RawItemRow>(
      `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
      [itemId, familyId]
    );
    if (itemRes.rows.length === 0) return null;
    const item = itemRes.rows[0];

    const claimSumRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as sum FROM claims WHERE item_id = $1`,
      [itemId]
    );
    const pledgeSumRes = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::int as sum FROM pledges WHERE item_id = $1`,
      [itemId]
    );

    const claimedCount = claimSumRes.rows[0].sum;
    const pledgedCents = pledgeSumRes.rows[0].sum;
    const isFullyPledged = Boolean(
      item.price_cents && item.price_cents > 0 && pledgedCents >= item.price_cents
    );
    const isTaken =
      !item.allow_duplicates &&
      !item.is_catch_all &&
      (claimedCount >= item.quantity || isFullyPledged);

    return {
      storeUrl: item.store_url,
      promptType: isTaken ? 'BUY_ANYWAY_CONFIRM' : 'ARE_YOU_GETTING_THIS',
      message: isTaken ? 'This item is already claimed. Buy anyway?' : 'Are you getting this?',
    };
  });
}

/**
 * Claim an item. Critical Surprise Rule: Recipient claiming check MUST happen before claimed check.
 * Returns null for 404; throws HttpError 403/409.
 */
export async function claimItem(
  auth: AuthContext | undefined,
  familyId: string,
  itemId: string,
  body: any
) {
  return withFamilyContext(familyId, async (client) => {
    const itemRes = await client.query<RawItemRow>(
      `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
      [itemId, familyId]
    );
    if (itemRes.rows.length === 0) return null;
    const item = itemRes.rows[0];

    const listRes = await client.query(
      `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
      [item.list_id, familyId]
    );
    if (listRes.rows.length === 0) return null;
    const list = listRes.rows[0];

    // CRITICAL SURPRISE RULE: Recipient cannot claim items on their own wish list
    if (auth?.user && list.recipient_user_id === auth.user.id) {
      throw new HttpError(403, 'Cannot claim items on your own wish list');
    }

    // Guest list restriction check
    if (
      auth?.kind === 'guest' &&
      auth.guestLink?.allowed_list_ids &&
      auth.guestLink.allowed_list_ids.length > 0 &&
      !auth.guestLink.allowed_list_ids.includes(list.id)
    ) {
      return null;
    }

    const quantity = Math.max(1, parseInt(String(body.quantity), 10) || 1);

    if (!item.allow_duplicates && !item.is_catch_all) {
      const claimCountRes = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int as count FROM claims WHERE item_id = $1`,
        [itemId]
      );
      const currentClaimed = claimCountRes.rows[0].count;
      if (currentClaimed + quantity > item.quantity) {
        throw new HttpError(409, 'Item is already claimed');
      }
    }

    const {
      userId: claimerUserId,
      guestLinkId: claimerGuestLinkId,
      firstName: claimerFirstName,
    } = resolveGiverIdentity(auth);

    const claimId = randomUUID();
    const bought = Boolean(body.bought);

    const insertRes = await client.query<RawClaimRow>(
      `INSERT INTO claims (
        id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
        assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, false, NOW())
      RETURNING *`,
      [
        claimId,
        familyId,
        list.id,
        itemId,
        claimerUserId,
        claimerGuestLinkId,
        claimerFirstName,
        quantity,
        bought,
      ]
    );

    await recordAuditLog(client, {
      familyId,
      actorUserId: claimerUserId,
      actorLabel: claimerFirstName,
      action: 'ITEM_CLAIMED',
      targetRecipientUserId: list.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { itemId, listId: list.id, quantity, bought },
    });

    return insertRes.rows[0];
  });
}

/** Look up a claim's family when the route carries no familyId. */
export async function findFamilyIdForClaim(claimId: string): Promise<string | undefined> {
  let familyId: string | undefined;
  await withSystemContext(async (sysClient) => {
    const cRes = await sysClient.query('SELECT family_id FROM claims WHERE id = $1', [claimId]);
    if (cRes.rows.length > 0) familyId = cRes.rows[0].family_id;
  });
  return familyId;
}

/** Release (delete) a claim. Returns null for 404; throws HttpError 403. */
export async function releaseClaim(
  auth: AuthContext | undefined,
  familyId: string,
  claimId: string
) {
  return withFamilyContext(familyId, async (client) => {
    const claimRes = await client.query<DbClaimRow>(
      `SELECT * FROM claims WHERE id = $1 AND family_id = $2`,
      [claimId, familyId]
    );
    if (claimRes.rows.length === 0) return null;
    const claim = claimRes.rows[0];

    const listRes = await client.query(
      `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
      [claim.list_id, familyId]
    );
    if (listRes.rows.length === 0) return null;
    const list = listRes.rows[0];

    if (!canManageClaim(auth, familyId, claim)) {
      throw new HttpError(403, 'Not authorized to release this claim');
    }

    if (claim.assignment_id) {
      await client.query(
        `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1`,
        [claim.assignment_id]
      );
    }

    await client.query(`DELETE FROM claims WHERE id = $1`, [claimId]);

    const actorLabel =
      auth?.kind === 'user' && auth.user
        ? extractFirstName(auth.user.first_name)
        : auth?.kind === 'guest' && auth.guestLink
          ? extractFirstName(auth.guestLink.guest_first_name)
          : 'Someone';

    await recordAuditLog(client, {
      familyId,
      actorUserId: auth?.user?.id ?? null,
      actorLabel,
      action: 'ITEM_RELEASED',
      targetRecipientUserId: list.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { claimId, itemId: claim.item_id },
    });

    return true;
  });
}

/** Update bought status on a claim. Returns null for 404; throws HttpError 403. */
export async function updateClaimBought(
  auth: AuthContext | undefined,
  familyId: string,
  claimId: string,
  bought: boolean
) {
  return withFamilyContext(familyId, async (client) => {
    const claimRes = await client.query<DbClaimRow>(
      `SELECT * FROM claims WHERE id = $1 AND family_id = $2`,
      [claimId, familyId]
    );
    if (claimRes.rows.length === 0) return null;
    const c = claimRes.rows[0];

    if (!canManageClaim(auth, familyId, c)) {
      throw new HttpError(403, 'Not authorized to update this claim');
    }

    const updRes = await client.query<RawClaimRow>(
      `UPDATE claims SET bought = $1 WHERE id = $2 RETURNING *`,
      [bought, claimId]
    );

    if (c.assignment_id) {
      await client.query(`UPDATE assignments SET status = $1, updated_at = NOW() WHERE id = $2`, [
        bought ? 'bought' : 'assigned',
        c.assignment_id,
      ]);
    }

    return updRes.rows[0];
  });
}
