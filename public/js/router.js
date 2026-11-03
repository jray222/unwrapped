/** Hash router: #/lists/:id, #/shopping, #/share, #/family (signed-in members only). */
import { state } from './state.js';
import { showView } from './ui.js';
import { loadFamilyWishLists, selectWishList } from './lists.js';
import { loadAssignmentsView } from './assignments.js';
import { loadShareLinksView } from './share-links.js';
import { loadFamilyAdminView } from './admin.js';

export function parseHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = parts[0] || '';
  if (!['lists', 'shopping', 'share', 'family'].includes(name)) return { name: '', id: null };
  return { name, id: name === 'lists' && parts[1] ? decodeURIComponent(parts[1]) : null };
}

export function listIdFromHash() {
  return parseHash().id;
}

/** Keep the URL in sync without adding a history entry or firing hashchange. */
export function replaceHash(hash) {
  if (window.location.hash !== hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
  }
}

export function navigate(hash) {
  if (window.location.hash === hash) handleRoute();
  else window.location.hash = hash;
}

export async function handleRoute() {
  if (state.sessionKind !== 'user' || !state.currentFamilyId) return undefined;
  const { name, id } = parseHash();
  if (name === 'shopping') return loadAssignmentsView();
  if (name === 'share') return loadShareLinksView();
  if (name === 'family') {
    if (state.currentFamilyRole !== 'family_admin') return navigate('#/lists');
    return loadFamilyAdminView();
  }
  if (name === 'lists') {
    showView('view-dashboard');
    if (id && state.lists.some((l) => l.id === id)) return selectWishList(id);
    if (!state.currentList) return loadFamilyWishLists(state.currentFamilyId);
  }
  return undefined;
}

export function bindRouter() {
  window.addEventListener('hashchange', handleRoute);
}
