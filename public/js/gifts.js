/** Gift claims and releases. */
import { state } from './state.js';
import { enqueueOfflineAction } from './offline.js';
import { apiFetch } from './api.js';
import { showToast } from './ui.js';
import { selectWishList } from './lists.js';

export async function handleClaimItem(itemId, quantity = 1) {
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/items/${itemId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
    });

    if (res && res.ok) {
      showToast("Gift claimed. The recipient won't see it until after the event.");
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not claim gift');
    }
  } catch (_e) {
    if (!navigator.onLine) {
      enqueueOfflineAction({
        endpoint: `/api/families/${state.currentFamilyId}/items/${itemId}/claim`,
        method: 'POST',
        body: { quantity },
        description: 'Claimed gift',
      });
    }
  }
}

export async function handleReleaseClaim(claimId) {
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/claims/${claimId}/release`, {
      method: 'POST',
    });
    if (res && res.ok) {
      showToast('Claim released.');
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not release claim');
    }
  } catch (_e) {
    if (!navigator.onLine) {
      enqueueOfflineAction({
        endpoint: `/api/families/${state.currentFamilyId}/claims/${claimId}/release`,
        method: 'POST',
        description: 'Released claim',
      });
    }
  }
}
