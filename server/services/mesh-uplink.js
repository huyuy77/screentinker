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

/** Devices as this node knows them, already narrowed to the grant. */
function deviceProjections(db, grantCategories) {
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.hardware_model, d.app_version, d.platform,
           t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
           t.ram_free_mb, t.ram_total_mb, t.cpu_usage, t.wifi_rssi, t.uptime_seconds
      FROM devices d
      LEFT JOIN (
        SELECT device_id, MAX(created_at) AS created_at FROM device_telemetry GROUP BY device_id
      ) latest ON latest.device_id = d.id
      LEFT JOIN device_telemetry t
             ON t.device_id = latest.device_id AND t.created_at = latest.created_at
  `).all();
  return rows.map((r) => mirror.projectDevice(r, grantCategories));
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

function openAlerts(db, grantCategories) {
  try {
    const rows = db.prepare(
      'SELECT id, metric, severity, device_id, opened_at, closed_at FROM alert_events ' +
      'WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 200').all();
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

    for (const d of deviceProjections(db, grant)) link.send(mk('device-summary', d));
    for (const a of openAlerts(db, grant)) link.send(mk('alert-event', a));
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
        }).start();
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

module.exports = { startMeshUplinks, REPORT_INTERVAL_MS, deviceProjections, nodeHealth, openAlerts };
