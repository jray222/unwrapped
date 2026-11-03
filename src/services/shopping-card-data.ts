import { withFamilyContext } from '../db/index.js';
import { extractFirstName } from '../security/surprise.js';
import type { ShoppingCardParams, ShoppingCardItem } from './shopping-card.js';

function toCardItem(row: any): ShoppingCardItem {
  return {
    name: row.name || 'Untitled Item',
    store_name: row.store_name || '',
    price_cents: row.price_cents ?? null,
    notes: row.notes || '',
    priority: row.priority || 'nice_to_have',
    quantity: row.quantity && row.quantity >= 1 ? row.quantity : 1,
  };
}

/** Parse shopping-card query params (comma-separated ids and fallback name). */
export function parseShoppingCardQuery(query: Record<string, any>) {
  const splitIds = (v: unknown): string[] =>
    v
      ? String(v)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return {
    assignmentIds: splitIds(query.assignmentIds),
    itemIds: splitIds(query.itemIds),
    fallbackAssigneeFirstName: query.assigneeFirstName
      ? String(query.assigneeFirstName).trim()
      : 'Assignee',
  };
}

/** Fetch items and context for shopping card generation. Null when nothing found. */
export async function getShoppingCardData(
  familyId: string,
  assignmentIds: string[],
  itemIds: string[],
  fallbackAssigneeFirstName: string
): Promise<ShoppingCardParams | null> {
  return withFamilyContext(familyId, async (client) => {
    const famRes = await client.query('SELECT name FROM families WHERE id = $1', [familyId]);
    const familyName = famRes.rows.length > 0 ? famRes.rows[0].name : 'Family';

    if (assignmentIds.length > 0) {
      const assignsRes = await client.query(
        `SELECT a.id AS assignment_id, a.assignee_first_name,
                i.id AS item_id, i.name, i.store_name, i.price_cents, i.notes, i.priority, i.quantity,
                l.name AS list_name, l.event_date, l.recipient_first_name
         FROM assignments a
         JOIN items i ON i.id = a.item_id
         JOIN lists l ON l.id = a.list_id
         WHERE a.family_id = $1 AND a.id = ANY($2)
         ORDER BY a.created_at ASC`,
        [familyId, assignmentIds]
      );
      if (assignsRes.rows.length === 0) return null;

      const firstRow = assignsRes.rows[0];
      return {
        familyName,
        listName: firstRow.list_name || 'Wish List',
        assigneeFirstName: extractFirstName(firstRow.assignee_first_name || fallbackAssigneeFirstName),
        eventDate: firstRow.event_date ? String(firstRow.event_date).slice(0, 10) : null,
        items: assignsRes.rows.map(toCardItem),
      };
    }

    if (itemIds.length > 0) {
      const itemsRes = await client.query(
        `SELECT i.id AS item_id, i.name, i.store_name, i.price_cents, i.notes, i.priority, i.quantity,
                l.name AS list_name, l.event_date, l.recipient_first_name
         FROM items i
         JOIN lists l ON l.id = i.list_id
         WHERE i.family_id = $1 AND i.id = ANY($2) AND i.deleted_by_recipient = false
         ORDER BY i.created_at ASC`,
        [familyId, itemIds]
      );
      if (itemsRes.rows.length === 0) return null;

      const firstRow = itemsRes.rows[0];
      return {
        familyName,
        listName: firstRow.list_name || 'Wish List',
        assigneeFirstName: extractFirstName(fallbackAssigneeFirstName || 'Family'),
        eventDate: firstRow.event_date ? String(firstRow.event_date).slice(0, 10) : null,
        items: itemsRes.rows.map(toCardItem),
      };
    }

    return null;
  });
}
