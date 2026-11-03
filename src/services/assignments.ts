import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { AuthContext } from '../types.js';
import { withFamilyContext, withSystemContext, recordAuditLog } from '../db/index.js';
import { HttpError } from '../errors.js';
import {
  extractFirstName,
  type RawItemRow,
  type RawAssignmentRow,
} from '../security/surprise.js';

/**
 * Assign items to a giver and immediately create linked claims.
 * Throws HttpError 403 when assigning on one's own wish list.
 */
export async function createAssignments(
  currentUser: NonNullable<AuthContext['user']>,
  familyId: string,
  itemIds: any[],
  cleanAssigneeName: string,
  assignmentLinkId: any
) {
  return withFamilyContext(familyId, async (client) => {
    const assignmentsOut: RawAssignmentRow[] = [];

    for (const itemId of itemIds) {
      const itemRes = await client.query<RawItemRow>(
        `SELECT * FROM items WHERE id = $1 AND family_id = $2 AND deleted_by_recipient = false`,
        [itemId, familyId]
      );
      if (itemRes.rows.length === 0) continue;
      const item = itemRes.rows[0];

      const listRes = await client.query(
        `SELECT * FROM lists WHERE id = $1 AND family_id = $2`,
        [item.list_id, familyId]
      );
      if (listRes.rows.length === 0) continue;
      const list = listRes.rows[0];

      // Cannot assign items on own wish list
      if (list.recipient_user_id === currentUser.id) {
        throw new HttpError(403, 'Cannot assign items on your own wish list');
      }

      const assignmentId = randomUUID();
      const assignRes = await client.query<RawAssignmentRow>(
        `INSERT INTO assignments (
          id, family_id, list_id, item_id, assigner_user_id, assignment_link_id,
          assignee_first_name, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'assigned', NOW(), NOW())
        RETURNING *`,
        [
          assignmentId,
          familyId,
          list.id,
          itemId,
          currentUser.id,
          assignmentLinkId || null,
          cleanAssigneeName,
        ]
      );

      // Immediately create linked claim in that person's name right away so no one else buys it
      const claimId = randomUUID();
      await client.query(
        `INSERT INTO claims (
          id, family_id, list_id, item_id, claimer_user_id, claimer_guest_link_id,
          assignment_id, claimer_first_name, quantity, bought, thank_you_sent, created_at
        ) VALUES ($1, $2, $3, $4, $5, null, $6, $7, 1, false, false, NOW())`,
        [claimId, familyId, list.id, itemId, currentUser.id, assignmentId, cleanAssigneeName]
      );

      await recordAuditLog(client, {
        familyId,
        actorUserId: currentUser.id,
        actorLabel: extractFirstName(currentUser.first_name),
        action: 'ITEM_ASSIGNED',
        targetRecipientUserId: list.recipient_user_id,
        isSurpriseSensitive: true,
        metadata: { assignmentId, itemId, listId: list.id, assigneeFirstName: cleanAssigneeName },
      });

      assignmentsOut.push(assignRes.rows[0]);
    }

    return assignmentsOut;
  });
}

/** Look up an assignment's family when the route carries no familyId. */
export async function findFamilyIdForAssignment(assignmentId: string): Promise<string | undefined> {
  let familyId: string | undefined;
  await withSystemContext(async (sysClient) => {
    const aRes = await sysClient.query('SELECT family_id FROM assignments WHERE id = $1', [
      assignmentId,
    ]);
    if (aRes.rows.length > 0) familyId = aRes.rows[0].family_id;
  });
  return familyId;
}

/**
 * Update assignment status (bought / couldn't get it / reassign).
 * `auth` must be defined. Returns null for 404; throws HttpError 403.
 */
export async function updateAssignmentStatus(
  auth: AuthContext,
  familyId: string,
  assignmentId: string,
  status: string,
  reassignToFirstName: any
) {
  return withFamilyContext(familyId, async (client) => {
    const aRes = await client.query(
      `SELECT a.*, l.recipient_user_id
       FROM assignments a
       JOIN lists l ON l.id = a.list_id
       WHERE a.id = $1 AND a.family_id = $2`,
      [assignmentId, familyId]
    );
    if (aRes.rows.length === 0) return null;
    const assignRow = aRes.rows[0];

    let authorized = false;
    let actorLabel = 'Assignee';
    let actorUserId: string | null = null;

    if (auth.kind === 'user' && auth.user) {
      const isFamilyAdmin = auth.memberships?.some(
        (m) => m.family_id === familyId && m.role === 'family_admin'
      );
      if (assignRow.assigner_user_id === auth.user.id || isFamilyAdmin) {
        authorized = true;
        actorUserId = auth.user.id;
        actorLabel = extractFirstName(auth.user.first_name);
      }
    } else if (auth.kind === 'assignment' && auth.assignmentLink) {
      if (
        auth.assignmentLink.family_id === familyId &&
        auth.assignmentLink.id === assignRow.assignment_link_id
      ) {
        authorized = true;
        actorLabel = extractFirstName(auth.assignmentLink.assignee_first_name);
      }
    }

    if (!authorized) {
      throw new HttpError(403, 'Access denied');
    }

    let updatedAssignment: RawAssignmentRow;

    if (status === 'bought') {
      const updRes = await client.query<RawAssignmentRow>(
        `UPDATE assignments SET status = 'bought', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [assignmentId]
      );
      updatedAssignment = updRes.rows[0];
      await client.query(`UPDATE claims SET bought = true WHERE assignment_id = $1`, [
        assignmentId,
      ]);
    } else if (status === 'couldnt_get_it') {
      if (reassignToFirstName && typeof reassignToFirstName === 'string' && reassignToFirstName.trim()) {
        const cleanName = extractFirstName(reassignToFirstName.trim());
        const updRes = await client.query<RawAssignmentRow>(
          `UPDATE assignments SET assignee_first_name = $1, status = 'assigned', updated_at = NOW() WHERE id = $2 RETURNING *`,
          [cleanName, assignmentId]
        );
        updatedAssignment = updRes.rows[0];
        await client.query(
          `UPDATE claims SET claimer_first_name = $1, bought = false WHERE assignment_id = $2`,
          [cleanName, assignmentId]
        );
      } else {
        const updRes = await client.query<RawAssignmentRow>(
          `UPDATE assignments SET status = 'couldnt_get_it', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [assignmentId]
        );
        updatedAssignment = updRes.rows[0];
        // Immediately release linked claim back to available
        await client.query(`DELETE FROM claims WHERE assignment_id = $1`, [assignmentId]);
      }
    } else {
      // status === 'assigned'
      const updRes = await client.query<RawAssignmentRow>(
        `UPDATE assignments SET status = 'assigned', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [assignmentId]
      );
      updatedAssignment = updRes.rows[0];
      await client.query(`UPDATE claims SET bought = false WHERE assignment_id = $1`, [
        assignmentId,
      ]);
    }

    await recordAuditLog(client, {
      familyId,
      actorUserId,
      actorLabel,
      action: 'ASSIGNMENT_UPDATED',
      targetRecipientUserId: assignRow.recipient_user_id,
      isSurpriseSensitive: true,
      metadata: { assignmentId, status, reassignToFirstName },
    });

    return updatedAssignment;
  });
}

/** Assignments created by the current user in this family. */
export async function listAssignmentsForAssigner(familyId: string, assignerUserId: string) {
  return withFamilyContext(familyId, async (client) => {
    const queryRes = await client.query(
      `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at, a.updated_at,
              i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url, i.notes AS item_notes,
              l.name AS list_name, l.event_date, l.recipient_first_name
       FROM assignments a
       JOIN items i ON i.id = a.item_id
       JOIN lists l ON l.id = a.list_id
       WHERE a.family_id = $1 AND a.assigner_user_id = $2
       ORDER BY a.created_at DESC`,
      [familyId, assignerUserId]
    );

    return queryRes.rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      listId: r.list_id,
      name: r.item_name,
      itemName: r.item_name,
      storeUrl: r.store_url,
      storeName: r.store_name,
      priceCents: r.price_cents,
      imageUrl: r.image_url,
      notes: r.item_notes,
      status: r.status,
      listName: r.list_name,
      recipientFirstName: extractFirstName(r.recipient_first_name),
      assigneeFirstName: extractFirstName(r.assignee_first_name),
      eventDate: r.event_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });
}

/** Upcoming assignment reminders for events within reminderDaysBeforeEvent. */
export async function listAssignmentReminders(familyId: string, assignerUserId: string) {
  return withFamilyContext(familyId, async (client) => {
    const queryRes = await client.query(
      `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at,
              i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url,
              l.name AS list_name, l.event_date, l.recipient_first_name
       FROM assignments a
       JOIN items i ON i.id = a.item_id
       JOIN lists l ON l.id = a.list_id
       WHERE a.family_id = $1
         AND a.assigner_user_id = $2
         AND a.status = 'assigned'
         AND l.event_date IS NOT NULL
         AND l.event_date <= (CURRENT_DATE + ($3 || ' days')::interval)
       ORDER BY l.event_date ASC, a.created_at ASC`,
      [familyId, assignerUserId, String(config.reminderDaysBeforeEvent)]
    );

    return queryRes.rows.map((r) => ({
      ...r,
      recipient_first_name: extractFirstName(r.recipient_first_name),
      assignee_first_name: extractFirstName(r.assignee_first_name),
    }));
  });
}

/** Data for the dedicated assignment-link view. */
export async function getAssignmentViewData(
  familyId: string,
  assignmentLinkId: string,
  assigneeFirstName: string
) {
  return withFamilyContext(familyId, async (client) => {
    const assignsRes = await client.query(
      `SELECT a.id, a.item_id, a.list_id, a.assignee_first_name, a.status, a.created_at, a.updated_at,
              i.name AS item_name, i.store_url, i.store_name, i.price_cents, i.image_url, i.notes AS item_notes,
              l.name AS list_name, l.recipient_first_name, l.event_date
       FROM assignments a
       JOIN items i ON i.id = a.item_id
       JOIN lists l ON l.id = a.list_id
       WHERE a.family_id = $1 AND a.assignment_link_id = $2
       ORDER BY a.created_at ASC`,
      [familyId, assignmentLinkId]
    );

    const assignments = assignsRes.rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      listId: row.list_id,
      name: row.item_name,
      itemName: row.item_name,
      storeUrl: row.store_url,
      storeName: row.store_name,
      priceCents: row.price_cents,
      imageUrl: row.image_url,
      notes: row.item_notes,
      status: row.status,
      listName: row.list_name,
      recipientFirstName: extractFirstName(row.recipient_first_name),
      eventDate: row.event_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return {
      assigneeFirstName: extractFirstName(assigneeFirstName),
      familyId,
      assignments,
    };
  });
}
