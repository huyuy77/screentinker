'use strict';

/*
 * The thing that actually reports upward: opens an Uplink per `up` edge and feeds it projections.
 *
 * ⚠️ EVERY PAYLOAD GOES THROUGH lib/mesh/mirror.js FIRST. Nothing reads a device row and sends it.
 * The grant is enforced by CONSTRUCTING what is allowed rather than by removing what is not — the
 * moment a new telemetry column lands, a delete-based filter silently starts shipping it upward and
 * nobody finds out until a client asks why their hub knows something it was never granted.
 *
 * ⚠️ THIS SERVICE MUST NEVER BE ABLE TO HARM ITS OWN NODE (I1). It is a reporter to an observer.
 * Every path is wrapped, the timer is unref'd, and a parent that is down, wrong, slow or hostile
 * changes nothing about scheduling, playback or the local dashboard.
 */

const { Uplink } = require('../lib/mesh/uplink');
const readProxy = require('../lib/mesh/read-proxy');
const envelope = require('../lib/mesh/envelope');
const mirror = require('../lib/mesh/mirror');
const store = require('../lib/mesh/store');

/*
 * How often a child reports. ⚠️ Not per heartbeat. A 400-screen node whose panels beat every 30s
 * would push 800 envelopes a minute at a hub that wants a picture, not a firehose — and the hub's
 * own backpressure would then throttle it, so the extra traffic buys nothing but load on both ends.
 */
const REPORT_INTERVAL_MS = 60_000;

const nowSec = () => Math.floor(Date.now() / 1000);

function activeUpEdges(db) {
  try {
    return db.prepare(
      "SELECT * FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL AND up_token IS NOT NULL")
      .all();
  } catch (e) {
    return [];
  }
}

/*
 * ⚠️ THE WORKSPACE SCOPE IS ENFORCED IN THE QUERY, not filtered afterwards.
 *
 * A shared list that is applied after the rows are fetched leaks the moment somebody adds a count,
 * a total or a "devices online" to a payload — the classic shape of this bug, and the same one the
 * hub's client scoping avoids by resolving visibility before it selects. Here the SQL simply cannot
 * return a workspace this edge was not granted.
 *
 * `null` means every workspace INCLUDING ones created later, which only the instance owner can
 * choose. A named list is fixed: a workspace added tomorrow is not silently swept in.
 */
function scopeClause(edge, alias) {
  const ids = edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;
  if (!ids || !ids.length) return { sql: '', params: [] };
  return {
    sql: ` WHERE ${alias} IN (${ids.map(() => '?').join(',')})`,
    params: ids,
  };
}

/** Devices as this node knows them, already narrowed to the grant AND to the shared workspaces. */
function deviceProjections(db, grantCategories, edge) {
  /*
   * ⚠️ Only columns that exist. The first version of this query named `hardware_model` and joined
   * device_telemetry on `created_at`; neither exists — telemetry is timestamped `reported_at`, and
   * the hardware fields in mirror.js's category map come from families that report them, not from a
   * `devices` column. SQLite errors on an unknown column, so the whole report failed and the hub
   * showed a connected node with zero screens — which looks exactly like a working link with an
   * empty fleet.
   *
   * projectDevice() skips anything undefined, so a field this node cannot answer is simply absent
   * rather than sent as null — the grant decides what MAY travel, the row decides what exists.
   */
  const scope = edge ? scopeClause(edge, 'd.workspace_id') : { sql: '', params: [] };
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.app_version, d.platform, d.client_type,
           d.workspace_id,
           t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
           t.ram_free_mb, t.ram_total_mb, t.cpu_usage, t.wifi_rssi, t.uptime_seconds
      FROM devices d
      LEFT JOIN (
        SELECT device_id, MAX(reported_at) AS reported_at FROM device_telemetry GROUP BY device_id
      ) latest ON latest.device_id = d.id
      LEFT JOIN device_telemetry t
             ON t.device_id = latest.device_id AND t.reported_at = latest.reported_at
    ${scope.sql}
  `).all(...scope.params);
  return rows.map((r) => mirror.projectDevice(r, grantCategories));
}

/**
 * This server's workspaces, so a parent can present them as separate orgs.
 *
 * ⚠️ WITHOUT THIS, A SECOND WORKSPACE IS INVISIBLE UPSTREAM. One connected server would read as one
 * org however many customers it actually holds, and every screen would land in the same
 * undifferentiated list — which is wrong in the specific way that matters to an MSP, because the
 * whole point of the hub is telling one client's estate from another's.
 *
 * Grant-gated on `identity` like every other name: a health-only edge learns that screens exist and
 * how they are coping, and learns nothing about how the client organises them.
 */
function workspaceProjections(db, grantCategories, edge) {
  if (!mirror.fieldsAllowedFor(grantCategories).includes('name')) return [];
  try {
    const scope = edge ? scopeClause(edge, 'w.id') : { sql: '', params: [] };
    return db.prepare(`
      SELECT w.id, w.name, o.name AS organization_name,
             (SELECT COUNT(*) FROM devices d WHERE d.workspace_id = w.id) AS device_count
        FROM workspaces w
        LEFT JOIN organizations o ON o.id = w.organization_id
      ${scope.sql}
    `).all(...scope.params);
  } catch (e) {
    // An older schema, or a build without workspaces: the parent simply groups by server instead.
    return [];
  }
}

function nodeHealth(db, nodeId) {
  const counts = db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online FROM devices")
    .get();
  return mirror.projectNodeHealth({
    node_id: nodeId,
    version: require('../package.json').version,
    device_count: counts.total || 0,
    devices_online: counts.online || 0,
    reported_at: nowSec(),
  });
}

function openAlerts(db, grantCategories, edge) {
  try {
    /*
     * ⚠️ Alerts are scoped too. An incident names a device, so an unscoped alert feed would tell a
     * parent about screens in a workspace that was deliberately withheld — leaking by description
     * what the workspace scope refused by row.
     */
    const ids = edge && edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;
    const scoped = ids && ids.length;
    const rows = db.prepare(
      'SELECT a.id, a.metric, a.severity, a.device_id, a.opened_at, a.closed_at FROM alert_events a ' +
      (scoped ? `LEFT JOIN devices d ON d.id = a.device_id
                  WHERE a.closed_at IS NULL AND d.workspace_id IN (${ids.map(() => '?').join(',')}) `
              : 'WHERE a.closed_at IS NULL ') +
      'ORDER BY a.opened_at DESC LIMIT 200').all(...(scoped ? ids : []));
    return rows
      .map((a) => mirror.projectAlert({
        id: a.id, type: a.metric, severity: a.severity,
        opened_at: a.opened_at, closed_at: a.closed_at,
        subject_count: 1, subjects: a.device_id ? [a.device_id] : [],
      }, grantCategories))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Answer a parent's read.
 *
 * ⚠️ THE ALLOWLIST, THE GRANT AND THE WORKSPACE SCOPE ARE ALL APPLIED HERE, on the child, in that
 * order — because this is the side that owns the rows. A parent asking for something it may not have
 * is refused by the party with the standing to refuse, which is the difference between a permission
 * and a request for good manners.
 *
 * It returns the SAME shape the child's own API returns, so the parent can render its ordinary
 * screens rather than a reduced summary of them. That is the whole point: an operator looking at a
 * customer's estate should see what the customer sees, minus the ability to change it.
 */
function answerRead(db, edge, req) {
  const grants = store.safeParseArray(edge.grant_categories);
  const check = readProxy.authorize(edge, req && req.path, req && req.method, grants);
  if (!check.ok) return { ok: false, reason: check.reason };

  const shared = edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;

  if (req.path === '/api/devices') {
    /*
     * ⚠️ Built from the same projection the mirror uses, so a field cannot travel over the proxy
     * that would not travel over the mirror. Two paths to the same data with two different filters
     * is how one of them ends up more generous than anybody intended.
     */
    const rows = deviceProjections(db, grants, edge);
    const scoped = readProxy.scopeRows(rows, shared);
    return { ok: true, rows: scoped, asOf: nowSec() };
  }

  if (req.path === '/api/groups') {
    try {
      const rows = db.prepare('SELECT id, name, workspace_id FROM device_groups').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (req.path === '/api/playlists') {
    try {
      const rows = db.prepare('SELECT id, name, workspace_id FROM playlists').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  return { ok: false, reason: 'That is not something this connection may read.' };
}

function startMeshUplinks(db, { config, connect, logger = console } = {}) {
  if (!config || !config.meshAllowUplink) return { stop() {}, links: new Map(), refresh() {} };

  const io = connect || require('socket.io-client').io;
  const links = new Map();
  let timer = null;

  const me = store.ensureNodeIdentity(db);
  if (!me) {
    logger.warn('[mesh] MESH_ALLOW_UPLINK is set but this node has no identity — not reporting upward.');
    return { stop() {}, links, refresh() {} };
  }

  function send(edge, link) {
    const grant = store.safeParseArray(edge.grant_categories);
    const mk = (type, body) => envelope.createEnvelope({
      originNodeId: me, type, bodyVersion: 1,
      ancestry: [me], originTs: Date.now(), body,
    });

    // Node health always: it is this node reporting on itself, the minimum any edge exists for.
    link.send(mk('node-health', nodeHealth(db, me)));

    // Workspaces before devices, so a device arriving first never references a workspace the parent
    // has not seen — the parent tolerates it, but the UI would flicker a screen into "unfiled" and
    // back out again on the very first sync.
    for (const w of workspaceProjections(db, grant, edge)) link.send(mk('workspace-summary', w));

    for (const d of deviceProjections(db, grant, edge)) link.send(mk('device-summary', d));
    for (const a of openAlerts(db, grant, edge)) link.send(mk('alert-event', a));
  }

  function tick() {
    for (const [edgeId, link] of links) {
      const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
      /*
       * ⚠️ Re-read every tick, so a revoke or a narrowed grant takes effect on the NEXT report
       * rather than at the next restart. The same reasoning as the parent re-reading its edge per
       * envelope: a permission change that waits for a process lifecycle is not a permission change.
       */
      if (!edge || edge.revoked_at) {
        try { link.stop(); } catch (e) { /* best effort */ }
        links.delete(edgeId);
        continue;
      }
      try { send(edge, link); } catch (e) {
        logger.warn(`[mesh] could not build a report for ${edge.peer_node_id}: ${e && e.message}`);
      }
    }
  }

  function refresh() {
    for (const edge of activeUpEdges(db)) {
      if (links.has(edge.id)) continue;
      try {
        const link = new Uplink({
          parentUrl: edge.peer_url,
          edgeToken: edge.up_token,
          nodeId: me,
          connect: io,
          tlsVerify: edge.tls_verify !== 0,
          logger,
          // ⚠️ Re-read per request, so narrowing a grant or a workspace scope takes effect on the
          // NEXT read rather than at the next restart.
          onRead: (req) => {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            return answerRead(db, fresh, req);
          },
        }).start();
        /*
         * ⚠️ REPORT AS SOON AS THE SOCKET COMES UP, not at the next tick. Otherwise a node that was
         * just enrolled shows nothing on the hub for up to a minute — the operator's very first
         * look at the thing they just connected is an empty page, which reads as "it did not work"
         * and gets retried. Also covers every reconnect, so a link that drops catches up at once
         * instead of waiting out the interval.
         */
        /*
         * ⚠️ A failing uplink SAYS SO in the log. The Uplink keeps lastError for the connection view,
         * but nothing printed it — so a link that could not connect looked identical to one that was
         * connected and idle, and the only symptom was a hub showing a node with no data. Rate is
         * not a concern: the backoff is jittered and caps at a minute.
         */
        link.on('retry-scheduled', ({ attempt, delayMs, reason }) => {
          logger.warn(`[mesh] uplink to ${edge.peer_node_id} failed (attempt ${attempt}): ` +
                      `${reason || 'unknown'} — retrying in ${Math.round(delayMs / 1000)}s`);
        });
        link.on('connected', () => {
          try {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (fresh && !fresh.revoked_at) send(fresh, link);
          } catch (e) {
            logger.warn(`[mesh] first report to ${edge.peer_node_id} failed: ${e && e.message}`);
          }
        });
        links.set(edge.id, link);
        logger.log(`[mesh] reporting upward to ${edge.peer_node_id} at ${edge.peer_url}`);
      } catch (e) {
        // A bad row must not stop the others, and must not stop the node.
        logger.warn(`[mesh] uplink to ${edge.peer_node_id} not started: ${e && e.message}`);
      }
    }
    // Anything revoked while we were not looking.
    for (const [edgeId, link] of links) {
      const still = db.prepare(
        "SELECT 1 FROM mesh_edges WHERE id = ? AND revoked_at IS NULL AND direction = 'up'").get(edgeId);
      if (!still) { try { link.stop(); } catch (e) { /* best effort */ } links.delete(edgeId); }
    }
  }

  refresh();
  tick();
  timer = setInterval(tick, REPORT_INTERVAL_MS);
  // ⚠️ Never hold the process open for an observer relationship.
  if (timer.unref) timer.unref();

  return {
    links,
    refresh,
    status: () => [...links.entries()].map(([id, l]) => ({ edgeId: id, ...l.status() })),
    stop() {
      if (timer) clearInterval(timer);
      for (const l of links.values()) { try { l.stop(); } catch (e) { /* best effort */ } }
      links.clear();
    },
  };
}

module.exports = {
  startMeshUplinks, REPORT_INTERVAL_MS,
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead,
};
