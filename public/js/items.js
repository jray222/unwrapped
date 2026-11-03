/** Item card rendering. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { closeActiveModal, createOverflowMenu, icon, openModal, showToast } from './ui.js';
import { handleClaimItem, handleReleaseClaim } from './gifts.js';

let openCardInner = null;

export async function deleteWishListItem(itemId) {
  if (!state.currentListId || !itemId) return;
  if (!confirm('Are you sure you want to remove this item from the list?')) {
    const card = document.querySelector(`[data-item-id="${itemId}"]`);
    if (card) {
      const cardInner = card.querySelector('.item-card-inner');
      if (cardInner) {
        cardInner.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
        cardInner.style.transform = 'translateX(0px)';
      }
      card.classList.remove('is-swiping', 'is-snapped');
    }
    return;
  }

  const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/items/${itemId}`, {
    method: 'DELETE',
  });

  if (res && res.ok) {
    showToast('Item removed.');
    closeActiveModal();
    const { selectWishList } = await import('./lists.js');
    selectWishList(state.currentListId);
  } else {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to remove item');
    const { selectWishList } = await import('./lists.js');
    selectWishList(state.currentListId);
  }
}

function attachSwipeToDelete(card, cardInner, itemId) {
  let startX = null;
  let startY = null;
  let pointerId = null;
  let isDragging = false;
  let isScrolling = false;
  let currentX = 0;
  let isSnappedOpen = false;

  const resetPosition = (smooth = true) => {
    if (smooth) {
      cardInner.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
    } else {
      cardInner.style.transition = 'none';
    }
    cardInner.style.transform = 'translateX(0px)';
    card.classList.remove('is-swiping', 'is-snapped');
    isSnappedOpen = false;
    if (openCardInner === cardInner) openCardInner = null;
  };

  cardInner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, select, input, textarea, .menu-wrap')) return;

    if (openCardInner && openCardInner !== cardInner) {
      openCardInner.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
      openCardInner.style.transform = 'translateX(0px)';
      const parent = openCardInner.closest('.item-card');
      if (parent) parent.classList.remove('is-swiping', 'is-snapped');
      openCardInner = null;
    }

    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    isDragging = false;
    isScrolling = false;
    currentX = isSnappedOpen ? -84 : 0;
    cardInner.style.transition = 'none';
  });

  cardInner.addEventListener('pointermove', (e) => {
    if (startX === null || isScrolling) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!isDragging) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 7) {
        isScrolling = true;
        startX = null;
        return;
      }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        isDragging = true;
        card.classList.add('is-swiping');
        try { cardInner.setPointerCapture(pointerId); } catch (_) {}
      }
    }

    if (isDragging) {
      const baseOffset = isSnappedOpen ? -84 : 0;
      const target = baseOffset + dx;
      currentX = target > 0 ? target * 0.2 : Math.max(-card.offsetWidth, target);
      cardInner.style.transform = `translateX(${currentX}px)`;
    }
  });

  const onPointerEnd = () => {
    if (startX === null && !isDragging) return;

    cardInner.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';

    if (isDragging) {
      try { cardInner.releasePointerCapture(pointerId); } catch (_) {}

      const cardWidth = card.offsetWidth;
      if (currentX < -cardWidth * 0.45 || currentX < -150) {
        cardInner.style.transform = `translateX(-${cardWidth}px)`;
        card.classList.add('is-snapped');
        setTimeout(() => {
          deleteWishListItem(itemId);
        }, 180);
      } else if (currentX < -45) {
        cardInner.style.transform = 'translateX(-84px)';
        card.classList.add('is-snapped');
        card.classList.remove('is-swiping');
        isSnappedOpen = true;
        openCardInner = cardInner;
      } else {
        resetPosition(true);
      }
    } else if (isSnappedOpen) {
      resetPosition(true);
    }

    startX = null;
    isDragging = false;
    isScrolling = false;
  };

  cardInner.addEventListener('pointerup', onPointerEnd);
  cardInner.addEventListener('pointercancel', onPointerEnd);
}

function makeTag(text, cls = '', iconName = '') {
  const tag = document.createElement('span');
  tag.className = `tag ${cls}`.trim();
  tag.innerHTML = iconName ? icon(iconName) : '';
  tag.append(document.createTextNode(text));
  return tag;
}

function dollars(cents, digits = 2) {
  return `$${(cents / 100).toFixed(digits)}`;
}

export function openEditItemModal(item) {
  const modal = document.getElementById('modal-edit-item');
  if (!modal) return;
  document.getElementById('edit-item-id').value = item.id || '';
  document.getElementById('edit-item-name').value = item.name || '';
  document.getElementById('edit-item-price').value =
    item.price_cents != null ? (item.price_cents / 100).toFixed(2) : '';
  document.getElementById('edit-item-store-name').value = item.store_name || '';
  document.getElementById('edit-item-store-url').value = item.store_url || '';
  document.getElementById('edit-item-image-url').value = item.image_url || '';
  document.getElementById('edit-item-notes').value = item.notes || '';
  document.getElementById('edit-item-priority').value = item.priority || 'nice_to_have';
  document.getElementById('edit-item-quantity').value = item.quantity || 1;
  document.getElementById('edit-item-allow-duplicates').checked = Boolean(item.allow_duplicates);
  openModal('modal-edit-item', { item });
}

export function createItemCard(item, { isTaken, isSurpriseProtected, canManageList = false }) {
  const card = document.createElement('article');
  card.className = `item-card ${item.priority === 'really_want' ? 'is-featured' : ''}`.trim();
  card.dataset.itemId = item.id;

  // Image (4:3) with a soft icon placeholder
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'item-image-wrapper';
  const showPlaceholder = () => {
    imgWrapper.innerHTML = `<span class="item-image-placeholder" aria-hidden="true">${icon('image')}</span>`;
  };
  if (item.image_url) {
    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = item.name;
    img.className = 'item-image';
    img.loading = 'lazy';
    img.onerror = showPlaceholder;
    imgWrapper.appendChild(img);
  } else {
    showPlaceholder();
  }

  const details = document.createElement('div');
  details.className = 'item-details';

  // Name + overflow menu
  const header = document.createElement('div');
  header.className = 'item-header';
  const title = document.createElement('h3');
  title.className = 'item-name';
  title.textContent = item.name;
  header.appendChild(title);

  const openStore = () => {
    if (isSurpriseProtected) {
      window.open(item.store_url, '_blank', 'noopener,noreferrer');
    } else if (isTaken) {
      openModal('modal-already-taken', { item });
    } else {
      openModal('modal-store-prompt', { item });
    }
  };

  // Overflow menu: Edit / Delete / Pledge / Assign / Open store / shopping cards.
  // Pledge and Assign are giver-only, so they never exist on the recipient's own list.
  const menuItems = [];
  if (canManageList) {
    menuItems.push({ label: 'Edit item', icon: 'pencil', onClick: () => openEditItemModal(item) });
    menuItems.push({ label: 'Delete item', icon: 'trash', onClick: () => deleteWishListItem(item.id) });
  }
  if (!isSurpriseProtected) {
    menuItems.push({ label: 'Pledge toward this', icon: 'coins', onClick: () => openModal('modal-pledge', { item }) });
    menuItems.push({ label: 'Assign to a relative', icon: 'user', onClick: () => openModal('modal-assign', { item }) });
  }
  if (item.store_url) {
    menuItems.push({ label: 'Open store', icon: 'external-link', onClick: openStore });
  }
  const safeName = item.name.replace(/[^a-zA-Z0-9]/g, '_');
  menuItems.push({
    label: 'Shopping card (PDF)',
    icon: 'download',
    href: `/api/families/${state.currentFamilyId}/shopping-card.pdf?itemIds=${item.id}`,
    download: `${safeName}_card.pdf`,
  });
  menuItems.push({
    label: 'Shopping card (PNG)',
    icon: 'download',
    href: `/api/families/${state.currentFamilyId}/shopping-card.png?itemIds=${item.id}`,
    download: `${safeName}_card.png`,
  });
  header.appendChild(createOverflowMenu(menuItems, `More actions for ${item.name}`));
  details.appendChild(header);

  // Price and store
  const priceStr = item.price_cents ? dollars(item.price_cents) : '';
  const storeStr = item.store_name || (item.store_url ? 'Online store' : '');
  const metaText = [priceStr, storeStr].filter(Boolean).join(' · ');
  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = metaText;
    details.appendChild(meta);
  }

  // Tags
  const tags = document.createElement('div');
  tags.className = 'item-tags';
  if (item.priority === 'really_want') tags.appendChild(makeTag('Really want', 'tag-really-want', 'star'));
  if (item.quantity > 1) tags.appendChild(makeTag(`Qty ${item.quantity}`));
  if (item.allow_duplicates) tags.appendChild(makeTag('Duplicates OK'));
  if (isTaken && item.taken_label) tags.appendChild(makeTag(item.taken_label, 'tag-taken', 'check'));
  if (tags.childElementCount) details.appendChild(tags);

  if (item.notes) {
    const notes = document.createElement('div');
    notes.className = 'item-notes';
    notes.textContent = item.notes;
    details.appendChild(notes);
  }

  // Group gift progress (never rendered on the recipient's own list)
  if (!isSurpriseProtected && item.price_cents && (item.total_pledged_cents > 0 || (item.pledges && item.pledges.length > 0))) {
    const pledgeBox = document.createElement('div');
    pledgeBox.className = 'pledge-bar-container';

    const track = document.createElement('div');
    track.className = 'pledge-progress-track';
    const fill = document.createElement('div');
    fill.className = 'pledge-progress-fill';
    fill.style.width = `${Math.min(100, item.pledge_progress_percent || 0)}%`;
    track.appendChild(fill);
    pledgeBox.appendChild(track);

    const stats = document.createElement('div');
    stats.className = 'pledge-stats';
    stats.textContent = `${dollars(item.total_pledged_cents || 0, 0)} of ${dollars(item.price_cents, 0)} pledged`;
    pledgeBox.appendChild(stats);

    details.appendChild(pledgeBox);
  }

  // One primary action
  const actions = document.createElement('div');
  actions.className = 'item-actions';

  if (!isSurpriseProtected) {
    const myClaim = (item.claims || []).find((c) => c.is_mine);
    if (myClaim) {
      const btnRelease = document.createElement('button');
      btnRelease.type = 'button';
      btnRelease.className = 'btn btn-secondary btn-sm';
      btnRelease.innerHTML = icon('undo');
      btnRelease.append(document.createTextNode('Release'));
      btnRelease.addEventListener('click', () => handleReleaseClaim(myClaim.id));
      actions.appendChild(btnRelease);
    } else if (!isTaken || item.allow_duplicates) {
      const btnClaim = document.createElement('button');
      btnClaim.type = 'button';
      btnClaim.className = 'btn btn-primary btn-sm';
      btnClaim.innerHTML = icon('gift');
      btnClaim.append(document.createTextNode('Claim'));
      btnClaim.addEventListener('click', () => handleClaimItem(item.id));
      actions.appendChild(btnClaim);
    }
  } else if (canManageList) {
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn-secondary btn-sm';
    btnEdit.innerHTML = icon('pencil');
    btnEdit.append(document.createTextNode('Edit'));
    btnEdit.addEventListener('click', () => openEditItemModal(item));
    actions.appendChild(btnEdit);
    if (item.store_url) {
      const btnStore = document.createElement('button');
      btnStore.type = 'button';
      btnStore.className = 'btn btn-secondary btn-sm';
      btnStore.innerHTML = icon('external-link');
      btnStore.append(document.createTextNode('Open store'));
      btnStore.addEventListener('click', openStore);
      actions.appendChild(btnStore);
    }
  } else if (item.store_url) {
    const btnStore = document.createElement('button');
    btnStore.type = 'button';
    btnStore.className = 'btn btn-secondary btn-sm';
    btnStore.innerHTML = icon('external-link');
    btnStore.append(document.createTextNode('Open store'));
    btnStore.addEventListener('click', openStore);
    actions.appendChild(btnStore);
  }
  if (actions.childElementCount) details.appendChild(actions);

  const inner = document.createElement('div');
  inner.className = 'item-card-inner';
  inner.appendChild(imgWrapper);
  inner.appendChild(details);

  if (canManageList) {
    card.classList.add('is-swipeable');

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'swipe-delete-action';
    deleteBtn.setAttribute('aria-label', `Delete ${item.name}`);
    deleteBtn.innerHTML = `${icon('trash')}<span>Delete</span>`;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteWishListItem(item.id);
    });

    card.appendChild(deleteBtn);
    card.appendChild(inner);
    attachSwipeToDelete(card, inner, item.id);
  } else {
    card.appendChild(inner);
  }

  return card;
}
