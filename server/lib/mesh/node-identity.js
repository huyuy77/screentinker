'use strict';

/*
 * Who this node is, and whose version it will speak to.
 *
 * ⚠️ IDENTITY IS GENERATED LOCALLY AND NEVER REGISTERED ANYWHERE (invariant I7). A v4 UUID at first
 * boot, and that is the whole ceremony: no license check, no activation call, no central registry to
 * be down, nothing to phone home to. An air-gapped install is a first-class install, and it cannot be
 * first-class if identity requires the internet.
 *
 * ⚠️ IDENTITY IS POSITION-INDEPENDENT (invariant I4). The id does not encode a parent, a path, or a
 * role. Re-parenting a node changes the paths displayed to an operator and nothing else — every row
 * that node ever emitted still resolves to it. Encoding position in an id is comfortable right up to
 * the first reorganisation, at which point all history silently belongs to the wrong place.
 *
 * ⚠️ NODE IDENTITY IS NOT DEVICE IDENTITY. #288 made one box a server and a player simultaneously, so
 * a node may also appear in its own `devices` table. The association is recorded explicitly rather
 * than inferred, because a rollup that counts the host as both a node and one of its own screens
 * reports a site as having one more screen than it has — a small, permanent, unexplainable error in
 * exactly the numbers an MSP invoices against.
 */

const crypto = require('crypto');
const { cmp } = require('../ota-breaker');

/**
 * ⚠️ THE VERSION FLOOR, DECIDED HERE (directive: "decided now").
 *
 * 2.0.0. Not a conservative guess — no earlier build can speak mesh at all, because the protocol does
 * not exist before it. Setting the floor anywhere lower would be pretending to support a conversation
 * that cannot occur.
 *
 * The point of naming it now is that WITHOUT a stated floor the envelope can never change: every
 * future edit has to stay compatible with every node ever shipped, forever, and in practice that
 * means it does not get edited and the design ossifies.
 *
 * ⚠️ THIS IS A DIFFERENT PROMISE FROM PLAYER COMPATIBILITY, which stays maximal and is unchanged. A
 * player is a screen on a wall that someone may not touch for three years. A node is a participant
 * that writes into someone else's database, and standing it up takes five minutes — "reasonably
 * current" is a fair ask of a node and an unfair one of a panel.
 */
const MIN_NODE_VERSION = '2.0.0';

/** How long a node may lag the floor before an operator is warned rather than refused. */
const DEPRECATION_WINDOW_NOTE =
  'A node below the floor is refused at enroll time, not silently degraded. Raising the floor in a ' +
  'future release must be announced one minor version ahead, so an operator meets a warning before ' +
  'they meet a refusal.';

function newNodeId() {
  return crypto.randomUUID();
}

/**
 * Is `version` new enough to be an edge peer?
 *
 * ⚠️ An unparseable version is REFUSED, not waved through. A node that cannot state its version
 * cannot be held to a contract, and "unknown" is exactly what a hostile or broken peer reports.
 */
function versionAcceptable(version, floor = MIN_NODE_VERSION) {
  const c = cmp(version, floor);
  if (c === null) return false;
  return c >= 0;
}

/**
 * Explain a version refusal to an operator (never accept-and-silently-degrade).
 */
function versionRefusalReason(version, floor = MIN_NODE_VERSION) {
  if (cmp(version, floor) === null) {
    return `The other node reported its version as "${version}", which is not a version this node ` +
           `can compare. Enrollment refused.`;
  }
  return `The other node is running ${version}. This node requires ${floor} or newer to form an ` +
         `edge. Upgrade it and pair again.`;
}

/**
 * ⚠️ DUPLICATE NODE ID DETECTION — refuse the second, loudly.
 *
 * Cloning a VM is routine MSP practice, and a clone carries its parent's node id. If the same origin
 * id then arrives over two edges, the two machines' histories interleave into one row set: uptime,
 * alerts and proof-of-play for two different sites, permanently mixed, with no field that
 * distinguishes them afterwards. It is close to impossible to untangle later and it is trivial to
 * refuse now.
 *
 * Refusing the SECOND (rather than both, or the newest) keeps the node that was already reporting
 * working while the operator fixes the clone — the failure is loud but it is not an outage.
 *
 * @param {string} incomingNodeId
 * @param {(nodeId: string) => {edge_id: string} | null} lookupExistingEdge
 * @param {string} viaEdgeId the edge this claim arrived on
 */
function checkDuplicateNodeId(incomingNodeId, lookupExistingEdge, viaEdgeId) {
  const existing = lookupExistingEdge(incomingNodeId);
  if (!existing || existing.edge_id === viaEdgeId) return { ok: true };
  return {
    ok: false,
    duplicate: true,
    reason: `Node ${incomingNodeId} is already connected on a different edge (${existing.edge_id}). ` +
            `Two machines are reporting the same node identity — almost always a cloned VM or disk ` +
            `image. Their data would be merged and could not be separated afterwards, so this ` +
            `connection is refused. Reset the node identity on the copy.`,
  };
}

module.exports = {
  MIN_NODE_VERSION,
  DEPRECATION_WINDOW_NOTE,
  newNodeId,
  versionAcceptable,
  versionRefusalReason,
  checkDuplicateNodeId,
};
