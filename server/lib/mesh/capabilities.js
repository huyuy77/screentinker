'use strict';

/*
 * What a node does on a given edge.
 *
 * ⚠️ A SET, NEVER AN ENUM. "Hub", "proxy", "site server", "analytics sink" are not types — they are
 * combinations of the capabilities below. #288 already proved the point by making one box a server
 * and a player at once; an enum would have needed a new member for that, and another for the next
 * combination somebody deploys.
 *
 * The test of this design is that adding a node type requires NO schema change and NO new branch in
 * the pairing logic — only a different set. If a future "regional cache that also consumes
 * proof-of-play but does not relay" needs code changes here, this file failed.
 *
 * ⚠️ CAPABILITY IS NOT PERMISSION. `relays-for-subtree` says a node will carry traffic; it says
 * nothing about what it may read. That is the grant, and it is stored separately on the same edge
 * (see grants.js). A hub edge and a proxy edge can hold identical grants and be entirely different
 * machines. Conflating the two is how "it relays for us" silently becomes "it can read everything
 * it relays" — which invariant I5 exists to forbid.
 */

const CAPABILITIES = Object.freeze({
  'accepts-enrollment': {
    summary: 'May mint pairing codes and accept child nodes',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'relays-for-subtree': {
    summary: 'Forwards payloads on behalf of nodes below it',
    // ⚠️ I5: a relay forwards what it cannot parse, unmodified, and may read the envelope only.
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'consumes-telemetry': {
    summary: 'Stores mirrored health and device state from below',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'consumes-proof-of-play': {
    summary: 'Stores play logs from below',
    // ⚠️ Phase 4: proof-of-play must never be downsampled — averaged evidence is not evidence.
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'redistributes-content': {
    summary: 'Caches and serves media to its subtree',
    // ⚠️ PHASE 5 ONLY. Named here so the vocabulary is stable, and REFUSED by validation until then.
    // This is the one that inverts I2's direction, so it gets its own security review.
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
    phase5: true,
  },
});

const ALL = Object.freeze(Object.keys(CAPABILITIES));
const AVAILABLE_NOW = Object.freeze(ALL.filter((c) => !CAPABILITIES[c].phase5));

function isKnown(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, name);
}

/**
 * Validate a requested capability set for an edge.
 *
 * Refusal is explicit and readable, for the same reason as in grants.js: a node that quietly drops
 * the capabilities it does not support leaves the operator believing the edge does something it does
 * not, and they find out when the data never arrives.
 *
 * @param {string[]} requested
 * @param {{acceptEnrollment?: boolean}} flags — this node's own feature flags
 */
function validateCapabilities(requested, flags = {}) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, rejected: [], reason: 'An edge must declare at least one capability.' };
  }

  const unknown = requested.filter((c) => !isKnown(c));
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      reason: `This node does not support ${unknown.map((c) => `"${c}"`).join(', ')}. It may be ` +
              `newer than this node — supported capabilities are: ${AVAILABLE_NOW.join(', ')}.`,
    };
  }

  const notYet = requested.filter((c) => CAPABILITIES[c].phase5);
  if (notYet.length) {
    return {
      ok: false,
      rejected: notYet,
      reason: `${notYet.join(', ')} is not available in this version. Content flows downward only ` +
              `from a later release; this node observes and reports, and cannot be sent content by ` +
              `a parent.`,
    };
  }

  const needsAccept = requested.filter((c) => CAPABILITIES[c].requiresFlag === 'MESH_ACCEPT_ENROLLMENT');
  if (needsAccept.length && !flags.acceptEnrollment) {
    return {
      ok: false,
      rejected: needsAccept,
      reason: `This node is not configured to accept enrollments. Set MESH_ACCEPT_ENROLLMENT=1 on ` +
              `it first — until then it cannot act as a parent for ${needsAccept.join(', ')}.`,
    };
  }

  return { ok: true, capabilities: [...new Set(requested)] };
}

module.exports = { CAPABILITIES, ALL, AVAILABLE_NOW, isKnown, validateCapabilities };
