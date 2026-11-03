/** Assignments tab and dedicated assignment view. */
import { renderSkeletons } from './lists.js';
import { state } from './state.js';
import { enqueueOfflineAction } from './offline.js';
import { apiFetch } from './api.js';
import { icon, showToast, showView } from './ui.js';

export async function loadAssignmentsView() {
  showView('view-assignments');
  const container = document.getElementById('assignments-list');
  if (!container) return;
  renderSkeletons(container, 2);

  try {
    const endpoint = state.sessionKind === 'assignment'
      ? '/api/assignment/view'
      : (state.currentFamilyId ? `/api/families/${state.currentFamilyId}/assignments` : '/api/assignment/view');
    const res = await apiFetch(endpoint);
    if (!res || !res.ok) return;
    const data = await res.json();
    renderAssignments(data.assignments || []);
  } catch (_e) {
    container.innerHTML = '<p>Your shopping list is not available offline.</p>';
  }
}

function assignmentName(assign) {
  return assign.item_name || assign.name || 'Gift';
}

/** One checklist row: check-off toggle, item, who it is for, store link. */
export function createAssignmentRow(assign, { allowShare = true } = {}) {
  const done = assign.status === 'bought';
  const name = assignmentName(assign);
  const recipient = assign.recipient_first_name || assign.recipientFirstName || 'a relative';

  const row = document.createElement('article');
  row.className = `check-row ${done ? 'is-done' : ''}`.trim();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'check-toggle';
  toggle.disabled = done;
  toggle.setAttribute('aria-label', done ? `Bought: ${name}` : `I bought this: ${name}`);
  toggle.innerHTML = `<span class="check-box">${icon('check')}</span><span class="check-text">${done ? 'Bought' : 'I bought this'}</span>`;
  toggle.addEventListener('click', () => updateAssignmentStatus(assign.id, 'bought'));
  row.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'check-body';
  const title = document.createElement('h3');
  title.className = 'check-name';
  title.textContent = name;
  body.appendChild(title);
  const meta = document.createElement('p');
  meta.className = 'check-meta';
  const bits = [`For ${recipient}`];
  if (assign.store_name) bits.push(assign.store_name);
  if (assign.status === 'couldnt_get_it') bits.push("Couldn't get it");
  meta.textContent = bits.join(' \u00b7 ');
  body.appendChild(meta);
  if (assign.notes) {
    const notes = document.createElement('p');
    notes.className = 'check-notes';
    notes.textContent = assign.notes;
    body.appendChild(notes);
  }
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'check-actions';
  if (assign.store_url) {
    const link = document.createElement('a');
    link.className = 'icon-btn';
    link.href = assign.store_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Open store';
    link.setAttribute('aria-label', `Open store for ${name}`);
    link.innerHTML = icon('external-link');
    actions.appendChild(link);
  }
  if (!done) {
    const btnCouldnt = document.createElement('button');
    btnCouldnt.type = 'button';
    btnCouldnt.className = 'btn btn-ghost btn-sm';
    btnCouldnt.textContent = "Couldn't get it";
    btnCouldnt.addEventListener('click', () => updateAssignmentStatus(assign.id, 'couldnt_get_it'));
    actions.appendChild(btnCouldnt);
  }
  if (allowShare && navigator.share) {
    const btnShare = document.createElement('button');
    btnShare.type = 'button';
    btnShare.className = 'icon-btn';
    btnShare.title = 'Share';
    btnShare.setAttribute('aria-label', `Share ${name}`);
    btnShare.innerHTML = icon('share');
    btnShare.addEventListener('click', () => {
      navigator.share({
        title: `Shopping task: ${name}`,
        text: `Gift for ${recipient}: ${name}`,
        url: window.location.href,
      }).catch(() => {});
    });
    actions.appendChild(btnShare);
  }
  row.appendChild(actions);
  return row;
}

function emptyChecklist(container, title, text) {
  container.removeAttribute('aria-busy');
  container.innerHTML = `
    <div class="empty-state">
      ${icon('shopping-bag')}
      <h3>${title}</h3>
      <p>${text}</p>
      <a href="#/lists" class="btn btn-primary">Browse wish lists</a>
    </div>
  `;
}

export function renderAssignments(assignments) {
  const container = document.getElementById('assignments-list');
  if (!container) return;
  container.innerHTML = '';

  // Shopping card downloads live in the page header
  const cardActions = document.getElementById('shopping-card-actions');
  const ids = assignments.map((a) => a.id).filter(Boolean);
  if (cardActions) {
    cardActions.hidden = ids.length === 0 || !state.currentFamilyId;
    const query = `assignmentIds=${ids.map(encodeURIComponent).join(',')}`;
    const pdf = document.getElementById('btn-shopping-card-pdf');
    const png = document.getElementById('btn-shopping-card-png');
    if (pdf) {
      pdf.href = `/api/families/${state.currentFamilyId}/shopping-card.pdf?${query}`;
      pdf.download = 'shopping_card.pdf';
    }
    if (png) {
      png.href = `/api/families/${state.currentFamilyId}/shopping-card.png?${query}`;
      png.download = 'shopping_card.png';
    }
  }

  if (assignments.length === 0) {
    emptyChecklist(container, 'Nothing to buy right now', "When someone asks you to pick up a gift, it will show up here.");
    return;
  }

  assignments.forEach((assign) => container.appendChild(createAssignmentRow(assign)));
}

export async function updateAssignmentStatus(assignmentId, status) {
  try {
    const endpoint = state.currentFamilyId
      ? `/api/families/${state.currentFamilyId}/assignments/${assignmentId}`
      : `/api/assignments/${assignmentId}/status`;
    const res = await apiFetch(endpoint, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });

    if (res && res.ok) {
      showToast(status === 'bought' ? 'Marked as bought.' : "Marked as couldn't get it.");
      loadAssignmentsView();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not update this gift');
    }
  } catch (_e) {
    if (!navigator.onLine) {
      const endpoint = state.currentFamilyId
        ? `/api/families/${state.currentFamilyId}/assignments/${assignmentId}`
        : `/api/assignments/${assignmentId}/status`;
      enqueueOfflineAction({
        endpoint,
        method: 'PATCH',
        body: { status },
        description: `Marked assignment as ${status}`,
      });
      loadAssignmentsView();
    }
  }
}

export async function initAssignmentInterface(assignmentLink) {
  showView('view-assignment');
  if (assignmentLink && assignmentLink.assignee_first_name) {
    document.getElementById('assignee-first-name-text').textContent = assignmentLink.assignee_first_name;
  }
  loadAssignmentDedicatedView();
}

export async function loadAssignmentDedicatedView() {
  const container = document.getElementById('assignment-dedicated-list');
  if (!container) return;
  renderSkeletons(container, 2);

  try {
    const res = await apiFetch('/api/assignment/view');
    if (!res || res.status !== 200) return;
    const data = await res.json();
    renderAssignmentDedicatedItems(data.assignments || []);
  } catch (_e) {
    container.innerHTML = '<p>You are offline. Showing your saved shopping list.</p>';
  }
}

export function renderAssignmentDedicatedItems(assignments) {
  const container = document.getElementById('assignment-dedicated-list');
  if (!container) return;
  container.innerHTML = '';
  if (assignments.length === 0) {
    emptyChecklist(container, 'Nothing to buy right now', 'Check back soon.');
    return;
  }
  assignments.forEach((assign) => container.appendChild(createAssignmentRow(assign, { allowShare: false })));
}
