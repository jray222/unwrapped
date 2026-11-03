/** Wish list tabs and active list rendering. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { openModal } from './ui.js';
import { listIdFromHash, replaceHash } from './router.js';
import { createItemCard } from './items.js';

export async function loadFamilyWishLists(familyId) {
  if (!familyId) return;
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
      chip.textContent = `${list.name} (${recipient})`;
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
  const isSurpriseProtected = isOwner && !list.thank_you_revealed;

  // 1. Surprise Protection Banner
  const surpriseBanner = document.getElementById('surprise-rule-banner');
  const revealBox = document.getElementById('reveal-thank-you-box');

  if (surpriseBanner) {
    surpriseBanner.hidden = !(isSurpriseProtected);
  }
  if (revealBox) {
    revealBox.hidden = !(isOwner && !list.thank_you_revealed);
  }

  // 2. Render Items
  const availableContainer = document.getElementById('items-available-container');
  const takenContainer = document.getElementById('items-taken-container');
  const takenAccordion = document.getElementById('already-taken-accordion');
  const takenCountSpan = document.getElementById('already-taken-count');

  if (!availableContainer || !takenContainer) return;
  availableContainer.innerHTML = '';
  takenContainer.innerHTML = '';

  const items = list.items || [];
  let takenCount = 0;

  items.forEach((item) => {
    const isTaken = Boolean(item.is_taken || (item.claims && item.claims.length > 0 && !item.allow_duplicates));

    if (isTaken && !isSurpriseProtected) {
      takenCount++;
      takenContainer.appendChild(createItemCard(item, { isTaken: true, isSurpriseProtected }));
    } else {
      availableContainer.appendChild(createItemCard(item, { isTaken: false, isSurpriseProtected }));
    }
  });

  if (takenAccordion && takenCountSpan) {
    takenCountSpan.textContent = takenCount;
    takenAccordion.hidden = !(takenCount > 0 && !isSurpriseProtected);
  }
}

export function renderEmptyListState() {
  const container = document.getElementById('items-available-container');
  if (container) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 2.5rem 1rem;">
        <h3>No Wish Lists Yet!</h3>
        <p>Start your holiday cheer by creating your family's first wish list!</p>
        <button type="button" id="btn-create-first-list" class="btn btn-primary">
          ✨ Create a Wish List
        </button>
      </div>
    `;
    document.getElementById('btn-create-first-list')?.addEventListener('click', () => {
      openModal('modal-create-list');
    });
  }
}
