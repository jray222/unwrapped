/** Assignments tab and dedicated assignment view. */
import { state } from './state.js';
import { enqueueOfflineAction } from './offline.js';
import { apiFetch } from './api.js';
import { showToast, showView } from './ui.js';

export async function loadAssignmentsView() {
  showView('view-assignments');
  const container = document.getElementById('assignments-list');
  if (!container) return;
  container.innerHTML = '<p>Loading your assignments...</p>';

  try {
    const endpoint = state.sessionKind === 'assignment'
      ? '/api/assignment/view'
      : (state.currentFamilyId ? `/api/families/${state.currentFamilyId}/assignments` : '/api/assignment/view');
    const res = await apiFetch(endpoint);
    if (!res || !res.ok) return;
    const data = await res.json();
    renderAssignments(data.assignments || []);
  } catch (_e) {
    container.innerHTML = '<p>Unable to load assignments offline.</p>';
  }
}

export function renderAssignments(assignments) {
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
    title.textContent = assign.item_name || assign.name || 'Gift Item';
    details.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `For: ${assign.recipient_first_name || assign.recipientFirstName || 'Relative'} • Status: ${(assign.status || 'assigned').toUpperCase()}`;
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
          title: `Shopping Task: ${assign.item_name || assign.name}`,
          text: `Gift assignment for ${assign.recipient_first_name || assign.recipientFirstName}: ${assign.item_name || assign.name}`,
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
      showToast(`Status updated to: ${status === 'bought' ? 'Bought ✅' : "Couldn't get it ⚠️"}`);
      loadAssignmentsView();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not update assignment status');
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

export function renderAssignmentDedicatedItems(assignments) {
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
