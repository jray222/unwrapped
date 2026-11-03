import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../types.js';
import { withFamilyContext, recordAuditLog } from '../db/index.js';
import { HttpError } from '../errors.js';
import { type RawItemRow, type RawPledgeRow } from '../security/surprise.js';
import { resolveGiverIdentity } from './giver-identity.js';

/**
 * Group gifting pledge. Critical Surprise Rule: Recipient cannot pledge toward own wish list.
 * Returns null for 404; throws HttpError 403.
 */
export async function createPledge(
  auth: AuthContext | undefined,
  familyId: string,
  itemId: string,
  amountCents: number,
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

    // CRITICAL SURPRISE RULE: Recipient cannot pledge toward items on their own wish list
    if (auth?.user && list.recipient_user_id === auth.user.id) {
      throw new HttpError(403, 'Cannot pledge toward items on your own wish list');
    }

    const {
      userId: pledgerUserId,
      guestLinkId: pledgerGuestLinkId,
      firstName: pledgerFirstName,
    } = resolveGiverIdentity(auth);

    const pledgeId = randomUUID();
    const note = body.note ? String(body.note).trim() : '';

    const insertRes = await client.query<RawPledgeRow>(
      `INSERT INTO pledges (
        id, family_id, list_id, item_id, pledger_user_id, pledger_guest_link_id,
        pledger_first_name, amount_cents, note, thank_you_sent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW())
      RETURNING *`,
      [
        pledgeId,
        familyId,
        list.id,
        itemId,
        pledgerUserId,
        pledgerGuestLinkId,
        pledgerFirstName,
        amountCents,
        note,
      ]
    );

    const sumRes = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::int as total FROM pledges WHERE item_id = $1`,
      [itemId]
    );
    const totalPledgedCents = sumRes.rows[0].total;

    await recordAuditLog(client, {
      familyId,
      actorUserId: pledgerUserId,
      actorLabel: pledgerFirstName,
      action: 'ITEM_PLEDGED',
      targetRecipientUserId: list.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { itemId, listId: list.id, amountCents, note },
    });

    return {
      pledge: insertRes.rows[0],
      totalPledgedCents,
      priceCents: item.price_cents,
    };
  });
}
