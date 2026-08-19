'use strict';

/*
 * The hub API over mirrored state.
 *
 * ⚠️ THE TWO PROPERTIES THAT MATTER MOST ARE BOTH ABOUT ABSENCE:
 *
 *   1. With the flag off there are NO routes — not routes returning empty, no routes. A 404 from a
 *      route that exists still tells a prober the mesh is compiled in.
 *   2. There is no write route, because 2.0 has no downward channel (I2). That is the absence of a
 *      mechanism rather than restraint being exercised, and it is what makes "the hub cannot change
 *      what plays on your screens" a fact rather than a promise.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Database } = require('../db/sqlite-driver');
const meshRoutes = require('../routes/mesh');

const NOW = Math.floor(Date.now() / 1000);

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubapi-'));
  const db = new Database(path.join(dir, 'h.db'));
  db.exec(`
    CREATE TABLE mesh_clients (id TEXT PRIMARY KEY, name TEXT, notes TEXT,
      parent_client_id TEXT, created_at INTEGER);
    CREATE TABLE mesh_client_access (client_id TEXT, user_id TEXT, role TEXT DEFAULT 'viewer',
      granted_at INTEGER, granted_by TEXT, PRIMARY KEY (client_id, user_id));
    CREATE TABLE mesh_edges (id TEXT PRIMARY KEY, peer_node_id TEXT, direction TEXT,
      role_capabilities TEXT DEFAULT '[]', grant_categories TEXT DEFAULT '[]',
      transport_direction TEXT, retention_days INTEGER, tombstone_purge_days INTEGER,
      tls_verify INTEGER DEFAULT 1, peer_version TEXT, peer_min_version TEXT,
      token_hash TEXT, token_expires_at INTEGER, client_id TEXT,
      created_at INTEGER, last_sync_at INTEGER, revoked_at INTEGER, peer_url TEXT);
    CREATE TABLE mesh_mirror_nodes (origin_node_id TEXT PRIMARY KEY, via_edge_id TEXT,
      node_version TEXT, device_count INTEGER, devices_online INTEGER, origin_ts INTEGER,
      received_at INTEGER, stale_since INTEGER);
    CREATE TABLE mesh_mirror_devices (origin_node_id TEXT, device_id TEXT, name TEXT, status TEXT,
      last_heartbeat INTEGER, body TEXT DEFAULT '{}', origin_ts INTEGER, received_at INTEGER,
      deleted_at INTEGER, PRIMARY KEY (origin_node_id, device_id));
    CREATE TABLE mesh_mirror_alerts (id TEXT PRIMARY KEY, origin_node_id TEXT, alert_type TEXT,
      severity TEXT, subject_count INTEGER, subjects TEXT, opened_at INTEGER, closed_at INTEGER,
      origin_ts INTEGER, received_at INTEGER);
    CREATE TABLE alert_events (id TEXT PRIMARY KEY, rule_id TEXT, device_id TEXT, workspace_id TEXT,
      metric TEXT, severity TEXT, opened_at INTEGER, closed_at INTEGER, opened_value REAL,
      peak_value REAL, closed_value REAL, notified_at INTEGER);
  `);
  db._dir = dir;
  return db;
}
const cleanup = (db) => { try { db.close(); } catch {} fs.rmSync(db._dir, { recursive: true, force: true }); };

/** Stand the router up with a fixed user. */
async function serve(db, user) {
  const app = express();
  app.use('/api/mesh', meshRoutes(db, {
    requireAuth: (req, _res, next) => { req.user = user; next(); },
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const seed = (db) => {
  db.prepare("INSERT INTO mesh_clients VALUES ('acme','Acme',NULL,NULL,?)").run(NOW);
  db.prepare("INSERT INTO mesh_clients VALUES ('contoso','Contoso',NULL,NULL,?)").run(NOW);
  db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at,grant_categories,peer_url)
              VALUES ('e-a','node-acme','down','acme',?,'["health","identity"]','https://acme.example')`).run(NOW - 20);
  db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at,grant_categories)
              VALUES ('e-c','node-contoso','down','contoso',?,'["health"]')`).run(NOW - 20);
  db.prepare("INSERT INTO mesh_mirror_devices VALUES ('node-acme','d1','Acme Lobby','online',?, '{}',?,?,NULL)")
    .run(NOW - 30, NOW - 30, NOW - 30);
  db.prepare("INSERT INTO mesh_mirror_devices VALUES ('node-contoso','d2','Contoso Foyer','online',?, '{}',?,?,NULL)")
    .run(NOW - 30, NOW - 30, NOW - 30);
};

const tech = { id: 'u-tech', role: 'user' };
const admin = { id: 'u-admin', role: 'platform_admin' };

test('⚠️ SCOPING: a tech named on Acme sees Acme and NOT Contoso', () => {
  /*
   * The property a client's security review actually asks about. Note this is enforced by never
   * SELECTING the other client's rows — a route that fetched everything and filtered afterwards
   * leaks the moment somebody adds a count or a total to the response, which is the classic shape
   * of this bug.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    return serve(db, tech).then(async ({ base, close }) => {
      try {
        const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
        assert.equal(r.total, 1, 'exactly one client\'s screens');
        assert.equal(r.devices[0].originNodeId, 'node-acme');
        assert.ok(!JSON.stringify(r).includes('Contoso'),
          'no trace of the other client anywhere in the response, including counts');
      } finally { await close(); }
    });
  } finally { setTimeout(() => cleanup(db), 100); }
});

test('⚠️ an UNFILED edge is visible to platform_admin only', async () => {
  /*
   * A node paired before anybody organised it into clients must not be readable by every technician.
   * "We hadn't got round to filing it yet" is not a defence in a security review, so the default is
   * admin-only rather than everyone.
   */
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at)
                VALUES ('e-x','node-orphan','down',NULL,?)`).run(NOW - 10);
    db.prepare("INSERT INTO mesh_mirror_devices VALUES ('node-orphan','d9','Orphan','online',?, '{}',?,?,NULL)")
      .run(NOW - 10, NOW - 10, NOW - 10);

    let s = await serve(db, tech);
    let r = await fetch(`${s.base}/api/mesh/devices`).then((x) => x.json());
    assert.equal(r.total, 0, 'a tech sees nothing of an unfiled node');
    await s.close();

    s = await serve(db, admin);
    r = await fetch(`${s.base}/api/mesh/devices`).then((x) => x.json());
    assert.equal(r.total, 1, 'the instance owner does');
    await s.close();
  } finally { cleanup(db); }
});

test('⚠️ every device row carries its tri-state status and as-of age', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
      const d = r.devices[0];
      assert.equal(d.status, 'live');
      assert.ok(typeof d.asOfAgeSec === 'number', 'the age is on every row, not only stale ones');
      // ⚠️ The origin node is its OWN field. Folding it into the name ("Lobby (Acme)") breaks sort
      // and search for every row at once, and is very hard to undo once customers read it that way.
      assert.equal(d.originNodeId, 'node-acme');
      assert.equal(d.name, 'Acme Lobby', 'the name is unmodified');
      assert.equal(d.deepLink, 'https://acme.example/#/devices/d1');
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('a stale link reports the screens as stale, not down', async () => {
  // The whole point of the tri-state, over the wire this time.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("UPDATE mesh_edges SET last_sync_at = ? WHERE id = 'e-a'").run(NOW - 7200);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
      assert.equal(r.devices[0].status, 'stale');
      assert.match(r.devices[0].explain, /check the connection to the site before the screen/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('the empty search result explains itself', async () => {
  /*
   * ⚠️ A health-only grant stores no device name, so those screens cannot be found by name. Without
   * saying so the result reads as a broken search, and the "fix" somebody reaches for is widening
   * the grant — the exact outcome the grant vocabulary exists to avoid.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices?search=nothing`).then((x) => x.json());
      assert.equal(r.total, 0);
      assert.match(r.searchNote, /health-only grant/i);
      assert.match(r.searchNote, /found by id/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('pagination is bounded no matter what the caller asks for', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices?limit=100000`).then((x) => x.json());
      assert.ok(r.limit <= 200, `limit should be capped, got ${r.limit}`);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('the node rollup hides the online count when the link is stale', async () => {
  // Zero is a measurement; "we cannot see" is not, and 0/40 tells an operator the site is dark.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("UPDATE mesh_edges SET last_sync_at = ? WHERE id = 'e-a'").run(NOW - 7200);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/nodes`).then((x) => x.json());
      assert.equal(r.nodes[0].devicesOnline, null);
      assert.equal(r.nodes[0].devicesTotal, 1, 'the last known inventory is still shown');
      assert.equal(r.nodes[0].stale, true);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ THERE IS NO WRITE ROUTE (I2)', () => {
  /*
   * Asserted against the SOURCE, because the value here is absence. A behavioural test can only show
   * that the routes somebody thought to try did not write; this shows there is nothing to call.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mesh.js'), 'utf8');
  for (const verb of ['router.post', 'router.put', 'router.patch', 'router.delete']) {
    assert.ok(!src.includes(verb),
      `${verb} exists in the hub API — 2.0 has no downward channel to write over`);
  }
});

test('the uptime report is bucketed in the ORIGIN zone and says so', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(
        `${base}/api/mesh/uptime?tz=America/Chicago&originTz=Australia/Perth`).then((x) => x.json());
      assert.equal(r.timezone, 'Australia/Perth', 'a report follows the site, not the reader');
      assert.match(r.timezoneLabel, /site's local zone/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});
