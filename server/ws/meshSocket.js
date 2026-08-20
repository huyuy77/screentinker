'use strict';

/*
 * The parent side of an edge: accepting a child node's connection.
 *
 * ⚠️ ITS OWN NAMESPACE, `/mesh`, and that is a deliberate isolation boundary rather than tidiness.
 * `/device` has been through #146, #148, the mass-reconnect payload work and the command-queue
 * flush-on-reconnect. Putting node traffic through it would mean a misbehaving PEER — a remote
 * machine on a version we do not control — sharing a connection handler with every screen in the
 * fleet, and a bug there would present as displays dropping. Separate namespace, separate handler,
 * separate failure (I6).
 *
 * ⚠️ NOTHING HERE IS REGISTERED UNLESS MESH_ACCEPT_ENROLLMENT IS ON. Not a disabled handler, not a
 * handler that returns early — the namespace is never created. With the flag off there is no route
 * to reach, which is what "invisible" in the directive actually means (I1).
 *
 * ⚠️ THERE IS NO DOWNWARD COMMAND HANDLER, AND THAT ABSENCE IS THE ENFORCEMENT (I2). This file
 * listens; it never emits an instruction to a child. A parent that wanted to reach down would have
 * nothing to call.
 */

const { Backpressure } = require('../lib/mesh/backpressure');
const envelope = require('../lib/mesh/envelope');
const pairing = require('../lib/mesh/pairing');

/**
 * @param {import('socket.io').Server} io
 * @param {object} deps
 * @param {() => boolean} deps.acceptEnrollment   the MESH_ACCEPT_ENROLLMENT flag
 * @param {(tokenHash: string) => object|null} deps.findEdgeByTokenHash
 * @param {(edge, env) => void} deps.onEnvelope   persist an accepted payload
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 */
function setupMeshSocket(io, deps) {
  if (!deps || !deps.acceptEnrollment || !deps.acceptEnrollment()) return null;

  const now = deps.now || (() => Date.now());
  const log = deps.logger || console;
  const backpressure = new Backpressure();
  const meshNs = io.of('/mesh');

  /*
   * Authenticate the edge, not the machine.
   *
   * ⚠️ THE TOKEN IS COMPARED BY HASH and never logged. A parent verifies; it has no reason to be able
   * to reproduce a child's token, so storing or printing the plaintext only converts one leaked log
   * file into standing access to a client's data.
   */
  meshNs.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.edgeToken;
    if (!token || typeof token !== 'string') {
      return next(new Error('This endpoint is for connected nodes. No edge token was presented.'));
    }
    let edge = null;
    try {
      edge = deps.findEdgeByTokenHash(pairing.hashEdgeToken(token));
    } catch (e) {
      log.warn(`[mesh] edge lookup failed: ${e && e.message}`);
      return next(new Error('Could not verify this connection. Try again shortly.'));
    }

    if (!edge) {
      // ⚠️ Deliberately identical for "no such token" and "revoked": a caller holding a stale token
      // learns only that it no longer works, not whether the edge still exists.
      return next(new Error('This connection is no longer authorised. It may have been revoked, or ' +
                            'its token may have expired — reconnect it from either end.'));
    }
    if (!pairing.edgeIsActive(edge, now())) {
      return next(new Error(pairing.edgeInactiveReason(edge, now()) || 'This connection is not active.'));
    }

    socket.data.edge = edge;
    socket.data.childNodeId = edge.peer_node_id;
    return next();
  });

  meshNs.on('connection', (socket) => {
    // ⚠️ `let`, because the edge is re-read per envelope below and the fresh row is what the rest of
    // the handler must use — a grant narrowed while the socket was open has to take effect on the
    // NEXT payload, not at the next reconnect.
    let edge = socket.data.edge;
    const childId = socket.data.childNodeId;
    log.log(`[mesh] node ${childId} connected on edge ${edge.id}`);

    socket.on('mesh:envelope', (raw, ack) => {
      /*
       * ⚠️ THE WHOLE HANDLER IS WRAPPED. A child is a remote writer on a version we do not control,
       * so a malformed payload is an expected input, not an exceptional one. An uncaught throw here
       * would land in socket.io's handler and — before #146 taught this lesson on the device side —
       * take other connections with it. One bad child must cost exactly one bad child (I6).
       */
      try {
        /*
         * ⚠️ AUTHORISATION IS RE-CHECKED HERE, NOT ONLY AT HANDSHAKE. This socket is long-lived by
         * design — a child dials its parent and stays connected — so an edge captured at connect
         * time means revoking it does nothing until the child happens to reconnect, which may be
         * days. An operator revokes precisely when they have decided a peer should stop being
         * trusted, and "it stops at the next reconnect" is not that.
         *
         * One indexed read per envelope, the same order as the write that follows it.
         */
        if (deps.reloadEdge) {
          const current = deps.reloadEdge(edge.id);
          if (!current || !pairing.edgeIsActive(current, now())) {
            const reason = pairing.edgeInactiveReason(current, now())
              || 'This connection is no longer authorised.';
            if (typeof ack === 'function') ack({ ok: false, reason });
            // Disconnected, not merely refused: leaving the socket open invites the child to keep
            // sending into a connection that will never accept anything again.
            socket.disconnect(true);
            return;
          }
          edge = current;
          socket.data.edge = current;
        }

        const size = typeof raw === 'string' ? raw.length : JSON.stringify(raw || {}).length;

        const admit = backpressure.admit(childId, size, now());
        if (!admit.ok) {
          // Answered, not dropped: the child needs to know to hold and retry rather than assume
          // delivery. Silence would look identical to success from the other end.
          if (typeof ack === 'function') {
            ack({ ok: false, throttled: true, limit: admit.limit, retryAfterMs: admit.retryAfterMs });
          }
          return;
        }

        const check = envelope.validateEnvelope(raw, { thisNodeId: deps.thisNodeId });
        if (!check.ok) {
          if (typeof ack === 'function') ack({ ok: false, reason: check.reason });
          return;
        }

        /*
         * ⚠️ A CHILD MAY ATTEST ONLY TO ITS OWN SUBTREE. Reject anything claiming an origin outside
         * it — a compromised leaf must not be able to forge data about a peer it merely shares a hub
         * with. The envelope's ancestry is the child's own claim, so the check is that the SENDING
         * child appears in it: it may relay for things below itself and nothing else.
         */
        const ancestry = Array.isArray(raw.ancestry) ? raw.ancestry : [];
        if (raw.origin_node_id !== childId && !ancestry.includes(childId)) {
          log.warn(`[mesh] node ${childId} claimed origin ${raw.origin_node_id} outside its subtree`);
          if (typeof ack === 'function') {
            ack({ ok: false, reason: 'A node may only report data from its own subtree.' });
          }
          return;
        }

        const stamped = envelope.stampReceipt(raw, deps.thisNodeId, now());
        deps.onEnvelope(edge, stamped, { relayOnly: !!check.relayOnly });
        if (typeof ack === 'function') ack({ ok: true, relayOnly: !!check.relayOnly });
      } catch (e) {
        log.warn(`[mesh] envelope from ${childId} failed: ${e && e.message}`);
        if (typeof ack === 'function') ack({ ok: false, reason: 'Could not process that payload.' });
      }
    });

    socket.on('disconnect', (reason) => {
      // Not an alarm: a node going quiet is normal, and the connection view is where it shows.
      log.log(`[mesh] node ${childId} disconnected (${reason})`);
    });
  });

  return { meshNs, backpressure };
}

module.exports = setupMeshSocket;
