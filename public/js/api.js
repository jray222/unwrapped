/** API client (CSRF, session expiry handling). */
import { state } from './state.js';
import { resetAuthState, showToast, showView } from './ui.js';

export async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }

  try {
    const res = await fetch(url, { credentials: 'same-origin', ...options, headers });

    // Handle session expiry or 401
    if (res.status === 401 && !url.includes('/api/auth/me')) {
      showToast('Session expired. Please sign in again.');
      resetAuthState();
      showView('view-auth');
      return res;
    }

    return res;
  } catch (err) {
    // Network failure when offline
    if (!navigator.onLine && ['POST', 'PUT', 'DELETE'].includes(method)) {
      throw new Error('OFFLINE_NETWORK_ERROR');
    }
    throw err;
  }
}
