/** Wish list tabs and active list rendering. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { icon, openModal } from './ui.js';
import { listIdFromHash, replaceHash } from './router.js';
import { createItemCard } from './items.js';

/** Simple placeholder cards while lists or items load. */
export function renderSkeletons(container, count = 3) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => (
    '<div class="skeleton-card" aria-hidden="true"><div class="skeleton-line skeleton-line-lg"></div><div class="skeleton-line"></div><div class="skeleton-line skeleton-line-sm"></div></div>'
  )).join('');
  container.setAttribute('aria-busy', 'true');
}

export async function loadFamilyWishLists(familyId) {
  if (!familyId) return;
  if (!state.lists.length) renderSkeletons(document.getElementById('items-available-container'));
  try {
    const res = await apiFetch(`/api/families/${familyId}/lists`);
    if (!res || !res.ok) return;
    const data = await res.json();
    state.lists = data.lists || data || [];
    renderListsTabs();

    if (state.lists.length > 0) {
      const wanted = [listIdFromHash(), state.currentListId].find((id) => id && state.lists.some((l) => l.id === id));
      selectWishList(wanted || state.lists[0].id);
    } else {
      renderEmptyListState();
    }
  } catch (_e) {
    // Handled by offline or error
  }
}

export function renderListsTabs() {
  const bar = document.getElementById('lists-tabs-bar');
  const side = document.getElementById('sidebar-lists');
  if (bar) bar.innerHTML = '';
  if (side) side.innerHTML = '';
  const dashboardActive = document.getElementById('view-dashboard')?.classList.contains('is-active');

  state.lists.forEach((list) => {
    const active = state.currentListId === list.id;
    const href = `#/lists/${encodeURIComponent(list.id)}`;
    const recipient = list.recipient_first_name || '';

    if (bar) {
      const chip = document.createElement('a');
      chip.href = href;
      chip.className = `list-tab-btn ${active ? 'is-active' : ''}`;
      chip.textContent = recipient ? `${list.name} · ${recipient}` : list.name;
      if (active && dashboardActive) chip.setAttribute('aria-current', 'page');
      bar.appendChild(chip);
    }

    if (side) {
      const row = document.createElement('a');
      row.href = href;
      row.className = `nav-item nav-list-row ${active ? 'is-active' : ''}`;
      if (active && dashboardActive) row.setAttribute('aria-current', 'page');
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = (recipient || list.name || '?').charAt(0).toUpperCase();
      const name = document.createElement('span');
      name.className = 'nav-list-name';
      name.textContent = list.name;
      const who = document.createElement('span');
      who.className = 'nav-list-recipient';
      who.textContent = recipient;
      row.append(avatar, name, who);
      side.appendChild(row);
    }
  });
}

export async function selectWishList(listId) {
  state.currentListId = listId;
  replaceHash(`#/lists/${encodeURIComponent(listId)}`);
  renderListsTabs();

  try {
    let query = '';
    if (state.currentPriceFilter === 'under25') query = '?maxPriceCents=2500';
    else if (state.currentPriceFilter === '25to50') query = '?minPriceCents=2500&maxPriceCents=5000';
    else if (state.currentPriceFilter === '50to100') query = '?minPriceCents=5000&maxPriceCents=10000';
    else if (state.currentPriceFilter === '100plus') query = '?minPriceCents=10000';

    if (!state.currentList || state.currentList.id !== listId) {
      renderSkeletons(document.getElementById('items-available-container'));
    }
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${listId}${query}`);
    if (!res || !res.ok) return;
    const data = await res.json();
    state.currentList = {
      ...(data.list || data),
      items: data.items || [],
      availableItems: data.availableItems || [],
      alreadyTakenItems: data.alreadyTakenItems || [],
    };
    renderActiveWishList();
  } catch (_e) {
    // Error loading active list
  }
}

export function renderActiveWishList() {
  const list = state.currentList;
  if (!list) return;

  const isOwner = Boolean(
    state.currentUser &&
    (list.recipient_user_id === state.currentUser.id ||
     list.owner_user_id === state.currentUser.id)
  );
  const isFamilyAdmin = Boolean(
    state.memberships?.some(
      (m) => m.family_id === state.currentFamilyId && m.role === 'family_admin'
    )
  );
  const canManageList = isOwner || isFamilyAdmin;
  const isSurpriseProtected = isOwner && !list.thank_you_revealed;

  // 1. Header, surprise notice and reveal card
  const surpriseBanner = document.getElementById('surprise-rule-banner');
  const revealBox = document.getElementById('reveal-thank-you-box');
  const canReveal = isOwner && !list.thank_you_revealed;

  renderListHeader(list, canReveal);
  if (surpriseBanner) surpriseBanner.hidden = !isSurpriseProtected;
  if (revealBox) revealBox.hidden = !canReveal;

  // 2. Render Items
  const availableContainer = document.getElementById('items-available-container');
  const takenContainer = document.getElementById('items-taken-container');
  const takenAccordion = document.getElementById('already-taken-accordion');
  const takenCountSpan = document.getElementById('already-taken-count');

  if (!availableContainer || !takenContainer) return;
  availableContainer.innerHTML = '';
  availableContainer.removeAttribute('aria-busy');
  takenContainer.innerHTML = '';

  const items = list.items || [];
  if (items.length === 0) {
    availableContainer.innerHTML = `
      <div class="empty-state">
        ${icon('gift')}
        <h3>No items yet</h3>
        <p>${isOwner ? 'Add the first thing you would love to receive.' : 'Add the first idea to this list.'}</p>
        <button type="button" id="btn-empty-add-item" class="btn btn-primary">Add item</button>
      </div>
    `;
    document.getElementById('btn-empty-add-item')?.addEventListener('click', () => openModal('modal-add-item'));
  }
  let takenCount = 0;

  items.forEach((item) => {
    const isTaken = Boolean(item.is_taken || (item.claims && item.claims.length > 0 && !item.allow_duplicates));

    if (isTaken && !isSurpriseProtected) {
      takenCount++;
      takenContainer.appendChild(createItemCard(item, { isTaken: true, isSurpriseProtected, canManageList }));
    } else {
      availableContainer.appendChild(createItemCard(item, { isTaken: false, isSurpriseProtected, canManageList }));
    }
  });

  if (takenAccordion && takenCountSpan) {
    takenCountSpan.textContent = takenCount;
    takenAccordion.hidden = !(takenCount > 0 && !isSurpriseProtected);
  }
}

/** "in 12 days", "tomorrow", "today", "3 days ago" from a YYYY-MM-DD (or ISO) date. */
export function describeEventDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const today = new Date();
  const days = Math.round((new Date(y, m - 1, d) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

function renderListHeader(list, canReveal) {
  const title = document.getElementById('current-list-title');
  const sub = document.getElementById('current-list-subtitle');
  const actions = document.getElementById('list-actions');
  const overflow = document.getElementById('list-overflow');
  if (title) title.textContent = list.name || 'Wish list';
  if (sub) {
    const count = (list.items || []).length;
    const when = describeEventDate(list.event_date);
    const who = list.recipient_first_name ? `For ${list.recipient_first_name}` : '';
    const parts = [who && when ? `${who} · ${when}` : who || (when ? `Event ${when}` : ''), `${count} ${count === 1 ? 'item' : 'items'}`];
    sub.textContent = parts.filter(Boolean).join(' · ');
  }
  if (actions) actions.hidden = false;
  if (overflow) overflow.hidden = !canReveal;
}

export function renderEmptyListState() {
  const title = document.getElementById('current-list-title');
  const sub = document.getElementById('current-list-subtitle');
  const actions = document.getElementById('list-actions');
  if (title) title.textContent = 'Wish lists';
  if (sub) sub.textContent = '';
  if (actions) actions.hidden = true;
  const container = document.getElementById('items-available-container');
  if (container) {
    container.removeAttribute('aria-busy');
    container.innerHTML = `
      <div class="empty-state">
        ${icon('gift')}
        <h3>No wish lists yet</h3>
        <p>Create your family's first wish list to get started.</p>
        <button type="button" id="btn-create-first-list" class="btn btn-primary">Create a wish list</button>
      </div>
    `;
    document.getElementById('btn-create-first-list')?.addEventListener('click', () => {
      openModal('modal-create-list');
    });
  }
}
