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
const meshUptime = require('../lib/mesh/uptime-report');
const alertRollup = require('../lib/mesh/alert-rollup');
const { openIncidents } = require('../services/threshold-alerts');

const nowSec = () => Math.floor(Date.now() / 1000);

module.exports = function meshRoutes(db, { requireAuth }) {
  const router = express.Router();

  /*
   * ⚠️ CLIENT SCOPING IS APPLIED ON THE WAY IN, NOT FILTERED ON THE WAY OUT. A route that fetched
   * everything and removed the rows the caller may not see would leak the moment somebody added a
   * count, an aggregate or a "total" to the response — the classic shape of this bug. Resolving the
   * visible set first means the query itself cannot return anything else.
   */
  function visibleClientIds(user) {
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
    return allowed;
  }

  /**
   * Every client beneath this one.
   *
   * ⚠️ Depth-bounded by a seen-set rather than trusting the tree to be acyclic. client-tree.js
   * cycle-checks on write, but a walk that assumes its input is well-formed is one bad row away from
   * hanging the request thread — and a hung report endpoint is indistinguishable from a slow one.
   */
  function descendantClientIds(rootId) {
    const rows = db.prepare('SELECT id, parent_client_id FROM mesh_clients').all();
    const children = new Map();
    for (const r of rows) {
      if (!r.parent_client_id) continue;
      if (!children.has(r.parent_client_id)) children.set(r.parent_client_id, []);
      children.get(r.parent_client_id).push(r.id);
    }
    const out = [];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      for (const kid of children.get(queue.shift()) || []) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        out.push(kid);
        queue.push(kid);
      }
    }
    return out;
  }

  function visibleNodeIds(user) {
    const allowed = visibleClientIds(user);
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

    /*
     * ⚠️ Counted, not hardcoded. This was `openAlerts: 0` — the rollup has always had the field and
     * has always reported none, so a site with nine open alerts rendered a clean card. A placeholder
     * that renders as a REASSURING value is worse than a missing one, because nothing on screen
     * invites anybody to check.
     */
    const alertCounts = new Map(db.prepare(
      `SELECT origin_node_id, COUNT(*) AS c FROM mesh_mirror_alerts
        WHERE origin_node_id IN (${marks}) AND closed_at IS NULL
        GROUP BY origin_node_id`).all(...ids).map((r) => [r.origin_node_id, r.c]));

    const out = ids.map((id) => hubView.nodeRollup({
      node: nodes.find((n) => n.origin_node_id === id) || null,
      edge: edgeFor(id),
      devices: byNode.get(id) || [],
      openAlerts: alertCounts.get(id) || 0,
    }, now));

    res.json({ nodes: out, total: out.length, asOf: now });
  });

  /**
   * GET /api/mesh/orgs — connected servers presented as ORGS this operator can select.
   *
   * ⚠️ THE MODEL SHIFT THAT MAKES THE REST OF THE UI WORK. Earlier the position was that remote
   * workspaces must never enter the workspace switcher, because the switcher assumes a local
   * WRITABLE workspace and every write surface would grow a disabled state — "a UI full of dead
   * controls teaches people the product is broken."
   *
   * That objection is answered by making the controls not dead: a write against a remote org is
   * relayed to the server that owns it, over the link that already exists. Once writes work,
   * selecting a remote org is exactly like selecting a local one, and keeping it out of the
   * switcher becomes the arbitrary choice. Until the downward channel lands (I2) the selection is
   * READ-ONLY and the UI says so — which is a caveat on one banner rather than a disabled state on
   * every button.
   *
   * Named after the CLIENT where one exists, because "Acme Retail" is what an operator calls that
   * site; a node UUID is what the machine calls itself and nobody else ever does.
   */
  router.get('/orgs', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ orgs: [] });

    const marks = ids.map(() => '?').join(',');
    const counts = new Map(db.prepare(
      `SELECT origin_node_id,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
         FROM mesh_mirror_devices
        WHERE origin_node_id IN (${marks}) AND deleted_at IS NULL
        GROUP BY origin_node_id`).all(...ids).map((r) => [r.origin_node_id, r]));

    res.json({
      orgs: ids.map((id) => {
        const edge = edgeFor(id);
        const client = edge && edge.client_id
          ? db.prepare('SELECT name FROM mesh_clients WHERE id = ?').get(edge.client_id) : null;
        const c = counts.get(id) || { total: 0, online: 0 };
        const fresh = require('../lib/mesh/mirror-store').freshnessOf(edge, now);
        return {
          nodeId: id,
          clientId: edge ? edge.client_id : null,
          name: (client && client.name) || edge?.peer_name || `Server ${String(id).slice(0, 8)}`,
          /*
           * ⚠️ The SERVER's own name, separate from the client it is filed under. The switcher used
           * to sub-title every remote org "another server", which is true of all of them and so
           * distinguishes none of them — and a node id distinguishes them only in principle. The
           * peer declares this when it pairs.
           */
          serverName: (edge && edge.peer_name) || null,
          deviceCount: c.total,
          // ⚠️ null when the link is stale, never 0 — see the note on nodeRollup. A remote org
          // showing "0 online" in a switcher is a claim that the site is dark.
          devicesOnline: fresh === 'stale' ? null : (c.online || 0),
          stale: fresh === 'stale',
          // The honest state of the feature, sent rather than assumed by the client: this server
          // can read the org but cannot yet write to it.
          writable: false,
        };
      }),
    });
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

    const mirrorStore = require('../lib/mesh/mirror-store');
    const alerts = rows.map((a) => {
      const edge = edgeFor(a.origin_node_id);
      return {
        ...a,
        subjects: a.subjects ? JSON.parse(a.subjects) : null,
        /*
         * ⚠️ An alert from a node we cannot currently reach is LAST KNOWN, like every other row on
         * this hub. Without the flag the inbox is the one screen in the product that still implies
         * live truth — and it is the screen people act on fastest.
         */
        stale: mirrorStore.freshnessOf(edge, now) === 'stale',
        deepLink: hubView.deepLink(edge, 'alert', a.id),
      };
    });

    /*
     * ⚠️ ROLLED UP, AND MOST IMPORTANTLY FOR THE CASE WHERE THIS HUB IS THE BROKEN THING. When most
     * children go quiet at once the honest reading is "suspect the observer", not "40 sites are
     * down" — the latter dispatches engineers to premises that are fine. alert-rollup.js has encoded
     * this since Phase 2 but had no caller until now, so the inbox would have shown the forty.
     */
    const rolled = alertRollup.rollup(
      rows.map((a) => ({
        node_id: a.origin_node_id,
        type: a.alert_type,
        // ⚠️ MILLISECONDS. alert-rollup's correlation window is a ms constant, while every timestamp
        // stored on this hub is unix SECONDS. Passing seconds against a ms `now` makes every alert
        // look ancient, so nothing ever correlates and the rollup silently degrades to no rollup at
        // all — working code, no error, and the self-suspicion case never fires.
        opened_at: a.opened_at * 1000,
        severity: a.severity,
        subject_count: a.subject_count,
      })),
      { now: now * 1000, totalChildren: ids.length },
    ).filter((r) => r.rolled);

    res.json({
      alerts,
      total: alerts.length,
      asOf: now,
      // Only the grouped conditions; a single site's alert stays a single site's alert, named, rather
      // than being buried in a summary that reads as a statistic.
      rollups: rolled,
      // Local incidents live in the same inbox — a hub is a node too, and its own problems are not
      // somebody else's category.
      local: openIncidents(db),
    });
  });

  /**
   * GET /api/mesh/uptime?clientId=… — the per-client report.
   *
   * ⚠️ Bucketed in the ORIGIN's timezone, and the response says so. A store manager's downtime
   * happened during THEIR business hours; bucketing Perth's October by Kenosha days makes every
   * figure quietly wrong with nothing on screen to explain the discrepancy.
   *
   * ⚠️ SCOPED PER CLIENT, and an earlier version was NOT — it checked that the caller could see at
   * least one node and then reported over every alert_events row on this server, which handed a
   * technician scoped to one client the whole local fleet's incident history. Exactly the
   * fetch-everything-then-hope shape this file's header warns about, except nothing filtered it at
   * all. The client is now resolved and authorised before any row is read.
   */
  function buildReport(req, clientId) {
    const to = Number(req.query.to) || nowSec();
    const from = Number(req.query.from) || (to - 30 * 86400);
    const client = db.prepare('SELECT id, name FROM mesh_clients WHERE id = ?').get(clientId);
    if (!client) return { error: 404, reason: 'No such client.' };
    if (!visibleClientIds(req.user).has(client.id)) {
      // 404, not 403: "you may not see this" confirms it exists, and client names are commercially
      // sensitive in exactly the multi-tenant deployments this feature is for.
      return { error: 404, reason: 'No such client.' };
    }

    const report = meshUptime.clientUptime(db, {
      clientId: client.id,
      clientName: client.name,
      from,
      to,
      descendantsOf: (id) => descendantClientIds(id),
      nowSec: nowSec(),
    });
    const zone = hubView.zoneFor('report', {
      operatorTz: req.query.tz || null,
      originTz: req.query.originTz || null,
    });
    return { report: { ...report, timezone: zone, timezoneLabel: hubView.timeLabel('report', zone) } };
  }

  router.get('/uptime', requireAuth, (req, res) => {
    if (!req.query.clientId) {
      /*
       * ⚠️ NO IMPLICIT "EVERYTHING" REPORT. A report headed with no client name, mixing several
       * customers' screens into one percentage, is worse than useless: it is the document somebody
       * forwards to one of those customers. Asking for the client is one extra parameter and removes
       * the possibility.
       */
      return res.json({
        report: null,
        clients: [...visibleClientIds(req.user)].map((id) =>
          db.prepare('SELECT id, name FROM mesh_clients WHERE id = ?').get(id)).filter(Boolean),
        reason: 'Choose a client to report on.',
      });
    }
    const out = buildReport(req, String(req.query.clientId));
    if (out.error) return res.status(out.error).json({ report: null, reason: out.reason });
    res.json(out.report);
  });

  /** GET /api/mesh/uptime.csv?clientId=… — the same report, as the artifact. */
  router.get('/uptime.csv', requireAuth, (req, res) => {
    const out = buildReport(req, String(req.query.clientId || ''));
    if (out.error) return res.status(out.error).json({ reason: out.reason });

    /*
     * ⚠️ The filename is built from a WHITELIST, never from the client name directly. A name is
     * attacker-influenced text arriving from another server, and dropping it into Content-Disposition
     * is a header-injection primitive — the same reasoning as lib/brand-filename.js.
     */
    const stem = String(out.report.clientName || out.report.clientId || 'client')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'client';
    const day = new Date(out.report.to * 1000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="uptime-${stem}-${day}.csv"`);
    res.send(meshUptime.toCsv(out.report));
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
