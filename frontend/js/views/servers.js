import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

/*
 * Servers — the hub's view of the nodes below it: the fleet, the alert inbox, the topology, and the
 * per-client uptime report.
 *
 * ⚠️ A NEW TOP-LEVEL SECTION, AND PLAYERS STAY EXACTLY WHERE THEY ARE. Nodes are not screens and do
 * not belong in the Displays list; mixing them would make the one list an operator uses daily
 * ambiguous about what each row IS.
 *
 * ⚠️ FOUR TABS, NOT FOUR NAV ITEMS. Alerts, topology and uptime are all answers about the same set of
 * connected servers, and a nav that grows an entry per question buries the section an operator
 * actually starts from. It also means an install with no mesh adds nothing to the sidebar at all.
 *
 * ⚠️ REMOTE WORKSPACES DELIBERATELY DO NOT ENTER THE WORKSPACE SWITCHER. The switcher mints a JWT with
 * current_workspace_id and reloads — it assumes a local, WRITABLE workspace. Putting remote ones
 * behind it would mean every write surface (bulk assign, drag-to-group, playlist assign, the schedule
 * editor) growing a disabled state, and a UI full of dead controls teaches people the product is
 * broken. Read-only browsing lives here instead, and acting on something remote is a deep link to the
 * node that owns it.
 *
 * ⚠️ EVERY REMOTE ROW SHOWS ITS AGE. This screen reports on machines over links that fail
 * independently of them, so "online" without "as of when" is a claim the reader cannot check.
 */

let state = {
  tab: 'fleet',
  nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
  clients: [], clientId: null, days: 30, report: null,
};

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

const hhmm = (sec) => (sec == null ? '' : new Date(sec * 1000).toLocaleString());
const mins = (sec) => (sec >= 3600 ? `${Math.round(sec / 360) / 10}h` : `${Math.round(sec / 60)}m`);

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

const TABS = [
  ['fleet', 'Screens'],
  ['alerts', 'Alerts'],
  ['topology', 'Topology'],
  ['uptime', 'Uptime report'],
  ['connect', 'Connect'],
];

/*
 * ⚠️ The grant vocabulary is spelled out for a HUMAN, in the order of how much it gives away. An
 * operator ticking boxes is deciding what another company may see about their customer's premises,
 * and "health, identity, network-wan" means nothing at the moment of the decision.
 */
const GRANTS = [
  ['health', 'Whether screens are alive and how they are coping', ''],
  ['identity', 'What each screen is called and what it runs', 'Without this, screens appear as opaque ids and cannot be searched by name.'],
  ['network-lan', 'Private addresses on the local network', 'Useful for on-site support. Does not identify the site to an outsider.'],
  ['display', 'What the screen hardware is doing', ''],
  ['content-metadata', 'What is scheduled to play', ''],
  ['proof-of-play', 'Evidence that specific content played at specific times', 'Never thinned in transit, so it stays usable as evidence — and costs more bandwidth at depth.'],
  ['diagnostics', 'Why something went wrong', ''],
  ['network-wan', 'The public internet address the screens appear from', '⚠️ Locates the premises — a public address is geolocatable to a town or building.'],
  ['display-capture', 'Actual images of what is on screen', '⚠️ Screenshots may contain whatever was on the screen, including anything private behind it.'],
];

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>${esc(t('nav.servers'))}</h2>
      <p class="muted">Servers connected to this one. This view is read-only — use the link on a row
      to act on something where it lives.</p>
    </div>
    <div class="tabs" id="serversTabs" style="display:flex;gap:4px;margin-bottom:16px">
      ${TABS.map(([id, label]) => `
        <button class="btn btn-sm ${state.tab === id ? 'btn-primary' : 'btn-secondary'}"
                data-tab="${id}">${esc(label)}</button>`).join('')}
    </div>
    <div id="serversPanel"></div>`;

  container.querySelector('#serversTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render(container);
  });

  const panel = container.querySelector('#serversPanel');
  if (state.tab === 'fleet') return renderFleet(panel);
  if (state.tab === 'alerts') return renderAlerts(panel);
  if (state.tab === 'topology') return renderTopology(panel);
  if (state.tab === 'connect') return renderConnect(panel);
  return renderUptime(panel);
}

/* ===================== the fleet ===================== */

async function renderFleet(panel) {
  panel.innerHTML = `
    <div id="serversRollup" class="info-grid"></div>
    <div class="card" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="serverSearch" class="input" placeholder="Search screens across all servers"
               style="max-width:340px" value="${esc(state.search)}">
        <span id="serversCount" class="muted" style="font-size:12px"></span>
      </div>
      <div id="serversNote" class="muted" style="font-size:12px;margin-bottom:8px"></div>
      <table class="data-table">
        <thead><tr><th>Screen</th><th>Server</th><th>Status</th><th></th></tr></thead>
        <tbody id="serversRows"></tbody>
      </table>
      <div id="serversPager" style="margin-top:12px;display:flex;gap:8px"></div>
    </div>`;

  panel.querySelector('#serverSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.offset = 0;              // a new search starts at the beginning, not mid-fleet
    clearTimeout(state._t);
    // Debounced: the query is server-side and bounded, so a keystroke per request is real load on
    // the hub for a term the operator has not finished typing.
    state._t = setTimeout(() => loadFleet(panel), 250);
  });

  await loadFleet(panel);
}

async function loadFleet(panel) {
  try {
    const [nodes, devices] = await Promise.all([
      api.get('/mesh/nodes'),
      api.get(`/mesh/devices?search=${encodeURIComponent(state.search)}` +
              `&limit=${state.limit}&offset=${state.offset}`),
    ]);
    state.nodes = nodes.nodes || [];
    state.devices = devices.devices || [];
    state.total = devices.total || 0;

    panel.querySelector('#serversRollup').innerHTML =
      state.nodes.map(nodeCard).join('') ||
      '<p class="muted">No servers are connected to this one yet.</p>';

    panel.querySelector('#serversRows').innerHTML =
      state.devices.map(deviceRow).join('') ||
      `<tr><td colspan="4" class="muted">No screens matched.</td></tr>`;

    panel.querySelector('#serversCount').textContent =
      state.total ? `${state.total} screen${state.total === 1 ? '' : 's'}` : '';

    // ⚠️ The search caveat is rendered when the server sends one: a health-only grant has no names
    // to match, and without saying so the empty result reads as a broken search.
    panel.querySelector('#serversNote').textContent = devices.searchNote || '';

    renderPager(panel);
  } catch (e) {
    panel.querySelector('#serversRows').innerHTML =
      `<tr><td colspan="4" class="muted">Could not load: ${esc(e.message || 'unknown error')}</td></tr>`;
  }
}

function renderPager(panel) {
  const el = panel.querySelector('#serversPager');
  const pages = Math.ceil(state.total / state.limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const page = Math.floor(state.offset / state.limit) + 1;
  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" ${state.offset === 0 ? 'disabled' : ''} id="pgPrev">Previous</button>
    <span class="muted" style="font-size:12px;align-self:center">Page ${page} of ${pages}</span>
    <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} id="pgNext">Next</button>`;
  el.querySelector('#pgPrev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit); loadFleet(panel);
  });
  el.querySelector('#pgNext')?.addEventListener('click', () => {
    state.offset += state.limit; loadFleet(panel);
  });
}

/* ===================== the alert inbox ===================== */

async function renderAlerts(panel) {
  panel.innerHTML = '<div class="card"><p class="muted">Loading alerts…</p></div>';
  let data;
  try {
    data = await api.get('/mesh/alerts');
  } catch (e) {
    panel.innerHTML = `<div class="card"><p class="muted">Could not load: ${esc(e.message)}</p></div>`;
    return;
  }

  /*
   * ⚠️ THE SELF-SUSPICION BANNER GOES FIRST, ABOVE THE ALERTS IT EXPLAINS. When most sites go quiet
   * at once the likely cause is this server's own connection, not forty simultaneous outages — and
   * the reader has to see that BEFORE the forty rows, because by row three they are already
   * phoning a client whose screens are fine.
   */
  const selfSuspect = (data.rollups || []).filter((r) => r.suspectSelf);
  const grouped = (data.rollups || []).filter((r) => !r.suspectSelf);

  const banner = selfSuspect.map((r) => `
    <div class="card" style="border-left:4px solid var(--warning,#f59e0b);margin-bottom:12px">
      <strong>Check this server's connection first</strong>
      <p style="margin:6px 0 0">${esc(r.summary)}</p>
    </div>`).join('');

  const groupRows = grouped.map((r) => `
    <div class="card" style="margin-bottom:8px">
      <strong>${esc(r.summary)}</strong>
      <div class="muted" style="font-size:12px;margin-top:4px">
        ${r.nodeCount} sites · ${esc((r.nodeIds || []).join(', '))}
      </div>
    </div>`).join('');

  const alerts = data.alerts || [];
  const local = data.local || [];

  panel.innerHTML = `
    ${banner}
    ${groupRows}
    <div class="card">
      <h3 style="margin-top:0">Open alerts across all servers</h3>
      <table class="data-table">
        <thead><tr><th>What</th><th>Server</th><th>Screens</th><th>Since</th><th></th></tr></thead>
        <tbody>
          ${alerts.map((a) => `
            <tr>
              <td>${esc(String(a.alert_type || '').replace(/[_-]/g, ' '))}
                  <span class="badge">${esc(a.severity || '')}</span></td>
              <td><span class="badge">${esc(a.origin_node_id)}</span>
                  ${a.stale
                    // ⚠️ An alert from a site we cannot currently reach is LAST KNOWN like every
                    // other row here. Without this the inbox is the one screen that still implies
                    // live truth, and it is the screen people act on fastest.
                    ? '<span style="color:var(--warning,#f59e0b);font-size:11px"> · last known</span>'
                    : ''}</td>
              <td>${a.subject_count == null ? '—' : a.subject_count}</td>
              <td>${esc(hhmm(a.opened_at))}</td>
              <td>${a.deepLink
                ? `<a href="${esc(a.deepLink)}" target="_blank" rel="noopener">Open &rarr;</a>`
                : '<span class="muted">—</span>'}</td>
            </tr>`).join('') ||
            '<tr><td colspan="5" class="muted">Nothing is open on any connected server.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">On this server</h3>
      <!-- A hub is a node too: its own problems are not somebody else's category, and splitting them
           into a separate screen is how they get read last. -->
      <table class="data-table">
        <thead><tr><th>Metric</th><th>Screen</th><th>Since</th></tr></thead>
        <tbody>
          ${local.map((i) => `
            <tr><td>${esc(i.metric)}</td><td>${esc(i.device_id || '—')}</td>
                <td>${esc(hhmm(i.opened_at))}</td></tr>`).join('') ||
            '<tr><td colspan="3" class="muted">Nothing open here.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

/* ===================== the topology ===================== */

async function renderTopology(panel) {
  panel.innerHTML = '<div class="card"><p class="muted">Loading topology…</p></div>';
  let data;
  try {
    data = await api.get('/mesh/topology');
  } catch (e) {
    panel.innerHTML = `<div class="card"><p class="muted">Could not load: ${esc(e.message)}</p></div>`;
    return;
  }

  const edges = data.edges || [];
  /*
   * ⚠️ VERSION SKEW IS COMPUTED AGAINST THE MOST COMMON VERSION, not against this hub's. A hub that
   * has not been upgraded yet would otherwise mark its entire healthy fleet as skewed, which is the
   * fastest way to teach an operator to ignore the column.
   */
  const counts = new Map();
  for (const e of edges) if (e.peerVersion) counts.set(e.peerVersion, (counts.get(e.peerVersion) || 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const FRESH = {
    live: ['#22c55e', 'healthy'],
    stale: ['#f59e0b', 'not reachable'],
    unknown: ['#94a3b8', 'never synced'],
  };

  panel.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">
        <div><div class="muted" style="font-size:11px">Connected servers</div>
             <div style="font-size:20px">${edges.length}</div></div>
        <div><div class="muted" style="font-size:11px">Depth limit</div>
             <!-- Stated, because "why can't I add a server under that one" is otherwise an
                  unanswerable question from the UI. -->
             <div style="font-size:20px">${data.depthCap ?? '—'}</div></div>
        <div><div class="muted" style="font-size:11px">Common version</div>
             <div style="font-size:20px">${esc(modal || '—')}</div></div>
      </div>
      <table class="data-table">
        <thead><tr>
          <th>Server</th><th>Client</th><th>Link</th><th>Version</th>
          <th>Shares</th><th>Transport</th><th>Last sync</th>
        </tr></thead>
        <tbody>
          ${edges.map((e) => {
            const [colour, word] = FRESH[e.freshness] || FRESH.unknown;
            const skew = e.peerVersion && modal && e.peerVersion !== modal;
            return `
            <tr>
              <td><span class="badge">${esc(e.peerNodeId || '')}</span></td>
              <td>${e.clientId ? esc(e.clientId) :
                // Unassigned edges are visible to platform admins only; saying so beats a blank.
                '<span class="muted" style="font-style:italic">unassigned</span>'}</td>
              <td><span class="status-dot" style="background:${colour}"></span> ${esc(word)}</td>
              <td>${esc(e.peerVersion || '—')}
                  ${skew ? '<span class="badge" style="background:var(--warning,#f59e0b)">skew</span>' : ''}</td>
              <td style="font-size:12px">${esc((e.grant || []).join(', ') || 'nothing')}</td>
              <td style="font-size:12px">${esc(e.transportDirection || '')}
                  ${e.tlsVerify === false
                    // ⚠️ Surfaced, not hidden. An edge with certificate checking off is a decision
                    // somebody made once and nobody revisits unless a screen shows it.
                    ? '<span class="badge" style="background:#ef4444">TLS unverified</span>' : ''}</td>
              <td>${esc(e.lastSyncAt ? hhmm(e.lastSyncAt) : 'never')}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="muted">No servers are connected.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

/* ===================== connecting servers ===================== */

async function renderConnect(panel) {
  let up = { uplinks: [], canEnroll: false, nodeId: '' };
  try { up = await api.get('/mesh/uplink'); } catch (e) { /* the child half may not be mounted */ }

  panel.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">This server</h3>
      <p class="muted" style="font-size:12px">Its id in the mesh is
        <span class="badge">${esc(up.nodeId || 'not assigned yet')}</span>.
        This id is generated here and registered nowhere — there is no central directory.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">Let another server observe this one</h3>
      <p class="muted" style="font-size:12px">Generate a code, then enter it on the other server
        along with this one's address. The code can be used once and expires shortly.</p>
      <!-- ⚠️ The grant is chosen HERE, by the side giving the data — never requested by the side
           redeeming the code. Otherwise whoever holds a code could ask for everything. -->
      <div id="grantList" style="margin:12px 0">
        ${GRANTS.map(([id, summary, warn], i) => `
          <label style="display:block;margin-bottom:6px;font-size:13px">
            <input type="checkbox" value="${id}" ${i === 0 ? 'checked' : ''}>
            <strong>${esc(summary)}</strong>
            ${warn ? `<div style="margin-left:22px;color:var(--text-muted);font-size:11px">${esc(warn)}</div>` : ''}
          </label>`).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="mintBtn">Generate a pairing code</button>
      <div id="mintOut" style="margin-top:12px"></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">Report this server to another one</h3>
      ${up.canEnroll ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="parentUrl" class="input" placeholder="https://hub.example.com" style="max-width:280px">
          <input id="pairCode" class="input" placeholder="pairing code" style="max-width:180px">
          <button class="btn btn-secondary btn-sm" id="enrollBtn">Connect</button>
        </div>
        <div id="enrollOut" style="margin-top:8px"></div>`
        : `<p class="muted" style="font-size:12px">This server is not configured to report upward.
           Set <code>MESH_ALLOW_UPLINK=1</code> and restart it.</p>`}

      <!-- ⚠️ Consent from below: always listed, even when the flag is off, so a link can never be
           made and then hidden by turning the flag back off. -->
      <div style="margin-top:16px">
        ${up.uplinks && up.uplinks.length ? up.uplinks.map((u) => `
          <div class="card" style="background:var(--bg-subtle,transparent)">
            <div><strong>Reporting to ${esc(u.parentNodeId || '')}</strong>
              ${u.revoked ? '<span class="badge">severed</span>' : ''}</div>
            <div class="muted" style="font-size:12px;margin-top:4px">
              ${esc(u.parentUrl || '')}<br>
              Shares: ${esc((u.sharedFields || u.grant || []).join(', ') || 'nothing')}<br>
              Last synced: ${u.lastSyncAt ? esc(hhmm(Math.floor(u.lastSyncAt / 1000))) : 'never'}
            </div>
            ${u.revoked ? '' :
              `<button class="btn btn-secondary btn-sm" data-sever="${esc(u.edgeId)}"
                       style="margin-top:8px">Stop reporting</button>`}
          </div>`).join('')
          : '<p class="muted" style="font-size:12px">This server does not report to anyone.</p>'}
      </div>
    </div>`;

  panel.querySelector('#mintBtn')?.addEventListener('click', async () => {
    const grant = [...panel.querySelectorAll('#grantList input:checked')].map((c) => c.value);
    const out = panel.querySelector('#mintOut');
    try {
      const r = await api.post('/mesh/pair/code', { grant, capabilities: ['consumes-telemetry'] });
      out.innerHTML = `
        <div style="font-size:28px;letter-spacing:4px;font-family:monospace">${esc(r.code)}</div>
        <div class="muted" style="font-size:12px">
          Valid until ${esc(hhmm(r.expiresAt))}, once. Give this and this server's address to the
          other side.<br>It will be allowed to see: ${esc(r.grantDescription || (r.grant || []).join(', '))}
        </div>`;
    } catch (e) {
      out.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
    }
  });

  panel.querySelector('#enrollBtn')?.addEventListener('click', async () => {
    const out = panel.querySelector('#enrollOut');
    out.textContent = 'Connecting…';
    try {
      const r = await api.post('/mesh/uplink', {
        parentUrl: panel.querySelector('#parentUrl').value,
        code: panel.querySelector('#pairCode').value,
        selfUrl: window.location.origin,
      });
      out.innerHTML = `<span class="muted">Connected to ${esc(r.parentNodeId)}. It can see:
        ${esc(r.grantDescription || '')}</span>`;
      setTimeout(() => renderConnect(panel), 1200);
    } catch (e) {
      // ⚠️ The other server's refusal text is shown VERBATIM. It is written to be actionable
      // ("codes expire and may be used once"), and replacing it with a generic failure would
      // discard the only explanation the operator is going to get.
      out.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
    }
  });

  panel.querySelectorAll('[data-sever]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api.delete(`/mesh/uplink/${encodeURIComponent(btn.dataset.sever)}`);
        showToast(r.note || 'Stopped reporting.');
        renderConnect(panel);
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
}

/* ===================== the uptime report ===================== */

async function renderUptime(panel) {
  panel.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="upClient" class="input" style="max-width:260px"></select>
        <select id="upDays" class="input" style="max-width:160px">
          ${[7, 30, 90].map((d) => `<option value="${d}" ${state.days === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" id="upCsv" disabled>Download CSV</button>
      </div>
      <div id="upBody" style="margin-top:16px"></div>
    </div>`;

  const sel = panel.querySelector('#upClient');
  try {
    const list = await api.get('/mesh/uptime');
    state.clients = list.clients || [];
  } catch (e) {
    panel.querySelector('#upBody').innerHTML = `<p class="muted">Could not load: ${esc(e.message)}</p>`;
    return;
  }

  if (!state.clients.length) {
    panel.querySelector('#upBody').innerHTML =
      '<p class="muted">No clients are visible to you, so there is nothing to report on.</p>';
    sel.innerHTML = '<option>No clients</option>';
    return;
  }

  /*
   * ⚠️ NO "ALL CLIENTS" OPTION. A report headed with no client name, mixing several customers'
   * screens into one percentage, is the document that gets forwarded to one of those customers.
   */
  sel.innerHTML = state.clients
    .map((c) => `<option value="${esc(c.id)}" ${state.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  state.clientId = state.clientId || state.clients[0].id;
  sel.value = state.clientId;

  sel.addEventListener('change', () => { state.clientId = sel.value; loadUptime(panel); });
  panel.querySelector('#upDays').addEventListener('change', (e) => {
    state.days = Number(e.target.value); loadUptime(panel);
  });
  panel.querySelector('#upCsv').addEventListener('click', () => downloadCsv(panel));

  await loadUptime(panel);
}

async function loadUptime(panel) {
  const body = panel.querySelector('#upBody');
  body.innerHTML = '<p class="muted">Building report…</p>';
  const to = Math.floor(Date.now() / 1000);
  const from = to - state.days * 86400;
  let r;
  try {
    r = await api.get(`/mesh/uptime?clientId=${encodeURIComponent(state.clientId)}&from=${from}&to=${to}`);
  } catch (e) {
    body.innerHTML = `<p class="muted">Could not load: ${esc(e.message)}</p>`;
    return;
  }
  state.report = r;
  panel.querySelector('#upCsv').disabled = false;

  if (r.uptimePct == null) {
    body.innerHTML = `<p class="muted">${esc(r.note || 'Nothing to report for this client.')}</p>`;
    return;
  }

  body.innerHTML = `
    <div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:16px">
      <div>
        <div class="muted" style="font-size:11px">Uptime</div>
        <div style="font-size:32px">${r.uptimePct}%</div>
      </div>
      <div>
        <!-- ⚠️ COVERAGE SITS BESIDE UPTIME, THE SAME SIZE. "99.9% uptime, 62% coverage" is honest;
             "99.9%" alone, computed over the 62%, tells a customer their screens were fine during a
             week nobody was watching them. Small print under the fold does not carry that. -->
        <div class="muted" style="font-size:11px">Coverage</div>
        <div style="font-size:32px;${r.coveragePct != null && r.coveragePct < 95
          ? 'color:var(--warning,#f59e0b)' : ''}">${r.coveragePct == null ? '—' : r.coveragePct + '%'}</div>
      </div>
      <div>
        <div class="muted" style="font-size:11px">Screens</div>
        <div style="font-size:32px">${r.deviceCount}</div>
      </div>
      <div>
        <div class="muted" style="font-size:11px">Incidents</div>
        <div style="font-size:32px">${r.incidentCount}</div>
      </div>
    </div>
    <p class="muted" style="font-size:12px">${esc(r.coverageNote || '')} ${esc(r.timezoneLabel || '')}</p>

    <h3>Incidents</h3>
    <table class="data-table">
      <thead><tr><th>Screen</th><th>Server</th><th>What</th><th>Started</th><th>For</th></tr></thead>
      <tbody>
        ${r.incidents.slice(0, 50).map((i) => `
          <tr>
            <td>${esc(i.deviceName || i.deviceId)}</td>
            <td><span class="badge">${esc(i.originNodeId)}</span></td>
            <td>${esc(String(i.alertType || '').replace(/[_-]/g, ' '))}</td>
            <td>${esc(hhmm(i.openedAt))}</td>
            <td>${i.ongoing ? '<strong>still down</strong>' : esc(mins(i.downSeconds))}</td>
          </tr>`).join('') ||
          '<tr><td colspan="5" class="muted">No incidents in this period.</td></tr>'}
      </tbody>
    </table>
    ${r.incidents.length > 50
      // Never a silent truncation: a report that quietly shows 50 of 300 reads as "that was all of
      // them", and the CSV is the thing that actually has all of them.
      ? `<p class="muted" style="font-size:12px">Showing the 50 longest of ${r.incidents.length}.
         The CSV export contains every one.</p>` : ''}
    ${(r.unattributedIncidents || []).length ? `
      <h3>Site-level incidents</h3>
      <p class="muted" style="font-size:12px">These affected a whole server rather than a named
      screen, so they are listed separately instead of being spread across the fleet.</p>
      <table class="data-table">
        <thead><tr><th>Server</th><th>What</th><th>Started</th><th>For</th></tr></thead>
        <tbody>${r.unattributedIncidents.map((u) => `
          <tr><td><span class="badge">${esc(u.originNodeId)}</span></td>
              <td>${esc(String(u.alertType || '').replace(/[_-]/g, ' '))}</td>
              <td>${esc(hhmm(u.openedAt))}</td>
              <td>${esc(mins(u.downSeconds))}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}`;
}

/*
 * ⚠️ FETCHED WITH THE AUTH HEADER, NOT A PLAIN LINK. The API is Bearer-authenticated from
 * localStorage, so an <a href> to the CSV endpoint would 401 — and it would 401 by REDIRECTING to
 * login, which reads as "my session expired" rather than "that link cannot carry a token".
 */
async function downloadCsv(panel) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - state.days * 86400;
  const url = `/api/mesh/uptime.csv?clientId=${encodeURIComponent(state.clientId)}&from=${from}&to=${to}`;
  const btn = panel.querySelector('#upCsv');
  btn.disabled = true;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
      || 'uptime.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick rather than immediately: some browsers abort a download whose object
    // URL is released before the transfer starts.
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    showToast(`Could not export: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

export function cleanup() {
  clearTimeout(state._t);
  state = {
    tab: 'fleet',
    nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
    clients: [], clientId: null, days: 30, report: null,
  };
}
