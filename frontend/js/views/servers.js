import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

/*
 * Servers — the connected servers themselves: their screens, the shape of the graph, and pairing.
 *
 * ⚠️ ALERTS AND THE UPTIME REPORT USED TO LIVE HERE AND DELIBERATELY DO NOT ANY MORE.
 *
 * A mesh-only alert inbox is a second place to look for one question — "what is wrong right now" —
 * and the moment there are two, the one an operator does not have open is the one with the answer.
 * Alerts belong on ONE screen that happens to include remote sites (Activity). The uptime report is
 * a report, and Reports is where somebody goes looking for one; filing it under Servers means you
 * have to already know the feature is mesh-shaped in order to find it.
 *
 * ⚠️ NODES ARE NOT SCREENS. A server is not a display and does not belong in the Displays list.
 * Remote DEVICES are a different matter — those now appear under their own org in the ordinary
 * Displays view, because to an operator a screen is a screen wherever it is plugged in.
 *
 * ⚠️ EVERY REMOTE ROW SHOWS ITS AGE. This screen reports on machines over links that fail
 * independently of them, so "online" without "as of when" is a claim the reader cannot check.
 */

let state = {
  tab: 'fleet',
  nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
};

/* live | stale | down | unknown → the dot, the word, and what it means. */
const STATUS_UI = {
  live:    { dot: '#22c55e', label: 'Online' },
  down:    { dot: '#ef4444', label: 'Offline' },
  // ⚠️ Amber, NOT red. Red says "this screen is broken"; amber says "we cannot currently see it".
  // Sending an engineer to a working site is the failure this colour exists to prevent.
  stale:   { dot: '#f59e0b', label: 'Last known' },
  unknown: { dot: '#94a3b8', label: 'Not reported' },
};

function ago(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const hhmm = (sec) => (sec == null ? '' : new Date(sec * 1000).toLocaleString());

/*
 * ⚠️ A node id is a UUID, and a full one in every row is unreadable — it pushes the columns an
 * operator actually reads off the screen and gives nothing back, because nobody distinguishes two
 * UUIDs by eye. Shortened for display with the full value on hover, so it stays recoverable when
 * somebody genuinely needs it. Not a CSS ellipsis: that hides WHICH end was kept, and the leading
 * characters are the half people compare.
 */
const shortId = (id) => (id ? String(id).slice(0, 8) : '');
const idBadge = (id) => (id
  ? `<span class="badge" title="${esc(id)}" style="font-family:monospace">${esc(shortId(id))}</span>`
  : '<span style="color:var(--text-muted)">—</span>');

/*
 * ⚠️ THE HOUSE TABLE STYLE, not an invented class. This view shipped using `class="data-table"`,
 * which exists in no stylesheet — so every table rendered completely unstyled: columns bunched
 * against the left edge, no padding, no header rule, two thirds of the width unused. The
 * source-level tests could not see it, because the markup was perfectly well-formed; it just
 * referred to a class nobody had written.
 *
 * Every other view wraps a table in `.table-wrap` (which supplies only horizontal scroll) and
 * styles it inline. Matching that is what makes this screen look like the rest of the app.
 */
const TH = 'padding:8px;text-align:left;color:var(--text-muted);font-weight:600;white-space:nowrap';
const TD = 'padding:8px;vertical-align:middle';
const TABLE_S = 'width:100%;border-collapse:collapse;font-size:13px;min-width:520px';
const ROW = 'border-bottom:1px solid var(--border)';

const table = (headers, rowsHtml, empty = 'Nothing to show.') => `
  <div class="table-wrap">
    <table style="${TABLE_S}">
      <thead><tr style="${ROW}">
        ${headers.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}
      </tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${headers.length}"
        style="padding:16px;text-align:center;color:var(--text-muted)">${esc(empty)}</td></tr>`}</tbody>
    </table>
  </div>`;

function statusCell(d) {
  const ui = STATUS_UI[d.status] || STATUS_UI.unknown;
  return `
    <span class="status-dot" style="background:${ui.dot};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>
    <span>${esc(ui.label)}</span>
    <!-- ⚠️ The age sits on EVERY row, not only stale ones: a green dot from ninety minutes ago is a
         lie by omission, and the reader has no other way to tell. -->
    <span style="color:var(--text-muted);font-size:11px;margin-left:6px">${esc(ago(d.asOfAgeSec))}</span>`;
}

function nodeCard(n) {
  const online = n.devicesOnline == null
    // ⚠️ "—", never 0. Zero is a measurement; not knowing is not, and 0/40 tells an operator the
    // whole site is dark when the truth is that we lost contact with the observer.
    ? `<span title="This server is not currently reachable, so its screen count is the last one received">—</span>`
    : `${n.devicesOnline}`;
  return `
    <div class="info-card">
      <div class="info-card-label" title="${esc(n.nodeId || '')}"
           style="font-family:monospace">${esc(shortId(n.nodeId))}</div>
      <div class="info-card-value">${online} / ${n.devicesTotal}</div>
      <div style="font-size:11px;color:var(--text-muted)">
        ${n.version ? esc(n.version) : ''}
        ${n.stale ? ' · <span style="color:var(--warning,#f59e0b)">not reachable</span>' : ''}
        ${n.openAlerts ? ` · ${n.openAlerts} open` : ''}
      </div>
    </div>`;
}

/*
 * ⚠️ NO "OPEN ON ITS SERVER" LINK, deliberately removed. It was what made a read-only hub useful
 * while remote objects were a dead end here — but sending an operator to another server, under a
 * different login, to act on something they are already looking at is a worse answer than letting
 * them act where they are. Remote orgs are selectable locally now and writes are relayed to the
 * server that owns the screen, so the link would only be a second, worse path to the same thing —
 * and the one people click first, because it is right there on the row.
 */
function deviceRow(d) {
  return `
    <tr style="${ROW}">
      <td style="${TD}">${d.name ? esc(d.name)
        // A health-only grant sends no name. Saying so beats an empty cell that reads as a bug.
        : '<span style="color:var(--text-muted);font-style:italic">not shared</span>'}</td>
      <!-- ⚠️ The origin server is its OWN column, never concatenated into the name. Folding it in
           ("Lobby (Acme)") breaks sort and search for every row at once. -->
      <td style="${TD}">${idBadge(d.originNodeId)}</td>
      <td style="${TD}">${statusCell(d)}</td>
    </tr>`;
}

const TABS = [
  ['fleet', 'Screens'],
  ['topology', 'Topology'],
  ['connect', 'Reporting upward'],
];

export async function render(container) {
  /*
   * ⚠️ TWO DIFFERENT ACTIONS THAT WERE WRONGLY ONE TAB.
   *
   * Handing out a pairing code (this server accepting an observer) and reporting upward (this
   * server becoming one) are opposite directions, gated by different flags, and used by different
   * people at different times. Bundling them meant a hub — which can only ever do the first — grew
   * a "Connect" tab whose second half read "this server is not configured for that".
   *
   * So: minting is a HEADER ACTION, the way adding a display is on Displays, because it is the
   * ordinary next thing to do on this page. The tab is now only the report-upward side, and appears
   * only when MESH_ALLOW_UPLINK is on — or when an uplink already exists, which is NOT optional: a
   * link that exists must stay visible and severable from below, or turning the flag off afterwards
   * would be a way to hide an MSP relationship from the client subject to it.
   */
  let connect = { canEnroll: false, canMint: false, uplinks: [] };
  try { connect = await api.get('/mesh/capabilities'); } catch (e) { /* enrollment not mounted */ }
  const showConnect = connect.canEnroll || (connect.uplinks || []).length > 0;
  const tabs = TABS.filter(([id]) => id !== 'connect' || showConnect);
  if (state.tab === 'connect' && !showConnect) state.tab = 'fleet';

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('nav.servers'))}</h1>
        <div class="subtitle">Other ScreenTinker servers connected to this one.</div></div>
      ${connect.canMint ? `
        <button class="btn btn-primary" id="connectServerBtn">+ Connect a server</button>` : ''}
    </div>
    <div id="mintPanel"></div>
    <div id="serversTabs" style="display:flex;gap:4px;margin-bottom:16px">
      ${tabs.map(([id, label]) => `
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

  container.querySelector('#connectServerBtn')?.addEventListener('click', () => {
    const host = container.querySelector('#mintPanel');
    // Toggle: a second click puts it away rather than stacking another copy.
    if (host.innerHTML) { host.innerHTML = ''; return; }
    renderMintPanel(host, connect);
  });

  const panel = container.querySelector('#serversPanel');
  if (state.tab === 'topology') return renderTopology(panel);
  if (state.tab === 'connect') return renderConnect(panel, connect);
  return renderFleet(panel);
}

/* ===================== the fleet ===================== */

async function renderFleet(panel) {
  panel.innerHTML = `
    <div id="serversRollup" class="info-grid"></div>
    <div class="settings-section" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="serverSearch" class="input" placeholder="Search screens across all servers"
               style="max-width:340px" value="${esc(state.search)}">
        <span id="serversCount" style="color:var(--text-muted);font-size:12px"></span>
      </div>
      <div id="serversNote" style="color:var(--text-muted);font-size:12px;margin-bottom:8px"></div>
      <div id="serversTable"></div>
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
      '<p style="color:var(--text-muted)">No servers are connected to this one yet.</p>';

    panel.querySelector('#serversTable').innerHTML =
      table(['Screen', 'Server', 'Status'], state.devices.map(deviceRow).join(''), 'No screens matched.');

    panel.querySelector('#serversCount').textContent =
      state.total ? `${state.total} screen${state.total === 1 ? '' : 's'}` : '';

    // ⚠️ The search caveat is rendered when the server sends one: a health-only grant has no names
    // to match, and without saying so the empty result reads as a broken search.
    panel.querySelector('#serversNote').textContent = devices.searchNote || '';

    renderPager(panel);
  } catch (e) {
    panel.querySelector('#serversTable').innerHTML =
      `<p style="color:var(--text-muted)">Could not load: ${esc(e.message || 'unknown error')}</p>`;
  }
}

function renderPager(panel) {
  const el = panel.querySelector('#serversPager');
  const pages = Math.ceil(state.total / state.limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const page = Math.floor(state.offset / state.limit) + 1;
  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" ${state.offset === 0 ? 'disabled' : ''} id="pgPrev">Previous</button>
    <span style="color:var(--text-muted);font-size:12px;align-self:center">Page ${page} of ${pages}</span>
    <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} id="pgNext">Next</button>`;
  el.querySelector('#pgPrev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit); loadFleet(panel);
  });
  el.querySelector('#pgNext')?.addEventListener('click', () => {
    state.offset += state.limit; loadFleet(panel);
  });
}

/* ===================== the topology ===================== */

async function renderTopology(panel) {
  panel.innerHTML = '<p style="color:var(--text-muted)">Loading topology…</p>';
  let data;
  try {
    data = await api.get('/mesh/topology');
  } catch (e) {
    panel.innerHTML = `<p style="color:var(--text-muted)">Could not load: ${esc(e.message)}</p>`;
    return;
  }

  const edges = data.edges || [];
  /*
   * ⚠️ VERSION SKEW IS MEASURED AGAINST THE MOST COMMON VERSION, not against this server's. A hub
   * that has not been upgraded yet would otherwise mark its entire healthy fleet as skewed, which
   * is the fastest way to teach an operator to ignore the column.
   */
  const counts = new Map();
  for (const e of edges) if (e.peerVersion) counts.set(e.peerVersion, (counts.get(e.peerVersion) || 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const FRESH = {
    live: ['#22c55e', 'healthy'],
    stale: ['#f59e0b', 'not reachable'],
    unknown: ['#94a3b8', 'never synced'],
  };

  const rows = edges.map((e) => {
    const [colour, word] = FRESH[e.freshness] || FRESH.unknown;
    const skew = e.peerVersion && modal && e.peerVersion !== modal;
    return `
      <tr style="${ROW}">
        <td style="${TD}">${idBadge(e.peerNodeId)}</td>
        <td style="${TD}">${e.clientId ? esc(e.clientId)
          // Unassigned edges are visible to instance owners only; saying so beats a blank cell.
          : '<span style="color:var(--text-muted);font-style:italic">unassigned</span>'}</td>
        <td style="${TD}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colour};margin-right:6px"></span>${esc(word)}</td>
        <td style="${TD}">${esc(e.peerVersion || '—')}
          ${skew ? '<span class="badge" style="background:var(--warning,#f59e0b)">skew</span>' : ''}</td>
        <td style="${TD};font-size:12px">${esc((e.grant || []).join(', ') || 'nothing')}</td>
        <td style="${TD};font-size:12px">${esc(e.transportDirection || '')}
          ${e.tlsVerify === false
            // ⚠️ Surfaced, not hidden. An edge with certificate checking off is a decision somebody
            // made once and nobody revisits unless a screen shows it.
            ? '<span class="badge" style="background:#ef4444">TLS unverified</span>' : ''}</td>
        <td style="${TD}">${esc(e.lastSyncAt ? hhmm(e.lastSyncAt) : 'never')}</td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
      <div><div style="color:var(--text-muted);font-size:11px">Connected servers</div>
           <div style="font-size:20px">${edges.length}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Depth limit</div>
           <!-- Stated, because "why can't I add a server under that one" is otherwise an
                unanswerable question from the UI. -->
           <div style="font-size:20px">${data.depthCap ?? '—'}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Common version</div>
           <div style="font-size:20px">${esc(modal || '—')}</div></div>
    </div>
    <div class="settings-section">
      ${table(['Server', 'Client', 'Link', 'Version', 'Shares', 'Transport', 'Last sync'],
              rows, 'No servers are connected.')}
    </div>`;
}

/* ===================== connecting servers ===================== */

/*
 * ⚠️ The grant vocabulary is spelled out for a HUMAN, ordered by how much it gives away. An
 * operator ticking boxes is deciding what another company may learn about their customer's
 * premises, and "health, identity, network-wan" means nothing at the moment of that decision.
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

/*
 * Handing out a pairing code. A header action rather than a tab, because on a hub it is the
 * ordinary next thing an operator does on this page — the same reasoning as "+ Add Display".
 */
function renderMintPanel(host, caps) {
  host.innerHTML = `
    <div class="settings-section" style="margin-bottom:16px">
      <h3 style="margin-top:0">Let another server report to this one</h3>
      <!-- ⚠️ The NAME leads. It is what the other side will see in its switcher once the two are
           paired, so it is the field to read before handing a code over — not the UUID. -->
      <p style="color:var(--text-muted);font-size:12px">This server is
        <strong>${esc(caps.nodeName || 'unnamed')}</strong> ${caps.nodeId ? idBadge(caps.nodeId) : ''}.
        Generate a code, then enter it on the other server along with this one's address. The code
        can be used once and expires shortly.</p>
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
    </div>`;

  host.querySelector('#mintBtn').addEventListener('click', async () => {
    const grant = [...host.querySelectorAll('#grantList input:checked')].map((c) => c.value);
    const out = host.querySelector('#mintOut');
    try {
      const r = await api.post('/mesh/pair/code', { grant, capabilities: ['consumes-telemetry'] });
      out.innerHTML = `
        <div style="font-size:28px;letter-spacing:4px;font-family:monospace">${esc(r.code)}</div>
        <div style="color:var(--text-muted);font-size:12px">
          Valid until ${esc(hhmm(r.expiresAt))}, once. The other server will see this one as
          <strong>${esc(r.nodeName || '')}</strong>.<br>It will be allowed to see:
          ${esc((r.grantDescription || r.grant || []).join(' '))}
        </div>`;
    } catch (e) {
      out.innerHTML = `<span style="color:var(--text-muted)">${esc(e.message)}</span>`;
    }
  });
}

/*
 * Which of this server's workspaces travel up the new edge.
 *
 * ⚠️ "ALL" IS THE INSTANCE OWNER'S CHOICE ALONE, and it is worded to say what it really means:
 * workspaces that do not exist yet are included too. Anyone else picks from the workspaces they
 * administer — a member must not be able to expose a colleague's workspace just because they can
 * log in to the same server.
 */
async function renderScopeBox(panel) {
  const box = panel.querySelector('#scopeBox');
  if (!box) return;
  let data;
  try { data = await api.get('/mesh/shareable-workspaces'); } catch (e) { box.innerHTML = ''; return; }

  const list = data.workspaces || [];
  if (!list.length) {
    box.innerHTML = '<p style="color:var(--text-muted);font-size:12px">' +
      'You do not administer any workspaces on this server, so there is nothing you can share.</p>';
    return;
  }

  box.innerHTML = `
    <div style="font-size:13px;margin-bottom:6px"><strong>What to share</strong></div>
    ${data.canShareAll ? `
      <label style="display:block;margin-bottom:8px;font-size:13px">
        <input type="checkbox" id="shareAll">
        Every workspace on this server
        <div style="margin-left:22px;color:var(--text-muted);font-size:11px">
          ⚠️ Includes workspaces created later. Only you can choose this.
        </div>
      </label>` : `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Sharing every workspace is limited to the instance owner. These are the ones you administer.
      </p>`}
    <div id="wsList">
      ${list.map((w) => `
        <label style="display:block;margin-bottom:4px;font-size:13px">
          <input type="checkbox" data-ws="${esc(w.id)}">
          ${esc(w.name)}${w.organization_name
            ? ` <span style="color:var(--text-muted)">· ${esc(w.organization_name)}</span>` : ''}
        </label>`).join('')}
    </div>`;

  // Ticking "all" disables the individual boxes rather than hiding them: the operator can still see
  // exactly what "all" currently covers, which is the thing they are agreeing to.
  box.querySelector('#shareAll')?.addEventListener('change', (e) => {
    box.querySelectorAll('#wsList input[data-ws]').forEach((c) => {
      c.disabled = e.target.checked;
      c.parentElement.style.opacity = e.target.checked ? 0.5 : 1;
    });
  });
}

async function renderConnect(panel, caps) {
  const uplinks = caps.uplinks || [];

  panel.innerHTML = `
    <div class="settings-section">
      <h3 style="margin-top:0">This server</h3>
      <!-- ⚠️ The NAME leads and the id follows. The name is what the other side will see in its
           switcher once these two are paired, so it is the field an operator should read before
           handing a code over — not the UUID, which nobody recognises. -->
      <p style="font-size:14px;margin:0 0 4px"><strong>${esc(caps.nodeName || 'unnamed')}</strong></p>
      <p style="color:var(--text-muted);font-size:12px">Other servers will see this name.
        Its id in the mesh is
        ${caps.nodeId ? idBadge(caps.nodeId) : '<span class="badge">not assigned yet</span>'} —
        generated here and registered nowhere, since there is no central directory.</p>
    </div>

    ${caps.canEnroll ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">Report this server to another one</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="parentUrl" class="input" placeholder="https://hub.example.com" style="max-width:280px">
        <input id="pairCode" class="input" placeholder="pairing code" style="max-width:180px">
      </div>
      <!-- ⚠️ WHAT GOES UP IS CHOSEN HERE, by the side giving the data. The grant says which FIELDS
           travel; this says which WORKSPACES do, and they are different questions — an MSP watching
           one customer's screens has no business seeing another customer on the same box. -->
      <div id="scopeBox" style="margin-top:12px"></div>
      <button class="btn btn-secondary btn-sm" id="enrollBtn" style="margin-top:12px">Connect</button>
      <div id="enrollOut" style="margin-top:8px"></div>
    </div>` : ''}

    ${uplinks.length ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">This server reports to</h3>
      <!-- ⚠️ Consent from below: always listed, whatever the flags say. A link that exists must be
           visible and severable by the operator subject to it — otherwise turning MESH_ALLOW_UPLINK
           back off would be a way to hide an MSP relationship from the client. -->
      ${uplinks.map((u) => `
        <div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div><strong>${esc(u.parentName || `server ${String(u.parentNodeId || '').slice(0, 8)}`)}</strong>
            ${idBadge(u.parentNodeId)}
            ${u.revoked ? '<span class="badge">severed</span>' : ''}</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">
            ${esc(u.parentUrl || '')}<br>
            Shares: ${esc((u.sharing || []).join(', ') || 'nothing')}<br>
            Workspaces: ${u.sharedWorkspaces === null || u.sharedWorkspaces === undefined
              // ⚠️ Spelled out. An empty list here would read as "nothing is shared", which is the
              // opposite of what null means.
              ? '<strong>all, including any created later</strong>'
              : esc(String(u.sharedWorkspaces.length)) + ' selected'}<br>
            Last synced: ${u.lastSyncAt ? esc(hhmm(Math.floor(u.lastSyncAt / 1000))) : 'never'}
          </div>
          ${u.revoked ? '' :
            `<button class="btn btn-secondary btn-sm" data-sever="${esc(u.edgeId)}"
                     style="margin-top:8px">Stop reporting</button>`}
        </div>`).join('')}
    </div>` : ''}`;

  // The workspace picker, filled from what this user may actually offer.
  if (caps.canEnroll) renderScopeBox(panel);

  panel.querySelector('#enrollBtn')?.addEventListener('click', async () => {
    const out = panel.querySelector('#enrollOut');
    out.textContent = 'Connecting…';
    try {
      const shareAll = !!panel.querySelector('#shareAll')?.checked;
      const r = await api.post('/mesh/uplink', {
        parentUrl: panel.querySelector('#parentUrl').value,
        code: panel.querySelector('#pairCode').value,
        selfUrl: window.location.origin,
        shareAllWorkspaces: shareAll,
        workspaceIds: shareAll ? []
          : [...panel.querySelectorAll('#scopeBox input[data-ws]:checked')].map((c) => c.dataset.ws),
      });
      out.innerHTML = `<span style="color:var(--text-muted)">Connected to
        <strong>${esc(r.parentName || r.parentNodeId)}</strong>.</span>`;
      setTimeout(() => render(panel.closest('#viewContainer') || document.body), 1200);
    } catch (e) {
      // ⚠️ The other server's refusal text is shown VERBATIM. It is written to be actionable
      // ("codes expire and may be used once"), and replacing it with a generic failure would
      // discard the only explanation the operator is going to get.
      out.innerHTML = `<span style="color:var(--text-muted)">${esc(e.message)}</span>`;
    }
  });

  panel.querySelectorAll('[data-sever]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api.delete(`/mesh/uplink/${encodeURIComponent(btn.dataset.sever)}`);
        showToast(r.note || 'Stopped reporting.');
        renderConnect(panel, await api.get('/mesh/capabilities'));
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
}

export function cleanup() {
  clearTimeout(state._t);
  state = {
    tab: 'fleet',
    nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
  };
}
