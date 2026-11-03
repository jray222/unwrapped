import { withFamilyContext } from '../db/index.js';
import {
  extractFirstName,
  serializeItem,
  type RawItemRow,
  type RawClaimRow,
  type RawPledgeRow,
  type RawAssignmentRow,
} from '../security/surprise.js';

/** Allowed lists for a guest link, with only first names of givers. */
export async function getGuestViewData(
  guestLinkId: string,
  familyId: string,
  guestFirstName: string,
  allowedListIds: string[] | null | undefined
) {
  return withFamilyContext(familyId, async (client) => {
    const famRes = await client.query('SELECT name FROM families WHERE id = $1', [familyId]);
    const familyName = famRes.rows.length > 0 ? famRes.rows[0].name : 'Family';

    let listsSql = 'SELECT * FROM lists WHERE family_id = $1';
    const params: any[] = [familyId];

    if (Array.isArray(allowedListIds) && allowedListIds.length > 0) {
      listsSql += ' AND id = ANY($2)';
      params.push(allowedListIds);
    }
    listsSql += ' ORDER BY created_at ASC';

    const listsRes = await client.query(listsSql, params);
    const serializedLists = [];

    for (const list of listsRes.rows) {
      const itemsRes = await client.query<RawItemRow>(
        'SELECT * FROM items WHERE list_id = $1 AND deleted_by_recipient = false ORDER BY created_at ASC, id ASC',
        [list.id]
      );
      const claimsRes = await client.query<RawClaimRow>(
        'SELECT * FROM claims WHERE list_id = $1 ORDER BY created_at ASC',
        [list.id]
      );
      const pledgesRes = await client.query<RawPledgeRow>(
        'SELECT * FROM pledges WHERE list_id = $1 ORDER BY created_at ASC',
        [list.id]
      );
      const assignsRes = await client.query<RawAssignmentRow>(
        'SELECT * FROM assignments WHERE list_id = $1 ORDER BY created_at ASC',
        [list.id]
      );

      const serializedItems = itemsRes.rows.map((item) => {
        const itemClaims = claimsRes.rows.filter((c) => c.item_id === item.id);
        const itemPledges = pledgesRes.rows.filter((p) => p.item_id === item.id);
        const itemAssigns = assignsRes.rows.filter((a) => a.item_id === item.id);

        return serializeItem({
          item,
          claims: itemClaims,
          pledges: itemPledges,
          assignments: itemAssigns,
          surpriseProtected: false,
          viewerUserId: null,
          viewerGuestLinkId: guestLinkId,
        });
      });

      const availableItems = serializedItems.filter((i: any) => !i.is_taken);
      const alreadyTakenItems = serializedItems.filter((i: any) => Boolean(i.is_taken));

      serializedLists.push({
        ...list,
        recipient_first_name: extractFirstName(list.recipient_first_name),
        items: serializedItems,
        availableItems,
        alreadyTakenItems,
      });
    }

    return {
      guestFirstName: extractFirstName(guestFirstName),
      familyId,
      familyName,
      lists: serializedLists,
    };
  });
}

/** Notifications for the current user or guest link. */
export async function getNotifications(
  familyId: string,
  auth: { kind?: string; user?: { id: string } | null; guestLink?: { id: string } | null } | undefined
) {
  return withFamilyContext(familyId, async (client) => {
    if (auth?.kind === 'user' && auth.user) {
      const nRes = await client.query(
        `SELECT * FROM notifications WHERE family_id = $1 AND target_user_id = $2 ORDER BY created_at DESC`,
        [familyId, auth.user.id]
      );
      return nRes.rows;
    } else if (auth?.kind === 'guest' && auth.guestLink) {
      const nRes = await client.query(
        `SELECT * FROM notifications WHERE family_id = $1 AND target_guest_link_id = $2 ORDER BY created_at DESC`,
        [familyId, auth.guestLink.id]
      );
      return nRes.rows;
    }
    return [];
  });
}
