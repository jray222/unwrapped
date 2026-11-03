/** User notifications banner. */
import { state } from './state.js';
import { apiFetch } from './api.js';

export async function loadNotifications() {
  if (state.sessionKind !== 'user' || !state.currentFamilyId) return;
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/notifications`);
    if (!res || !res.ok) return;
    const data = await res.json();
    state.notifications = data.notifications || data || [];
    renderNotifications();
  } catch (_err) {
    // Ignore notifications error silently
  }
}

export function renderNotifications() {
  const container = document.getElementById('notification-bar');
  if (!container) return;
  container.innerHTML = '';

  state.notifications.forEach((notif) => {
    const card = document.createElement('div');
    card.className = `notification-card ${notif.is_warning ? 'is-warning' : ''}`;

    const text = document.createElement('div');
    text.textContent = notif.message;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-dismiss-notification';
    btn.textContent = 'Dismiss';
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/notifications/${notif.id}/read`, { method: 'POST' });
        state.notifications = state.notifications.filter((n) => n.id !== notif.id);
        renderNotifications();
      } catch (_e) {
        card.remove();
      }
    });

    card.appendChild(text);
    card.appendChild(btn);
    container.appendChild(card);
  });
}
