'use strict';

/*
 * The hub's read-only API over mirrored state: Servers, remote screens, alerts, uptime.
 *
 * ⚠️ READ-ONLY, AND STRUCTURALLY SO. There is no route here that writes to a child, because 2.0 has
 * no downward channel to write over (I2). That is not a restraint being exercised — it is the absence
 * of a mechanism, and it is what makes "the hub cannot change what plays on your screens" a fact
 * rather than a promise.
 *
 * ⚠️ EVERY DEVICE ROW GOES THROUGH deviceStatus(), never straight from the table. The stored `status`
 * column is what a node last SAID; it becomes meaningful only when combined with whether that node is
 * still reachable. Serving the raw column is how a dashboard ends up showing a green dot from ninety
 * minutes ago.
 */

const express = require('express');
const hubView = require('../lib/mesh/hub-view');
const clientRoles = require('../lib/mesh/client-roles');
const clientTree = require('../lib/mesh/client-tree');
const { openIncidents, uptimeReport } = require('../services/threshold-alerts');

const nowSec = () => Math.floor(Date.now() / 1000);

module.exports = function meshRoutes(db, { requireAuth }) {
  const router = express.Router();

  /*
   * ⚠️ CLIENT SCOPING IS APPLIED ON THE WAY IN, NOT FILTERED ON THE WAY OUT. A route that fetched
   * everything and removed the rows the caller may not see would leak the moment somebody added a
   * count, an aggregate or a "total" to the response — the classic shape of this bug. Resolving the
   * visible set first means the query itself cannot return anything else.
   */
  function visibleNodeIds(user) {
    const clients = db.prepare('SELECT id, parent_client_id FROM mesh_clients').all();
    const parentOf = new Map(clients.map((c) => [c.id, c.parent_client_id]));
    const getParentId = (id) => parentOf.get(id) || null;
    const getAccessRow = (clientId, userId) => db.prepare(
      'SELECT role FROM mesh_client_access WHERE client_id = ? AND user_id = ?').get(clientId, userId);

    const allowed = new Set();
    for (const c of clients) {
      const { role } = clientTree.resolveAccess(c.id, user, getParentId, getAccessRow, clientRoles);
      if (role && clientRoles.roleAllows(role, 'view-mirrored-data')) allowed.add(c.id);
    }

    const edges = db.prepare(
      "SELECT peer_node_id, client_id FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL"
    ).all();

    /*
     * ⚠️ An edge with NO client is visible to platform_admin only. Defaulting it to "everyone" would
     * mean a node paired before anybody organised it into clients is silently readable by every
     * technician — and "we hadn't got round to filing it yet" is not a defence in a security review.
     */
    return edges
      .filter((e) => (e.client_id ? allowed.has(e.client_id) : user && user.role === 'platform_admin'))
      .map((e) => e.peer_node_id);
  }

  const edgeFor = (nodeId) => db.prepare(
    "SELECT * FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'").get(nodeId);

  /** GET /api/mesh/nodes — the Servers list. */
  router.get('/nodes', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ nodes: [], total: 0 });

    const marks = ids.map(() => '?').join(',');
    const nodes = db.prepare(
      `SELECT * FROM mesh_mirror_nodes WHERE origin_node_id IN (${marks})`).all(...ids);
    const devices = db.prepare(
      `SELECT origin_node_id, status FROM mesh_mirror_devices
        WHERE origin_node_id IN (${marks}) AND deleted_at IS NULL`).all(...ids);

    const byNode = new Map();
    for (const d of devices) {
      if (!byNode.has(d.origin_node_id)) byNode.set(d.origin_node_id, []);
      byNode.get(d.origin_node_id).push(d);
    }

    const out = ids.map((id) => hubView.nodeRollup({
      node: nodes.find((n) => n.origin_node_id === id) || null,
      edge: edgeFor(id),
      devices: byNode.get(id) || [],
      openAlerts: 0,
    }, now));

    res.json({ nodes: out, total: out.length, asOf: now });
  });

  /** GET /api/mesh/devices — the aggregated cross-node screens view. */
  router.get('/devices', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ devices: [], total: 0, limit: 0, offset: 0 });

    const q = hubView.deviceQuery({
      search: req.query.search || null,
      nodeIds: ids,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    const rows = db.prepare(q.sql).all(...q.params);
    const total = db.prepare(q.countSql).get(...q.countParams).c;
    const edges = new Map(ids.map((id) => [id, edgeFor(id)]));

    const devices = rows.map((r) => {
      const edge = edges.get(r.origin_node_id);
      const view = hubView.withAsOf(hubView.deviceStatus(r, edge, now), now);
      let body = {};
      try { body = JSON.parse(r.body || '{}'); } catch (e) { body = {}; }
      return {
        deviceId: r.device_id,
        // ⚠️ The origin node is its OWN field, never concatenated into the name. Folding it in
        // ("Lobby (Acme)") breaks sort and search for every row at once, and it is the sort of thing
        // that is very hard to undo once a customer has learned to read it.
        originNodeId: r.origin_node_id,
        name: r.name,
        ...view,
        body,
        deepLink: hubView.deepLink(edge, 'device', r.device_id),
      };
    });

    res.json({
      devices, total, limit: q.limit, offset: Number(req.query.offset) || 0,
      asOf: now,
      /*
       * ⚠️ The empty state has to EXPLAIN ITSELF. A health-only grant stores no device name, so those
       * screens are un-searchable by name — a documented consequence of the grant. Without this the
       * result reads as a broken search, and the "fix" somebody reaches for is widening the grant.
       */
      searchNote: req.query.search
        ? 'Screens shared under a health-only grant have no name here and can only be found by id.'
        : null,
    });
  });

  /** GET /api/mesh/alerts — the cross-node inbox. */
  router.get('/alerts', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ alerts: [], total: 0 });

    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM mesh_mirror_alerts
        WHERE origin_node_id IN (${marks}) AND closed_at IS NULL
        ORDER BY opened_at DESC LIMIT 200`).all(...ids);

    res.json({
      alerts: rows.map((a) => ({
        ...a,
        subjects: a.subjects ? JSON.parse(a.subjects) : null,
        deepLink: hubView.deepLink(edgeFor(a.origin_node_id), 'alert', a.id),
      })),
      total: rows.length,
      asOf: now,
      // Local incidents live in the same inbox — a hub is a node too, and its own problems are not
      // somebody else's category.
      local: openIncidents(db),
    });
  });

  /**
   * GET /api/mesh/uptime — the per-client report.
   *
   * ⚠️ Bucketed in the ORIGIN's timezone, and the response says so. A store manager's downtime
   * happened during THEIR business hours; bucketing Perth's October by Kenosha days makes every
   * figure quietly wrong with nothing on screen to explain the discrepancy.
   */
  router.get('/uptime', requireAuth, (req, res) => {
    const to = Number(req.query.to) || nowSec();
    const from = Number(req.query.from) || (to - 30 * 86400);
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ report: null, reason: 'No connected sites are visible to you.' });

    const report = uptimeReport(db, { from, to });
    const zone = hubView.zoneFor('report', {
      operatorTz: req.query.tz || null,
      originTz: req.query.originTz || null,
    });
    res.json({ ...report, timezone: zone, timezoneLabel: hubView.timeLabel('report', zone) });
  });

  /** GET /api/mesh/topology — the graph, for the topology view. */
  router.get('/topology', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    const edges = ids.map((id) => {
      const e = edgeFor(id);
      const node = db.prepare('SELECT * FROM mesh_mirror_nodes WHERE origin_node_id = ?').get(id);
      return {
        edgeId: e ? e.id : null,
        peerNodeId: id,
        clientId: e ? e.client_id : null,
        grant: e ? JSON.parse(e.grant_categories || '[]') : [],
        transportDirection: e ? e.transport_direction : null,
        tlsVerify: e ? !!e.tls_verify : null,
        peerVersion: node ? node.node_version : null,
        lastSyncAt: e ? e.last_sync_at : null,
        // Surfaced per edge so an operator can see WHICH link is the problem rather than being told
        // the mesh is unwell.
        freshness: require('../lib/mesh/mirror-store').freshnessOf(e, now),
      };
    });
    res.json({ edges, asOf: now, depthCap: require('../config').meshMaxDepth });
  });

  return router;
};
