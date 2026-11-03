/** Session bootstrap, invite routing, and member dashboard init. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { loadNotifications } from './notifications.js';
import { resetAuthState, showToast, showView } from './ui.js';
import { loadFamilyWishLists } from './lists.js';
import { initAssignmentInterface, loadAssignmentDedicatedView, loadAssignmentsView } from './assignments.js';
import { loadShareLinksView } from './share-links.js';
import { initInstanceAdminInterface, loadFamilyAdminView, loadInstanceAdminView } from './admin.js';
import { initGuestInterface, loadGuestView } from './guest.js';
import { startTotpEnrollment } from './passkeys.js';

export function refreshActiveView() {
  if (state.sessionKind === 'user') {
    if (document.getElementById('view-dashboard')?.classList.contains('is-active')) {
      loadFamilyWishLists(state.currentFamilyId);
    } else if (document.getElementById('view-assignments')?.classList.contains('is-active')) {
      loadAssignmentsView();
    } else if (document.getElementById('view-share-links')?.classList.contains('is-active')) {
      loadShareLinksView();
    } else if (document.getElementById('view-family-admin')?.classList.contains('is-active')) {
      loadFamilyAdminView();
    }
  } else if (state.sessionKind === 'guest') {
    loadGuestView();
  } else if (state.sessionKind === 'assignment') {
    loadAssignmentDedicatedView();
  } else if (state.sessionKind === 'instance_admin') {
    loadInstanceAdminView();
  }
}

export async function checkCurrentSession() {
  // Extract token directly if browser navigated to /invite/:token or /assisted/:token before redirect
  const path = window.location.pathname;
  if (path.startsWith('/invite/')) {
    state.pendingInviteToken = path.replace('/invite/', '').split(/[?#]/)[0];
  } else if (path.startsWith('/assisted/')) {
    state.pendingAssistedToken = path.replace('/assisted/', '').split(/[?#]/)[0];
  }

  const isInviteMode =
    path.startsWith('/invite/') ||
    path.startsWith('/assisted/') ||
    window.location.search.includes('mode=invite') ||
    window.location.search.includes('mode=assisted');

  // Scrub token paths or mode query from browser address bar
  if (
    path.startsWith('/g/') ||
    path.startsWith('/a/') ||
    path.startsWith('/invite/') ||
    path.startsWith('/assisted/') ||
    isInviteMode
  ) {
    window.history.replaceState({}, document.title, '/');
  }

  // Always check if there is a pending invite or assisted enrollment token first!
  const hasInvite = await checkPendingInvite();
  if (hasInvite) {
    showView('view-auth');
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me');
    if (!res || res.status !== 200) {
      handleUnauthenticatedRoute();
      return;
    }

    const data = await res.json();
    if (!data.authenticated) {
      handleUnauthenticatedRoute();
      return;
    }

    state.sessionKind = data.kind;
    state.csrfToken = data.csrfToken || '';

    if (data.kind === 'user' && data.user) {
      state.currentUser = data.user;
      state.memberships = data.memberships || [];
      if (!data.user.mfa_enrolled) {
        showView('view-auth');
        startTotpEnrollment();
        return;
      }
      initUserInterface();
    } else if (data.kind === 'instance_admin') {
      initInstanceAdminInterface();
    } else if (data.kind === 'guest') {
      initGuestInterface(data.guestLink);
    } else if (data.kind === 'assignment') {
      initAssignmentInterface(data.assignmentLink);
    } else {
      handleUnauthenticatedRoute();
    }
  } catch (_e) {
    handleUnauthenticatedRoute();
  }
}

export function handleUnauthenticatedRoute() {
  resetAuthState();
  if (window.location.pathname === '/guest') {
    initGuestInterface();
  } else if (window.location.pathname === '/assignment') {
    initAssignmentInterface();
  } else {
    showView('view-auth');
  }
}

export async function openInviteWithToken(rawInput, forceAssisted = false) {
  let cleaned = String(rawInput || '').trim();
  if (!cleaned) return false;

  let isAssisted = forceAssisted;
  if (cleaned.includes('/assisted/')) {
    cleaned = cleaned.split('/assisted/')[1].split(/[?#\s]/)[0];
    isAssisted = true;
  } else if (cleaned.includes('/invite/')) {
    cleaned = cleaned.split('/invite/')[1].split(/[?#\s]/)[0];
  } else {
    cleaned = cleaned.split(/[?#\s]/)[0];
  }

  if (isAssisted) {
    state.pendingAssistedToken = cleaned;
    state.pendingInviteToken = null;
  } else {
    state.pendingInviteToken = cleaned;
    state.pendingAssistedToken = null;
  }

  return renderInviteBannerForToken(cleaned, isAssisted);
}

export async function renderInviteBannerForToken(tokenToQuery, isAssisted = false) {
  try {
    const infoRes = await apiFetch(`/api/auth/invite-info/${encodeURIComponent(tokenToQuery)}`);
    if (!infoRes || !infoRes.ok) {
      showToast('Invite link is invalid, expired, or has already been used.');
      return false;
    }
    const info = await infoRes.json();

    const banner = document.getElementById('subview-invite-accept');
    const signInCard = document.getElementById('card-signin');
    const title = document.getElementById('invite-welcome-title');
    const desc = document.getElementById('invite-welcome-desc');
    const emailGroup = document.getElementById('group-invite-email-display');
    const emailInput = document.getElementById('accept-email-readonly');
    const assistedGroup = document.getElementById('assisted-passkey-group');
    const passwordForm = document.getElementById('form-accept-invite-password');

    if (info.isAssistedEnrollment || isAssisted) {
      state.pendingAssistedToken = tokenToQuery;
      state.pendingInviteToken = null;
    } else {
      state.pendingInviteToken = tokenToQuery;
      state.pendingAssistedToken = null;
    }

    if (banner && title && desc) {
      title.textContent = `🎁 Welcome to the ${info.familyName || 'Family'} Wish List!`;
      if (emailGroup && emailInput && info.email) {
        emailInput.value = info.email;
        emailGroup.style.display = 'block';
      }
      if (info.isAssistedEnrollment || isAssisted) {
        desc.textContent = `Admin-assisted enrollment for ${info.email || 'you'}. Tap below to complete your setup!`;
        if (assistedGroup) assistedGroup.style.display = 'block';
        if (passwordForm) passwordForm.style.display = 'none';
      } else {
        desc.textContent = `You've been invited to join ${info.familyName || 'the family'} as a ${info.role === 'family_admin' ? 'Family Admin' : 'Family Member'}. Create your account below:`;
        if (assistedGroup) assistedGroup.style.display = 'none';
        if (passwordForm) passwordForm.style.display = 'block';
      }
      banner.style.display = 'block';
      if (signInCard) signInCard.style.display = 'none';
      setTimeout(() => document.getElementById('accept-first-name')?.focus(), 50);
      return true;
    }
  } catch (_e) {
    // Ignore error
  }
  return false;
}

export async function checkPendingInvite() {
  try {
    let inviteToken = state.pendingInviteToken;
    let assistedToken = state.pendingAssistedToken;

    if (!inviteToken && !assistedToken) {
      const res = await apiFetch('/api/links/pending');
      if (res && res.ok) {
        const pending = await res.json();
        inviteToken = pending.inviteToken || null;
        assistedToken = pending.assistedToken || null;
      }
    }

    const tokenToQuery = inviteToken || assistedToken;
    if (!tokenToQuery) return false;

    return await renderInviteBannerForToken(tokenToQuery, Boolean(assistedToken));
  } catch (_e) {
    return false;
  }
}

export function initUserInterface() {
  const headerControls = document.getElementById('header-user-controls');
  if (headerControls) headerControls.style.display = 'flex';

  const familySelect = document.getElementById('family-selector');
  if (familySelect) {
    familySelect.innerHTML = '';
    state.memberships.forEach((mem) => {
      const opt = document.createElement('option');
      opt.value = mem.family_id;
      opt.textContent = `${mem.family_name} (${mem.role === 'family_admin' ? 'Admin' : 'Member'})`;
      familySelect.appendChild(opt);
    });

    if (state.memberships.length > 0) {
      state.currentFamilyId = state.memberships[0].family_id;
      state.currentFamilyRole = state.memberships[0].role;
      familySelect.value = state.currentFamilyId;
    }
  }

  updateFamilyRoleUi();
  loadNotifications();
  showView('view-dashboard');
  loadFamilyWishLists(state.currentFamilyId);
}

export function updateFamilyRoleUi() {
  const currentMem = state.memberships.find((m) => m.family_id === state.currentFamilyId);
  state.currentFamilyRole = currentMem ? currentMem.role : 'member';

  const adminNav = document.getElementById('nav-admin');
  if (adminNav) {
    adminNav.style.display = state.currentFamilyRole === 'family_admin' ? 'inline-flex' : 'none';
  }

  const roleText = document.getElementById('current-user-role-text');
  if (roleText && currentMem) {
    roleText.textContent = `${currentMem.family_name} — Role: ${currentMem.role === 'family_admin' ? 'Family Admin' : 'Family Member'}`;
  }
}
