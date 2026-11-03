export function extractFirstName(fullNameOrFirst: string): string {
  const trimmed = String(fullNameOrFirst || '').trim();
  if (!trimmed) return 'Someone';
  return trimmed.split(/\s+/)[0];
}

export interface RawItemRow {
  id: string;
  family_id: string;
  list_id: string;
  name: string;
  store_url: string;
  store_name: string;
  price_cents: number | null;
  image_url: string;
  notes: string;
  priority: 'really_want' | 'nice_to_have';
  quantity: number;
  allow_duplicates: boolean;
  is_catch_all: boolean;
  deleted_by_recipient: boolean;
  created_at: string;
  updated_at: string;
}

export interface RawClaimRow {
  id: string;
  item_id: string;
  claimer_user_id: string | null;
  claimer_guest_link_id: string | null;
  assignment_id: string | null;
  claimer_first_name: string;
  quantity: number;
  bought: boolean;
  thank_you_sent: boolean;
  created_at: string;
}

export interface RawPledgeRow {
  id: string;
  item_id: string;
  pledger_user_id: string | null;
  pledger_guest_link_id: string | null;
  pledger_first_name: string;
  amount_cents: number;
  note: string;
  thank_you_sent: boolean;
  created_at: string;
}

export interface RawAssignmentRow {
  id: string;
  item_id: string;
  assigner_user_id: string;
  assignment_link_id: string | null;
  assignee_first_name: string;
  status: 'assigned' | 'bought' | 'couldnt_get_it';
  created_at: string;
  updated_at: string;
}

/**
 * Determines whether the current viewer is subject to the Surprise Rule for a list.
 * Even a Family Admin is subject to the Surprise Rule on their own wish list
 * until `thank_you_revealed` is enabled after the event.
 */
export function isViewerSubjectToSurpriseRule(params: {
  viewerUserId?: string | null;
  listRecipientUserId?: string | null;
  thankYouRevealed: boolean;
}): boolean {
  if (params.thankYouRevealed) return false;
  if (!params.viewerUserId || !params.listRecipientUserId) return false;
  return params.viewerUserId === params.listRecipientUserId;
}

/**
 * Serializes an item while strictly enforcing the Surprise Rule and Guest First-Name Rule.
 * When `surpriseProtected` is true, ALL claim, pledge, and assignment fields are omitted
 * so the JSON payload is identical whether the item is claimed or unclaimed.
 */
export function serializeItem(params: {
  item: RawItemRow;
  claims: RawClaimRow[];
  pledges: RawPledgeRow[];
  assignments: RawAssignmentRow[];
  surpriseProtected: boolean;
  viewerUserId?: string | null;
  viewerGuestLinkId?: string | null;
}) {
  const { item, surpriseProtected } = params;

  const baseItem = {
    id: item.id,
    list_id: item.list_id,
    name: item.name,
    store_url: item.store_url,
    store_name: item.store_name,
    price_cents: item.price_cents,
    image_url: item.image_url,
    notes: item.notes,
    priority: item.priority,
    quantity: item.quantity,
    allow_duplicates: item.allow_duplicates,
    is_catch_all: item.is_catch_all,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  if (surpriseProtected) {
    return baseItem;
  }

  const itemClaims = params.claims.map((c) => ({
    id: c.id,
    claimer_first_name: extractFirstName(c.claimer_first_name),
    quantity: c.quantity,
    bought: c.bought,
    thank_you_sent: c.thank_you_sent,
    is_mine: Boolean(
      (params.viewerUserId && c.claimer_user_id === params.viewerUserId) ||
        (params.viewerGuestLinkId && c.claimer_guest_link_id === params.viewerGuestLinkId)
    ),
    assignment_id: c.assignment_id,
    created_at: c.created_at,
  }));

  const itemPledges = params.pledges.map((p) => ({
    id: p.id,
    pledger_first_name: extractFirstName(p.pledger_first_name),
    amount_cents: p.amount_cents,
    note: p.note,
    thank_you_sent: p.thank_you_sent,
    is_mine: Boolean(
      (params.viewerUserId && p.pledger_user_id === params.viewerUserId) ||
        (params.viewerGuestLinkId && p.pledger_guest_link_id === params.viewerGuestLinkId)
    ),
    created_at: p.created_at,
  }));

  const activeAssignments = params.assignments
    .filter((a) => a.status !== 'couldnt_get_it')
    .map((a) => ({
      id: a.id,
      assignee_first_name: extractFirstName(a.assignee_first_name),
      status: a.status,
      is_assigned_by_me: Boolean(params.viewerUserId && a.assigner_user_id === params.viewerUserId),
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));

  const claimedCount = itemClaims.reduce((sum, c) => sum + c.quantity, 0);
  const totalPledgedCents = itemPledges.reduce((sum, p) => sum + p.amount_cents, 0);
  const pledgeProgressPercent =
    item.price_cents && item.price_cents > 0
      ? Math.min(100, Math.round((totalPledgedCents / item.price_cents) * 100))
      : 0;

  const isFullyPledged = Boolean(
    item.price_cents && item.price_cents > 0 && totalPledgedCents >= item.price_cents
  );
  const isTaken =
    !item.allow_duplicates &&
    !item.is_catch_all &&
    (claimedCount >= item.quantity || isFullyPledged);

  const takenByNames = Array.from(
    new Set([
      ...itemClaims.map((c) => c.claimer_first_name),
      ...itemPledges.map((p) => p.pledger_first_name),
    ])
  );

  return {
    ...baseItem,
    claimed_count: claimedCount,
    is_taken: isTaken,
    taken_by_names: takenByNames,
     taken_label: takenByNames.length > 0 ? `Taken by ${takenByNames.join(', ')}` : null,
    total_pledged_cents: totalPledgedCents,
    pledge_progress_percent: pledgeProgressPercent,
    claims: itemClaims,
    pledges: itemPledges,
    assignments: activeAssignments,
  };
}
