/** Offline action queue and synchronization. */
import { OFFLINE_QUEUE_KEY, state } from './state.js';
import { apiFetch } from './api.js';
import { showToast } from './ui.js';
import { refreshActiveView } from './session.js';

export function loadOfflineQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    state.offlineQueue = raw ? JSON.parse(raw) : [];
  } catch (_e) {
    state.offlineQueue = [];
  }
  updateOfflineBanner();
}

export function saveOfflineQueue() {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(state.offlineQueue));
  } catch (_e) {
    // Ignore storage quota errors
  }
  updateOfflineBanner();
}

export function enqueueOfflineAction(action) {
  const item = {
    id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...action,
  };
  state.offlineQueue.push(item);
  saveOfflineQueue();
  showToast(`Action saved offline: ${action.description || 'Action queued'}`);
}

export function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  const badge = document.getElementById('offline-queue-badge');
  if (!banner || !badge) return;

  const count = state.offlineQueue.length;
  badge.textContent = `${count} pending`;

  if (!navigator.onLine || count > 0) {
    banner.classList.add('is-active');
  } else {
    banner.classList.remove('is-active');
  }
}

export async function syncOfflineQueue() {
  if (state.offlineQueue.length === 0) {
    showToast('All actions are already synced!');
    return;
  }
  if (!navigator.onLine) {
    showToast('Cannot sync: phone is currently offline.');
    return;
  }

  const actionsToSync = [...state.offlineQueue];
  let successCount = 0;

  try {
    // Attempt bulk sync endpoint first
    const res = await apiFetch('/api/offline/sync', {
      method: 'POST',
      body: JSON.stringify({ actions: actionsToSync }),
    });

    if (res && res.status === 200) {
      state.offlineQueue = [];
      saveOfflineQueue();
      showToast(`Successfully synced ${actionsToSync.length} offline actions!`);
      refreshActiveView();
      return;
    }
  } catch (_e) {
    // Fall back to sequential action replay
  }

  // Sequential playback fallback
  const remainingQueue = [];
  for (const item of actionsToSync) {
    try {
      const res = await apiFetch(item.endpoint, {
        method: item.method || 'POST',
        body: item.body ? JSON.stringify(item.body) : undefined,
      });
      if (res && (res.status >= 200 && res.status < 400)) {
        successCount++;
      } else {
        remainingQueue.push(item);
      }
    } catch (_err) {
      remainingQueue.push(item);
    }
  }

  state.offlineQueue = remainingQueue;
  saveOfflineQueue();

  if (successCount > 0) {
    showToast(`Synced ${successCount} actions. ${remainingQueue.length} pending.`);
    refreshActiveView();
  }
}
