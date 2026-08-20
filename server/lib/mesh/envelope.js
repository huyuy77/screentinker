'use strict';

/*
 * The envelope every mesh message travels in.
 *
 * ⚠️ THE ENVELOPE IS STABLE; THE BODY IS VERSIONED. These are separate contracts on purpose. A relay
 * must be able to read where a message came from and where it is going without understanding what is
 * inside it (invariant I5) — so envelope fields can never be extended casually, while payload bodies
 * evolve freely behind their own version number. Collapsing the two means a hub upgrade breaks every
 * older child at once, which is the failure mode that makes people stop upgrading.
 *
 * ⚠️ TWO CLOCKS, NEVER ONE. `origin_ts` is stamped by the node that observed the event, from its own
 * clock. `receipts[]` is appended to at each hop from that hop's clock. Nothing in the mesh may order
 * events by a single clock, because the nodes are other people's machines: a site server with a
 * two-hour skew would silently interleave its alerts into the middle of yesterday in a hub's inbox,
 * and the hub operator would have no way to see why the story does not make sense. Carrying both
 * lets skew be DETECTED and SHOWN (see `clockSkewMs`) instead of quietly corrupting history.
 *
 * ⚠️ ANCESTRY IS RECORDED AT SEND TIME AND IS NOT AN ADDRESS. It says where this message came
 * through, for loop detection and for showing an operator the path. It is never used to locate,
 * authorise, or re-parent anything — identity is position-independent (invariant I4), so a node that
 * moves in the tree keeps every id it ever had.
 */

const ENVELOPE_VERSION = 1;

/**
 * Payload contracts. Each body carries its own version so it can evolve without touching the
 * envelope. A receiver that does not know a type MUST forward it untouched rather than drop it —
 * that is I5, and it is what lets a mid-tier node relay a payload invented after it was installed.
 */
const PAYLOAD_TYPES = Object.freeze({
  'node-health': 1,
  /*
   * ⚠️ A remote server's workspaces, so its orgs appear as ORGS here rather than as one lump per
   * machine. Without it a second workspace created on a child is invisible: its screens land in the
   * same undifferentiated list as everything else on that box, and an operator has no way to tell
   * which customer they belong to.
   */
  'workspace-summary': 1,
  'device-summary': 1,
  'alert-event': 1,
  'proof-of-play': 1,
  'tombstone': 1,
});

/**
 * Build an envelope.
 *
 * @param {object} p
 * @param {string} p.originNodeId  UUID of the node that OBSERVED this, never the sender if relayed
 * @param {string} p.type          payload type
 * @param {number} p.bodyVersion   version of the body contract
 * @param {string[]} p.ancestry    node ids this message has passed through, origin first
 * @param {number} p.originTs      epoch ms from the ORIGIN's clock
 * @param {object} p.body
 */
function createEnvelope({ originNodeId, type, bodyVersion, ancestry, originTs, body }) {
  return {
    envelope_version: ENVELOPE_VERSION,
    origin_node_id: originNodeId,
    type,
    body_version: bodyVersion,
    ancestry: Array.isArray(ancestry) ? [...ancestry] : [originNodeId],
    origin_ts: originTs,
    receipts: [],
    body,
  };
}

/**
 * Stamp a message as received by this node.
 *
 * ⚠️ APPEND, NEVER OVERWRITE. Each hop's clock is evidence. Replacing the previous hop's receipt
 * destroys the only record of where a delay or a skew was introduced, which is exactly what someone
 * is trying to find out when they look at this.
 */
function stampReceipt(env, nodeId, nowMs) {
  const receipts = Array.isArray(env.receipts) ? env.receipts : [];
  return { ...env, receipts: [...receipts, { node_id: nodeId, received_ts: nowMs }] };
}

/**
 * Apparent clock skew between the origin and the first node that received it, in ms.
 *
 * Positive means the origin's clock is AHEAD of the receiver's. Returns null when there is no receipt
 * to compare against. This is deliberately the FIRST receipt: later hops accumulate real transit
 * time, so comparing against them measures the network rather than the clock.
 *
 * Network transit is included in this figure and cannot be separated from skew without a round trip.
 * That is acceptable because the number exists to answer "is this node's clock roughly sane", where
 * the interesting values are minutes and hours, not the milliseconds transit contributes.
 */
function clockSkewMs(env) {
  if (!env || !Array.isArray(env.receipts) || env.receipts.length === 0) return null;
  if (typeof env.origin_ts !== 'number') return null;
  const first = env.receipts[0];
  if (!first || typeof first.received_ts !== 'number') return null;
  return env.origin_ts - first.received_ts;
}

/** Skew worth telling an operator about. A minute is noise; ten is a story that will not add up. */
const SKEW_WARN_MS = 10 * 60 * 1000;

function skewIsNotable(env) {
  const skew = clockSkewMs(env);
  return skew !== null && Math.abs(skew) >= SKEW_WARN_MS;
}

/**
 * Would forwarding this message create a loop?
 *
 * ⚠️ A REACHABILITY CHECK ON RECORDED ANCESTRY, not a path-prefix comparison (invariant I3). Prefix
 * matching assumes a tree; the mesh is a DAG, because multi-parent is a real requirement — an MSP's
 * hub and the client's own hub may both observe the same server. Under multi-parent a legitimate
 * message routinely arrives with an ancestry that is not a prefix of anything local, and a prefix
 * check would refuse it.
 */
function wouldLoop(env, thisNodeId) {
  return Array.isArray(env?.ancestry) && env.ancestry.includes(thisNodeId);
}

/**
 * Validate an inbound envelope.
 *
 * ⚠️ AN UNKNOWN PAYLOAD TYPE IS NOT AN ERROR. It is the relay case (I5) and it must survive. This
 * returns `relayOnly` for it: the node may forward it and must not try to store or interpret it.
 * Refusing unknown types would mean every node in a path had to be upgraded before any new payload
 * could travel — which is precisely the coupling the envelope/body split exists to prevent.
 */
function validateEnvelope(env, { thisNodeId } = {}) {
  if (!env || typeof env !== 'object') {
    return { ok: false, reason: 'Message is not an envelope.' };
  }
  if (env.envelope_version !== ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: `Envelope version ${env.envelope_version} is not supported by this node ` +
              `(it speaks version ${ENVELOPE_VERSION}). The sending node is likely newer; ` +
              `upgrade this one.`,
    };
  }
  if (typeof env.origin_node_id !== 'string' || !env.origin_node_id) {
    return { ok: false, reason: 'Envelope has no origin node id.' };
  }
  if (typeof env.origin_ts !== 'number') {
    return { ok: false, reason: 'Envelope has no origin timestamp.' };
  }
  if (thisNodeId && wouldLoop(env, thisNodeId)) {
    return {
      ok: false,
      reason: `Refusing a message that has already passed through this node ` +
              `(${thisNodeId}) — that would be a routing loop.`,
    };
  }

  const known = Object.prototype.hasOwnProperty.call(PAYLOAD_TYPES, env.type);
  if (!known) {
    // I5: forward it, do not understand it, do not drop it.
    return { ok: true, relayOnly: true, reason: `Unknown payload type "${env.type}" — relay only.` };
  }
  if (env.body_version > PAYLOAD_TYPES[env.type]) {
    // A newer body of a type we know: still relayable, still not storable.
    return {
      ok: true,
      relayOnly: true,
      reason: `Payload "${env.type}" version ${env.body_version} is newer than this node ` +
              `understands (${PAYLOAD_TYPES[env.type]}) — relay only.`,
    };
  }

  return { ok: true, relayOnly: false };
}

module.exports = {
  ENVELOPE_VERSION,
  PAYLOAD_TYPES,
  SKEW_WARN_MS,
  createEnvelope,
  stampReceipt,
  clockSkewMs,
  skewIsNotable,
  wouldLoop,
  validateEnvelope,
};
