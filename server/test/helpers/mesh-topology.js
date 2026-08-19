'use strict';

/*
 * A topology harness: spin N nodes, wire them into an arbitrary graph, and break it on purpose.
 *
 * ⚠️ A PHASE 1 DELIVERABLE, NOT AN OPTIONAL EXTRA. Distributed bugs do not reproduce on demand.
 * Without this, the alternative is debugging through support reports about topologies nobody can see,
 * and that is what decides whether this stays maintainable by one person.
 *
 * ⚠️ IT DRIVES THE REAL MODULES. Every node here validates enrollments with lib/mesh/pairing.js,
 * builds and checks envelopes with lib/mesh/envelope.js, and filters by grant with lib/mesh/grants.js.
 * A harness that reimplemented those would only ever prove itself correct — the failure mode of most
 * simulation tests, and the reason this one holds no logic of its own beyond delivery and failure
 * injection.
 *
 * WHAT IT DOES NOT DO YET: real sockets. Transport lands later in Phase 1, and when it does, this
 * file grows a second delivery backend while the graph, the failure injection and every case written
 * against it stay exactly as they are. That is the point of keeping delivery behind one method.
 */

const pairing = require('../../lib/mesh/pairing');
const envelope = require('../../lib/mesh/envelope');
const grants = require('../../lib/mesh/grants');
const capabilities = require('../../lib/mesh/capabilities');
const identity = require('../../lib/mesh/node-identity');

const DEFAULT_VERSION = '2.0.0';

class Node {
  constructor(mesh, { id, version = DEFAULT_VERSION, clockSkewMs = 0, acceptEnrollment = true,
                      allowUplink = true, maxDepth = 2 }) {
    this.mesh = mesh;
    this.id = id;
    this.version = version;
    // A per-node clock offset, so skew is a property of the node rather than something a test has to
    // remember to apply at every call site.
    this.clockSkewMs = clockSkewMs;
    this.flags = { acceptEnrollment, allowUplink };
    this.maxDepth = maxDepth;

    this.edges = new Map();       // edgeId -> edge row
    this.codes = new Map();       // normalized code -> {code, expires_at, burned_at}
    this.received = [];           // envelopes accepted and stored here
    this.relayed = [];            // envelopes forwarded without being understood
    this.refusals = [];           // {from, reason}
    this.reachable = true;        // flip to simulate an unreachable node
    this.ingest = { count: 0, windowStart: 0, throttled: 0 };
  }

  now() { return this.mesh.now() + this.clockSkewMs; }

  /** Ancestry as this node currently knows it: itself plus everything above. */
  ancestry() {
    const chain = [this.id];
    const seen = new Set(chain);
    let cur = this;
    for (;;) {
      const up = [...cur.edges.values()].find((e) => e.direction === 'up' && !e.revoked_at);
      if (!up) break;
      const parent = this.mesh.nodes.get(up.peer_node_id);
      if (!parent || seen.has(parent.id)) break;
      chain.push(parent.id);
      seen.add(parent.id);
      cur = parent;
    }
    return chain;
  }

  mintCode() {
    const code = pairing.mintPairingCode();
    const rec = { code, expires_at: this.now() + pairing.PAIRING_CODE_TTL_MS, burned_at: null };
    this.codes.set(pairing.normalizeCode(code), rec);
    return code;
  }
}

class Mesh {
  constructor({ startMs = 1_700_000_000_000 } = {}) {
    this.nodes = new Map();
    this._now = startMs;
    this.deliveries = [];
  }

  now() { return this._now; }
  advance(ms) { this._now += ms; return this._now; }

  addNode(id, opts = {}) {
    const node = new Node(this, { id, ...opts });
    this.nodes.set(id, node);
    return node;
  }

  /**
   * Enroll `childId` under `parentId`, going through the real validation.
   *
   * @returns {{ok: true, edgeId: string} | {ok: false, reason: string}}
   */
  enroll(childId, parentId, { capabilities: caps = ['consumes-telemetry'], grant = ['health'],
                              code = null, transport = 'they-dial' } = {}) {
    const child = this.nodes.get(childId);
    const parent = this.nodes.get(parentId);
    if (!child || !parent) return { ok: false, reason: 'unknown node' };

    if (!child.flags.allowUplink) {
      return { ok: false, reason: 'This node is not configured to enroll upward (MESH_ALLOW_UPLINK).' };
    }

    const typed = code || parent.mintCode();
    const rec = parent.codes.get(pairing.normalizeCode(typed)) || null;

    const verdict = pairing.validateEnrollment({
      code: typed,
      codeRecord: rec,
      peer: { nodeId: child.id, version: child.version, ancestry: child.ancestry() },
      capabilities: caps,
      grant,
      deps: {
        now: parent.now(),
        thisNodeId: parent.id,
        // ⚠️ The PARENT'S own chain. Depth and one half of the cycle check are measured from it,
        // because it is the half that cannot be lied about by the node asking to join.
        thisAncestry: parent.ancestry(),
        maxDepth: parent.maxDepth,
        flags: parent.flags,
        // Only DOWNWARD edges: this node's own uplink to its parent is not a child, and treating it
        // as one made "enroll A under B, where B is under A" report a duplicate instead of a loop.
        existingEdgeForPeer: (nodeId) =>
          [...parent.edges.values()].find(
            (e) => e.direction === 'down' && e.peer_node_id === nodeId && !e.revoked_at) || null,
        newEdgeId: `${parent.id}->${child.id}`,
        mods: { identity, capabilities, grants },
      },
    });

    if (!verdict.ok) {
      parent.refusals.push({ from: child.id, reason: verdict.reason });
      return { ok: false, reason: verdict.reason };
    }

    if (rec) rec.burned_at = parent.now();     // single use

    const { token, tokenHash } = pairing.mintEdgeToken();
    const edgeId = `${parent.id}->${child.id}`;
    parent.edges.set(edgeId, {
      id: edgeId, peer_node_id: child.id, direction: 'down',
      role_capabilities: verdict.capabilities, grant_categories: verdict.grant,
      transport_direction: transport, token_hash: tokenHash,
      created_at: parent.now(), revoked_at: null,
    });
    child.edges.set(edgeId, {
      id: edgeId, peer_node_id: parent.id, direction: 'up',
      role_capabilities: verdict.capabilities, grant_categories: verdict.grant,
      transport_direction: transport, token,
      created_at: child.now(), revoked_at: null,
    });
    return { ok: true, edgeId, token };
  }

  /**
   * Revoke an edge from either side.
   *
   * ⚠️ NOT PROPAGATED DOWNWARD — that would be a downward command (I2). Cutting an edge stops flow
   * THROUGH it; nothing below is notified, and nothing below needs to change.
   */
  revoke(edgeId) {
    let found = false;
    for (const node of this.nodes.values()) {
      const e = node.edges.get(edgeId);
      if (e) { e.revoked_at = node.now(); found = true; }
    }
    return found;
  }

  /** Emit an observation from `originId` and let it travel as far as it can. */
  emit(originId, { type = 'node-health', bodyVersion = 1, body = {}, category = 'health' } = {}) {
    const origin = this.nodes.get(originId);
    if (!origin) return { delivered: [], blocked: 'unknown node' };
    const env = envelope.createEnvelope({
      originNodeId: origin.id, type, bodyVersion,
      ancestry: [origin.id], originTs: origin.now(), body,
    });
    return this._forward(origin, env, category, []);
  }

  _forward(fromNode, env, category, delivered) {
    const up = [...fromNode.edges.values()].find((e) => e.direction === 'up' && !e.revoked_at);
    if (!up) return { delivered, blocked: 'no active parent' };

    // ⚠️ ENFORCED AT THE SOURCE (I10): a denied category never leaves the node that owns the data.
    if (!grants.grantAllows(up.grant_categories, category)) {
      return { delivered, blocked: `grant does not include ${category}` };
    }

    const parent = this.nodes.get(up.peer_node_id);
    if (!parent) return { delivered, blocked: 'parent missing' };
    if (!parent.reachable) return { delivered, blocked: 'parent unreachable' };

    // Backpressure: a child is an authenticated remote writer on a version you do not control.
    if (!parent._admit(this.now())) {
      parent.ingest.throttled++;
      return { delivered, blocked: 'throttled' };
    }

    /*
     * ⚠️ VALIDATE FIRST, THEN APPEND. The loop check asks "have I already handled this?", so it must
     * run against the ancestry as it ARRIVED. Appending this node first makes every message look like
     * a loop through itself — which is exactly what happened when this was written the other way
     * round, and it failed as a total delivery outage rather than as anything resembling a loop.
     */
    const check = envelope.validateEnvelope(env, { thisNodeId: parent.id });
    if (!check.ok) return { delivered, blocked: check.reason };

    const stamped = envelope.stampReceipt(
      { ...env, ancestry: [...env.ancestry, parent.id] }, parent.id, parent.now());

    if (check.relayOnly) parent.relayed.push(stamped);
    else parent.received.push(stamped);

    delivered.push(parent.id);
    this.deliveries.push({ at: parent.id, env: stamped, relayOnly: !!check.relayOnly });

    // Keep going up: a relay forwards what it could not understand (I5).
    return this._forward(parent, stamped, category, delivered);
  }
}

/** Simple fixed-window ingest cap, so one flooding child cannot starve the others (I6). */
const INGEST_LIMIT = 100;
const INGEST_WINDOW_MS = 1000;
Node.prototype._admit = function admit(nowMs) {
  if (nowMs - this.ingest.windowStart >= INGEST_WINDOW_MS) {
    this.ingest.windowStart = nowMs;
    this.ingest.count = 0;
  }
  this.ingest.count++;
  return this.ingest.count <= INGEST_LIMIT;
};

module.exports = { Mesh, Node, DEFAULT_VERSION, INGEST_LIMIT, INGEST_WINDOW_MS };
