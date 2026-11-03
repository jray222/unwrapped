/** Share links and QR modal. */
import { state } from './state.js';
import { createQRCodeSvg } from './qr.js';
import { apiFetch } from './api.js';
import { icon, openModal, showToast, showView } from './ui.js';

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

function fullUrl(l, prefix) {
  if (l.shareUrl) return l.shareUrl.startsWith('http') ? l.shareUrl : `${window.location.origin}${l.shareUrl}`;
  return `${window.location.origin}${prefix}${l.raw_token || l.token || l.id}`;
}

function iconButton(name, label, onClick, cls = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${cls}`.trim();
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon(name);
  btn.addEventListener('click', onClick);
  return btn;
}

/** A link row: name, dates, and icon actions (copy, share, QR, revoke). */
function createLinkRow({ name, iconName, link, url, shareText, qrLabel, copiedToast, revokeText, revokePath }) {
  const row = document.createElement('div');
  row.className = 'link-row';

  const badge = document.createElement('span');
  badge.className = 'avatar';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = icon(iconName);
  row.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'link-info';
  const title = document.createElement('div');
  title.className = 'link-name';
  title.textContent = name;
  const dates = document.createElement('div');
  dates.className = 'link-dates';
  const created = link.created_at ? `Created ${new Date(link.created_at).toLocaleDateString()}` : '';
  const expires = link.expires_at ? `Expires ${new Date(link.expires_at).toLocaleDateString()}` : '';
  dates.textContent = [created, expires].filter(Boolean).join(' \u00b7 ');
  info.append(title, dates);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'link-actions-group';
  actions.appendChild(iconButton('copy', `Copy link for ${name}`, () => {
    navigator.clipboard?.writeText(url);
    showToast(copiedToast);
  }));

  if (navigator.share) {
    actions.appendChild(iconButton('share', `Share link for ${name}`, () => {
      navigator.share({ title: 'Unwrapped', text: shareText, url }).catch(() => {});
    }));
  } else {
    const sms = document.createElement('a');
    sms.className = 'icon-btn';
    sms.title = 'Send by text message';
    sms.setAttribute('aria-label', `Text link to ${name}`);
    sms.href = `sms:?&body=${encodeURIComponent(`${shareText} ${url}`)}`;
    sms.innerHTML = icon('message');
    actions.appendChild(sms);
  }

  actions.appendChild(iconButton('qr-code', `Show QR code for ${name}`, () => showQrModal(url, qrLabel)));
  actions.appendChild(iconButton('trash', `Revoke link for ${name}`, async () => {
    if (confirm(revokeText)) {
      await apiFetch(`/api/families/${state.currentFamilyId}/${revokePath}/${link.id}/revoke`, { method: 'POST' });
      loadShareLinksView();
    }
  }, 'icon-btn-danger'));
  row.appendChild(actions);
  return row;
}

function renderLinkList(containerId, links, build) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const list = Array.isArray(links) ? links : [];
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `${icon('link')}<h3>No links yet</h3><p>Share a link so someone can view a list without an account.</p>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = containerId === 'guest-links-list' ? 'Create a guest link' : 'Create a shopping link';
    btn.addEventListener('click', () => {
      document.getElementById(containerId === 'guest-links-list' ? 'guest-first-name' : 'assignee-first-name')?.focus();
    });
    empty.appendChild(btn);
    container.appendChild(empty);
    return;
  }
  list.forEach((l) => container.appendChild(build(l)));
}

export function renderGuestLinks(links) {
  renderLinkList('guest-links-list', links, (l) => createLinkRow({
    name: l.guest_first_name,
    iconName: 'user',
    link: l,
    url: fullUrl(l, '/g/'),
    shareText: 'Here is our family gift list:',
    qrLabel: `Guest link for ${l.guest_first_name}`,
    copiedToast: 'Guest link copied.',
    revokeText: `Revoke the guest link for ${l.guest_first_name}?`,
    revokePath: 'guest-links',
  }));
}

export function renderAssignmentLinks(links) {
  renderLinkList('assignment-links-list', links, (l) => createLinkRow({
    name: l.assignee_first_name,
    iconName: 'shopping-bag',
    link: l,
    url: fullUrl(l, '/a/'),
    shareText: 'Here are the gifts you are shopping for:',
    qrLabel: `Shopping link for ${l.assignee_first_name}`,
    copiedToast: 'Shopping link copied.',
    revokeText: `Revoke the shopping link for ${l.assignee_first_name}?`,
    revokePath: 'assignment-links',
  }));
}

export function showQrModal(url, label) {
  const qrBox = document.getElementById('qr-box');
  const qrText = document.getElementById('qr-link-text');
  const qrTitle = document.getElementById('modal-qr-title');
  if (!qrBox || !qrText) return;

  qrBox.innerHTML = '';
  qrBox.appendChild(createQRCodeSvg(url, 240));
  qrText.textContent = url;
  if (qrTitle) qrTitle.textContent = label || 'QR code';

  openModal('modal-qr');
}
