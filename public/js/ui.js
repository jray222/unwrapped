/** Toasts, modals, and view switching. */
import { state } from './state.js';

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
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
  if (firstInput) firstInput.focus();
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
        if (open) menu.querySelector('button')?.focus();
      }
      return;
    }
    if (!e.target.closest('.menu') || e.target.closest('.menu-item')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.menu-wrap .menu-btn[aria-expanded="true"]');
    if (!open) return;
    closeMenus();
    open.focus();
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
