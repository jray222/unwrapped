/** Event listeners: share links, invites, admin consoles. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { closeActiveModal, openModal, resetAuthState, showToast, showView } from './ui.js';
import { openInviteWithToken } from './session.js';
import { loadShareLinksView, showQrModal } from './share-links.js';
import { initInstanceAdminInterface, loadInstanceAdminView } from './admin.js';

export function bindAdminListeners() {
  // Create Guest Link Form
  document.getElementById('form-create-guest-link')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const guestFirstName = document.getElementById('guest-first-name').value.trim();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/guest-links`, {
      method: 'POST',
      body: JSON.stringify({ guestFirstName }),
    });
    if (res && res.ok) {
      document.getElementById('form-create-guest-link').reset();
      loadShareLinksView();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create guest link');
    }
  });

  // Create Assignment Link Form
  document.getElementById('form-create-assignment-link')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const assigneeFirstName = document.getElementById('assignee-first-name').value.trim();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links`, {
      method: 'POST',
      body: JSON.stringify({ assigneeFirstName }),
    });
    if (res && res.ok) {
      document.getElementById('form-create-assignment-link').reset();
      loadShareLinksView();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create assignment link');
    }
  });

  // Invite Member Form
  document.getElementById('form-invite-member')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('invite-email').value.trim();
    const role = document.getElementById('invite-role').value;
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    if (res && res.ok) {
      const data = await res.json();
      const token = data.inviteToken || data.raw_token || data.token || '';
      const url = data.inviteUrl
        ? (data.inviteUrl.startsWith('http') ? data.inviteUrl : `${window.location.origin}${data.inviteUrl}`)
        : `${window.location.origin}/invite/${token}`;
      document.getElementById('invite-result-box').innerHTML = `
        <div class="card" style="background: var(--pine-100); border-color: var(--pine-600);">
          <h4>✅ 7-Day Invite Generated for ${email}</h4>
          <p class="form-hint">Send this single-use link to your relative:</p>
          <input type="text" readonly value="${url}" style="margin-bottom: 0.5rem;">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-invite">📋 Copy Link</button>
        </div>
      `;
      document.getElementById('btn-copy-invite')?.addEventListener('click', () => {
        navigator.clipboard.writeText(url);
        showToast('Invite link copied!');
      });
      document.getElementById('form-invite-member').reset();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create invite');
    }
  });

  // Admin-Assisted Passkey Enrollment Form
  document.getElementById('form-assisted-enrollment')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('assisted-first-name').value.trim();
    const lastName = document.getElementById('assisted-last-name').value.trim();
    const email = document.getElementById('assisted-email').value.trim();

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assisted-enrollment`, {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName, email }),
    });

    if (res && res.ok) {
      const data = await res.json();
      const token = data.token || data.raw_token || '';
      const url = data.assistedUrl
        ? (data.assistedUrl.startsWith('http') ? data.assistedUrl : `${window.location.origin}${data.assistedUrl}`)
        : `${window.location.origin}/assisted/${token}`;
      document.getElementById('assisted-result-box').innerHTML = `
        <div class="card" style="background: var(--gold-100); border-color: var(--gold-500);">
          <h4>✨ 1-Tap Passkey Setup Link for ${firstName}</h4>
          <p class="form-hint">Your relative can tap this link on their phone to immediately enroll their FaceID/Fingerprint without entering any password!</p>
          <input type="text" readonly value="${url}" style="margin-bottom: 0.5rem;">
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-assisted">📋 Copy Link</button>
            <a class="btn btn-secondary btn-sm" href="sms:?&body=${encodeURIComponent(`Hi ${firstName}! Tap this link to join our family gift list: ${url}`)}">💬 Send SMS</a>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-qr-assisted">📱 QR Code</button>
          </div>
        </div>
      `;
      document.getElementById('btn-copy-assisted')?.addEventListener('click', () => {
        navigator.clipboard.writeText(url);
        showToast('Assisted link copied!');
      });
      document.getElementById('btn-qr-assisted')?.addEventListener('click', () => {
        showQrModal(url, `Assisted Setup for ${firstName}`);
      });
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create assisted enrollment link');
    }
  });

  // Instance Admin Triggers
  document.getElementById('btn-show-instance-admin')?.addEventListener('click', () => {
    openModal('modal-instance-login');
  });

  document.getElementById('btn-exit-instance-admin')?.addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    resetAuthState();
    showView('view-auth');
  });

  document.getElementById('form-instance-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('instance-bootstrap-token').value.trim();
    closeActiveModal();

    const res = await apiFetch('/api/instance-admin/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    if (res && res.ok) {
      state.sessionKind = 'instance_admin';
      const data = await res.json().catch(() => ({}));
      state.csrfToken = data.csrfToken || '';
      initInstanceAdminInterface();
    } else {
      showToast('Invalid bootstrap admin token.');
    }
  });

  document.getElementById('form-create-family')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('family-name').value.trim();
    const slug = document.getElementById('family-slug').value.trim();
    const adminEmail = document.getElementById('family-admin-email').value.trim();

    const res = await apiFetch('/api/instance-admin/families', {
      method: 'POST',
      body: JSON.stringify({ name, slug, adminEmail }),
    });

    if (res && res.ok) {
      const data = await res.json();
      const token = data.bootstrapInviteToken || data.invite_token || data.token || '';
      const inviteUrl = data.inviteUrl
        ? (data.inviteUrl.startsWith('http') ? data.inviteUrl : `${window.location.origin}${data.inviteUrl}`)
        : `${window.location.origin}/invite/${token}`;
      document.getElementById('create-family-result').innerHTML = `
        <div class="card" style="background: var(--pine-100); border-color: var(--pine-600);">
          <h4>✅ Family "${name}" Created Successfully</h4>
          <p class="form-hint">Initial Admin Invite Link for ${adminEmail}:</p>
          <input type="text" readonly value="${inviteUrl}" style="margin-bottom: 0.5rem;">
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-family-invite">📋 Copy Invite</button>
            <button type="button" class="btn btn-primary btn-sm" id="btn-open-family-invite">👉 Open Invite &amp; Create Admin Account</button>
          </div>
        </div>
      `;
      document.getElementById('btn-copy-family-invite')?.addEventListener('click', () => {
        navigator.clipboard.writeText(inviteUrl);
        showToast('Admin invite copied!');
      });
      document.getElementById('btn-open-family-invite')?.addEventListener('click', async () => {
        await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        resetAuthState();
        showView('view-auth');
        await openInviteWithToken(token);
      });
      document.getElementById('form-create-family').reset();
      loadInstanceAdminView();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create family');
    }
  });
}
