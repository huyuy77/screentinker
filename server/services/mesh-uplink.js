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
const nodeData = require('../lib/mesh/node-data');
const {
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
} = nodeData;
const { createReadRunner } = require('../lib/mesh/read-runner');
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

  /*
   * ⚠️ Reads go to a worker where one exists, and inline where one does not — the same answer
   * either way. better-sqlite3 is synchronous, so an inline read is served on the event loop that
   * answers every player's heartbeat: a parent's convenience paid for out of the child's own
   * responsiveness, which is what I1 forbids.
   */
  const reads = createReadRunner({
    dbPath: (config && config.dbPath) || require('../config').dbPath,
    db,
    nodeData,
    logger,
    preferWorker: process.env.ST_MESH_READ_WORKER !== '0',
  });

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
            /*
             * ⚠️ The EDGE is re-read on this thread, then handed to the runner. Authorisation is
             * decided here from live state; the worker only computes an answer for an edge it was
             * given. A worker that fetched its own edge row could serve a revoked one from a
             * connection opened before the revoke.
             */
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            return reads.run(fresh, req);
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
    readMode: () => reads.mode,
    stop() {
      if (timer) clearInterval(timer);
      reads.stop();
      for (const l of links.values()) { try { l.stop(); } catch (e) { /* best effort */ } }
      links.clear();
    },
  };
}

module.exports = {
  startMeshUplinks, REPORT_INTERVAL_MS,
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
};
