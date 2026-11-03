/** Guest view. */
import { apiFetch } from './api.js';
import { showView } from './ui.js';
import { createItemCard } from './items.js';

export async function initGuestInterface(guestLink) {
  showView('view-guest');
  if (guestLink && guestLink.guest_first_name) {
    document.getElementById('guest-first-name-text').textContent = guestLink.guest_first_name;
  }
  loadGuestView();
}

export async function loadGuestView() {
  const container = document.getElementById('guest-items-container');
  if (!container) return;
  container.innerHTML = '<p>Loading family wish lists for you...</p>';

  try {
    const res = await apiFetch('/api/guest/view');
    if (!res || !res.ok) return;
    const data = await res.json();
    const items = data.items || (data.lists ? data.lists.flatMap((l) => l.items || []) : []);
    renderGuestItems(items);
  } catch (_e) {
    container.innerHTML = '<p>Unable to load guest list offline.</p>';
  }
}

export function renderGuestItems(items) {
  const container = document.getElementById('guest-items-container');
  if (!container) return;
  container.innerHTML = '';

  items.forEach((item) => {
    container.appendChild(createItemCard(item, { isTaken: item.is_taken, isSurpriseProtected: false }));
  });
}
