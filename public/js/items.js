/** Item card rendering. */
import { state } from './state.js';
import { createOverflowMenu, icon, openModal } from './ui.js';
import { handleClaimItem, handleReleaseClaim } from './gifts.js';

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
  card.appendChild(imgWrapper);

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

  // Overflow menu: Edit / Pledge / Assign / Open store / shopping cards.
  // Pledge and Assign are giver-only, so they never exist on the recipient's own list.
  const menuItems = [];
  if (canManageList) {
    menuItems.push({ label: 'Edit item', icon: 'pencil', onClick: () => openEditItemModal(item) });
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

  card.appendChild(details);
  return card;
}
