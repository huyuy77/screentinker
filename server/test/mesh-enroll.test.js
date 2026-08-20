'use strict';

/*
 * Enrollment as an operator actually reaches it.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE PHASE 1 WAS MARKED COMPLETE WITHOUT IT. Pairing, validation, transport
 * and storage were all built and thoroughly tested as modules, and nothing ever called them from an
 * HTTP surface — no route minted a code, none redeemed one, and no production code ever constructed
 * an Uplink. Every unit test passed and two servers could not be connected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Database } = require('../db/sqlite-driver');
const meshEnroll = require('../routes/mesh-enroll');
const pairing = require('../lib/mesh/pairing');

const NOW = Math.floor(Date.now() / 1000);

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-'));
  const db = new Database(path.join(dir, 'e.db'));
  db.exec(`
    CREATE TABLE mesh_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      node_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, self_device_id TEXT,
      node_name TEXT);
    CREATE TABLE mesh_edges (id TEXT PRIMARY KEY, peer_node_id TEXT NOT NULL, direction TEXT NOT NULL,
      role_capabilities TEXT DEFAULT '[]', grant_categories TEXT DEFAULT '[]',
      transport_direction TEXT, retention_days INTEGER, tombstone_purge_days INTEGER,
      tls_verify INTEGER DEFAULT 1, peer_version TEXT, peer_min_version TEXT, token_hash TEXT,
      token_expires_at INTEGER, client_id TEXT, created_at INTEGER, last_sync_at INTEGER,
      revoked_at INTEGER, peer_url TEXT, up_token TEXT, peer_name TEXT,
      shared_workspaces TEXT, UNIQUE (peer_node_id, direction));
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE mesh_pairing_codes (id TEXT PRIMARY KEY, code TEXT NOT NULL,
      role_capabilities TEXT DEFAULT '[]', grant_categories TEXT DEFAULT '[]', client_id TEXT,
      retention_days INTEGER, created_by TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, burned_at INTEGER, burned_by_node TEXT);
  `);
  db._dir = dir;
  return db;
}
const cleanup = (db) => { try { db.close(); } catch {} fs.rmSync(db._dir, { recursive: true, force: true }); };

const CONFIG = {
  meshAcceptEnrollment: true, meshAllowUplink: true,
  meshMaxDepth: 2, meshMinNodeVersion: '2.0.0-0',
};

async function serve(db, user, config = CONFIG) {
  const app = express();
  app.use(express.json());
  app.use('/api/mesh', meshEnroll(db, {
    requireAuth: (req, _res, next) => { req.user = user; next(); },
    config,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const owner = { id: 'u1', role: 'platform_admin' };
const tech = { id: 'u2', role: 'user' };

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

test('an operator can mint a code and a node can redeem it', async () => {
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code',
      { grant: ['health', 'identity'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    assert.match(mint.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/, 'readable aloud');
    assert.ok(Array.isArray(mint.grantDescription) && mint.grantDescription.length,
      'and it says in words what it will hand over');

    const red = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: 'child-1', version: '2.0.0-alpha0', ancestry: ['child-1'] })
      .then((r) => r.json());
    assert.ok(red.edgeToken, 'the child gets a durable token');
    assert.deepEqual(red.grant, ['health', 'identity']);

    const edge = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down'").get();
    // ⚠️ The parent stores a HASH. It only ever verifies, so keeping the plaintext would turn a
    // leaked database into standing access to a client's data.
    assert.equal(edge.token_hash, pairing.hashEdgeToken(red.edgeToken));
    assert.ok(!JSON.stringify(edge).includes(red.edgeToken), 'the plaintext is nowhere in the row');
  } finally { await close(); cleanup(db); }
});

test('⚠️ THE CODE IS STORED NORMALISED, so a redemption can actually find it', async () => {
  /*
   * mintPairingCode() returns a hyphenated display form and normalizeCode() strips everything that
   * is not alphanumeric, so an operator can retype it however they like. Storing the display form
   * meant the lookup never matched and every redemption answered "that code is not valid" about a
   * code minted seconds earlier — a bug that only shows up end to end.
   */
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const stored = db.prepare('SELECT code FROM mesh_pairing_codes').get().code;
    assert.equal(stored, pairing.normalizeCode(mint.code));
    assert.ok(!stored.includes('-'), 'stored without the display hyphen');

    // Typed back in any of the ways a human might.
    for (const typed of [mint.code, mint.code.toLowerCase(), mint.code.replace('-', ' ')]) {
      const r = await post(base, '/api/mesh/pair/redeem',
        { code: typed, nodeId: `c-${Math.random()}`, version: '2.0.0', ancestry: [] });
      const j = await r.json();
      // The first succeeds; later ones fail because it BURNED, never because it was unfindable.
      if (r.ok) assert.ok(j.edgeToken);
      else assert.match(j.error, /already been used|used once/);
    }
  } finally { await close(); cleanup(db); }
});

test('⚠️ A CODE IS SINGLE-USE, and burning is in the same transaction as the edge', async () => {
  /*
   * Burned separately, two nodes redeeming in the same instant both pass the burned check and both
   * get an edge — single-use enforced everywhere except under the concurrency it exists to prevent.
   */
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const first = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: 'child-1', version: '2.0.0', ancestry: [] });
    assert.equal(first.status, 200);

    const second = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: 'child-2', version: '2.0.0', ancestry: [] });
    assert.equal(second.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM mesh_edges WHERE direction='down'").get().c, 1);
    assert.ok(db.prepare('SELECT burned_at FROM mesh_pairing_codes').get().burned_at);
  } finally { await close(); cleanup(db); }
});

test('an expired code is refused, and says why in a way that can be acted on', async () => {
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    db.prepare('UPDATE mesh_pairing_codes SET expires_at = ?').run(NOW - 10);
    const r = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: 'child-1', version: '2.0.0', ancestry: [] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /expire/i);
  } finally { await close(); cleanup(db); }
});

test('⚠️ THE GRANT COMES FROM THE CODE, never from the node redeeming it', async () => {
  /*
   * The hub operator decides what a code will grant before handing it over. If the redeemer could
   * ask, whoever held a code could request everything and a five-minute expiry would be the only
   * thing between a stranger and a client's content library.
   */
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const red = await post(base, '/api/mesh/pair/redeem', {
      code: mint.code, nodeId: 'child-1', version: '2.0.0', ancestry: [],
      // Asking nicely for everything.
      grant: ['health', 'identity', 'display-capture', 'proof-of-play', 'network-wan'],
      capabilities: ['accepts-enrollment'],
    }).then((r) => r.json());
    assert.deepEqual(red.grant, ['health'], 'exactly what the code said, nothing more');
  } finally { await close(); cleanup(db); }
});

test('a node below the version floor is refused, and a 2.0.0 prerelease is NOT', async () => {
  // ⚠️ The second half is the point: a prerelease sorts below its own release, so a floor of
  // "2.0.0" would refuse every 2.0.0-alpha node, including one running identical code.
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const old = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const refused = await post(base, '/api/mesh/pair/redeem',
      { code: old.code, nodeId: 'c-old', version: '1.9.39', ancestry: [] });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /1\.9\.39/);

    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const ok = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: 'c-alpha', version: '2.0.0-alpha0', ancestry: [] });
    assert.equal(ok.status, 200, 'an alpha node pairs with an alpha node');
  } finally { await close(); cleanup(db); }
});

test('⚠️ minting is instance-owner-only; enrolling follows what you administer', async () => {
  /*
   * Two different acts. ACCEPTING an observer exposes whatever the code grants and is therefore an
   * instance-level decision. REPORTING UPWARD exposes only what the person doing it administers, so
   * a workspace owner putting their own workspace under an MSP's hub should not need the instance
   * owner to broker it — requiring that just means it gets done by sharing an admin login instead.
   */
  const db = freshDb();
  const { base, close } = await serve(db, tech);
  try {
    assert.equal((await post(base, '/api/mesh/pair/code',
      { grant: ['health'], capabilities: ['consumes-telemetry'] })).status, 403,
      'a technician cannot hand out a pairing code');

    // …and with no workspaces of their own, there is nothing they could report upward either.
    const r = await post(base, '/api/mesh/uplink', { parentUrl: 'https://x', code: 'AAAAA-BBBBB' });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /do not administer any workspace/);
  } finally { await close(); cleanup(db); }
});

test('the parent URL is validated before it becomes an outbound dial target', async () => {
  // ⚠️ It is a request from inside the operator's network to an address they typed, so an
  // unvalidated value is a forgery primitive aimed at whatever this server can reach.
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    for (const bad of ['file:///etc/passwd', 'not a url', 'ftp://x/', 'https://u:p@host/']) {
      const r = await post(base, '/api/mesh/uplink', { parentUrl: bad, code: 'AAAAA-BBBBB' });
      assert.equal(r.status, 400, `${bad} should be refused`);
    }
  } finally { await close(); cleanup(db); }
});

test('⚠️ CONSENT FROM BELOW is readable even with both flags off', async () => {
  /*
   * A node that HAS a parent must always be able to show its operator that it does and sever it. The
   * one configuration where an MSP link must not become invisible is the one where somebody turned
   * the flag off after making it.
   */
  const db = freshDb();
  db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,grant_categories,transport_direction,
              created_at,peer_url,up_token) VALUES ('e1','parent-1','up','["health"]','we-dial',?,?,?)`)
    .run(NOW, 'https://hub.example', 'secret-token');
  const { base, close } = await serve(db, owner,
    { ...CONFIG, meshAcceptEnrollment: false, meshAllowUplink: false });
  try {
    const r = await fetch(`${base}/api/mesh/uplink`).then((x) => x.json());
    assert.equal(r.uplinks.length, 1);
    assert.equal(r.uplinks[0].parentNodeId, 'parent-1');
    assert.equal(r.canEnroll, false, 'while still saying it cannot make new ones');
    assert.ok(!JSON.stringify(r).includes('secret-token'), 'and never echoes the token');

    const sever = await fetch(`${base}/api/mesh/uplink/e1`, { method: 'DELETE' }).then((x) => x.json());
    assert.ok(sever.ok, 'severing works with the flag off — it must never be able to strand a node');
    const after = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get('e1');
    assert.ok(after.revoked_at);
    assert.equal(after.up_token, null, 'and the secret is dropped once it is useless');
    assert.match(sever.note, /already sent is still held/, 'and it says what severing does NOT undo');
  } finally { await close(); cleanup(db); }
});

test('a node cannot enroll with itself', async () => {
  const db = freshDb();
  const { base, close } = await serve(db, owner);
  try {
    const mint = await post(base, '/api/mesh/pair/code', { grant: ['health'], capabilities: ['consumes-telemetry'] }).then((r) => r.json());
    const r = await post(base, '/api/mesh/pair/redeem',
      { code: mint.code, nodeId: mint.nodeId, version: '2.0.0', ancestry: [] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /cannot enroll with itself/);
  } finally { await close(); cleanup(db); }
});

/* ===================== which workspaces travel up ===================== */

function seedWorkspaces(db) {
  db.prepare("INSERT INTO organizations VALUES ('o1','Acme')").run();
  for (const [id, name] of [['w1', 'Retail'], ['w2', 'Corporate'], ['w3', 'Someone Else']]) {
    db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(id, 'o1', name);
  }
  // The technician administers two of the three.
  db.prepare("INSERT INTO workspace_members VALUES ('m1','w1','u2','admin')").run();
  db.prepare("INSERT INTO workspace_members VALUES ('m2','w2','u2','owner')").run();
}

test('⚠️ ONLY THE INSTANCE OWNER CAN SHARE EVERY WORKSPACE', () => {
  /*
   * "All" includes workspaces that do not exist yet, which is a standing grant over things nobody
   * has decided about. A member choosing it would be handing away a colleague's future workspace.
   */
  const db = freshDb();
  seedWorkspaces(db);
  return serve(db, tech).then(async ({ base, close }) => {
    try {
      const r = await fetch(`${base}/api/mesh/shareable-workspaces`).then((x) => x.json());
      assert.equal(r.canShareAll, false, 'a technician may not');
      assert.deepEqual(r.workspaces.map((w) => w.id).sort(), ['w1', 'w2'],
        'and sees only the workspaces they administer');
    } finally { await close(); }
  }).finally(() => cleanup(db));
});

test('the instance owner sees every workspace and may share all', () => {
  const db = freshDb();
  seedWorkspaces(db);
  return serve(db, owner).then(async ({ base, close }) => {
    try {
      const r = await fetch(`${base}/api/mesh/shareable-workspaces`).then((x) => x.json());
      assert.equal(r.canShareAll, true);
      assert.deepEqual(r.workspaces.map((w) => w.id).sort(), ['w1', 'w2', 'w3']);
    } finally { await close(); }
  }).finally(() => cleanup(db));
});

test('⚠️ SHARING A WORKSPACE YOU DO NOT ADMINISTER IS REFUSED, not silently trimmed', async () => {
  /*
   * Trimming would leave the operator believing they shared something they did not, and they would
   * find out when a report came back empty — long after the pairing conversation ended.
   */
  const db = freshDb();
  seedWorkspaces(db);
  const { base, close } = await serve(db, tech);
  try {
    const r = await post(base, '/api/mesh/uplink', {
      parentUrl: 'https://hub.example', code: 'AAAAA-BBBBB',
      workspaceIds: ['w1', 'w3'],
    });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /do not administer/);
  } finally { await close(); cleanup(db); }
});

test('a technician asking to share ALL is refused', async () => {
  const db = freshDb();
  seedWorkspaces(db);
  const { base, close } = await serve(db, tech);
  try {
    const r = await post(base, '/api/mesh/uplink',
      { parentUrl: 'https://hub.example', code: 'AAAAA-BBBBB', shareAllWorkspaces: true });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /instance owner/);
  } finally { await close(); cleanup(db); }
});

test('sharing nothing at all is refused rather than treated as everything', async () => {
  /*
   * ⚠️ THE FAILURE THIS PREVENTS IS THE WORST ONE AVAILABLE. null means "all workspaces" in the
   * column, so an empty selection quietly becoming null would turn "I picked none" into "I shared
   * every one, forever, including future ones" — opposite outcomes, one keystroke apart.
   */
  const db = freshDb();
  seedWorkspaces(db);
  const { base, close } = await serve(db, tech);
  try {
    const r = await post(base, '/api/mesh/uplink',
      { parentUrl: 'https://hub.example', code: 'AAAAA-BBBBB', workspaceIds: [] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /at least one workspace/);
  } finally { await close(); cleanup(db); }
});
