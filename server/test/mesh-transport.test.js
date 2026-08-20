'use strict';

/*
 * Transport, end to end: a child node dials a parent over a real socket and reports upward.
 *
 * ⚠️ REAL SOCKETS, NOT THE SIMULATION. The topology harness models the graph and the failure
 * injection; these prove the wire actually carries it — authentication, backpressure answered rather
 * than dropped, subtree attestation, and the reconnect behaviour. A simulation cannot tell you that
 * an auth middleware rejects, because in a simulation there is no middleware.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const setupMeshSocket = require('../ws/meshSocket');
const pairing = require('../lib/mesh/pairing');
const envelope = require('../lib/mesh/envelope');
const { Uplink, backoffFor, BACKOFF_MAX_MS } = require('../lib/mesh/uplink');

const HUB_ID = 'hub-node';
const CHILD_ID = 'child-node';
const quietLogger = { log() {}, warn() {}, error() {} };

/** Stand a parent up on a random port with one live edge. */
async function parent({ edgeOver = {}, onEnvelope = () => {} } = {}) {
  const { token, tokenHash } = pairing.mintEdgeToken();
  const edge = {
    id: 'edge-1', peer_node_id: CHILD_ID, direction: 'down',
    grant_categories: ['health'], role_capabilities: ['consumes-telemetry'],
    revoked_at: null, token_expires_at: null, ...edgeOver,
  };

  const http = createServer();
  const io = new Server(http, { pingInterval: 300, pingTimeout: 300 });
  const received = [];

  const wired = setupMeshSocket(io, {
    thisNodeId: HUB_ID,
    acceptEnrollment: () => true,
    findEdgeByTokenHash: (h) => (h === tokenHash ? edge : null),
    // The same mutable row, so a test can revoke or expire it MID-SESSION and see the open socket
    // react — which is the whole point of re-reading it per envelope.
    reloadEdge: (id) => (id === edge.id ? edge : null),
    onEnvelope: (e, env, meta) => { received.push({ env, meta }); onEnvelope(e, env, meta); },
    logger: quietLogger,
  });

  const port = await new Promise((r) => http.listen(0, '127.0.0.1', () => r(http.address().port)));
  return {
    url: `http://127.0.0.1:${port}`, token, edge, received, io, http, wired,
    async close() { io.close(); await new Promise((r) => http.close(r)); },
  };
}

function child(hub, over = {}) {
  return new Uplink({
    parentUrl: hub.url, edgeToken: hub.token, nodeId: CHILD_ID,
    connect, logger: quietLogger, ...over,
  });
}

const waitFor = (fn, ms = 4000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let v; try { v = fn(); } catch { v = false; }
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error('timed out waiting'));
    setTimeout(tick, 20);
  };
  tick();
});

// ===== the wire works =====

test('a child dials its parent and an observation arrives', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    up.send(envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { up: true },
    }));
    await waitFor(() => hub.received.length === 1);

    const got = hub.received[0].env;
    assert.equal(got.origin_node_id, CHILD_ID);
    // ⚠️ The parent stamps its own receipt, so skew stays measurable across the hop.
    assert.equal(got.receipts.length, 1);
    assert.equal(got.receipts[0].node_id, HUB_ID);
    await waitFor(() => up.lastSyncAt !== null, 2000);
  } finally { up.stop(); await hub.close(); }
});

// ===== authentication =====

test('a connection with no token is refused', async () => {
  const hub = await parent();
  const sock = connect(`${hub.url}/mesh`, { transports: ['websocket'], reconnection: false });
  try {
    const err = await new Promise((resolve) => sock.on('connect_error', resolve));
    assert.match(err.message, /No edge token was presented/i);
  } finally { sock.close(); await hub.close(); }
});

test('a revoked edge is refused, and says so without confirming the edge exists', async () => {
  /*
   * ⚠️ "Revoked" and "no such token" answer identically on purpose. A caller holding a stale token
   * learns that it no longer works — not whether the relationship still exists, which is somebody
   * else's business.
   */
  const hub = await parent({ edgeOver: { revoked_at: Math.floor(Date.now() / 1000) } });
  const up = child(hub).start();
  try {
    await waitFor(() => up.lastError !== null);
    assert.match(up.lastError, /no longer authorised|revoked|expired/i);
    assert.equal(up.connected, false);
  } finally { up.stop(); await hub.close(); }
});

test('a wrong token is refused with the same answer as a revoked one', async () => {
  const hub = await parent();
  const up = child(hub, { edgeToken: 'not-the-token' }).start();
  try {
    await waitFor(() => up.lastError !== null);
    assert.match(up.lastError, /no longer authorised/i);
  } finally { up.stop(); await hub.close(); }
});

// ===== the security property =====

test('⚠️ a child may attest only to its own subtree', async () => {
  /*
   * A compromised leaf must not be able to forge data about a peer it merely shares a hub with.
   * The check is that the SENDING child appears in the ancestry: it may relay for things below
   * itself, and nothing else.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);

    const forged = envelope.createEnvelope({
      originNodeId: 'someone-elses-node', type: 'node-health', bodyVersion: 1,
      ancestry: ['someone-elses-node'], originTs: Date.now(), body: { forged: true },
    });
    const reply = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', forged, (err, res) => resolve(err || res));
    });
    assert.equal(reply.ok, false);
    assert.match(reply.reason, /only report data from its own subtree/i);
    assert.equal(hub.received.length, 0, 'and nothing was stored');

    // Relaying for a node BELOW itself is legitimate and must still work.
    const relayed = envelope.createEnvelope({
      originNodeId: 'leaf', type: 'node-health', bodyVersion: 1,
      ancestry: ['leaf', CHILD_ID], originTs: Date.now(), body: {},
    });
    const ok = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', relayed, (err, res) => resolve(err || res));
    });
    assert.equal(ok.ok, true, 'a child relaying for its own subtree is exactly the point of I5');
  } finally { up.stop(); await hub.close(); }
});

test('an unknown payload type crosses the wire as relay-only', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const env = envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'invented-in-2027', bodyVersion: 4,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    const res = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', env, (e, r) => resolve(e || r));
    });
    assert.equal(res.ok, true, 'an unknown type must not be an error (I5)');
    assert.equal(res.relayOnly, true, 'but must be marked relay-only rather than interpreted');
  } finally { up.stop(); await hub.close(); }
});

// ===== backpressure over the wire =====

test('a throttled child is ANSWERED, not silently dropped', async () => {
  /*
   * ⚠️ Silence is indistinguishable from success at the far end. A child told nothing assumes
   * delivery and moves on, so the data is lost with both sides believing otherwise.
   */
  const hub = await parent();
  hub.wired.backpressure.limits.maxMessages = 2;
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    const send = () => new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', mk(), (e, r) => resolve(e || r));
    });

    await send(); await send();
    const third = await send();
    assert.equal(third.ok, false);
    assert.equal(third.throttled, true);
    assert.equal(third.limit, 'rate');
    assert.ok(third.retryAfterMs > 0, 'and told when it may try again');
  } finally { up.stop(); await hub.close(); }
});

// ===== reconnect =====

test('backoff is bounded and jittered, so a fleet does not thunder', () => {
  /*
   * ⚠️ THE JITTER IS THE LOAD-BEARING HALF (#144). A hub restart disconnects every child at the same
   * instant; without jitter they all retry in the same millisecond, knock it over again, and the
   * outage repeats on a fixed period until a human intervenes.
   */
  const spread = new Set();
  for (let i = 0; i < 200; i++) spread.add(backoffFor(3));
  assert.ok(spread.size > 50, `expected a wide spread of delays, got ${spread.size} distinct`);

  for (let attempt = 1; attempt <= 30; attempt++) {
    const d = backoffFor(attempt);
    assert.ok(d >= 250, 'never a hot loop');
    assert.ok(d <= BACKOFF_MAX_MS * 1.5, 'and always bounded');
  }
  // Deterministic with a fixed source, so the ceiling is testable rather than merely asserted.
  assert.equal(backoffFor(1, () => 0.5), 1000);
});

test('a node whose parent is down keeps buffering and stays fully functional (I1)', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    await hub.close();                        // the parent goes away mid-life
    await waitFor(() => !up.connected, 4000);

    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    for (let i = 0; i < 5; i++) up.send(mk());

    assert.ok(up.buffer.length > 0, 'observations are held for backfill');
    assert.equal(up.status().connected, false);
    assert.ok(up.status().retryAttempt > 0, 'and it is retrying, with the reason recorded');
  } finally { up.stop(); }
});

test('the buffer is bounded and drops the OLDEST', async () => {
  /*
   * A node whose parent is away for a week must not consume its own memory reporting to nobody —
   * that would turn an observer's outage into the observed node's outage. Oldest-first because after
   * a long gap, "what is happening now" is worth more than the middle of last Tuesday.
   */
  const hub = await parent();
  const up = child(hub, { bufferMax: 3 });
  try {
    for (let i = 0; i < 10; i++) {
      up.send(envelope.createEnvelope({
        originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
        ancestry: [CHILD_ID], originTs: i, body: { i },
      }));
    }
    assert.equal(up.buffer.length, 3);
    assert.equal(up.buffer[0].body.i, 7, 'the newest survive');
    assert.equal(up.dropped, 7);
    assert.equal(up.status().droppedOldest, 7, 'and the loss is reported, not hidden');
  } finally { up.stop(); await hub.close(); }
});

test('an uplink refuses to exist without an operator-supplied address (I9)', () => {
  // ⚠️ There is no default parent and no fallback. This is how a peer architecture quietly becomes
  // hub-and-spoke, and it always arrives as a convenience.
  assert.throws(() => new Uplink({ edgeToken: 't', nodeId: 'n', connect }),
    /no default address/i);
  assert.throws(() => new Uplink({ parentUrl: 'http://x', nodeId: 'n', connect }), /edge token/i);
});

test('⚠️ with the flag OFF there is no /mesh endpoint to reach (I1)', async () => {
  /*
   * The invisibility guarantee, at the transport layer. Not "a handler that refuses" — the namespace
   * is never created, so there is no surface at all. A user who never sets MESH_ACCEPT_ENROLLMENT
   * must not be able to tell the mesh exists, and an early-returning handler would still answer.
   */
  const http = createServer();
  const io = new Server(http);
  const wired = setupMeshSocket(io, { acceptEnrollment: () => false, logger: quietLogger });
  assert.equal(wired, null, 'nothing is wired when the flag is off');

  const port = await new Promise((r) => http.listen(0, '127.0.0.1', () => r(http.address().port)));
  const sock = connect(`http://127.0.0.1:${port}/mesh`, {
    transports: ['websocket'], reconnection: false, timeout: 2000,
  });
  try {
    const err = await new Promise((resolve, reject) => {
      sock.on('connect_error', resolve);
      sock.on('connect', () => reject(new Error('the namespace answered — it should not exist')));
      setTimeout(() => reject(new Error('no answer either way')), 5000);
    });
    // socket.io's own "Invalid namespace" — the endpoint genuinely is not there.
    assert.match(err.message, /invalid namespace/i);
  } finally {
    sock.close(); io.close(); await new Promise((r) => http.close(r));
  }
});

test('⚠️ END TO END: a denied field never crosses the wire', async () => {
  /*
   * The I10 property, proven on the actual socket rather than in a unit test. Filtering at the
   * PARENT would look identical from the child's side and be worthless: the data would already have
   * crossed into somebody else's process, and the client's only protection would be the good
   * behaviour of a machine they do not control.
   *
   * So the child projects with lib/mesh/mirror.js BEFORE sending, and what arrives is checked for
   * the absence of everything the grant did not cover.
   */
  const mirror = require('../lib/mesh/mirror');
  const hub = await parent();                       // edge grants ['health'] only
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);

    const deviceRow = {
      id: 'dev-1', name: 'Reception', status: 'online', battery_level: 55,
      hardware_serial: 'SN-77', ip_address: '80.51.0.7', local_ip: '10.0.0.5',
      playlist_name: 'Autumn Promo', screenshot_url: '/uploads/screenshots/dev-1.jpg',
    };

    up.send(envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'device-summary', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(),
      body: mirror.projectDevice(deviceRow, hub.edge.grant_categories),
    }));
    await waitFor(() => hub.received.length === 1);

    const body = hub.received[0].env.body;
    assert.equal(body.id, 'dev-1', 'the identifier travels — a grant hides what a screen is, not that it exists');
    assert.equal(body.battery_level, 55, 'and the granted health fields travel');

    for (const denied of ['name', 'hardware_serial', 'ip_address', 'local_ip',
                          'playlist_name', 'screenshot_url']) {
      assert.ok(!(denied in body),
        `"${denied}" reached the parent under a health-only grant — filtering is at the wrong end`);
    }

    // ⚠️ Belt and braces: the serialised frame must not contain the values either, in case a future
    // projection nests them somewhere the key check would miss.
    const wire = JSON.stringify(hub.received[0].env);
    for (const secret of ['Reception', 'SN-77', '80.51.0.7', 'Autumn Promo']) {
      assert.ok(!wire.includes(secret), `"${secret}" appeared in the frame sent to the parent`);
    }
  } finally { up.stop(); await hub.close(); }
});

// ===== authorisation is not a handshake-only decision =====

test('⚠️ REVOKING AN EDGE STOPS A SOCKET THAT IS ALREADY OPEN', async () => {
  /*
   * A mesh socket is long-lived by design: a child dials its parent and stays. So an edge captured
   * at handshake means revocation does nothing until the child happens to reconnect — which may be
   * days. An operator revokes precisely when they have decided a peer should stop being trusted, and
   * "it takes effect at the next reconnect" is not a revoke.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { ok: true },
    });
    up.send(mk());
    await waitFor(() => hub.received.length === 1);

    // Revoked while the connection is up.
    hub.edge.revoked_at = Math.floor(Date.now() / 1000);

    up.send(mk());
    await waitFor(() => !up.connected, 4000);
    assert.equal(hub.received.length, 1, 'nothing was accepted after the revoke');
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ AN EXPIRED TOKEN IS ACTUALLY CHECKED — the column has to be SELECTed', async () => {
  /*
   * The real bug this guards: store.findEdgeByTokenHash did not select token_expires_at, so
   * edgeIsActive() saw `undefined`, its `typeof … === 'number'` gate skipped, and an expired edge
   * token authenticated forever. Every unit test passed because they build edge objects by hand
   * with the field present — only the production query omitted it.
   */
  const hub = await parent({ edgeOver: { token_expires_at: Math.floor(Date.now() / 1000) - 60 } });
  const up = child(hub).start();
  try {
    await waitFor(() => up.lastError, 4000);
    assert.match(up.lastError, /expired/i, 'and the child is told which of the two it was');
    assert.equal(up.connected, false);
  } finally { up.stop(); await hub.close(); }
});

test('the real store query loads every field edgeIsActive gates on', () => {
  /*
   * Read from the SOURCE rather than a hand-built row: the failure mode was a field the checker
   * reads and the query never returned, which no amount of testing edgeIsActive itself can catch.
   */
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/mesh/store.js'), 'utf8');
  const active = fs.readFileSync(require.resolve('../lib/mesh/pairing.js'), 'utf8')
    .match(/function edgeIsActive[\s\S]*?\n}/)[0];
  for (const field of ['revoked_at', 'token_expires_at']) {
    assert.ok(active.includes(field), `edgeIsActive should gate on ${field}`);
    for (const fn of ['findEdgeByTokenHash', 'reloadEdge']) {
      const body = src.match(new RegExp(`function ${fn}[\\s\\S]*?\\n}`))[0];
      assert.ok(body.includes(field), `${fn} must SELECT ${field} — it is gated on`);
    }
  }
});

// ===== the uplink buffer =====

test('⚠️ send() reports THIS envelope, not a running total', () => {
  /*
   * It used to `return this.dropped === 0`, so one drop at any point latched the return to false
   * forever and a caller counting on it reported loss on every later send that buffered fine.
   */
  const up = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n',
                          connect: () => ({ on() {}, close() {} }), bufferMax: 2, logger: quietLogger });
  assert.equal(up.send({ a: 1 }), true);
  assert.equal(up.send({ a: 2 }), true);
  assert.equal(up.send({ a: 3 }), false, 'this one evicted the oldest');
  assert.equal(up.buffer.length, 2, 'and the buffer stayed at its limit');
  assert.equal(up.dropped, 1);
});

test('⚠️ the RE-BUFFER path is bounded too', () => {
  /*
   * A parent that accepts connections but times out every emit sends everything back through
   * _requeue. Pushing directly there grew the buffer past its own limit — the exact condition the
   * limit exists for, since an observer's outage must never become the observed node's outage (I1).
   */
  const up = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n',
                          connect: () => ({ on() {}, close() {} }), bufferMax: 3, logger: quietLogger });
  for (let i = 0; i < 3; i++) up.send({ i });
  for (let i = 0; i < 100; i++) up._requeue({ requeued: i });
  assert.equal(up.buffer.length, 3, 'never grows past the limit however many come back');
  assert.equal(up.dropped, 100, 'and the loss is counted rather than hidden');
});
