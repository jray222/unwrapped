/** Toasts, modals, and view switching. */
import { state } from './state.js';

export function showToast(msg) {
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

  // Update header nav buttons active state
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
  if (viewId === 'view-dashboard') document.getElementById('nav-wishlists')?.classList.add('active');
  if (viewId === 'view-assignments') document.getElementById('nav-assignments')?.classList.add('active');
  if (viewId === 'view-share-links') document.getElementById('nav-links')?.classList.add('active');
  if (viewId === 'view-family-admin') document.getElementById('nav-admin')?.classList.add('active');
}

export function resetAuthState() {
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
