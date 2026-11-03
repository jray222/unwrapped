/** Family admin and instance admin views. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { showView } from './ui.js';

export async function loadFamilyAdminView() {
  showView('view-family-admin');
  if (!state.currentFamilyId) return;

  // Members list
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/members`);
    if (res && res.ok) {
      const data = await res.json();
      renderFamilyMembers(data.members || data || []);
    }
  } catch (_e) {}

  // Audit log
  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/audit-logs`);
    if (res && res.ok) {
      const data = await res.json();
      renderAuditLogs(data.auditLogs || data || []);
    }
  } catch (_e) {}
}

export function renderFamilyMembers(members) {
  const tbody = document.getElementById('members-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = Array.isArray(members) ? members : [];

  list.forEach((m) => {
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
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      loadFamilyAdminView();
    });
  });
}

export function renderAuditLogs(logs) {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = Array.isArray(logs) ? logs : [];

  list.forEach((log) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(log.created_at).toLocaleString()}</td>
      <td><strong>${log.actor_label || 'User'}</strong></td>
      <td>${log.action}</td>
    `;
    tbody.appendChild(tr);
  });
}

export function initInstanceAdminInterface() {
  showView('view-instance-admin');
  loadInstanceAdminView();
}

export async function loadInstanceAdminView() {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '<p>Loading registered families...</p>';

  try {
    const res = await apiFetch('/api/instance-admin/families');
    if (!res || !res.ok) return;
    const data = await res.json();
    renderInstanceFamilies(data.families || data || []);
  } catch (_e) {
    container.innerHTML = '<p>Failed to load families.</p>';
  }
}

export function renderInstanceFamilies(families) {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(families) ? families : (families?.families || []);

  list.forEach((f) => {
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
