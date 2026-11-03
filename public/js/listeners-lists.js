/** Event listeners: wish lists, items, pledges, assignments. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { closeActiveModal, openModal, showToast } from './ui.js';
import { loadFamilyWishLists, selectWishList } from './lists.js';
import { handleClaimItem } from './gifts.js';
import { handleAutofill } from './autofill.js';

export function bindListListeners() {
  // Reveal Thank-You List Button
  document.getElementById('btn-reveal-thank-you')?.addEventListener('click', async () => {
    if (!state.currentListId) return;
    if (confirm('Reveal givers for this list? This will unlock Thank-You mode.')) {
      const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/reveal-thank-you`, {
        method: 'POST',
      });
      if (res && res.ok) {
        showToast('🎁 Thank-You list revealed! See who claimed your gifts below.');
        selectWishList(state.currentListId);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Could not reveal thank-you list');
      }
    }
  });

  // Price Filter Pills
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('is-active'));
      e.target.classList.add('is-active');
      state.currentPriceFilter = e.target.getAttribute('data-filter') || 'all';
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
      showToast('🎁 Item added to wish list!');
      document.getElementById('form-add-item').reset();
      document.getElementById('accordion-add-item').removeAttribute('open');
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to add item');
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
      showToast(`🤝 Pledged $${amountDollars}! Thank you for contributing.`);
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
      showToast(`👤 Item assigned to ${assigneeFirstName}!`);
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
      showToast(`✨ Created wish list "${newList.name}"!`);
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
