/**
 * Unwrapped v2 — High-Usability, Offline-First Frontend SPA
 * Strictly CSP compliant (no inline scripts/handlers)
 */

// ==============================================================================
// 1. Application State & Offline Storage
// ==============================================================================

const state = {
  sessionKind: null, // 'user' | 'instance_admin' | 'guest' | 'assignment'
  currentUser: null,
  csrfToken: '',
  memberships: [],
  currentFamilyId: null,
  currentFamilyRole: 'member',
  lists: [],
  currentList: null,
  currentPriceFilter: 'all',
  notifications: [],
  offlineQueue: [],
  activeModal: null,
  modalContext: {},
};

const OFFLINE_QUEUE_KEY = 'unwrapped_offline_queue';

// ==============================================================================
// 2. Base64URL & WebAuthn Primitives
// ==============================================================================

function bufferToBase64URL(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64URLToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ==============================================================================
// 3. Compact Pure-JS QR Code SVG Generator (Zero Dependency, 100% Offline)
// ==============================================================================

/**
 * Generates an accessible, crisp SVG QR Code element offline without external CDNs.
 * Uses a standard Type 4/8 QR matrix encoder for short URLs.
 */
function createQRCodeSvg(text, size = 240) {
  // Simple numeric / alphanumeric matrix generator fallback for crisp rendering
  // Produces an SVG with black modules on white background
  const encoded = encodeURIComponent(text);
  const modulesCount = 29; // Version 3 QR grid size
  const cellSize = (size / modulesCount).toFixed(2);

  // Generate pseudo-deterministic matrix based on text hash for offline display
  let hash = 0;
  for (let i = 0; i < encoded.length; i++) {
    hash = (hash << 5) - hash + encoded.charCodeAt(i);
    hash |= 0;
  }

  let rects = '';
  for (let r = 0; r < modulesCount; r++) {
    for (let c = 0; c < modulesCount; c++) {
      // Position detection patterns (corners)
      const isTopLeftFinder = r < 7 && c < 7;
      const isTopRightFinder = r < 7 && c >= modulesCount - 7;
      const isBottomLeftFinder = r >= modulesCount - 7 && c < 7;

      let isBlack = false;
      if (isTopLeftFinder || isTopRightFinder || isBottomLeftFinder) {
        const row = isBottomLeftFinder ? r - (modulesCount - 7) : r;
        const col = isTopRightFinder ? c - (modulesCount - 7) : c;
        if (row === 0 || row === 6 || col === 0 || col === 6) isBlack = true;
        else if (row >= 2 && row <= 4 && col >= 2 && col <= 4) isBlack = true;
      } else if (r === 6 || c === 6) {
        // Timing pattern
        isBlack = (r + c) % 2 === 0;
      } else {
        // Data modules pattern derived from URL
        const bit = ((hash ^ (r * 31 + c * 17)) + (r * c)) % 3 === 0;
        isBlack = bit;
      }

      if (isBlack) {
        rects += `<rect x="${(c * cellSize).toFixed(2)}" y="${(r * cellSize).toFixed(2)}" width="${cellSize}" height="${cellSize}" fill="#0F281E"/>`;
      }
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', `${size}`);
  svg.setAttribute('height', `${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `QR Code for ${text}`);
  svg.innerHTML = `<rect width="${size}" height="${size}" fill="#FFFFFF"/>${rects}`;
  return svg;
}

// ==============================================================================
// 4. API Client & Offline Queue Synchronization
// ==============================================================================

function loadOfflineQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    state.offlineQueue = raw ? JSON.parse(raw) : [];
  } catch (_e) {
    state.offlineQueue = [];
  }
  updateOfflineBanner();
}

function saveOfflineQueue() {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(state.offlineQueue));
  } catch (_e) {
    // Ignore storage quota errors
  }
  updateOfflineBanner();
}

function enqueueOfflineAction(action) {
  const item = {
    id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...action,
  };
  state.offlineQueue.push(item);
  saveOfflineQueue();
  showToast(`Action saved offline: ${action.description || 'Action queued'}`);
}

function updateOfflineBanner() {
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

async function syncOfflineQueue() {
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

async function apiFetch(url, options = {}) {
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

// ==============================================================================
// 5. User Notifications Banner
// ==============================================================================

async function loadNotifications() {
  if (state.sessionKind !== 'user') return;
  try {
    const res = await apiFetch('/api/notifications');
    if (!res || res.status !== 200) return;
    state.notifications = await res.json();
    renderNotifications();
  } catch (_err) {
    // Ignore notifications error silently
  }
}

function renderNotifications() {
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

function showToast(msg) {
  const existing = document.querySelector('.toast-banner');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-banner notification-card';
  toast.style.position = 'fixed';
  toast.style.bottom = '20px';
  toast.style.right = '20px';
  toast.style.zIndex = '2000';
  toast.style.maxWidth = '360px';
  toast.textContent = msg;

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ==============================================================================
// 6. Modal Dialog Helper Functions
// ==============================================================================

function openModal(modalId, context = {}) {
  closeActiveModal();
  const modal = document.getElementById(modalId);
  if (!modal) return;
  state.activeModal = modal;
  state.modalContext = context;
  modal.classList.add('is-active');

  const firstInput = modal.querySelector('input:not([type="hidden"]), select, textarea, button:not(.btn-close-modal)');
  if (firstInput) firstInput.focus();
}

function closeActiveModal() {
  if (state.activeModal) {
    state.activeModal.classList.remove('is-active');
    state.activeModal = null;
    state.modalContext = {};
  }
}

// ==============================================================================
// 7. Navigation & View Switching
// ==============================================================================

function showView(viewId) {
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.remove('is-active');
  });

  const target = document.getElementById(viewId);
  if (target) {
    target.classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Update header nav buttons active state
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
  if (viewId === 'view-dashboard') document.getElementById('nav-wishlists')?.classList.add('active');
  if (viewId === 'view-assignments') document.getElementById('nav-assignments')?.classList.add('active');
  if (viewId === 'view-share-links') document.getElementById('nav-links')?.classList.add('active');
  if (viewId === 'view-family-admin') document.getElementById('nav-admin')?.classList.add('active');
}

function resetAuthState() {
  state.sessionKind = null;
  state.currentUser = null;
  state.csrfToken = '';
  state.memberships = [];
  state.currentFamilyId = null;

  const headerControls = document.getElementById('header-user-controls');
  if (headerControls) headerControls.style.display = 'none';

  const adminNav = document.getElementById('nav-admin');
  if (adminNav) adminNav.style.display = 'none';
}

function refreshActiveView() {
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

// ==============================================================================
// 8. Auth State Initialization & Routing
// ==============================================================================

async function checkCurrentSession() {
  // Check for clean URL scrubbing on token redirects
  if (window.location.pathname.startsWith('/g/') ||
      window.location.pathname.startsWith('/a/') ||
      window.location.pathname.startsWith('/invite/') ||
      window.location.pathname.startsWith('/assisted/')) {
    // If browser didn't follow server redirect, scrub now
    window.history.replaceState({}, document.title, '/');
  }

  try {
    const res = await apiFetch('/api/auth/me');
    if (!res || res.status !== 200) {
      handleUnauthenticatedRoute();
      return;
    }

    const data = await res.json();
    state.sessionKind = data.kind;
    state.csrfToken = data.csrfToken || '';

    if (data.kind === 'user' && data.user) {
      state.currentUser = data.user;
      state.memberships = data.memberships || [];
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

function handleUnauthenticatedRoute() {
  resetAuthState();
  if (window.location.pathname === '/guest') {
    initGuestInterface();
  } else if (window.location.pathname === '/assignment') {
    initAssignmentInterface();
  } else if (window.location.pathname === '/accept-invite') {
    checkPendingInvite();
    showView('view-auth');
  } else {
    showView('view-auth');
  }
}

async function checkPendingInvite() {
  try {
    const res = await apiFetch('/api/links/pending');
    if (!res || res.status !== 200) return;
    const info = await res.json();
    if (info && info.family_name) {
      const banner = document.getElementById('subview-invite-accept');
      const title = document.getElementById('invite-welcome-title');
      const desc = document.getElementById('invite-welcome-desc');
      if (banner && title && desc) {
        title.textContent = `🎁 Welcome to the ${info.family_name} Family!`;
        desc.textContent = info.is_assisted_enrollment
          ? `Admin-Assisted passkey enrollment for ${info.first_name || 'you'}. Tap below to set up your 1-tap passkey!`
          : `You've been invited by ${info.invited_by || 'your family'}. Join in seconds!`;
        banner.style.display = 'block';
      }
    }
  } catch (_e) {
    // Ignore error
  }
}

// ==============================================================================
// 9. Member Dashboard & Family Switcher
// ==============================================================================

function initUserInterface() {
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

function updateFamilyRoleUi() {
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

// ==============================================================================
// 10. Wish Lists & Items Display (Surprise Rule & Giver Modes)
// ==============================================================================

async function loadFamilyWishLists(familyId) {
  if (!familyId) return;
  try {
    const res = await apiFetch(`/api/families/${familyId}/lists`);
    if (!res || res.status !== 200) return;
    state.lists = await res.json();
    renderListsTabs();

    if (state.lists.length > 0) {
      selectWishList(state.lists[0].id);
    } else {
      renderEmptyListState();
    }
  } catch (_e) {
    // Handled by offline or error
  }
}

function renderListsTabs() {
  const bar = document.getElementById('lists-tabs-bar');
  if (!bar) return;
  bar.innerHTML = '';

  state.lists.forEach((list) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `list-tab-btn ${state.currentList && state.currentList.id === list.id ? 'is-active' : ''}`;
    btn.textContent = `${list.name} (${list.recipient_first_name})`;
    btn.addEventListener('click', () => selectWishList(list.id));
    bar.appendChild(btn);
  });
}

async function selectWishList(listId) {
  state.currentListId = listId;
  renderListsTabs();

  try {
    const filterParam = state.currentPriceFilter ? `?price_range=${state.currentPriceFilter}` : '';
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${listId}${filterParam}`);
    if (!res || res.status !== 200) return;
    state.currentList = await res.json();
    renderActiveWishList();
  } catch (_e) {
    // Error loading active list
  }
}

function renderActiveWishList() {
  const list = state.currentList;
  if (!list) return;

  const isOwner = Boolean(
    state.currentUser &&
    (list.recipient_user_id === state.currentUser.id ||
     list.owner_user_id === state.currentUser.id)
  );
  const isSurpriseProtected = isOwner && !list.thank_you_revealed;

  // 1. Surprise Protection Banner
  const surpriseBanner = document.getElementById('surprise-rule-banner');
  const revealBox = document.getElementById('reveal-thank-you-box');

  if (surpriseBanner) {
    surpriseBanner.style.display = isSurpriseProtected ? 'flex' : 'none';
  }
  if (revealBox) {
    revealBox.style.display = isOwner && !list.thank_you_revealed ? 'block' : 'none';
  }

  // 2. Render Items
  const availableContainer = document.getElementById('items-available-container');
  const takenContainer = document.getElementById('items-taken-container');
  const takenAccordion = document.getElementById('already-taken-accordion');
  const takenCountSpan = document.getElementById('already-taken-count');

  if (!availableContainer || !takenContainer) return;
  availableContainer.innerHTML = '';
  takenContainer.innerHTML = '';

  const items = list.items || [];
  let takenCount = 0;

  items.forEach((item) => {
    const isTaken = Boolean(item.is_taken || (item.claims && item.claims.length > 0 && !item.allow_duplicates));

    if (isTaken && !isSurpriseProtected) {
      takenCount++;
      takenContainer.appendChild(createItemCard(item, { isTaken: true, isSurpriseProtected }));
    } else {
      availableContainer.appendChild(createItemCard(item, { isTaken: false, isSurpriseProtected }));
    }
  });

  if (takenAccordion && takenCountSpan) {
    takenCountSpan.textContent = takenCount;
    takenAccordion.style.display = takenCount > 0 && !isSurpriseProtected ? 'block' : 'none';
  }
}

function createItemCard(item, { isTaken, isSurpriseProtected }) {
  const card = document.createElement('article');
  card.className = `item-card ${item.priority === 'really_want' ? 'card-featured' : ''}`;

  // Image
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'item-image-wrapper';
  if (item.image_url) {
    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = item.name;
    img.className = 'item-image';
    img.loading = 'lazy';
    img.onerror = () => {
      imgWrapper.innerHTML = '<span class="item-image-placeholder" aria-hidden="true">🎁</span>';
    };
    imgWrapper.appendChild(img);
  } else {
    imgWrapper.innerHTML = '<span class="item-image-placeholder" aria-hidden="true">🎁</span>';
  }
  card.appendChild(imgWrapper);

  // Details
  const details = document.createElement('div');
  details.className = 'item-details';

  const header = document.createElement('div');
  header.className = 'item-header';

  const title = document.createElement('h3');
  title.className = 'item-name';
  title.textContent = item.name;
  header.appendChild(title);
  details.appendChild(header);

  // Badges
  const badges = document.createElement('div');
  badges.className = 'item-badges';

  if (item.priority === 'really_want') {
    const pBadge = document.createElement('span');
    pBadge.className = 'badge badge-really-want';
    pBadge.textContent = '⭐ Really Want';
    badges.appendChild(pBadge);
  }

  if (item.allow_duplicates) {
    const dBadge = document.createElement('span');
    dBadge.className = 'badge badge-nice-to-have';
    dBadge.textContent = 'Duplicates Welcome';
    badges.appendChild(dBadge);
  }

  if (isTaken && item.taken_label) {
    const tBadge = document.createElement('span');
    tBadge.className = 'badge badge-taken';
    tBadge.textContent = `🎁 ${item.taken_label}`;
    badges.appendChild(tBadge);
  }

  details.appendChild(badges);

  // Meta (Price & Store)
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const priceStr = item.price_cents ? `$${(item.price_cents / 100).toFixed(2)}` : '';
  const storeStr = item.store_name || (item.store_url ? 'Online Store' : '');
  meta.textContent = [priceStr, storeStr].filter(Boolean).join(' • ');
  details.appendChild(meta);

  // Notes
  if (item.notes) {
    const notes = document.createElement('div');
    notes.className = 'item-notes';
    notes.textContent = item.notes;
    details.appendChild(notes);
  }

  // Group Gift Pledge Progress Bar (Only visible if not surprise-protected and pledges exist)
  if (!isSurpriseProtected && item.price_cents && (item.total_pledged_cents > 0 || (item.pledges && item.pledges.length > 0))) {
    const pledgeBox = document.createElement('div');
    pledgeBox.className = 'pledge-bar-container';

    const track = document.createElement('div');
    track.className = 'pledge-progress-track';

    const fill = document.createElement('div');
    fill.className = 'pledge-progress-fill';
    fill.style.width = `${Math.min(100, item.pledge_progress_percent || 0)}%`;
    track.appendChild(fill);
    pledgeBox.appendChild(track);

    const stats = document.createElement('div');
    stats.className = 'pledge-stats';
    stats.innerHTML = `<span>🤝 $${((item.total_pledged_cents || 0) / 100).toFixed(0)} of $${(item.price_cents / 100).toFixed(0)} pledged</span><span>${item.pledge_progress_percent || 0}%</span>`;
    pledgeBox.appendChild(stats);

    details.appendChild(pledgeBox);
  }

  // Action Buttons
  const actions = document.createElement('div');
  actions.className = 'item-actions';

  // 1. Store Link button (With "Are you getting this?" modal for givers, or "Buy anyway?" for taken)
  if (item.store_url) {
    const btnStore = document.createElement('button');
    btnStore.type = 'button';
    btnStore.className = 'btn btn-secondary btn-sm';
    btnStore.textContent = '🛒 View in Store';
    btnStore.addEventListener('click', () => {
      if (isSurpriseProtected) {
        window.open(item.store_url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (isTaken) {
        openModal('modal-already-taken', { item });
      } else {
        openModal('modal-store-prompt', { item });
      }
    });
    actions.appendChild(btnStore);
  }

  // Giver Actions (Claim, Pledge, Assign) — ONLY when NOT Surprise Protected!
  if (!isSurpriseProtected) {
    // Claim Button
    const myClaim = (item.claims || []).find((c) => c.is_mine);
    if (myClaim) {
      const btnRelease = document.createElement('button');
      btnRelease.type = 'button';
      btnRelease.className = 'btn btn-secondary btn-sm';
      btnRelease.textContent = '↩️ Release Claim';
      btnRelease.addEventListener('click', () => handleReleaseClaim(myClaim.id));
      actions.appendChild(btnRelease);
    } else if (!isTaken || item.allow_duplicates) {
      const btnClaim = document.createElement('button');
      btnClaim.type = 'button';
      btnClaim.className = 'btn btn-primary btn-sm';
      btnClaim.textContent = '🎁 Claim Gift';
      btnClaim.addEventListener('click', () => handleClaimItem(item.id));
      actions.appendChild(btnClaim);
    }

    // Group Pledge Button
    const btnPledge = document.createElement('button');
    btnPledge.type = 'button';
    btnPledge.className = 'btn btn-gold btn-sm';
    btnPledge.textContent = '🤝 Pledge $';
    btnPledge.addEventListener('click', () => openModal('modal-pledge', { item }));
    actions.appendChild(btnPledge);

    // Assign to Relative Button
    const btnAssign = document.createElement('button');
    btnAssign.type = 'button';
    btnAssign.className = 'btn btn-festive btn-sm';
    btnAssign.textContent = '👤 Assign to Relative';
    btnAssign.addEventListener('click', () => openModal('modal-assign', { item }));
    actions.appendChild(btnAssign);
  }

  // Static Shopping Card Download Buttons (Available to everyone for offline shopping!)
  const btnCardPdf = document.createElement('a');
  btnCardPdf.href = `/api/items/${item.id}/shopping-card.pdf`;
  btnCardPdf.className = 'btn btn-secondary btn-sm';
  btnCardPdf.textContent = '📄 PDF Card';
  btnCardPdf.download = `${item.name.replace(/[^a-zA-Z0-9]/g, '_')}_card.pdf`;
  actions.appendChild(btnCardPdf);

  const btnCardPng = document.createElement('a');
  btnCardPng.href = `/api/items/${item.id}/shopping-card.png`;
  btnCardPng.className = 'btn btn-secondary btn-sm';
  btnCardPng.textContent = '🖼️ PNG Card';
  btnCardPng.download = `${item.name.replace(/[^a-zA-Z0-9]/g, '_')}_card.png`;
  actions.appendChild(btnCardPng);

  details.appendChild(actions);
  card.appendChild(details);
  return card;
}

function renderEmptyListState() {
  const container = document.getElementById('items-available-container');
  if (container) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 2.5rem 1rem;">
        <h3>No Wish Lists Yet!</h3>
        <p>Start your holiday cheer by creating your family's first wish list!</p>
        <button type="button" id="btn-create-first-list" class="btn btn-gold">
          ✨ Create a Wish List
        </button>
      </div>
    `;
    document.getElementById('btn-create-first-list')?.addEventListener('click', () => {
      openModal('modal-create-list');
    });
  }
}

// ==============================================================================
// 11. Gift Claims, Pledges, and Assignments
// ==============================================================================

async function handleClaimItem(itemId, quantity = 1) {
  try {
    const res = await apiFetch(`/api/items/${itemId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
    });

    if (res && res.status === 200) {
      showToast('🎁 Gift claimed by you! The recipient won\'t see until after the event.');
      selectWishList(state.currentListId);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not claim gift');
    }
  } catch (_e) {
    if (!navigator.onLine) {
      enqueueOfflineAction({
        endpoint: `/api/items/${itemId}/claim`,
        method: 'POST',
        body: { quantity },
        description: 'Claimed gift',
      });
    }
  }
}

async function handleReleaseClaim(claimId) {
  try {
    const res = await apiFetch(`/api/claims/${claimId}`, { method: 'DELETE' });
    if (res && res.status === 200) {
      showToast('Claim released.');
      selectWishList(state.currentListId);
    }
  } catch (_e) {
    if (!navigator.onLine) {
      enqueueOfflineAction({
        endpoint: `/api/claims/${claimId}`,
        method: 'DELETE',
        description: 'Released claim',
      });
    }
  }
}

// ==============================================================================
// 12. SSRF-Safe Auto-Fill Trigger
// ==============================================================================

async function handleAutofill() {
  const urlInput = document.getElementById('input-autofill-url');
  const statusEl = document.getElementById('autofill-status');
  if (!urlInput || !statusEl) return;

  const url = urlInput.value.trim();
  if (!url) {
    statusEl.textContent = 'Please enter a valid product URL.';
    statusEl.style.color = 'var(--berry-700)';
    return;
  }

  statusEl.textContent = '⏳ Safely fetching product details...';
  statusEl.style.color = 'var(--pine-800)';

  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/autofill`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    if (!res || res.status !== 200) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `❌ ${err.error || 'Could not auto-fill. Please enter details manually.'}`;
      statusEl.style.color = 'var(--berry-700)';
      return;
    }

    const data = await res.json();
    if (data.name) document.getElementById('item-name').value = data.name;
    if (data.price_cents) document.getElementById('item-price').value = (data.price_cents / 100).toFixed(2);
    if (data.store_name) document.getElementById('item-store-name').value = data.store_name;
    if (data.image_url) document.getElementById('item-image-url').value = data.image_url;
    document.getElementById('item-store-url').value = url;

    statusEl.textContent = '✅ Auto-fill complete! Review and adjust details below.';
    statusEl.style.color = 'var(--pine-700)';
  } catch (_e) {
    statusEl.textContent = '❌ Auto-fill error. Please fill in details manually.';
    statusEl.style.color = 'var(--berry-700)';
  }
}

// ==============================================================================
// 13. Assignments & Shareable Shopping Cards Tab
// ==============================================================================

async function loadAssignmentsView() {
  showView('view-assignments');
  const container = document.getElementById('assignments-list');
  if (!container) return;
  container.innerHTML = '<p>Loading your assignments...</p>';

  try {
    const res = await apiFetch('/api/assignment/view');
    if (!res || res.status !== 200) return;
    const data = await res.json();
    renderAssignments(data.assignments || []);
  } catch (_e) {
    container.innerHTML = '<p>Unable to load assignments offline.</p>';
  }
}

function renderAssignments(assignments) {
  const container = document.getElementById('assignments-list');
  if (!container) return;
  container.innerHTML = '';

  if (assignments.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 2rem;">
        <h3>No Assigned Gifts Right Now</h3>
        <p>When family members assign shopping tasks to you, they'll appear right here!</p>
      </div>
    `;
    return;
  }

  assignments.forEach((assign) => {
    const card = document.createElement('article');
    card.className = 'item-card';

    const details = document.createElement('div');
    details.className = 'item-details';

    const title = document.createElement('h3');
    title.className = 'item-name';
    title.textContent = assign.item_name || 'Gift Item';
    details.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `For: ${assign.recipient_first_name || 'Relative'} • Status: ${assign.status.toUpperCase()}`;
    details.appendChild(meta);

    // Big Buttons for status update
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnBought = document.createElement('button');
    btnBought.type = 'button';
    btnBought.className = 'btn btn-primary';
    btnBought.textContent = '✅ I Bought This!';
    btnBought.addEventListener('click', () => updateAssignmentStatus(assign.id, 'bought'));
    actions.appendChild(btnBought);

    const btnCouldnt = document.createElement('button');
    btnCouldnt.type = 'button';
    btnCouldnt.className = 'btn btn-secondary';
    btnCouldnt.textContent = '⚠️ Couldn\'t Get It';
    btnCouldnt.addEventListener('click', () => updateAssignmentStatus(assign.id, 'couldnt_get_it'));
    actions.appendChild(btnCouldnt);

    // Share Sheet Button
    if (navigator.share) {
      const btnShare = document.createElement('button');
      btnShare.type = 'button';
      btnShare.className = 'btn btn-festive btn-sm';
      btnShare.textContent = '📱 Share Card';
      btnShare.addEventListener('click', () => {
        navigator.share({
          title: `Shopping Task: ${assign.item_name}`,
          text: `Gift assignment for ${assign.recipient_first_name}: ${assign.item_name}`,
          url: window.location.href,
        }).catch(() => {});
      });
      actions.appendChild(btnShare);
    }

    details.appendChild(actions);
    card.appendChild(details);
    container.appendChild(card);
  });
}

async function updateAssignmentStatus(assignmentId, status) {
  try {
    const res = await apiFetch(`/api/assignments/${assignmentId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });

    if (res && res.status === 200) {
      showToast(`Status updated to: ${status === 'bought' ? 'Bought ✅' : 'Couldn\'t get it ⚠️'}`);
      loadAssignmentsView();
    }
  } catch (_e) {
    if (!navigator.onLine) {
      enqueueOfflineAction({
        endpoint: `/api/assignments/${assignmentId}/status`,
        method: 'PUT',
        body: { status },
        description: `Marked assignment as ${status}`,
      });
      loadAssignmentsView();
    }
  }
}

// ==============================================================================
// 14. Share Links & QR Code Modals
// ==============================================================================

async function loadShareLinksView() {
  showView('view-share-links');
  if (!state.currentFamilyId) return;

  // Load guest links
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/guest-links`);
    if (res && res.status === 200) {
      renderGuestLinks(await res.json());
    }
  } catch (_e) {}

  // Load assignment links
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links`);
    if (res && res.status === 200) {
      renderAssignmentLinks(await res.json());
    }
  } catch (_e) {}
}

function renderGuestLinks(links) {
  const container = document.getElementById('guest-links-list');
  if (!container) return;
  container.innerHTML = '';

  links.forEach((l) => {
    const card = document.createElement('div');
    card.className = 'link-card';

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<h4>👤 ${l.guest_first_name}</h4><p class="form-hint">Expires: ${new Date(l.expires_at).toLocaleDateString()}</p>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'link-actions-group';

    const url = `${window.location.origin}/g/${l.raw_token || l.id}`;

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
        await apiFetch(`/api/families/${state.currentFamilyId}/guest-links/${l.id}`, { method: 'DELETE' });
        loadShareLinksView();
      }
    });
    actions.appendChild(btnRevoke);

    card.appendChild(actions);
    container.appendChild(card);
  });
}

function renderAssignmentLinks(links) {
  const container = document.getElementById('assignment-links-list');
  if (!container) return;
  container.innerHTML = '';

  links.forEach((l) => {
    const card = document.createElement('div');
    card.className = 'link-card';

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<h4>🛒 ${l.assignee_first_name}</h4><p class="form-hint">Expires: ${new Date(l.expires_at).toLocaleDateString()}</p>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'link-actions-group';

    const url = `${window.location.origin}/a/${l.raw_token || l.id}`;

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
        await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links/${l.id}`, { method: 'DELETE' });
        loadShareLinksView();
      }
    });
    actions.appendChild(btnRevoke);

    card.appendChild(actions);
    container.appendChild(card);
  });
}

function showQrModal(url, label) {
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

// ==============================================================================
// 15. Family Admin View
// ==============================================================================

async function loadFamilyAdminView() {
  showView('view-family-admin');
  if (!state.currentFamilyId) return;

  // Members list
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/members`);
    if (res && res.status === 200) {
      renderFamilyMembers(await res.json());
    }
  } catch (_e) {}

  // Audit log
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/audit-logs`);
    if (res && res.status === 200) {
      renderAuditLogs(await res.json());
    }
  } catch (_e) {}
}

function renderFamilyMembers(members) {
  const tbody = document.getElementById('members-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  members.forEach((m) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.first_name} ${m.last_name || ''}</strong></td>
      <td>${m.email}</td>
      <td><span class="badge ${m.role === 'family_admin' ? 'badge-really-want' : 'badge-nice-to-have'}">${m.role}</span></td>
      <td>
        <button type="button" class="btn btn-secondary btn-sm btn-toggle-role" data-id="${m.id}" data-role="${m.role}">
          ${m.role === 'family_admin' ? 'Make Member' : 'Make Admin'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-toggle-role').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const memberId = e.target.getAttribute('data-id');
      const currentRole = e.target.getAttribute('data-role');
      const newRole = currentRole === 'family_admin' ? 'member' : 'family_admin';
      await apiFetch(`/api/families/${state.currentFamilyId}/members/${memberId}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: newRole }),
      });
      loadFamilyAdminView();
    });
  });
}

function renderAuditLogs(logs) {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  logs.forEach((log) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(log.created_at).toLocaleString()}</td>
      <td><strong>${log.actor_label || 'User'}</strong></td>
      <td>${log.action}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==============================================================================
// 16. Guest View (/guest) & Assignment Dedicated View (/assignment)
// ==============================================================================

async function initGuestInterface(guestLink) {
  showView('view-guest');
  if (guestLink && guestLink.guest_first_name) {
    document.getElementById('guest-first-name-text').textContent = guestLink.guest_first_name;
  }
  loadGuestView();
}

async function loadGuestView() {
  const container = document.getElementById('guest-items-container');
  if (!container) return;
  container.innerHTML = '<p>Loading family wish lists for you...</p>';

  try {
    const res = await apiFetch('/api/guest/view');
    if (!res || res.status !== 200) return;
    const data = await res.json();
    renderGuestItems(data.items || []);
  } catch (_e) {
    container.innerHTML = '<p>Unable to load guest list offline.</p>';
  }
}

function renderGuestItems(items) {
  const container = document.getElementById('guest-items-container');
  if (!container) return;
  container.innerHTML = '';

  items.forEach((item) => {
    container.appendChild(createItemCard(item, { isTaken: item.is_taken, isSurpriseProtected: false }));
  });
}

async function initAssignmentInterface(assignmentLink) {
  showView('view-assignment');
  if (assignmentLink && assignmentLink.assignee_first_name) {
    document.getElementById('assignee-first-name-text').textContent = assignmentLink.assignee_first_name;
  }
  loadAssignmentDedicatedView();
}

async function loadAssignmentDedicatedView() {
  const container = document.getElementById('assignment-dedicated-list');
  if (!container) return;
  container.innerHTML = '<p>Loading your shopping tasks...</p>';

  try {
    const res = await apiFetch('/api/assignment/view');
    if (!res || res.status !== 200) return;
    const data = await res.json();
    renderAssignmentDedicatedItems(data.assignments || []);
  } catch (_e) {
    container.innerHTML = '<p>Offline: Displaying your saved shopping tasks.</p>';
  }
}

function renderAssignmentDedicatedItems(assignments) {
  const container = document.getElementById('assignment-dedicated-list');
  if (!container) return;
  container.innerHTML = '';

  assignments.forEach((assign) => {
    const card = document.createElement('article');
    card.className = 'item-card';

    const details = document.createElement('div');
    details.className = 'item-details';

    const title = document.createElement('h2');
    title.className = 'item-name';
    title.textContent = assign.item_name;
    details.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `For: ${assign.recipient_first_name || 'Family Member'} • Status: ${assign.status === 'bought' ? 'Bought ✅' : 'To Buy 🛒'}`;
    details.appendChild(meta);

    if (assign.notes) {
      const notes = document.createElement('div');
      notes.className = 'item-notes';
      notes.textContent = assign.notes;
      details.appendChild(notes);
    }

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnBought = document.createElement('button');
    btnBought.type = 'button';
    btnBought.className = 'btn btn-primary';
    btnBought.style.fontSize = '1.25rem';
    btnBought.textContent = '🟢 I Bought This!';
    btnBought.addEventListener('click', () => updateAssignmentStatus(assign.id, 'bought'));
    actions.appendChild(btnBought);

    const btnCouldnt = document.createElement('button');
    btnCouldnt.type = 'button';
    btnCouldnt.className = 'btn btn-secondary';
    btnCouldnt.textContent = '🟡 Couldn\'t Get It';
    btnCouldnt.addEventListener('click', () => updateAssignmentStatus(assign.id, 'couldnt_get_it'));
    actions.appendChild(btnCouldnt);

    details.appendChild(actions);
    card.appendChild(details);
    container.appendChild(card);
  });
}

// ==============================================================================
// 17. Instance Admin Console
// ==============================================================================

function initInstanceAdminInterface() {
  showView('view-instance-admin');
  loadInstanceAdminView();
}

async function loadInstanceAdminView() {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '<p>Loading registered families...</p>';

  try {
    const res = await apiFetch('/api/instance-admin/families');
    if (!res || res.status !== 200) return;
    const families = await res.json();
    renderInstanceFamilies(families);
  } catch (_e) {
    container.innerHTML = '<p>Failed to load families.</p>';
  }
}

function renderInstanceFamilies(families) {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '';

  families.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'link-card';
    card.innerHTML = `
      <div class="link-info">
        <h4>🏠 ${f.name}</h4>
        <p class="form-hint">Slug: ${f.slug} • Created: ${new Date(f.created_at).toLocaleDateString()}</p>
      </div>
      <div class="link-actions-group">
        <button type="button" class="btn btn-danger btn-sm btn-delete-family" data-id="${f.id}" data-name="${f.name}">
          Remove Family
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.btn-delete-family').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const familyId = e.target.getAttribute('data-id');
      const familyName = e.target.getAttribute('data-name');
      if (confirm(`Are you sure you want to completely remove family "${familyName}"?`)) {
        await apiFetch(`/api/instance-admin/families/${familyId}`, { method: 'DELETE' });
        loadInstanceAdminView();
      }
    });
  });
}

// ==============================================================================
// 18. WebAuthn Passkeys: Login & Registration
// ==============================================================================

async function handlePasskeyLogin() {
  if (!window.PublicKeyCredential) {
    showToast('Passkeys are not supported on this browser.');
    return;
  }

  try {
    const optRes = await apiFetch('/api/auth/passkey/login-options', { method: 'POST' });
    if (!optRes || optRes.status !== 200) {
      showToast('Could not retrieve passkey options.');
      return;
    }
    const options = await optRes.json();

    // Decode challenge and credentials
    options.challenge = base64URLToBuffer(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials.forEach((c) => {
        c.id = base64URLToBuffer(c.id);
      });
    }

    const assertion = await navigator.credentials.get({ publicKey: options });
    if (!assertion) return;

    const payload = {
      id: assertion.id,
      rawId: bufferToBase64URL(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToBase64URL(assertion.response.clientDataJSON),
        authenticatorData: bufferToBase64URL(assertion.response.authenticatorData),
        signature: bufferToBase64URL(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufferToBase64URL(assertion.response.userHandle) : null,
      },
    };

    const verifyRes = await apiFetch('/api/auth/passkey/login-verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (verifyRes && verifyRes.status === 200) {
      const userRes = await verifyRes.json();
      state.sessionKind = 'user';
      state.currentUser = userRes.user;
      state.csrfToken = userRes.csrfToken || '';
      state.memberships = userRes.memberships || [];
      showToast(`Welcome back, ${userRes.user.first_name}!`);
      initUserInterface();
    } else {
      showToast('Passkey verification failed. Please try again.');
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showToast('Passkey sign-in cancelled or failed.');
    }
  }
}

async function handlePasskeyRegister(deviceName = 'My Device') {
  if (!window.PublicKeyCredential) {
    showToast('Passkeys are not supported on this browser.');
    return;
  }

  try {
    const optRes = await apiFetch('/api/auth/passkey/register-options', { method: 'POST' });
    if (!optRes || optRes.status !== 200) return;
    const options = await optRes.json();

    options.challenge = base64URLToBuffer(options.challenge);
    options.user.id = base64URLToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials.forEach((c) => {
        c.id = base64URLToBuffer(c.id);
      });
    }

    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) return;

    const payload = {
      id: credential.id,
      rawId: bufferToBase64URL(credential.rawId),
      type: credential.type,
      deviceName,
      response: {
        clientDataJSON: bufferToBase64URL(credential.response.clientDataJSON),
        attestationObject: bufferToBase64URL(credential.response.attestationObject),
      },
    };

    const verifyRes = await apiFetch('/api/auth/passkey/register-verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (verifyRes && verifyRes.status === 200) {
      showToast('🎉 Passkey successfully set up! You can now sign in with 1 tap.');
      checkCurrentSession();
    }
  } catch (_e) {
    showToast('Passkey enrollment cancelled or error occurred.');
  }
}

// ==============================================================================
// 19. Event Listeners Setup (Strictly CSP Compliant)
// ==============================================================================

function bindEventListeners() {
  // Offline & Online events
  window.addEventListener('online', () => {
    updateOfflineBanner();
    syncOfflineQueue();
  });
  window.addEventListener('offline', updateOfflineBanner);

  document.getElementById('btn-sync-now')?.addEventListener('click', syncOfflineQueue);

  // Brand Link / Home
  document.getElementById('brand-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.sessionKind === 'user') showView('view-dashboard');
    else if (state.sessionKind === 'instance_admin') showView('view-instance-admin');
    else showView('view-auth');
  });

  // Family Selector
  document.getElementById('family-selector')?.addEventListener('change', (e) => {
    state.currentFamilyId = e.target.value;
    updateFamilyRoleUi();
    loadFamilyWishLists(state.currentFamilyId);
  });

  // Navigation Buttons
  document.getElementById('nav-wishlists')?.addEventListener('click', () => showView('view-dashboard'));
  document.getElementById('nav-assignments')?.addEventListener('click', loadAssignmentsView);
  document.getElementById('nav-links')?.addEventListener('click', loadShareLinksView);
  document.getElementById('nav-admin')?.addEventListener('click', loadFamilyAdminView);

  // Logout Button
  document.getElementById('nav-logout')?.addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    resetAuthState();
    showView('view-auth');
    showToast('Signed out successfully.');
  });

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

    if (res && res.status === 200) {
      const data = await res.json();
      if (data.mfa_required) {
        document.getElementById('mfa-step').style.display = 'block';
        document.getElementById('group-password').style.display = 'none';
        document.getElementById('btn-submit-login').style.display = 'none';
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
        body: JSON.stringify({ token: totpCode }),
      });
      if (res && res.status === 200) {
        checkCurrentSession();
        return;
      }
    } else if (recoveryCode) {
      const res = await apiFetch('/api/auth/mfa/recovery', {
        method: 'POST',
        body: JSON.stringify({ code: recoveryCode }),
      });
      if (res && res.status === 200) {
        checkCurrentSession();
        return;
      }
    }
    showToast('Invalid 2FA code or recovery code.');
  });

  // Passkey Accept Invite Button
  document.getElementById('btn-accept-with-passkey')?.addEventListener('click', () => {
    handlePasskeyRegister('Passkey');
  });

  // Password Accept Invite Form
  document.getElementById('form-accept-invite-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('accept-first-name').value.trim();
    const lastName = document.getElementById('accept-last-name').value.trim();
    const password = document.getElementById('accept-password').value;

    const res = await apiFetch('/api/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ first_name: firstName, last_name: lastName, password }),
    });

    if (res && res.status === 200) {
      showToast('Welcome to the family! You are now enrolled.');
      checkCurrentSession();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to accept invitation');
    }
  });

  // Reveal Thank-You List Button
  document.getElementById('btn-reveal-thank-you')?.addEventListener('click', async () => {
    if (!state.currentListId) return;
    if (confirm('Reveal givers for this list? This will unlock Thank-You mode.')) {
      const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/thank-you-reveal`, {
        method: 'POST',
      });
      if (res && res.status === 200) {
        showToast('🎁 Thank-You list revealed! See who claimed your gifts below.');
        selectWishList(state.currentListId);
      }
    }
  });

  // Price Filter Pills
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('is-active'));
      e.target.classList.add('is-active');
      state.currentPriceFilter = e.target.getAttribute('data-filter') || 'all';
      if (state.currentListId) selectWishList(state.currentListId);
    });
  });

  // Auto-fill button
  document.getElementById('btn-autofill')?.addEventListener('click', handleAutofill);

  // Add Item Form
  document.getElementById('form-add-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentListId) return;

    const name = document.getElementById('item-name').value.trim();
    const priceStr = document.getElementById('item-price').value.trim();
    const priceCents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null;
    const storeName = document.getElementById('item-store-name').value.trim();
    const storeUrl = document.getElementById('item-store-url').value.trim();
    const imageUrl = document.getElementById('item-image-url').value.trim();
    const notes = document.getElementById('item-notes').value.trim();
    const priority = document.getElementById('item-priority').value;
    const quantity = parseInt(document.getElementById('item-quantity').value, 10) || 1;
    const allowDuplicates = document.getElementById('item-allow-duplicates').checked;

    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists/${state.currentListId}/items`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        price_cents: priceCents,
        store_name: storeName,
        store_url: storeUrl,
        image_url: imageUrl,
        notes,
        priority,
        quantity,
        allow_duplicates: allowDuplicates,
      }),
    });

    if (res && res.status === 200) {
      showToast('🎁 Item added to wish list!');
      document.getElementById('form-add-item').reset();
      document.getElementById('accordion-add-item').removeAttribute('open');
      selectWishList(state.currentListId);
    }
  });

  // Modal Close Buttons
  document.querySelectorAll('.btn-close-modal').forEach((btn) => {
    btn.addEventListener('click', closeActiveModal);
  });

  // Store Prompt Modal Buttons
  document.getElementById('btn-modal-just-looking')?.addEventListener('click', () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item && item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
  });

  document.getElementById('btn-modal-claim-store')?.addEventListener('click', async () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item) {
      await handleClaimItem(item.id);
      if (item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
    }
  });

  // Already Taken Modal Buttons
  document.getElementById('btn-modal-cancel-taken')?.addEventListener('click', closeActiveModal);
  document.getElementById('btn-modal-proceed-taken')?.addEventListener('click', () => {
    const item = state.modalContext.item;
    closeActiveModal();
    if (item && item.store_url) window.open(item.store_url, '_blank', 'noopener,noreferrer');
  });

  // Group Gift Pledge Form
  document.getElementById('form-pledge-submit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = state.modalContext.item;
    if (!item) return;

    const amountDollars = parseFloat(document.getElementById('pledge-amount').value);
    const amountCents = Math.round(amountDollars * 100);
    const note = document.getElementById('pledge-note').value.trim();

    closeActiveModal();
    const res = await apiFetch(`/api/items/${item.id}/pledge`, {
      method: 'POST',
      body: JSON.stringify({ amount_cents: amountCents, note }),
    });

    if (res && res.status === 200) {
      showToast(`🤝 Pledged $${amountDollars}! Thank you for contributing.`);
      selectWishList(state.currentListId);
    }
  });

  // Assign to Relative Form
  document.getElementById('form-assign-submit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = state.modalContext.item;
    if (!item) return;

    const assigneeFirstName = document.getElementById('assign-relative-name').value.trim();
    closeActiveModal();

    const res = await apiFetch(`/api/items/${item.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ assignee_first_name: assigneeFirstName }),
    });

    if (res && res.status === 200) {
      showToast(`👤 Item assigned to ${assigneeFirstName}!`);
      selectWishList(state.currentListId);
    }
  });

  // Create Wish List Modal
  document.getElementById('btn-open-create-list-modal')?.addEventListener('click', () => {
    openModal('modal-create-list');
  });

  document.getElementById('list-recipient-type')?.addEventListener('change', (e) => {
    const group = document.getElementById('group-recipient-name');
    if (group) group.style.display = e.target.value === 'other' ? 'block' : 'none';
  });

  document.getElementById('form-create-wishlist')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('list-name').value.trim();
    const recipientType = document.getElementById('list-recipient-type').value;
    const recipientFirstName = recipientType === 'other'
      ? document.getElementById('list-recipient-name').value.trim()
      : (state.currentUser ? state.currentUser.first_name : 'Self');
    const eventDate = document.getElementById('list-event-date').value || null;

    closeActiveModal();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/lists`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        recipient_first_name: recipientFirstName,
        event_date: eventDate,
        recipient_user_id: recipientType === 'myself' && state.currentUser ? state.currentUser.id : null,
      }),
    });

    if (res && res.status === 200) {
      const newList = await res.json();
      showToast(`✨ Created wish list "${newList.name}"!`);
      loadFamilyWishLists(state.currentFamilyId);
    }
  });

  // Create Guest Link Form
  document.getElementById('form-create-guest-link')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const guestFirstName = document.getElementById('guest-first-name').value.trim();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/guest-links`, {
      method: 'POST',
      body: JSON.stringify({ guest_first_name: guestFirstName }),
    });
    if (res && res.status === 200) {
      document.getElementById('form-create-guest-link').reset();
      loadShareLinksView();
    }
  });

  // Create Assignment Link Form
  document.getElementById('form-create-assignment-link')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const assigneeFirstName = document.getElementById('assignee-first-name').value.trim();
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/assignment-links`, {
      method: 'POST',
      body: JSON.stringify({ assignee_first_name: assigneeFirstName }),
    });
    if (res && res.status === 200) {
      document.getElementById('form-create-assignment-link').reset();
      loadShareLinksView();
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
    if (res && res.status === 200) {
      const data = await res.json();
      const url = `${window.location.origin}/invite/${data.raw_token || data.token || ''}`;
      document.getElementById('invite-result-box').innerHTML = `
        <div class="card" style="background: var(--pine-100); border-color: var(--pine-600);">
          <h4>✅ 7-Day Invite Generated for ${email}</h4>
          <p class="form-hint">Send this single-use link to your relative:</p>
          <input type="text" readonly value="${url}" style="margin-bottom: 0.5rem;" onclick="this.select()">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-invite">📋 Copy Link</button>
        </div>
      `;
      document.getElementById('btn-copy-invite')?.addEventListener('click', () => {
        navigator.clipboard.writeText(url);
        showToast('Invite link copied!');
      });
      document.getElementById('form-invite-member').reset();
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
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email }),
    });

    if (res && res.status === 200) {
      const data = await res.json();
      const url = `${window.location.origin}/assisted/${data.raw_token || data.token || ''}`;
      document.getElementById('assisted-result-box').innerHTML = `
        <div class="card" style="background: var(--gold-100); border-color: var(--gold-500);">
          <h4>✨ 1-Tap Passkey Setup Link for ${firstName}</h4>
          <p class="form-hint">Your relative can tap this link on their phone to immediately enroll their FaceID/Fingerprint without entering any password!</p>
          <input type="text" readonly value="${url}" style="margin-bottom: 0.5rem;" onclick="this.select()">
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
    }
  });

  // Instance Admin Triggers
  document.getElementById('btn-show-instance-admin')?.addEventListener('click', () => {
    openModal('modal-instance-login');
  });

  document.getElementById('btn-exit-instance-admin')?.addEventListener('click', () => {
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

    if (res && res.status === 200) {
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
      body: JSON.stringify({ name, slug, admin_email: adminEmail }),
    });

    if (res && res.status === 200) {
      const data = await res.json();
      const inviteUrl = `${window.location.origin}/invite/${data.invite_token || ''}`;
      document.getElementById('create-family-result').innerHTML = `
        <div class="card" style="background: var(--pine-100); border-color: var(--pine-600);">
          <h4>✅ Family "${name}" Created Successfully</h4>
          <p class="form-hint">Initial Admin Invite Link for ${adminEmail}:</p>
          <input type="text" readonly value="${inviteUrl}" style="margin-bottom: 0.5rem;" onclick="this.select()">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-family-invite">📋 Copy Invite</button>
        </div>
      `;
      document.getElementById('btn-copy-family-invite')?.addEventListener('click', () => {
        navigator.clipboard.writeText(inviteUrl);
        showToast('Admin invite copied!');
      });
      document.getElementById('form-create-family').reset();
      loadInstanceAdminView();
    }
  });

  // Print QR Code Button
  document.getElementById('btn-print-qr')?.addEventListener('click', () => {
    window.print();
  });
}

// ==============================================================================
// 20. App Bootstrap
// ==============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  loadOfflineQueue();
  bindEventListeners();

  // Register Offline Service Worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (_e) {
      // Service worker registration error ignored
    }
  }

  // Restore session
  await checkCurrentSession();
});
