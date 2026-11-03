/** Share links and QR modal. */
import { state } from './state.js';
import { createQRCodeSvg } from './qr.js';
import { apiFetch } from './api.js';
import { openModal, showToast, showView } from './ui.js';

export async function loadShareLinksView() {
  showView('view-share-links');
  if (!state.currentFamilyId) return;

  // Load guest links
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/guest-links`);
    if (res && res.ok) {
      const data = await res.json();
      renderGuestLinks(data.guestLinks || data || []);
    }
  } catch (_e) {}

  // Load assignment links
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links`);
    if (res && res.ok) {
      const data = await res.json();
      renderAssignmentLinks(data.assignmentLinks || data || []);
    }
  } catch (_e) {}
}

export function renderGuestLinks(links) {
  const container = document.getElementById('guest-links-list');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(links) ? links : [];

  list.forEach((l) => {
    const card = document.createElement('div');
    card.className = 'link-card';

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<h4>👤 ${l.guest_first_name}</h4><p class="form-hint">Expires: ${new Date(l.expires_at).toLocaleDateString()}</p>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'link-actions-group';

    const url = l.shareUrl
      ? (l.shareUrl.startsWith('http') ? l.shareUrl : `${window.location.origin}${l.shareUrl}`)
      : `${window.location.origin}/g/${l.raw_token || l.token || l.id}`;

    // Copy Link Button
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn btn-secondary btn-sm';
    btnCopy.textContent = '📋 Copy Link';
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(url);
      showToast('Guest link copied to clipboard!');
    });
    actions.appendChild(btnCopy);

    // SMS Button
    const btnSms = document.createElement('a');
    btnSms.className = 'btn btn-secondary btn-sm';
    btnSms.href = `sms:?&body=${encodeURIComponent(`Here is our family gift list: ${url}`)}`;
    btnSms.textContent = '💬 SMS';
    actions.appendChild(btnSms);

    // QR Code Button
    const btnQr = document.createElement('button');
    btnQr.type = 'button';
    btnQr.className = 'btn btn-secondary btn-sm';
    btnQr.textContent = '📱 QR Code';
    btnQr.addEventListener('click', () => showQrModal(url, `Guest Link for ${l.guest_first_name}`));
    actions.appendChild(btnQr);

    // Revoke Button
    const btnRevoke = document.createElement('button');
    btnRevoke.type = 'button';
    btnRevoke.className = 'btn btn-danger btn-sm';
    btnRevoke.textContent = 'Revoke';
    btnRevoke.addEventListener('click', async () => {
      if (confirm(`Revoke guest link for ${l.guest_first_name}?`)) {
        await apiFetch(`/api/families/${state.currentFamilyId}/guest-links/${l.id}/revoke`, { method: 'POST' });
        loadShareLinksView();
      }
    });
    actions.appendChild(btnRevoke);

    card.appendChild(actions);
    container.appendChild(card);
  });
}

export function renderAssignmentLinks(links) {
  const container = document.getElementById('assignment-links-list');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(links) ? links : [];

  list.forEach((l) => {
    const card = document.createElement('div');
    card.className = 'link-card';

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<h4>🛒 ${l.assignee_first_name}</h4><p class="form-hint">Expires: ${new Date(l.expires_at).toLocaleDateString()}</p>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'link-actions-group';

    const url = l.shareUrl
      ? (l.shareUrl.startsWith('http') ? l.shareUrl : `${window.location.origin}${l.shareUrl}`)
      : `${window.location.origin}/a/${l.raw_token || l.token || l.id}`;

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn btn-secondary btn-sm';
    btnCopy.textContent = '📋 Copy Link';
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(url);
      showToast('Assignment link copied!');
    });
    actions.appendChild(btnCopy);

    const btnQr = document.createElement('button');
    btnQr.type = 'button';
    btnQr.className = 'btn btn-secondary btn-sm';
    btnQr.textContent = '📱 QR Code';
    btnQr.addEventListener('click', () => showQrModal(url, `Shopping List for ${l.assignee_first_name}`));
    actions.appendChild(btnQr);

    const btnRevoke = document.createElement('button');
    btnRevoke.type = 'button';
    btnRevoke.className = 'btn btn-danger btn-sm';
    btnRevoke.textContent = 'Revoke';
    btnRevoke.addEventListener('click', async () => {
      if (confirm(`Revoke assignment link for ${l.assignee_first_name}?`)) {
        await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links/${l.id}/revoke`, { method: 'POST' });
        loadShareLinksView();
      }
    });
    actions.appendChild(btnRevoke);

    card.appendChild(actions);
    container.appendChild(card);
  });
}

export function showQrModal(url, label) {
  const qrBox = document.getElementById('qr-box');
  const qrText = document.getElementById('qr-link-text');
  const qrTitle = document.getElementById('modal-qr-title');
  if (!qrBox || !qrText) return;

  qrBox.innerHTML = '';
  qrBox.appendChild(createQRCodeSvg(url, 240));
  qrText.textContent = url;
  if (qrTitle) qrTitle.textContent = label || 'Printable QR Code';

  openModal('modal-qr');
}
