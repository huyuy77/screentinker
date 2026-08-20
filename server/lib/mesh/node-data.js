'use strict';

/*
 * What this node knows about itself, projected for one edge.
 *
 * ⚠️ EXTRACTED SO A WORKER THREAD CAN LOAD IT WITHOUT LOADING THE UPLINK SERVICE. The reporting
 * loop and the read path shared these functions, and requiring the service from a worker would drag
 * in the socket client and the timers with it — a thread whose whole job is a SQLite query would
 * have started a second reporter. Keeping the data functions in their own module makes the worker's
 * dependency list exactly what it needs, and removes the circular require the alternative created.
 *
 * ⚠️ EVERY PROJECTION IS BUILT BY ADDING WHAT THE GRANT ALLOWS, never by removing what it does not.
 * A delete-based filter silently starts shipping each column added afterwards, and nobody finds out
 * until a client asks why their hub knows something they never shared.
 */

const readProxy = require('./read-proxy');
const mirror = require('./mirror');
const store = require('./store');

const nowSec = () => Math.floor(Date.now() / 1000);

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
           d.workspace_id, d.playlist_id, d.layout_id,
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

/**
 * One screen, in the shape the device page actually expects.
 *
 * ⚠️ THE SUMMARY SHAPE WAS NOT ENOUGH, and the symptom was silent. The local /api/devices/:id
 * returns a composite — telemetry[], assignments[], playlist_status, statusLog, screenshot — and
 * returning only the flat summary made the Playlist tab read "No content assigned" and Device Info
 * render blank. Both are legitimate states for a real screen, so nothing looked broken; the page
 * simply lied quietly. A proxy that returns a DIFFERENT shape from the endpoint it stands in for is
 * not a proxy.
 *
 * ⚠️ EACH PIECE IS GATED ON THE GRANT THAT COVERS IT, so the composite cannot become the way around
 * the grant that the individual fields respect. And the local response's `owner_email`,
 * `owner_name` and `_workspaceRole` are deliberately NOT carried: those name the client's own
 * staff, which is nobody else's business and is not something any grant here asks for.
 */
function deviceDetail(db, grants, deviceId, summary) {
  const has = (g) => grants.includes(g);
  const out = { ...summary };
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  out.telemetry = has('health') ? safe(() => db.prepare(
    `SELECT battery_level, battery_charging, storage_free_mb, storage_total_mb, ram_free_mb,
            ram_total_mb, cpu_usage, wifi_rssi, uptime_seconds, local_ip, local_ip6,
            attached_display, video_mode, temperature_c, reported_at
       FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20`)
    .all(deviceId), []) : [];

  /*
   * ⚠️ The screenshot needs `display-capture`, which is its own grant for a reason: an image of a
   * screen may contain whatever was behind it. Without the grant there is no path, not an empty
   * one — the page then renders its ordinary "no screenshot" state rather than a broken image.
   */
  out.screenshot = has('display-capture') ? safe(() => db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1')
    .get(deviceId) || null, null) : null;

  const row = safe(() => db.prepare('SELECT playlist_id, layout_id FROM devices WHERE id = ?')
    .get(deviceId), null);

  out.assignments = [];
  out.playlist_status = null;
  out.playlist_has_published = false;
  out.active_layout_zones = [];
  if (has('content-metadata') && row && row.playlist_id) {
    out.assignments = safe(() => db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
             pi.muted, pi.created_at, pi.updated_at,
             COALESCE(c.filename, w.name) AS filename, c.mime_type, c.duration_sec AS content_duration,
             w.name AS widget_name, w.widget_type
        FROM playlist_items pi
        LEFT JOIN content c ON pi.content_id = c.id
        LEFT JOIN widgets w ON pi.widget_id = w.id
       WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`).all(row.playlist_id), []);
    const pl = safe(() => db.prepare(
      'SELECT status, published_snapshot FROM playlists WHERE id = ?').get(row.playlist_id), null);
    if (pl) {
      out.playlist_status = pl.status;
      out.playlist_has_published = pl.published_snapshot !== null;
    }
    /*
     * ⚠️ `filepath` and `thumbnail_path` are omitted on purpose. They are paths on the CHILD's
     * disk; a parent can neither fetch them nor do anything useful with them, and shipping them
     * would leak the client's storage layout for no benefit at all.
     */
  }

  // Diagnostics: why something went wrong is its own grant, separate from whether it is alive.
  out.statusLog = has('diagnostics') ? safe(() => db.prepare(
    `SELECT status, reason, detail, timestamp FROM device_status_log
      WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC`)
    .all(deviceId, Math.floor(Date.now() / 1000) - 86400), []) : [];
  out.deviceEvents = has('diagnostics') ? safe(() => db.prepare(
    `SELECT * FROM device_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(deviceId), []) : [];

  return out;
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

  const path = String(req.path || '').split('?')[0];
  const seg = path.split('/');
  const inScope = (wsId) => !shared || !shared.length || wsId == null || shared.includes(wsId);

  /*
   * ⚠️ COMPUTED ONCE PER REQUEST. Every branch below needs the visible device set — the collection
   * to return it, the single-object reads to check the id is one this edge may see at all — and
   * each call was re-running a devices×telemetry join over the whole fleet. Three passes to answer
   * one question about one screen.
   *
   * ⚠️ AND THIS RUNS ON THE MAIN THREAD. better-sqlite3 is synchronous by design, and there is no
   * worker behind the mesh: a read from a parent is served on the same event loop that answers
   * every player's heartbeat. On a 400-screen node that is the difference between a proxy that is
   * free and one an operator feels on their own screens — which is exactly the harm I1 exists to
   * prevent, arriving from the opposite direction to the one it was written for.
   */
  const visible = deviceProjections(db, grants, edge);

  if (path === '/api/devices') {
    /*
     * ⚠️ Built from the same projection the mirror uses, so a field cannot travel over the proxy
     * that would not travel over the mirror. Two paths to the same data with two different filters
     * is how one of them ends up more generous than anybody intended.
     */
    return { ok: true, rows: readProxy.scopeRows(visible, shared), asOf: nowSec() };
  }

  if (seg.length === 4 && seg[2] === 'devices') {
    /*
     * ⚠️ THE SCOPE IS CHECKED ON THE ROW, NOT ON THE REQUEST. A single-object read cannot be
     * filtered by the list comprehension that protects the collection, so it needs its own check —
     * and a parent guessing device ids from another workspace is exactly the shape of attack a
     * per-collection filter misses.
     */
    const one = visible.find((d) => d.id === seg[3]);
    if (!one) return { ok: false, reason: 'No such screen on this server.' };
    return { ok: true, row: deviceDetail(db, grants, seg[3], one), asOf: nowSec() };
  }

  if (seg.length === 5 && seg[2] === 'devices' && seg[4] === 'telemetry') {
    const owns = visible.some((d) => d.id === seg[3]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const rows = db.prepare(
        `SELECT battery_level, battery_charging, storage_free_mb, storage_total_mb, ram_free_mb,
                ram_total_mb, cpu_usage, wifi_rssi, uptime_seconds, local_ip, local_ip6,
                attached_display, video_mode, temperature_c, reported_at
           FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 50`).all(seg[3]);
      return { ok: true, rows, asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (seg.length === 5 && seg[2] === 'assignments' && seg[3] === 'device') {
    const owns = visible.some((d) => d.id === seg[4]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const rows = db.prepare(
        `SELECT a.*, p.name AS playlist_name
           FROM assignments a LEFT JOIN playlists p ON p.id = a.playlist_id
          WHERE a.device_id = ?`).all(seg[4]);
      return { ok: true, rows, asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (path === '/api/groups') {
    try {
      const rows = db.prepare('SELECT id, name, workspace_id FROM device_groups').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (path === '/api/playlists') {
    try {
      const rows = db.prepare(
        'SELECT id, name, workspace_id, created_at, updated_at FROM playlists').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (seg.length === 4 && seg[2] === 'playlists') {
    try {
      const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(seg[3]);
      if (!row || !inScope(row.workspace_id)) {
        return { ok: false, reason: 'No such playlist on this server.' };
      }
      const items = db.prepare(
        `SELECT i.*, c.name AS content_name, c.type AS content_type
           FROM playlist_items i LEFT JOIN content c ON c.id = i.content_id
          WHERE i.playlist_id = ? ORDER BY i.position`).all(seg[3]);
      return { ok: true, row: { ...row, items }, asOf: nowSec() };
    } catch (e) { return { ok: false, reason: 'Could not read that playlist.' }; }
  }

  return { ok: false, reason: 'That is not something this connection may read.' };
}

module.exports = {
  scopeClause, deviceProjections, workspaceProjections, deviceDetail,
  nodeHealth, openAlerts, answerRead,
};
