import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Servers — the hub's view of the nodes below it.
 *
 * ⚠️ A NEW TOP-LEVEL SECTION, AND PLAYERS STAY EXACTLY WHERE THEY ARE. Nodes are not screens and do
 * not belong in the Displays list; mixing them would make the one list an operator uses daily
 * ambiguous about what each row IS.
 *
 * ⚠️ REMOTE WORKSPACES DELIBERATELY DO NOT ENTER THE WORKSPACE SWITCHER. The switcher mints a JWT
 * with current_workspace_id and reloads — it assumes a local, WRITABLE workspace. Putting remote ones
 * behind it would mean every write surface (bulk assign, drag-to-group, playlist assign, the schedule
 * editor) growing a disabled state, and a UI full of dead controls teaches people the product is
 * broken. Read-only browsing lives here instead, and acting on something remote is a deep link to the
 * node that owns it.
 *
 * ⚠️ EVERY REMOTE ROW SHOWS ITS AGE. This screen reports on machines over links that fail
 * independently of them, so "online" without "as of when" is a claim the reader cannot check.
 */

let state = { nodes: [], devices: [], alerts: [], total: 0, search: '', offset: 0, limit: 50 };

/* live | stale | down | unknown → the dot, the word, and what it means. */
const STATUS_UI = {
  live:    { cls: 'online',  dot: '#22c55e', label: 'Online' },
  down:    { cls: 'offline', dot: '#ef4444', label: 'Offline' },
  // ⚠️ Amber, NOT red. Red says "this screen is broken"; amber says "we cannot currently see it".
  // Sending an engineer to a working site is the failure this colour exists to prevent.
  stale:   { cls: 'stale',   dot: '#f59e0b', label: 'Last known' },
  unknown: { cls: 'unknown', dot: '#94a3b8', label: 'Not reported' },
};

function ago(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function statusCell(d) {
  const ui = STATUS_UI[d.status] || STATUS_UI.unknown;
  return `
    <span class="status-dot" style="background:${ui.dot}"></span>
    <span>${esc(ui.label)}</span>
    <!-- ⚠️ The age sits on EVERY row, not only stale ones: a green dot from ninety minutes ago is a
         lie by omission, and the reader has no other way to tell. -->
    <span style="color:var(--text-muted);font-size:11px;margin-left:6px">${esc(ago(d.asOfAgeSec))}</span>`;
}

function nodeCard(n) {
  const online = n.devicesOnline == null
    // ⚠️ "—", never 0. Zero is a measurement; not knowing is not, and 0/40 tells an operator the
    // whole site is dark when the truth is that we lost contact with the observer.
    ? `<span title="This node is not currently reachable, so its screen count is the last one received">—</span>`
    : `${n.devicesOnline}`;
  return `
    <div class="info-card">
      <div class="info-card-label">${esc(n.nodeId || '')}</div>
      <div class="info-card-value">${online} / ${n.devicesTotal}</div>
      <div style="font-size:11px;color:var(--text-muted)">
        ${n.version ? esc(n.version) : ''}
        ${n.stale ? ' · <span style="color:var(--warning,#f59e0b)">not reachable</span>' : ''}
        ${n.openAlerts ? ` · ${n.openAlerts} open` : ''}
      </div>
    </div>`;
}

function deviceRow(d) {
  return `
    <tr>
      <td>${esc(d.name || '')}${d.name ? '' :
        // A health-only grant sends no name. Saying so beats an empty cell that reads as a bug.
        `<span style="color:var(--text-muted);font-style:italic">not shared</span>`}</td>
      <!-- ⚠️ The origin node is its OWN column, never concatenated into the name. Folding it in
           ("Lobby (Acme)") breaks sort and search for every row at once. -->
      <td><span class="badge">${esc(d.originNodeId || '')}</span></td>
      <td>${statusCell(d)}</td>
      <td>${d.deepLink
        ? `<a href="${esc(d.deepLink)}" target="_blank" rel="noopener">Open on its server &rarr;</a>`
        : '<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`;
}

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>${esc(t('nav.servers'))}</h2>
      <p class="muted">Servers connected to this one. This view is read-only — use the link on a row
      to act on something where it lives.</p>
    </div>
    <div id="serversRollup" class="info-grid"></div>
    <div class="card" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="serverSearch" class="input" placeholder="Search screens across all servers"
               style="max-width:340px">
        <span id="serversCount" class="muted" style="font-size:12px"></span>
      </div>
      <div id="serversNote" class="muted" style="font-size:12px;margin-bottom:8px"></div>
      <table class="data-table">
        <thead><tr><th>Screen</th><th>Server</th><th>Status</th><th></th></tr></thead>
        <tbody id="serversRows"></tbody>
      </table>
      <div id="serversPager" style="margin-top:12px;display:flex;gap:8px"></div>
    </div>`;

  container.querySelector('#serverSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.offset = 0;              // a new search starts at the beginning, not mid-fleet
    clearTimeout(state._t);
    // Debounced: the query is server-side and bounded, so a keystroke per request is real load on
    // the hub for a term the operator has not finished typing.
    state._t = setTimeout(() => load(container), 250);
  });

  await load(container);
}

async function load(container) {
  try {
    const [nodes, devices] = await Promise.all([
      api.get('/mesh/nodes'),
      api.get(`/mesh/devices?search=${encodeURIComponent(state.search)}` +
              `&limit=${state.limit}&offset=${state.offset}`),
    ]);
    state.nodes = nodes.nodes || [];
    state.devices = devices.devices || [];
    state.total = devices.total || 0;

    container.querySelector('#serversRollup').innerHTML =
      state.nodes.map(nodeCard).join('') ||
      '<p class="muted">No servers are connected to this one yet.</p>';

    container.querySelector('#serversRows').innerHTML =
      state.devices.map(deviceRow).join('') ||
      `<tr><td colspan="4" class="muted">No screens matched.</td></tr>`;

    container.querySelector('#serversCount').textContent =
      state.total ? `${state.total} screen${state.total === 1 ? '' : 's'}` : '';

    // ⚠️ The search caveat is rendered when the server sends one: a health-only grant has no names
    // to match, and without saying so the empty result reads as a broken search.
    container.querySelector('#serversNote').textContent = devices.searchNote || '';

    renderPager(container);
  } catch (e) {
    container.querySelector('#serversRows').innerHTML =
      `<tr><td colspan="4" class="muted">Could not load: ${esc(e.message || 'unknown error')}</td></tr>`;
  }
}

function renderPager(container) {
  const el = container.querySelector('#serversPager');
  const pages = Math.ceil(state.total / state.limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const page = Math.floor(state.offset / state.limit) + 1;
  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" ${state.offset === 0 ? 'disabled' : ''} id="pgPrev">Previous</button>
    <span class="muted" style="font-size:12px;align-self:center">Page ${page} of ${pages}</span>
    <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} id="pgNext">Next</button>`;
  el.querySelector('#pgPrev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit); load(container);
  });
  el.querySelector('#pgNext')?.addEventListener('click', () => {
    state.offset += state.limit; load(container);
  });
}

export function cleanup() {
  clearTimeout(state._t);
  state = { nodes: [], devices: [], alerts: [], total: 0, search: '', offset: 0, limit: 50 };
}
