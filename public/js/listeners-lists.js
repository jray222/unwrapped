/** Event listeners: wish lists, items, pledges, assignments. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { closeActiveModal, openModal, showToast } from './ui.js';
import { loadFamilyWishLists, selectWishList } from './lists.js';
import { handleClaimItem } from './gifts.js';
import { handleAutofill } from './autofill.js';
import { navigate } from './router.js';

export function bindListListeners() {
  // Reveal givers (card button and overflow menu item)
  const revealGivers = async () => {
    if (!state.currentListId) return;
    if (confirm('Reveal givers for this list? This turns on thank-you mode.')) {
      const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/reveal-thank-you`, {
        method: 'POST',
      });
      if (res && res.ok) {
        showToast('Givers revealed. See who claimed each gift below.');
        selectWishList(state.currentListId);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Could not reveal givers');
      }
    }
  };
  document.getElementById('btn-reveal-thank-you')?.addEventListener('click', revealGivers);
  document.getElementById('btn-menu-reveal')?.addEventListener('click', revealGivers);

  // Add item sheet and Share shortcut
  document.getElementById('btn-open-add-item')?.addEventListener('click', () => openModal('modal-add-item'));
  document.getElementById('btn-list-share')?.addEventListener('click', () => navigate('#/share'));

  // Price Filter Pills
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('is-active', b === e.currentTarget);
        b.setAttribute('aria-pressed', String(b === e.currentTarget));
      });
      state.currentPriceFilter = e.currentTarget.getAttribute('data-filter') || 'all';
      if (state.currentListId) selectWishList(state.currentListId);
    });
  });

  // Auto-fill button
  document.getElementById('btn-autofill')?.addEventListener('click', handleAutofill);

  // Add Item Form
  document.getElementById('form-add-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentListId) return;

    const name = document.getElementById('item-name').value.trim();
    const priceStr = document.getElementById('item-price').value.trim();
    const priceCents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null;
    const storeName = document.getElementById('item-store-name').value.trim();
    const storeUrl = document.getElementById('item-store-url').value.trim();
    const imageUrl = document.getElementById('item-image-url').value.trim();
    const notes = document.getElementById('item-notes').value.trim();
    const priority = document.getElementById('item-priority').value;
    const quantity = parseInt(document.getElementById('item-quantity').value, 10) || 1;
    const allowDuplicates = document.getElementById('item-allow-duplicates').checked;

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/items`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        priceCents,
        storeName,
        storeUrl,
        imageUrl,
        notes,
        priority,
        quantity,
        allowDuplicates,
      }),
    });

    if (res && res.ok) {
      showToast('Item added to your list.');
      document.getElementById('form-add-item').reset();
      closeActiveModal();
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to add item');
    }
  });

  // Edit Item Form
  document.getElementById('form-edit-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentListId) return;
    const itemId = document.getElementById('edit-item-id').value;
    if (!itemId) return;

    const name = document.getElementById('edit-item-name').value.trim();
    const priceStr = document.getElementById('edit-item-price').value.trim();
    const priceCents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null;
    const storeName = document.getElementById('edit-item-store-name').value.trim();
    const storeUrl = document.getElementById('edit-item-store-url').value.trim();
    const imageUrl = document.getElementById('edit-item-image-url').value.trim();
    const notes = document.getElementById('edit-item-notes').value.trim();
    const priority = document.getElementById('edit-item-priority').value;
    const quantity = parseInt(document.getElementById('edit-item-quantity').value, 10) || 1;
    const allowDuplicates = document.getElementById('edit-item-allow-duplicates').checked;

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        priceCents,
        storeName,
        storeUrl,
        imageUrl,
        notes,
        priority,
        quantity,
        allowDuplicates,
      }),
    });

    if (res && res.ok) {
      showToast('Item updated.');
      closeActiveModal();
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update item');
    }
  });

  // Delete Item Button (inside Edit item sheet)
  document.getElementById('btn-delete-item')?.addEventListener('click', async () => {
    if (!state.currentListId) return;
    const itemId = document.getElementById('edit-item-id').value;
    if (!itemId) return;

    if (!confirm('Are you sure you want to remove this item from the list?')) return;

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/items/${itemId}`, {
      method: 'DELETE',
    });

    if (res && res.ok) {
      showToast('Item removed.');
      closeActiveModal();
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to remove item');
    }
  });

  // Modal Close Buttons
  document.querySelectorAll('.btn-close-modal').forEach((btn) => {
    btn.addEventListener('click', closeActiveModal);
  });

  // Store Prompt Modal Buttons
  document.getElementById('btn-modal-just-looking')?.addEventListener('click', () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item && item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
  });

  document.getElementById('btn-modal-claim-store')?.addEventListener('click', async () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item) {
      await handleClaimItem(item.id);
      if (item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
    }
  });

  // Already Taken Modal Buttons
  document.getElementById('btn-modal-cancel-taken')?.addEventListener('click', closeActiveModal);
  document.getElementById('btn-modal-proceed-taken')?.addEventListener('click', () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item && item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
  });

  // Group Gift Pledge Form
  document.getElementById('form-pledge-submit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = state.modalContext.item;
    if (!item) return;

    const amountDollars = parseFloat(document.getElementById('pledge-amount').value);
    const amountCents = Math.round(amountDollars * 100);
    const note = document.getElementById('pledge-note').value.trim();

    closeActiveModal();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/items/${item.id}/pledge`, {
      method: 'POST',
      body: JSON.stringify({ amountCents, note }),
    });

    if (res && res.ok) {
      showToast(`Pledged $${amountDollars}. Thank you for chipping in.`);
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not submit pledge');
    }
  });

  // Assign to Relative Form
  document.getElementById('form-assign-submit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = state.modalContext.item;
    if (!item) return;

    const assigneeFirstName = document.getElementById('assign-relative-name').value.trim();
    closeActiveModal();

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assignments`, {
      method: 'POST',
      body: JSON.stringify({ itemIds: [item.id], assigneeFirstName }),
    });

    if (res && res.ok) {
      showToast(`Assigned to ${assigneeFirstName}.`);
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not assign gift');
    }
  });

  // Create Wish List Modal
  document.getElementById('btn-open-create-list-modal')?.addEventListener('click', () => {
    openModal('modal-create-list');
  });

  document.getElementById('list-recipient-type')?.addEventListener('change', (e) => {
    const group = document.getElementById('group-recipient-name');
    if (group) group.hidden = !(e.target.value === 'other');
  });

  document.getElementById('form-create-wishlist')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('list-name').value.trim();
    const recipientType = document.getElementById('list-recipient-type').value;
    const recipientFirstName = recipientType === 'other'
      ? document.getElementById('list-recipient-name').value.trim()
      : (state.currentUser ? state.currentUser.first_name : 'Self');
    const eventDate = document.getElementById('list-event-date').value || null;

    closeActiveModal();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        recipientFirstName,
        eventDate,
        recipientUserId: recipientType === 'myself' && state.currentUser ? state.currentUser.id : null,
      }),
    });

    if (res && res.ok) {
      const data = await res.json();
      const newList = data.list || data;
      showToast(`Created "${newList.name}".`);
      loadFamilyWishLists(state.currentFamilyId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create wish list');
    }
  });

  // Print QR Code Button
  document.getElementById('btn-print-qr')?.addEventListener('click', () => {
    window.print();
  });
}
