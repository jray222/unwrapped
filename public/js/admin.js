/** Family admin and instance admin views. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { icon, showView } from './ui.js';

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

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

export function renderFamilyMembers(members) {
  const tbody = document.getElementById('members-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = Array.isArray(members) ? members : [];

  list.forEach((m) => {
    const isAdmin = m.role === 'family_admin';
    const fullName = `${m.first_name || ''} ${m.last_name || ''}`.trim();
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const who = document.createElement('div');
    who.className = 'member-cell';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(m.first_name || m.email);
    const text = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'member-name';
    nm.textContent = fullName || m.email;
    const em = document.createElement('div');
    em.className = 'member-email';
    em.textContent = m.email || '';
    text.append(nm, em);
    who.append(avatar, text);
    nameCell.appendChild(who);

    const roleCell = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = `tag ${isAdmin ? '' : 'tag-quiet'}`.trim();
    tag.textContent = isAdmin ? 'Admin' : 'Member';
    roleCell.appendChild(tag);

    const actCell = document.createElement('td');
    actCell.className = 'cell-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = isAdmin ? 'Make member' : 'Make admin';
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/families/${state.currentFamilyId}/members/${m.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: isAdmin ? 'member' : 'family_admin' }),
      });
      loadFamilyAdminView();
    });
    actCell.appendChild(btn);

    tr.append(nameCell, roleCell, actCell);
    tbody.appendChild(tr);
  });
}

function describeAction(action) {
  const text = String(action || '').replace(/[._]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function renderAuditLogs(logs) {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = Array.isArray(logs) ? logs : [];

  if (list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'No activity yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  list.forEach((log) => {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.className = 'cell-muted';
    when.textContent = new Date(log.created_at).toLocaleString();
    const who = document.createElement('td');
    who.textContent = log.actor_label || 'Someone';
    const what = document.createElement('td');
    what.textContent = describeAction(log.action);
    tr.append(when, who, what);
    tbody.appendChild(tr);
  });
}

/** In-page tabs: Members | Invites | Activity. */
export function showFamilyTab(name) {
  document.querySelectorAll('#view-family-admin .tab-btn').forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  ['members', 'invites', 'activity'].forEach((t) => {
    const panel = document.getElementById(`tab-${t}`);
    if (panel) panel.hidden = t !== name;
  });
}

export function bindFamilyTabs() {
  const tabs = [...document.querySelectorAll('#view-family-admin .tab-btn')];
  tabs.forEach((btn, idx) => {
    btn.addEventListener('click', () => showFamilyTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      showFamilyTab(next.dataset.tab);
      next.focus();
    });
  });
}

export function initInstanceAdminInterface() {
  showView('view-instance-admin');
  loadInstanceAdminView();
}

export async function loadInstanceAdminView() {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '<p>Loading families...</p>';

  try {
    const res = await apiFetch('/api/instance-admin/families');
    if (!res || !res.ok) return;
    const data = await res.json();
    renderInstanceFamilies(data.families || data || []);
  } catch (_e) {
    container.innerHTML = '<p>Could not load families.</p>';
  }
}

export function renderInstanceFamilies(families) {
  const container = document.getElementById('instance-families-list');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(families) ? families : (families?.families || []);

  if (list.length === 0) {
    container.innerHTML = '<p class="form-hint">No families yet.</p>';
    return;
  }

  list.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'link-row';

    const badge = document.createElement('span');
    badge.className = 'avatar';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = icon('home');

    const info = document.createElement('div');
    info.className = 'link-info';
    const name = document.createElement('div');
    name.className = 'link-name';
    name.textContent = f.name;
    const dates = document.createElement('div');
    dates.className = 'link-dates';
    dates.textContent = `${f.slug} \u00b7 Created ${new Date(f.created_at).toLocaleDateString()}`;
    info.append(name, dates);

    const actions = document.createElement('div');
    actions.className = 'link-actions-group';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm btn-text-danger';
    btn.textContent = 'Remove family';
    btn.addEventListener('click', async () => {
      if (confirm(`Remove the family "${f.name}"? This can't be undone.`)) {
        await apiFetch(`/api/instance-admin/families/${f.id}`, { method: 'DELETE' });
        loadInstanceAdminView();
      }
    });
    actions.appendChild(btn);

    row.append(badge, info, actions);
    container.appendChild(row);
  });
}
