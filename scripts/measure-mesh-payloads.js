'use strict';

/*
 * What the mesh actually puts on the wire, measured — not estimated.
 *
 * Builds a synthetic node of N screens, generates the REAL envelopes the reporting loop and the
 * read proxy would send (same projections, same envelope builder), and measures:
 *   - raw JSON bytes, per message and per full report cycle
 *   - deflate / gzip / brotli, applied PER MESSAGE (what permessage-deflate does)
 *   - the same payloads BATCHED into one message, then compressed
 *
 * The per-message vs batched split is the point: socket.io compresses each frame on its own, and a
 * compressor with no history to work from does very little on a 300-byte object.
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Run with:  node scripts/measure-mesh-payloads.js       (needs Node 22+ for better-sqlite3)
 *
 * Kept in the repo so the numbers behind the batching decision can be re-derived rather than
 * remembered. A measurement quoted in a commit message ages; one that can be re-run does not.
 */

const SERVER = path.join(__dirname, '..', 'server');
const { Database } = require(path.join(SERVER, 'db/sqlite-driver'));
const nodeData = require(path.join(SERVER, 'lib/mesh/node-data'));
const envelope = require(path.join(SERVER, 'lib/mesh/envelope'));

const NOW = Math.floor(Date.now() / 1000);
const FLEETS = [5, 40, 400];
const GRANT = ['health', 'identity', 'content-metadata', 'display'];

function buildDb(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmeasure-'));
  const db = new Database(path.join(dir, 'm.db'));
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_heartbeat INTEGER,
      app_version TEXT, platform TEXT, client_type TEXT, workspace_id TEXT, playlist_id TEXT,
      layout_id TEXT, orientation TEXT, screen_width INTEGER, screen_height INTEGER,
      created_at INTEGER);
    CREATE TABLE device_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT,
      battery_level INTEGER, battery_charging INTEGER, storage_free_mb INTEGER,
      storage_total_mb INTEGER, ram_free_mb INTEGER, ram_total_mb INTEGER, cpu_usage REAL,
      wifi_rssi INTEGER, uptime_seconds INTEGER, local_ip TEXT, local_ip6 TEXT,
      attached_display TEXT, video_mode TEXT, temperature_c REAL, reported_at INTEGER);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT, status TEXT, published_snapshot TEXT,
      workspace_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT,
      content_id TEXT, widget_id TEXT, zone_id TEXT, sort_order INTEGER, duration_sec INTEGER,
      muted INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE content (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, duration_sec INTEGER);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, widget_type TEXT);
    CREATE TABLE device_groups (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT);
    CREATE TABLE alert_events (id TEXT PRIMARY KEY, rule_id TEXT, device_id TEXT, workspace_id TEXT,
      metric TEXT, severity TEXT, opened_at INTEGER, closed_at INTEGER);
  `);
  db.prepare("INSERT INTO organizations VALUES ('o1','Acme Retail Group')").run();
  db.prepare("INSERT INTO workspaces VALUES ('w1','o1','Acme Retail Stores')").run();
  db.prepare("INSERT INTO playlists VALUES ('pl1','Store Front Loop','published',NULL,'w1',?,?)")
    .run(NOW, NOW);

  const plats = ['Android TV', 'BrightSign XT245', 'Fire TV Stick', 'Chrome', 'Raspberry Pi 5'];
  const ins = db.prepare(`INSERT INTO devices
    (id,name,status,last_heartbeat,app_version,platform,client_type,workspace_id,playlist_id,
     orientation,screen_width,screen_height,created_at)
    VALUES (?,?,?,?,?,?,?,'w1','pl1','landscape',1920,1080,?)`);
  const tel = db.prepare(`INSERT INTO device_telemetry
    (device_id,battery_level,battery_charging,storage_free_mb,storage_total_mb,ram_free_mb,
     ram_total_mb,cpu_usage,wifi_rssi,uptime_seconds,local_ip,reported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= n; i++) {
    ins.run(`dev-${i}`, `Store ${Math.ceil(i / 4)} — Screen ${((i - 1) % 4) + 1}`,
            i % 9 === 0 ? 'offline' : 'online', NOW - (i % 60),
            '1.9.39', plats[i % plats.length], 'player', NOW - 86400 * 30);
    tel.run(`dev-${i}`, null, null, 2000 + (i * 7) % 9000, 15000, 400 + (i * 13) % 600, 2048,
            Math.round(((i * 37) % 900) / 10) / 10, -40 - (i % 45), 3600 * (i % 72),
            `192.168.${(i % 250) + 1}.${(i % 200) + 10}`, NOW);
  }
  db.__dir = dir;
  return db;
}

const B = (s) => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');
const defl = (b) => zlib.deflateSync(b).length;
const gz = (b) => zlib.gzipSync(b).length;
const br = (b) => zlib.brotliCompressSync(b, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },   // realistic for a live path, not max
}).length;

const pct = (from, to) => `${Math.round((1 - to / from) * 100)}%`;
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

const edge = {
  id: 'e1', peer_node_id: 'child',
  grant_categories: JSON.stringify(GRANT),
  shared_workspaces: null, revoked_at: null,
};

console.log('\n=== ONE REPORT CYCLE (what a child sends every 60s) ===\n');
console.log('fleet │ msgs │ raw total │ per-msg deflate │ BATCHED raw │ batched deflate │ batched brotli');
console.log('──────┼──────┼───────────┼─────────────────┼─────────────┼─────────────────┼───────────────');

const cycles = {};
for (const n of FLEETS) {
  const db = buildDb(n);
  const me = 'node-aaaaaaaa';
  const mk = (type, body) => envelope.createEnvelope({
    originNodeId: me, type, bodyVersion: 1, ancestry: [me], originTs: Date.now(), body,
  });

  const msgs = [];
  msgs.push(mk('node-health', nodeData.nodeHealth(db, me)));
  for (const w of nodeData.workspaceProjections(db, GRANT, edge)) msgs.push(mk('workspace-summary', w));
  for (const d of nodeData.deviceProjections(db, GRANT, edge)) msgs.push(mk('device-summary', d));

  const raw = msgs.reduce((s, m) => s + B(m), 0);
  const perDeflate = msgs.reduce((s, m) => s + defl(Buffer.from(JSON.stringify(m))), 0);
  const perBrotli = msgs.reduce((s, m) => s + br(Buffer.from(JSON.stringify(m))), 0);
  const batchedBuf = Buffer.from(JSON.stringify(msgs));
  const batchedRaw = batchedBuf.length;
  const batchedDeflate = defl(batchedBuf);
  const batched = br(batchedBuf);

  cycles[n] = { msgs: msgs.length, raw, perDeflate, perBrotli, batched, batchedRaw };
  console.log(
    `${String(n).padStart(5)} │ ${String(msgs.length).padStart(4)} │ ${kb(raw).padStart(9)} │ ` +
    `${(kb(perDeflate) + ' (' + pct(raw, perDeflate) + ')').padStart(15)} │ ` +
    `${kb(batchedRaw).padStart(11)} │ ` +
    `${(kb(batchedDeflate) + ' (' + pct(raw, batchedDeflate) + ')').padStart(15)} │ ` +
    `${(kb(batched) + ' (' + pct(raw, batched) + ')').padStart(14)}`);
  db.close();
  fs.rmSync(db.__dir, { recursive: true, force: true });
}

console.log('\n=== A SINGLE MESSAGE (why per-message compression underperforms) ===\n');
{
  const db = buildDb(5);
  const me = 'node-aaaaaaaa';
  const one = envelope.createEnvelope({
    originNodeId: me, type: 'device-summary', bodyVersion: 1, ancestry: [me],
    originTs: Date.now(), body: nodeData.deviceProjections(db, GRANT, edge)[0],
  });
  const s = JSON.stringify(one);
  const buf = Buffer.from(s);
  console.log(`  one device-summary envelope : ${kb(B(s))}`);
  console.log(`    deflate                   : ${kb(defl(buf))}  (${pct(B(s), defl(buf))})`);
  console.log(`    gzip                      : ${kb(gz(buf))}  (${pct(B(s), gz(buf))})`);
  console.log(`    brotli q5                 : ${kb(br(buf))}  (${pct(B(s), br(buf))})`);
  console.log(`\n  envelope overhead (non-body): ${kb(B(s) - B(one.body))} of ${kb(B(s))}`);
  db.close();
  fs.rmSync(db.__dir, { recursive: true, force: true });
}

console.log('\n=== A READ-THROUGH RESPONSE (the proxy path) ===\n');
for (const n of [40, 400]) {
  const db = buildDb(n);
  const list = nodeData.answerRead(db, edge, { path: '/api/devices', method: 'GET' });
  const one = nodeData.answerRead(db, edge, { path: '/api/devices/dev-1', method: 'GET' });
  for (const [label, payload] of [[`/api/devices (${n})`, list], ['/api/devices/:id', one]]) {
    const buf = Buffer.from(JSON.stringify(payload));
    console.log(`  ${label.padEnd(20)} raw ${kb(buf.length).padStart(9)} │ ` +
                `deflate ${kb(defl(buf)).padStart(8)} (${pct(buf.length, defl(buf))}) │ ` +
                `brotli ${kb(br(buf)).padStart(8)} (${pct(buf.length, br(buf))})`);
  }
  db.close();
  fs.rmSync(db.__dir, { recursive: true, force: true });
}

console.log('\n=== BACKFILL AFTER AN OUTAGE (buffered envelopes, oldest first) ===\n');
{
  const db = buildDb(400);
  const me = 'node-aaaaaaaa';
  const devs = nodeData.deviceProjections(db, GRANT, edge);
  // A child buffers up to DEFAULT_BUFFER_MAX; a 2-hour outage at 60s cycles is ~120 cycles, so the
  // bound bites long before that. Measure the bound itself: 5,000 envelopes.
  const buffered = [];
  for (let i = 0; buffered.length < 5000; i++) {
    buffered.push(envelope.createEnvelope({
      originNodeId: me, type: 'device-summary', bodyVersion: 1, ancestry: [me],
      originTs: Date.now() - i * 1000, body: devs[i % devs.length],
    }));
  }
  const raw = buffered.reduce((s, m) => s + B(m), 0);
  const perDeflate = buffered.reduce((s, m) => s + defl(Buffer.from(JSON.stringify(m))), 0);
  const batched = br(Buffer.from(JSON.stringify(buffered)));
  console.log(`  5,000 buffered envelopes    : ${kb(raw)}`);
  console.log(`    per-message deflate       : ${kb(perDeflate)}  (${pct(raw, perDeflate)})`);
  console.log(`    batched brotli            : ${kb(batched)}  (${pct(raw, batched)})`);
  db.close();
  fs.rmSync(db.__dir, { recursive: true, force: true });
}

console.log('\n=== COST OF COMPRESSING (main-thread CPU, per report cycle) ===\n');
{
  const db = buildDb(400);
  const me = 'node-aaaaaaaa';
  const msgs = nodeData.deviceProjections(db, GRANT, edge).map((d) => envelope.createEnvelope({
    originNodeId: me, type: 'device-summary', bodyVersion: 1, ancestry: [me],
    originTs: Date.now(), body: d,
  }));
  const bufs = msgs.map((m) => Buffer.from(JSON.stringify(m)));
  for (const [label, fn] of [['deflate', defl], ['brotli q5', br]]) {
    const t0 = process.hrtime.bigint();
    for (const b of bufs) fn(b);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`  ${label.padEnd(12)} 400 messages: ${ms.toFixed(1)} ms`);
  }
  const t0 = process.hrtime.bigint();
  br(Buffer.from(JSON.stringify(msgs)));
  console.log(`  brotli q5    batched as one: ` +
              `${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`);
  db.close();
  fs.rmSync(db.__dir, { recursive: true, force: true });
}
console.log('');
