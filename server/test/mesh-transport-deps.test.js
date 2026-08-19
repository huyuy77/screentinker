'use strict';

/*
 * The socket.io client is a PRODUCTION dependency, and the server and client can talk to each other.
 *
 * ⚠️ WHY THIS TEST EXISTS AT ALL. socket.io ships as two packages: `socket.io` is the server and
 * accepts connections; `socket.io-client` dials out. Until the mesh, this product only ever needed
 * the first — players dial in, and the server dials nothing. A child node dialling its parent is the
 * first outgoing socket in the codebase.
 *
 * `socket.io-client` was already in the tree as a DEV dependency, so `require()` succeeded on any
 * developer machine and in CI (which installs dev dependencies) while being absent from a production
 * `npm ci --omit=dev`. Transport code would have passed everything here and crashed on the first real
 * deploy — the same shape as the config-gated crash that took production down with 1676 tests green.
 *
 * So the first assertion is not about behaviour at all. It is that the dependency is declared in the
 * right section, because that is the part no amount of functional testing would have caught.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('node:http');

test('socket.io-client is a PRODUCTION dependency, not a dev one', () => {
  /*
   * ⚠️ Reads package.json rather than attempting a require. A require proves only that THIS tree has
   * it — which was true when it was dev-only, and was exactly the trap.
   */
  const pkg = require('../package.json');
  assert.ok(pkg.dependencies['socket.io-client'],
    'a child node dials its parent, so the client must survive `npm ci --omit=dev`');
  assert.ok(!(pkg.devDependencies || {})['socket.io-client'],
    'declared in both sections is ambiguous — production wins, so remove the dev entry');
});

test('the lockfile does not mark it dev-only', () => {
  // package.json can be right while the lock still carries `dev: true` from before the move, and it
  // is the LOCK that `npm ci` obeys.
  const lock = require('../package-lock.json');
  const entry = lock.packages['node_modules/socket.io-client'];
  assert.ok(entry, 'socket.io-client missing from the lockfile');
  assert.notEqual(entry.dev, true,
    'the lock still marks it dev-only, so a production install would omit it');
});

test('the server and client versions actually interoperate', async () => {
  /*
   * ⚠️ NOT a version-string comparison. socket.io's server and client are versioned independently
   * (4.7.x server against 4.8.x client here), and protocol compatibility is a property of the two
   * talking, not of their numbers matching. This opens a real connection and round-trips a message,
   * which is the only claim worth making.
   */
  const { Server } = require('socket.io');
  const { io: connect } = require('socket.io-client');

  const http = createServer();
  const server = new Server(http, { cors: { origin: '*' } });

  const port = await new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => resolve(http.address().port));
  });

  server.on('connection', (socket) => {
    socket.on('mesh:hello', (payload, ack) => {
      // The shape the mesh handshake will use: a node identifying itself and being acknowledged.
      if (typeof ack === 'function') ack({ ok: true, saw: payload.nodeId });
    });
  });

  const client = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });

  try {
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
      setTimeout(() => reject(new Error('timed out connecting')), 8000);
    });

    // ⚠️ An ACK round-trip, not a fire-and-forget emit. A one-way emit can appear to succeed against
    // a server that never understood it; the mesh handshake needs the parent's answer, so that is
    // what gets proven here.
    const reply = await new Promise((resolve, reject) => {
      client.timeout(5000).emit('mesh:hello', { nodeId: 'node-under-test' }, (err, res) => {
        if (err) reject(err); else resolve(res);
      });
    });

    assert.deepEqual(reply, { ok: true, saw: 'node-under-test' },
      'server and client must round-trip an acknowledged message');
  } finally {
    client.close();
    server.close();
    await new Promise((r) => http.close(r));
  }
});

test('the client carries no native code', () => {
  /*
   * The BrightSign payload builder REFUSES any .node binary, because the package must run unchanged
   * on aarch64. A dependency that pulled one in would not fail here — it would fail at package time,
   * with a message about the player rather than about this dependency.
   */
  const fs = require('node:fs');
  const roots = ['socket.io-client', 'engine.io-client', 'engine.io-parser', 'socket.io-parser'];
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.node')) found.push(full);
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', 'node_modules', r));
  assert.deepEqual(found, [], 'a native binary here would break the BrightSign player package');
});
