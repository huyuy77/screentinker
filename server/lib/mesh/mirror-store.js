'use strict';

/*
 * Persisting what arrives from below, and getting rid of it again.
 *
 * ⚠️ EVERY WRITE IS AN UPSERT KEYED ON (origin_node_id, …). A child that reconnects and backfills
 * will re-send state it already sent — that is normal, not a fault — and an insert-only design turns
 * an ordinary reconnect into duplicate rows that quietly double every count on the hub's dashboard.
 * Keying on the origin's own identifier also means re-parenting a node changes nothing here (I4).
 *
 * ⚠️ RETENTION IS PER EDGE, ENFORCED HERE, AND IT IS A PROMISE TO SOMEBODY ELSE. A client whose own
 * policy is 30 days can bind the parent to 30 days; holding their data longer than they hold it is a
 * real problem in a regulated environment, and it is the sort of thing that is discovered during an
 * audit rather than by us. So the prune reads the edge's own number rather than a global default.
 */

const { safeParseArray } = require('./store');

/** Node self-report. */
function upsertNodeHealth(db, { edgeId, originNodeId, body, originTs, receivedAt }) {
  db.prepare(`
    INSERT INTO mesh_mirror_nodes
      (origin_node_id, via_edge_id, node_version, device_count, devices_online, origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin_node_id) DO UPDATE SET
      via_edge_id    = excluded.via_edge_id,
      node_version   = excluded.node_version,
      device_count   = excluded.device_count,
      devices_online = excluded.devices_online,
      origin_ts      = excluded.origin_ts,
      received_at    = excluded.received_at,
      -- ⚠️ Hearing from a node CLEARS its stale mark. Without this a node that was disconnected and
      -- later re-paired would stay greyed out forever while cheerfully reporting.
      stale_since    = NULL
  `).run(originNodeId, edgeId, body.version || null, body.device_count ?? null,
         body.devices_online ?? null, originTs ?? null, receivedAt);
}

/**
 * Device summary.
 *
 * ⚠️ The hot columns are written from the body when present and left NULL when not. A health-only
 * grant sends no name, so `name` is NULL and that device is un-searchable by name — a documented
 * consequence of the grant, and the empty state has to say so or it reads as a broken search.
 */
function upsertDevice(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  db.prepare(`
    INSERT INTO mesh_mirror_devices
      (origin_node_id, device_id, name, status, last_heartbeat, body, origin_ts, received_at,
       first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin_node_id, device_id) DO UPDATE SET
      name           = excluded.name,
      status         = excluded.status,
      last_heartbeat = excluded.last_heartbeat,
      body           = excluded.body,
      origin_ts      = excluded.origin_ts,
      received_at    = excluded.received_at,
      -- A device that reports again is not deleted, whatever a stale tombstone said.
      deleted_at     = NULL
      -- ⚠️ first_seen_at is deliberately ABSENT from this SET list, which is what makes it mean
      -- "first", and it is not re-stamped when a tombstoned screen comes back: identity is stable
      -- (I4), so a screen that returns is the same screen and its history still belongs to it.
      -- Rows written before the column existed keep NULL and fall back to received_at in the report,
      -- rather than being back-stamped to now — which would read as "installed today" and quietly
      -- drop the whole existing fleet out of the first report anybody ran.
  `).run(originNodeId, body.id, body.name ?? null, body.status ?? null,
         body.last_heartbeat ?? null, JSON.stringify(body), originTs ?? null, receivedAt,
         receivedAt);
  return true;
}

function upsertAlert(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  db.prepare(`
    INSERT INTO mesh_mirror_alerts
      (id, origin_node_id, alert_type, severity, subject_count, subjects, opened_at, closed_at,
       origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      severity      = excluded.severity,
      subject_count = excluded.subject_count,
      subjects      = excluded.subjects,
      -- An alert closing is the update that matters most; everything else about it is immutable.
      closed_at     = excluded.closed_at,
      received_at   = excluded.received_at
  `).run(body.id, originNodeId, body.type, body.severity ?? null, body.subject_count ?? null,
         body.subjects ? JSON.stringify(body.subjects) : null,
         body.opened_at ?? null, body.closed_at ?? null, originTs ?? null, receivedAt);
  return true;
}

function insertPlayLog(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  // ⚠️ INSERT OR IGNORE, not upsert: a play event is an immutable historical fact. A re-send during
  // backfill must be a no-op, and anything that "updates" a past play is corrupting evidence.
  db.prepare(`
    INSERT OR IGNORE INTO mesh_mirror_play_logs
      (id, origin_node_id, device_id, content_ref, played_at, duration_ms, origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.id, originNodeId, body.device_id ?? null, body.content_ref ?? null,
         body.played_at ?? null, body.duration_ms ?? null, originTs ?? null, receivedAt);
  return true;
}

/** Route a validated envelope to the right table. */
function storeEnvelope(db, edge, env, now) {
  const receivedAt = now || Math.floor(Date.now() / 1000);
  const ctx = { edgeId: edge.id, originNodeId: env.origin_node_id, body: env.body || {},
                originTs: env.origin_ts ? Math.floor(env.origin_ts / 1000) : null, receivedAt };
  switch (env.type) {
    case 'node-health':    upsertNodeHealth(db, ctx); return 'node-health';
    case 'device-summary': return upsertDevice(db, ctx) ? 'device-summary' : null;
    case 'alert-event':    return upsertAlert(db, ctx) ? 'alert-event' : null;
    case 'proof-of-play':  return insertPlayLog(db, ctx) ? 'proof-of-play' : null;
    case 'tombstone':      return markDeleted(db, ctx) ? 'tombstone' : null;
    default:
      // ⚠️ Unknown types are NOT stored. They are relayable (I5) and that is a transport concern —
      // inventing a table for a payload this node cannot interpret would be storing bytes nobody can
      // ever read, and it is how a mirror becomes a landfill.
      return null;
  }
}

/**
 * A device deleted on the child.
 *
 * ⚠️ MARKED, NOT DELETED. Removing the row would rewrite last month's uptime report, and a report
 * that changes retroactively cannot be cited in an invoice dispute. The purge horizon is per edge.
 */
function markDeleted(db, { originNodeId, body, receivedAt }) {
  if (!body || !body.object_id) return false;
  db.prepare(`
    UPDATE mesh_mirror_devices SET deleted_at = ?
     WHERE origin_node_id = ? AND device_id = ?
  `).run(body.deleted_at || receivedAt, originNodeId, body.object_id);
  return true;
}

/** Mark everything from a node as stale, without deleting any of it (disenrollment). */
function markNodeStale(db, originNodeId, now) {
  db.prepare('UPDATE mesh_mirror_nodes SET stale_since = ? WHERE origin_node_id = ?')
    .run(now || Math.floor(Date.now() / 1000), originNodeId);
}

/**
 * Prune one edge's mirrored data to its own retention.
 *
 * ⚠️ CURRENT STATE IS NEVER PRUNED BY AGE. `mesh_mirror_devices` and `mesh_mirror_nodes` hold the
 * LATEST state, so a device that has not changed in six months would be deleted by an age sweep and
 * the screen would vanish from the hub while still hanging on a wall. Only HISTORY — alerts and play
 * logs — ages out. Current state leaves only when its tombstone's purge horizon passes.
 */
function pruneEdge(db, edge, now) {
  const nowSec = now || Math.floor(Date.now() / 1000);
  const out = { alerts: 0, playLogs: 0, tombstoned: 0 };

  if (edge.retention_days > 0) {
    const cutoff = nowSec - edge.retention_days * 86400;
    // Closed alerts only: an alert that is still open is current state however old it is.
    out.alerts = db.prepare(`
      DELETE FROM mesh_mirror_alerts
       WHERE origin_node_id = ? AND closed_at IS NOT NULL AND closed_at < ?
    `).run(edge.peer_node_id, cutoff).changes;

    out.playLogs = db.prepare(`
      DELETE FROM mesh_mirror_play_logs WHERE origin_node_id = ? AND played_at < ?
    `).run(edge.peer_node_id, cutoff).changes;
  }

  if (edge.tombstone_purge_days > 0) {
    const tombCutoff = nowSec - edge.tombstone_purge_days * 86400;
    out.tombstoned = db.prepare(`
      DELETE FROM mesh_mirror_devices
       WHERE origin_node_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?
    `).run(edge.peer_node_id, tombCutoff).changes;
  }

  return out;
}

/** Everything a hub holds from one node — used by purge-on-request after disenrollment. */
function purgeNode(db, originNodeId) {
  const out = {};
  const tx = db.transaction(() => {
    out.devices  = db.prepare('DELETE FROM mesh_mirror_devices WHERE origin_node_id = ?').run(originNodeId).changes;
    out.alerts   = db.prepare('DELETE FROM mesh_mirror_alerts WHERE origin_node_id = ?').run(originNodeId).changes;
    out.playLogs = db.prepare('DELETE FROM mesh_mirror_play_logs WHERE origin_node_id = ?').run(originNodeId).changes;
    out.node     = db.prepare('DELETE FROM mesh_mirror_nodes WHERE origin_node_id = ?').run(originNodeId).changes;
  });
  tx();
  return out;
}

/**
 * ⚠️ FRESHNESS IS JUDGED BY THE EDGE, NOT BY THE ROW'S AGE.
 *
 * A device row an hour old is perfectly current if its node reports hourly and is reachable, and
 * badly out of date if the node dropped ten minutes ago. Reading the row's own timestamp gives the
 * wrong answer in both directions — this is the data behind Phase 3's tri-state, where a WAN blip on
 * one hub link must never paint 400 healthy screens red.
 *
 * @returns {'live'|'stale'|'unknown'}
 */
function freshnessOf(edge, nowSec, staleAfterSec = 600) {
  if (!edge || edge.revoked_at) return 'stale';
  if (!edge.last_sync_at) return 'unknown';   // never synced is not the same as gone quiet
  return (nowSec - edge.last_sync_at) > staleAfterSec ? 'stale' : 'live';
}

function readDevice(db, originNodeId, deviceId) {
  const row = db.prepare(`
    SELECT * FROM mesh_mirror_devices WHERE origin_node_id = ? AND device_id = ?
  `).get(originNodeId, deviceId);
  if (!row) return null;
  let body = {};
  try { body = JSON.parse(row.body || '{}'); } catch (e) { body = {}; }
  return { ...row, body };
}

module.exports = {
  upsertNodeHealth, upsertDevice, upsertAlert, insertPlayLog, storeEnvelope,
  markDeleted, markNodeStale, pruneEdge, purgeNode, freshnessOf, readDevice, safeParseArray,
};
