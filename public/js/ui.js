/** Toasts, modals, and view switching. */
import { state } from './state.js';

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
}

/**
 * Build an overflow ("more actions") menu.
 * items: [{ label, icon, onClick } | { label, icon, href, download, external }]
 */
export function createOverflowMenu(items, label = 'More actions') {
  const wrap = document.createElement('div');
  wrap.className = 'menu-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'menu-btn icon-btn';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon('more-horizontal');

  const menu = document.createElement('div');
  menu.className = 'menu menu-right';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  items.forEach((it) => {
    const el = document.createElement(it.href ? 'a' : 'button');
    el.className = 'menu-item';
    el.setAttribute('role', 'menuitem');
    if (it.href) {
      el.href = it.href;
      if (it.download) el.download = it.download;
      if (it.external) {
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      }
    } else {
      el.type = 'button';
      el.addEventListener('click', it.onClick);
    }
    el.innerHTML = it.icon ? icon(it.icon) : '';
    el.append(document.createTextNode(` ${it.label}`));
    menu.appendChild(el);
  });

  wrap.append(btn, menu);
  return wrap;
}

export function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = msg;

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ==============================================================================
// 6. Modal Dialog Helper Functions
// ==============================================================================

export function openModal(modalId, context = {}) {
  closeActiveModal();
  const modal = document.getElementById(modalId);
  if (!modal) return;
  state.activeModal = modal;
  state.modalContext = context;
  modal.classList.add('is-active');

  const firstInput = modal.querySelector('input:not([type="hidden"]), select, textarea, button:not(.btn-close-modal)');
  const card = modal.querySelector('.modal-card');
  if (card) card.scrollTop = 0;
  if (firstInput) firstInput.focus({ preventScroll: true });
}

export function closeActiveModal() {
  if (state.activeModal) {
    state.activeModal.classList.remove('is-active');
    state.activeModal = null;
    state.modalContext = {};
  }
}

export function showView(viewId) {
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.remove('is-active');
  });

  const target = document.getElementById(viewId);
  if (target) {
    target.classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const navKey = VIEW_NAV[viewId];
  document.body.dataset.shell = navKey ? 'app' : 'minimal';
  closeMenus();

  // Mark the matching sidebar and tab items as the current page
  document.querySelectorAll('[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
  if (navKey) {
    document.querySelectorAll(`[data-nav="${navKey}"]`).forEach((el) => el.setAttribute('aria-current', 'page'));
    if (navKey === 'lists') document.querySelectorAll('.nav-list-row.is-active, .list-tab-btn.is-active').forEach((el) => el.setAttribute('aria-current', 'page'));
  }
}

const VIEW_NAV = {
  'view-dashboard': 'lists',
  'view-assignments': 'shopping',
  'view-share-links': 'share',
  'view-family-admin': 'family',
};

// ---- Dropdown menus (.menu-wrap > .menu-btn + .menu) ----
export function closeMenus(except = null) {
  document.querySelectorAll('.menu-wrap .menu-btn[aria-expanded="true"]').forEach((btn) => {
    const menu = btn.parentElement.querySelector('.menu');
    if (menu === except) return;
    btn.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

export function initMenus() {
  document.querySelectorAll('.menu-wrap .menu').forEach((m) => { m.hidden = true; });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-btn');
    if (btn) {
      const menu = btn.parentElement.querySelector('.menu');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      closeMenus(open ? menu : null);
      btn.setAttribute('aria-expanded', String(open));
      if (menu) {
        menu.hidden = !open;
        if (open) menu.querySelector('button, a')?.focus();
      }
      return;
    }
    if (!e.target.closest('.menu') || e.target.closest('.menu-item')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.menu-wrap .menu-btn[aria-expanded="true"]');
    if (!open) {
      closeActiveModal();
      return;
    }
    closeMenus();
    open.focus();
  });
  // Clicking the dimmed backdrop closes the open dialog or sheet
  document.addEventListener('click', (e) => {
    if (e.target.classList?.contains('modal-overlay')) closeActiveModal();
  });
}

export function resetAuthState() {
  state.sessionKind = null;
  state.currentUser = null;
  state.csrfToken = '';
  state.memberships = [];
  state.currentFamilyId = null;

  document.body.dataset.shell = 'minimal';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
