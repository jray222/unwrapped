/** Event listeners: navigation, login, MFA, invites. */
import { state } from './state.js';
import { syncOfflineQueue, updateOfflineBanner } from './offline.js';
import { apiFetch } from './api.js';
import { closeActiveModal, openModal, resetAuthState, showToast, showView } from './ui.js';
import { checkCurrentSession, openInviteWithToken, updateFamilyRoleUi } from './session.js';
import { loadFamilyWishLists } from './lists.js';
import { navigate, parseHash, replaceHash } from './router.js';
import { handlePasskeyLogin, handlePasskeyRegister, startTotpEnrollment } from './passkeys.js';

export function bindAuthListeners() {
  // Offline & Online events
  window.addEventListener('online', () => {
    updateOfflineBanner();
    syncOfflineQueue();
  });
  window.addEventListener('offline', updateOfflineBanner);

  document.getElementById('btn-sync-now')?.addEventListener('click', syncOfflineQueue);

  // Brand Link / Home
  document.querySelectorAll('.brand-wrapper').forEach((link) => link.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.sessionKind === 'user') navigate('#/lists');
    else if (state.sessionKind === 'instance_admin') showView('view-instance-admin');
    else showView('view-auth');
  }));

  // Family Selector (source of truth; the switcher menus dispatch 'change' on it)
  document.getElementById('family-selector')?.addEventListener('change', (e) => {
    state.currentFamilyId = e.target.value;
    state.currentList = null;
    state.currentListId = null;
    updateFamilyRoleUi();
    if (parseHash().name === 'lists') replaceHash('#/lists');
    else navigate('#/lists');
    loadFamilyWishLists(state.currentFamilyId);
  });

  // New list (sidebar)
  document.getElementById('btn-sidebar-new-list')?.addEventListener('click', () => openModal('modal-create-list'));

  // Sign out (sidebar footer and phone top bar avatar menus)
  document.querySelectorAll('[data-action="logout"]').forEach((btn) => btn.addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    resetAuthState();
    showView('view-auth');
    showToast('Signed out successfully.');
  }));

  // Passkey Login Button
  document.getElementById('btn-passkey-login')?.addEventListener('click', handlePasskeyLogin);

  // Google Login Button
  document.getElementById('btn-google-login')?.addEventListener('click', () => {
    window.location.href = '/api/auth/google';
  });

  // Email & Password Login Form
  document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('input-email').value.trim();
    const password = document.getElementById('input-password').value;

    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (res && res.ok) {
      const data = await res.json();
      state.csrfToken = data.csrfToken || state.csrfToken;
      if (data.mfaEnrollmentRequired) {
        showToast('Mandatory 2FA setup required. Please enroll an authenticator app.');
        startTotpEnrollment();
      } else if (data.mfaRequired || data.mfa_required) {
        document.getElementById('mfa-step').hidden = false;
        document.getElementById('group-password').hidden = true;
        document.getElementById('btn-submit-login').hidden = true;
        showToast('Please enter your 2FA authenticator code or recovery code.');
      } else {
        checkCurrentSession();
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Invalid credentials');
    }
  });

  // MFA Verification Button
  document.getElementById('btn-verify-mfa')?.addEventListener('click', async () => {
    const totpCode = document.getElementById('input-totp-code').value.trim();
    const recoveryCode = document.getElementById('input-recovery-code').value.trim();

    if (totpCode) {
      const res = await apiFetch('/api/auth/mfa/totp/verify', {
        method: 'POST',
        body: JSON.stringify({ code: totpCode }),
      });
      if (res && res.ok) {
        checkCurrentSession();
        return;
      }
    } else if (recoveryCode) {
      const res = await apiFetch('/api/auth/mfa/recovery/verify', {
        method: 'POST',
        body: JSON.stringify({ recoveryCode }),
      });
      if (res && res.ok) {
        checkCurrentSession();
        return;
      }
    }
    showToast('Invalid 2FA code or recovery code.');
  });

  // TOTP Enable Form in Modal
  document.getElementById('form-totp-enable')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('totp-verify-code').value.trim();
    if (!code) return;

    const res = await apiFetch('/api/auth/mfa/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (res && res.ok) {
      const data = await res.json();
      const step1 = document.getElementById('totp-setup-step-1');
      const step2 = document.getElementById('totp-setup-step-2');
      const codesBox = document.getElementById('totp-recovery-codes-box');

      if (step1) step1.hidden = true;
      if (step2) step2.hidden = false;
      if (codesBox && Array.isArray(data.recoveryCodes)) {
        codesBox.innerHTML = data.recoveryCodes
          .map((c) => `<div class="recovery-code-pill">${c}</div>`)
          .join('');
      }
      showToast('Two-step sign-in is on.');
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Invalid 6-digit verification code');
    }
  });

  document.getElementById('btn-totp-complete')?.addEventListener('click', () => {
    closeActiveModal();
    checkCurrentSession();
  });

  // Passkey Accept Invite Button
  document.getElementById('btn-accept-with-passkey')?.addEventListener('click', async () => {
    if (state.pendingAssistedToken) {
      try {
        const res = await apiFetch('/api/auth/assisted-enroll', {
          method: 'POST',
          body: JSON.stringify({ token: state.pendingAssistedToken }),
        });
        if (res && res.ok) {
          const data = await res.json();
          state.sessionKind = 'user';
          state.currentUser = data.user;
          state.csrfToken = data.csrfToken || '';
          showToast('Passkey set up. Welcome to the family.');
          if (data.recoveryCodes && data.recoveryCodes.length > 0) {
            const step1 = document.getElementById('totp-setup-step-1');
            const step2 = document.getElementById('totp-setup-step-2');
            const codesBox = document.getElementById('totp-recovery-codes-box');
            if (step1) step1.hidden = true;
            if (step2) step2.hidden = false;
            if (codesBox) {
              codesBox.innerHTML = data.recoveryCodes
                .map((c) => `<div class="recovery-code-pill">${c}</div>`)
                .join('');
            }
            openModal('modal-totp-enrollment');
          } else {
            checkCurrentSession();
          }
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Assisted enrollment failed');
        }
      } catch (_e) {
        showToast('Assisted enrollment failed');
      }
    } else if (state.pendingInviteToken) {
      showToast('Please enter your name and password below to join, then you can enroll your passkey!');
      document.getElementById('accept-first-name')?.focus();
    } else {
      handlePasskeyRegister('Passkey');
    }
  });

  // Password Accept Invite Form
  document.getElementById('form-accept-invite-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('accept-first-name').value.trim();
    const lastName = document.getElementById('accept-last-name').value.trim();
    const password = document.getElementById('accept-password').value;

    if (!state.pendingInviteToken) {
      showToast('No pending invite found. Please use the invite link you received.');
      return;
    }

    const res = await apiFetch('/api/auth/register-from-invite', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: state.pendingInviteToken,
        firstName,
        lastName,
        password,
      }),
    });

    if (res && res.ok) {
      const data = await res.json();
      state.sessionKind = 'user';
      state.currentUser = data.user;
      state.csrfToken = data.csrfToken || '';
      showToast('Welcome to the family! Please complete Two-Factor Authentication setup.');
      document.getElementById('subview-invite-accept').hidden = true;
      if (data.mfaEnrollmentRequired) {
        startTotpEnrollment();
      } else {
        checkCurrentSession();
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to accept invitation');
    }
  });

  // Cancel Invite & Back to Sign In
  document.getElementById('btn-cancel-invite')?.addEventListener('click', async () => {
    state.pendingInviteToken = null;
    state.pendingAssistedToken = null;
    await apiFetch('/api/links/clear-pending', { method: 'POST' }).catch(() => {});
    const banner = document.getElementById('subview-invite-accept');
    const signInCard = document.getElementById('card-signin');
    if (banner) banner.hidden = true;
    if (signInCard) signInCard.hidden = false;
  });

  // Quiet "I have an invite link" toggle
  document.getElementById('btn-toggle-manual-invite')?.addEventListener('click', (e) => {
    const form = document.getElementById('form-manual-invite');
    if (!form) return;
    form.hidden = !form.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) document.getElementById('input-manual-invite')?.focus();
  });

  // Manual Invite Link / Token Redeem Form
  document.getElementById('form-manual-invite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = document.getElementById('input-manual-invite')?.value || '';
    const ok = await openInviteWithToken(raw);
    if (ok) {
      document.getElementById('form-manual-invite')?.reset();
    }
  });
}
