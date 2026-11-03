/** Wish list tabs and active list rendering. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { openModal } from './ui.js';
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
      selectWishList(state.lists[0].id);
    } else {
      renderEmptyListState();
    }
  } catch (_e) {
    // Handled by offline or error
  }
}

export function renderListsTabs() {
  const bar = document.getElementById('lists-tabs-bar');
  if (!bar) return;
  bar.innerHTML = '';

  state.lists.forEach((list) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `list-tab-btn ${state.currentList && state.currentList.id === list.id ? 'is-active' : ''}`;
    btn.textContent = `${list.name} (${list.recipient_first_name})`;
    btn.addEventListener('click', () => selectWishList(list.id));
    bar.appendChild(btn);
  });
}

export async function selectWishList(listId) {
  state.currentListId = listId;
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
    surpriseBanner.style.display = isSurpriseProtected ? 'flex' : 'none';
  }
  if (revealBox) {
    revealBox.style.display = isOwner && !list.thank_you_revealed ? 'block' : 'none';
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
    takenAccordion.style.display = takenCount > 0 && !isSurpriseProtected ? 'block' : 'none';
  }
}

export function renderEmptyListState() {
  const container = document.getElementById('items-available-container');
  if (container) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 2.5rem 1rem;">
        <h3>No Wish Lists Yet!</h3>
        <p>Start your holiday cheer by creating your family's first wish list!</p>
        <button type="button" id="btn-create-first-list" class="btn btn-gold">
          ✨ Create a Wish List
        </button>
      </div>
    `;
    document.getElementById('btn-create-first-list')?.addEventListener('click', () => {
      openModal('modal-create-list');
    });
  }
}
