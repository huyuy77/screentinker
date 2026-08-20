'use strict';

/*
 * Mesh reads on a worker thread, and the same reads without one.
 *
 * ⚠️ THE PROPERTY THAT MATTERS IS THAT THE TWO AGREE. A fallback that answers slightly differently
 * is worse than no fallback: the path nobody develops on is the one that is wrong, and it is wrong
 * only in the field — on BrightSign, where a patched Node may have no worker_threads at all and
 * where nobody is watching a console.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const nodeData = require('../lib/mesh/node-data');
const { createReadRunner, workerThreadsAvailable } = require('../lib/mesh/read-runner');

const NOW = Math.floor(Date.now() / 1000);
const quiet = { log() {}, warn() {}, error() {} };

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshread-'));
  const file = path.join(dir, 'r.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_heartbeat INTEGER,
      app_version TEXT, platform TEXT, client_type TEXT, workspace_id TEXT, playlist_id TEXT,
      layout_id TEXT, created_at INTEGER);
    CREATE TABLE device_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT,
      battery_level INTEGER, battery_charging INTEGER, storage_free_mb INTEGER,
      storage_total_mb INTEGER, ram_free_mb INTEGER, ram_total_mb INTEGER, cpu_usage REAL,
      wifi_rssi INTEGER, uptime_seconds INTEGER, local_ip TEXT, local_ip6 TEXT,
      attached_display TEXT, video_mode TEXT, temperature_c REAL, reported_at INTEGER);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT, status TEXT, published_snapshot TEXT,
      workspace_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT,
      content_id TEXT, widget_id TEXT, zone_id TEXT, sort_order INTEGER, duration_sec INTEGER,
      muted INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE content (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, duration_sec INTEGER);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, widget_type TEXT);
    CREATE TABLE device_groups (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT);
  `);

  db.prepare(`INSERT INTO devices (id,name,status,last_heartbeat,workspace_id,playlist_id,created_at)
              VALUES ('d1','Lobby','online',?, 'w1','pl1',?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO devices (id,name,status,last_heartbeat,workspace_id,created_at)
              VALUES ('d2','Elsewhere','offline',?, 'w2',?)`).run(NOW - 900, NOW);
  db.prepare(`INSERT INTO device_telemetry (device_id,storage_free_mb,cpu_usage,uptime_seconds,reported_at)
              VALUES ('d1',4096,12.5,7200,?)`).run(NOW);
  db.prepare("INSERT INTO playlists VALUES ('pl1','Store Loop','published',NULL,'w1',?,?)").run(NOW, NOW);
  db.prepare("INSERT INTO content VALUES ('c1','Welcome.mp4','video/mp4',18)").run();
  db.prepare(`INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec,created_at,updated_at)
              VALUES ('pl1','c1',0,18,?,?)`).run(NOW, NOW);

  db.__dir = dir;
  db.__file = file;
  return db;
}
const cleanup = (db) => {
  try { db.close(); } catch (e) { /* closed */ }
  try { fs.rmSync(db.__dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
};

const edge = (over = {}) => ({
  id: 'e1', peer_node_id: 'child', direction: 'up',
  grant_categories: JSON.stringify(['health', 'identity', 'content-metadata']),
  shared_workspaces: null, revoked_at: null, ...over,
});

test('⚠️ THE WORKER AND THE FALLBACK RETURN THE SAME ANSWER', async () => {
  /*
   * The property the whole design rests on. Both paths call the identical function; the moment they
   * can disagree, the one nobody develops on is wrong and is wrong only in the field.
   */
  const db = freshDb();
  const withWorker = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const withoutWorker = createReadRunner({
    dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const p of ['/api/devices', '/api/devices/d1', '/api/playlists', '/api/devices/d1/telemetry']) {
      const req = { path: p, method: 'GET' };
      const [a, b] = await Promise.all([withWorker.run(edge(), req), withoutWorker.run(edge(), req)]);

      /*
       * ⚠️ COMPARED AS DELIVERED, which is JSON over a socket — and the distinction is not pedantry,
       * it caught a genuine difference between the two sqlite drivers.
       *
       * `node:sqlite` returns rows with a NULL PROTOTYPE; better-sqlite3 returns ordinary objects.
       * postMessage's structured clone normalises them, so the worker path yields plain objects and
       * the inline path yields null-prototype ones — deepEqual distinguishes those, and the raw
       * comparison failed on the fallback driver only.
       *
       * Neither survives the wire: both serialise to the same bytes, and `undefined` values are
       * dropped by JSON identically. So the property worth guarding is that what the PARENT receives
       * is the same, not that two in-memory representations share a prototype.
       */
      /*
       * ⚠️ EXCEPT `asOf`, WHICH IS ALLOWED TO DIFFER — and comparing it exactly is a test bug I
       * shipped. Each path stamps its own generation time, which is correct: they are two separate
       * computations. An exact comparison therefore fails whenever the two straddle a second
       * boundary — locally almost never, in CI often enough to block a release.
       *
       * The property is that the same QUESTION yields the same DATA, so the timestamps are checked
       * for being close rather than equal. "Re-run it" would have been the wrong response to this.
       */
      const strip = (r) => JSON.stringify({ ...r, asOf: undefined });
      assert.equal(strip(a), strip(b), `${p} must be identical on both paths, as delivered`);
      if (a.asOf !== undefined) {
        assert.ok(Math.abs(a.asOf - b.asOf) <= 2,
          `${p}: the two paths stamped times ${Math.abs(a.asOf - b.asOf)}s apart`);
      }
      assert.equal(a.ok, true, `${p} should have answered`);
    }
  } finally { withWorker.stop(); withoutWorker.stop(); cleanup(db); }
});

test('the fallback runner reports itself as inline, and still answers', async () => {
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    assert.equal(r.mode, 'inline');
    const answer = await r.run(edge(), { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, true);
    assert.equal(answer.rows.length, 2);
  } finally { r.stop(); cleanup(db); }
});

test('a worker runs on this platform, and says so', async () => {
  // ⚠️ Skipped rather than failed where the module is absent — that is the BrightSign case, and it
  // is a supported configuration, not a broken one.
  if (!workerThreadsAvailable()) return;
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  try {
    assert.equal(r.mode, 'worker');
    const answer = await r.run(edge(), { path: '/api/devices/d1', method: 'GET' });
    assert.equal(answer.ok, true);
    assert.equal(answer.row.name, 'Lobby');
    assert.equal(answer.row.telemetry.length, 1, 'the composite shape survives the thread hop');
    assert.equal(answer.row.assignments.length, 1);
  } finally { r.stop(); cleanup(db); }
});

test('⚠️ the WORKSPACE SCOPE is applied on both paths', async () => {
  // A scope that held only on the main thread would be no scope at all once the worker was the
  // normal path — and the worker is the path that runs in production.
  const db = freshDb();
  const scoped = edge({ shared_workspaces: JSON.stringify(['w1']) });
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const list = await r.run(scoped, { path: '/api/devices', method: 'GET' });
      assert.deepEqual(list.rows.map((d) => d.id), ['d1'], 'the other workspace never travels');
      const other = await r.run(scoped, { path: '/api/devices/d2', method: 'GET' });
      assert.equal(other.ok, false, 'and cannot be reached by id either');
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('⚠️ the GRANT is applied on both paths', async () => {
  const db = freshDb();
  const healthOnly = edge({ grant_categories: JSON.stringify(['health']) });
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const one = await r.run(healthOnly, { path: '/api/devices/d1', method: 'GET' });
      assert.equal(one.ok, true);
      assert.equal(one.row.name, undefined, 'a health-only edge learns no names');
      assert.deepEqual(one.row.assignments, [], 'and no content');
      const pl = await r.run(healthOnly, { path: '/api/playlists', method: 'GET' });
      assert.equal(pl.ok, false, 'playlists need content-metadata');
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('a write is refused on both paths', async () => {
  const db = freshDb();
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const res = await r.run(edge(), { path: '/api/devices/d1', method: 'DELETE' });
      assert.equal(res.ok, false);
      assert.match(res.reason, /can read, and cannot write/);
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('⚠️ a dead worker falls back instead of hanging', async () => {
  /*
   * In-flight reads must be ANSWERED when the worker dies, not left pending. Leaving them would
   * hang the parent until its own timeout, and an operator watching a spinner concludes the product
   * is broken — a worse outcome than the slow path.
   */
  if (!workerThreadsAvailable()) return;
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  try {
    assert.equal(r.mode, 'worker');
    r.stop();                       // the worker is gone
    assert.equal(r.mode, 'inline', 'and the runner says so');
    const answer = await r.run(edge(), { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, true, 'reads keep working');
  } finally { cleanup(db); }
});

test('the worker opens the database READ-ONLY', () => {
  /*
   * ⚠️ Makes "the read path cannot write" a property of the file descriptor rather than of the code
   * above it: a bug in a projection produces SQLITE_READONLY instead of a silent mutation on a
   * customer's server.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'read-worker.js'), 'utf8');
  assert.match(src, /new Database\(workerData\.dbPath, \{ readonly: true \}\)/);
});

test('⚠️ the platform is not sniffed — the capability is TRIED', () => {
  /*
   * BrightSign runs a patched Node whose capabilities do not follow from its version, so a check
   * like "is this BrightSign" is wrong in both directions the moment either side changes: a future
   * OS that gains workers stays slow forever, and a platform nobody thought of crashes.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'read-runner.js'), 'utf8');
  /*
   * ⚠️ Comments stripped first. The file EXPLAINS why it does not sniff, and naming the platform in
   * that explanation would fail a test asserting the platform is not named — which is how a correct
   * guard gets deleted for being "wrong".
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /brightsign|BrightSign|process\.platform ===/, 'no platform sniffing');
  assert.match(src, /require\('node:worker_threads'\)/);
  assert.match(src, /require\('worker_threads'\)/, 'and the unprefixed name is tried too');
  assert.match(src, /catch \(e\) \{[\s\S]{0,400}mode = 'inline'/,
    'constructing one either works or it does not');
});
