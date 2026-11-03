/**
 * Unwrapped v2 — High-Usability, Offline-First Frontend SPA (entry point)
 * Strictly CSP compliant (no inline scripts/handlers). Native ES modules, no build step.
 */
import { loadOfflineQueue } from './offline.js';
import { checkCurrentSession } from './session.js';
import { bindAuthListeners } from './listeners-auth.js';
import { bindListListeners } from './listeners-lists.js';
import { bindAdminListeners } from './listeners-admin.js';

// Must match CACHE_NAME in /sw.js
const CURRENT_SHELL_CACHE = 'unwrapped-v2-shell-v4';

function bindEventListeners() {
  bindAuthListeners();
  bindListListeners();
  bindAdminListeners();

  // Select-all on click for the TOTP secret (replaces former inline onclick="this.select()")
  document.getElementById('totp-secret-text')?.addEventListener('click', (e) => {
    e.currentTarget.select();
  });
}

// Module scripts are deferred, but DOMContentLoaded may in rare cases already have fired.
async function bootstrap() {
  loadOfflineQueue();
  bindEventListeners();

  // Purge any legacy v1/v2 service worker caches and update SW immediately
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      for (const k of keys) {
        if (k !== CURRENT_SHELL_CACHE) {
          await caches.delete(k);
        }
      }
    } catch (_e) {}
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      reg.update().catch(() => {});
    } catch (_e) {
      // Service worker registration error ignored
    }
  }

  // Restore session or pending invite
  await checkCurrentSession();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
