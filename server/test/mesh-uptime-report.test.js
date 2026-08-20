'use strict';

/*
 * The per-client uptime report — the artifact an MSP hands a customer, so the tests here are mostly
 * about the ways a confident-looking percentage can be WRONG rather than about it being computed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Database } = require('../db/sqlite-driver');

const { clientUptime, toCsv, csvCell, mergeIntervals } = require('../lib/mesh/uptime-report');

const NOW = 1_760_000_000;
const DAY = 86400;

/*
 * ⚠️ A REAL, EMPTY DATABASE PER TEST. The first version of this helper pointed DB_PATH at a temp dir
 * and re-required db/database.js, which returns a module-level singleton — so every test shared one
 * file and screens accumulated across them. Four tests then "passed" against forty devices seeded by
 * an earlier one, and the arithmetic tests failed with plausible-looking wrong numbers rather than
 * anything that named the cause.
 */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-uptime-'));
  const db = new Database(path.join(dir, 'u.db'));
  db.exec(`
    CREATE TABLE mesh_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT, parent_client_id TEXT,
      created_at INTEGER NOT NULL);
    CREATE TABLE mesh_edges (
      id TEXT PRIMARY KEY, peer_node_id TEXT NOT NULL, direction TEXT NOT NULL,
      transport_direction TEXT NOT NULL, client_id TEXT, last_sync_at INTEGER,
      revoked_at INTEGER, peer_url TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE mesh_mirror_devices (
      origin_node_id TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT, status TEXT,
      last_heartbeat INTEGER, body TEXT NOT NULL DEFAULT '{}', origin_ts INTEGER,
      received_at INTEGER NOT NULL, deleted_at INTEGER, first_seen_at INTEGER,
      workspace_id TEXT,
      PRIMARY KEY (origin_node_id, device_id));
    CREATE TABLE mesh_mirror_alerts (
      id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, alert_type TEXT NOT NULL, severity TEXT,
      subject_count INTEGER, subjects TEXT, opened_at INTEGER, closed_at INTEGER,
      origin_ts INTEGER, received_at INTEGER NOT NULL);
  `);
  db.__dir = dir;
  return db;
}
function cleanup(db) {
  try { db.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(db.__dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
}

/** A client with one node, `n` screens, and a live edge. */
function seed(db, { clientId = 'c1', nodeId = 'n1', devices = 1, lastSync = NOW,
                    firstSeen = NOW - 90 * DAY } = {}) {
  db.prepare('INSERT OR REPLACE INTO mesh_clients (id,name,created_at) VALUES (?,?,?)')
    .run(clientId, `Client ${clientId}`, NOW - 365 * DAY);
  db.prepare(`INSERT OR REPLACE INTO mesh_edges
      (id, peer_node_id, direction, transport_direction, client_id, last_sync_at, created_at)
      VALUES (?,?,'down','we-dial',?,?,?)`)
    .run(`e-${nodeId}`, nodeId, clientId, lastSync, NOW - 365 * DAY);
  for (let i = 1; i <= devices; i++) {
    db.prepare(`INSERT OR REPLACE INTO mesh_mirror_devices
        (origin_node_id, device_id, name, status, body, received_at, first_seen_at)
        VALUES (?,?,?,'online','{}',?,?)`)
      .run(nodeId, `d${i}`, `Screen ${i}`, NOW, firstSeen);
  }
}

function addAlert(db, { id, nodeId = 'n1', subjects, opened, closed = null, type = 'device_offline' }) {
  db.prepare(`INSERT OR REPLACE INTO mesh_mirror_alerts
      (id, origin_node_id, alert_type, severity, subject_count, subjects, opened_at, closed_at, received_at)
      VALUES (?,?,?,'warn',?,?,?,?,?)`)
    .run(id, nodeId, type, subjects ? subjects.length : 0,
         subjects ? JSON.stringify(subjects) : null, opened, closed, NOW);
}

const report = (db, over = {}) => clientUptime(db, {
  clientId: 'c1', clientName: 'Client c1',
  from: NOW - DAY, to: NOW,
  descendantsOf: () => [], nowSec: NOW,
  ...over,
});

// ===== the headline number =====

test('⚠️ FLEET UPTIME IS DEVICE-WEIGHTED, NOT WALL-CLOCK-MERGED', () => {
  /*
   * THE bug this module exists to avoid. threshold-alerts#uptimeReport merges overlapping incidents
   * before summing — right for one device, catastrophic across a fleet. One screen dark for the whole
   * day among 40 is 97.5%, not 0%; the merged version would union that one outage across everything
   * and report the client's entire estate as down all day.
   */
  const db = freshDb();
  try {
    seed(db, { devices: 40 });
    addAlert(db, { id: 'a1', subjects: ['d1'], opened: NOW - DAY, closed: NOW });
    const r = report(db);
    assert.equal(r.deviceCount, 40);
    assert.equal(r.uptimePct, 97.5, 'one dead screen in forty, not a dead site');
  } finally { cleanup(db); }
});

test('overlapping alerts on ONE device are still merged, not summed', () => {
  // The behaviour that is correct within a device is preserved — offline AND low battery during one
  // outage is one period of downtime, and adding them can exceed 100%.
  const db = freshDb();
  try {
    seed(db, { devices: 1 });
    addAlert(db, { id: 'a1', subjects: ['d1'], opened: NOW - 600, closed: NOW - 200, type: 'offline' });
    addAlert(db, { id: 'a2', subjects: ['d1'], opened: NOW - 500, closed: NOW - 100, type: 'battery' });
    const r = report(db);
    assert.equal(r.downSeconds, 500, 'the union (600→100), not 400+400');
    assert.equal(r.incidentCount, 2, 'while both incidents are still listed as evidence');
  } finally { cleanup(db); }
});

test('⚠️ an alert is charged to EVERY subject it names', () => {
  // A node-level alert naming twelve screens is twelve screens' downtime. Charging it to one row
  // understates the fleet figure by an order of magnitude on the incidents that matter most.
  const db = freshDb();
  try {
    seed(db, { devices: 4 });
    addAlert(db, { id: 'a1', subjects: ['d1', 'd2', 'd3'], opened: NOW - DAY, closed: NOW });
    const r = report(db);
    assert.equal(r.uptimePct, 25, 'three of four screens down all day');
  } finally { cleanup(db); }
});

// ===== the denominator =====

test('⚠️ A SCREEN INSTALLED MID-WINDOW IS NOT SCORED AS DOWN BEFORE IT EXISTED', () => {
  /*
   * The report window is a month; the screen went in on the 20th. Counting the first 19 days against
   * it produces a number the customer knows is wrong, which discredits the numbers that were right.
   */
  const db = freshDb();
  try {
    seed(db, { devices: 1, firstSeen: NOW - DAY / 4 });   // existed for the last six hours only
    const r = report(db, { from: NOW - DAY, to: NOW });
    assert.equal(r.devices[0].possibleSeconds, DAY / 4);
    assert.equal(r.uptimePct, 100, 'no incidents while it existed');
    assert.ok(r.coveragePct <= 100);
  } finally { cleanup(db); }
});

test('a retired screen keeps the outages it really had, and stops there', () => {
  // Dropping decommissioned screens would quietly improve the number every time a client retires a
  // problem one.
  const db = freshDb();
  try {
    seed(db, { devices: 1 });
    db.prepare('UPDATE mesh_mirror_devices SET deleted_at = ? WHERE device_id = ?')
      .run(NOW - DAY / 2, 'd1');
    addAlert(db, { id: 'a1', subjects: ['d1'], opened: NOW - DAY, closed: NOW - DAY * 3 / 4 });
    const r = report(db);
    assert.equal(r.devices[0].retired, true);
    assert.equal(r.devices[0].possibleSeconds, DAY / 2, 'only the half-day it was still installed');
    assert.equal(r.downSeconds, DAY / 4, 'and the outage it really had');
  } finally { cleanup(db); }
});

// ===== silence is not success =====

test('⚠️ A SITE WE CANNOT SEE DOES NOT SCORE 100% — the report that looks fine', () => {
  /*
   * The most dangerous failure in the whole feature. Incidents are the only evidence of downtime, so
   * a site whose link died a week ago sends none and scores perfectly. A broken collector produces a
   * BEAUTIFUL report, and nothing on the page invites anybody to doubt it.
   */
  const db = freshDb();
  try {
    seed(db, { devices: 10, lastSync: NOW - DAY / 2 });   // link stale for twelve hours
    const r = report(db);
    assert.ok(r.coveragePct < 60, `coverage must fall, got ${r.coveragePct}`);
    assert.ok(r.devices[0].unobservedSeconds > 0, 'and the unseen time is stated per screen');
    assert.match(r.coverageNote, /unreachable/);
  } finally { cleanup(db); }
});

test('a client with no connected sites reports "not measured", never 100%', () => {
  // Rendering 100% for a client with nothing connected is a claim about screens nobody watched.
  const db = freshDb();
  try {
    db.prepare('INSERT INTO mesh_clients (id,name,created_at) VALUES (?,?,?)')
      .run('c1', 'Client c1', NOW);
    const r = report(db);
    assert.equal(r.uptimePct, null);
    assert.equal(r.deviceCount, 0);
    assert.match(r.note, /nothing to report/);
  } finally { cleanup(db); }
});

test('a screen never observed reports null uptime, not 100', () => {
  const db = freshDb();
  try {
    seed(db, { devices: 1, firstSeen: NOW });   // appeared exactly at the window end
    const r = report(db, { from: NOW - DAY, to: NOW });
    assert.equal(r.devices[0].uptimePct, null, 'never watched is not never broken');
  } finally { cleanup(db); }
});

// ===== attribution =====

test('⚠️ a site-level alert with no subjects is listed, not spread and not dropped', () => {
  /*
   * "This server is out of disk" names no screen. Spreading it across the fleet invents downtime for
   * screens that were playing; dropping it hides a real incident from a report whose job is to list
   * them.
   */
  const db = freshDb();
  try {
    seed(db, { devices: 4 });
    addAlert(db, { id: 'a1', subjects: null, opened: NOW - DAY, closed: NOW, type: 'disk_full' });
    const r = report(db);
    assert.equal(r.uptimePct, 100, 'no screen downtime was invented');
    assert.equal(r.unattributedIncidents.length, 1, 'and the incident is still on the report');
    assert.equal(r.unattributedIncidents[0].alertType, 'disk_full');
  } finally { cleanup(db); }
});

test('an incident spanning the window edge is clamped to the window', () => {
  const db = freshDb();
  try {
    seed(db, { devices: 1 });
    addAlert(db, { id: 'a1', subjects: ['d1'], opened: NOW - 10 * DAY, closed: NOW + 10 * DAY });
    const r = report(db, { from: NOW - DAY, to: NOW });
    assert.equal(r.downSeconds, DAY);
    assert.equal(r.uptimePct, 0, 'exactly zero, never negative');
  } finally { cleanup(db); }
});

test('downtime can never exceed the time we were watching', () => {
  // Whatever the incident rows say. A percentage below zero destroys trust in every other figure.
  const db = freshDb();
  try {
    seed(db, { devices: 1, firstSeen: NOW - 3600 });
    addAlert(db, { id: 'a1', subjects: ['d1'], opened: NOW - 10 * DAY, closed: NOW });
    const r = report(db, { from: NOW - DAY, to: NOW });
    assert.ok(r.uptimePct >= 0 && r.uptimePct <= 100, `got ${r.uptimePct}`);
  } finally { cleanup(db); }
});

test('incidents are ordered worst-first, because that is what gets read', () => {
  const db = freshDb();
  try {
    seed(db, { devices: 2 });
    addAlert(db, { id: 'small', subjects: ['d1'], opened: NOW - 300, closed: NOW - 240 });
    addAlert(db, { id: 'big', subjects: ['d2'], opened: NOW - 5000, closed: NOW });
    const r = report(db);
    assert.equal(r.incidents[0].id, 'big');
  } finally { cleanup(db); }
});

// ===== scoping =====

test('a parent client includes its descendants\' sites', () => {
  // A regional client exists so its parent can be reported on as a whole; omitting children would
  // silently miss most of the estate.
  const db = freshDb();
  try {
    seed(db, { clientId: 'c1', nodeId: 'n1', devices: 2 });
    seed(db, { clientId: 'c2', nodeId: 'n2', devices: 2 });
    db.prepare('UPDATE mesh_clients SET parent_client_id = ? WHERE id = ?').run('c1', 'c2');
    const r = clientUptime(db, {
      clientId: 'c1', from: NOW - DAY, to: NOW, nowSec: NOW,
      descendantsOf: () => ['c2'],
    });
    assert.equal(r.nodeCount, 2);
    assert.equal(r.deviceCount, 4);
  } finally { cleanup(db); }
});

test('another client\'s screens never enter the report', () => {
  const db = freshDb();
  try {
    seed(db, { clientId: 'c1', nodeId: 'n1', devices: 2 });
    seed(db, { clientId: 'other', nodeId: 'n9', devices: 30 });
    const r = report(db);
    assert.equal(r.deviceCount, 2);
    assert.ok(!r.devices.some((d) => d.originNodeId === 'n9'));
  } finally { cleanup(db); }
});

// ===== the export =====

test('⚠️ CSV FORMULA INJECTION IS NEUTRALISED', () => {
  /*
   * A screen named =cmd|'/c calc'!A1 is a live formula the moment the customer opens this in Excel —
   * and the name arrives from somebody ELSE'S server, which is the whole untrusted-input-into-a-
   * trusted-document shape.
   */
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=x", "\r=x"]) {
    // Strip the CSV quoting first: a value containing \r is BOTH neutralised and quoted, so the
    // apostrophe sits inside the quotes rather than at the start of the cell.
    const inner = csvCell(bad).replace(/^"|"$/g, '').replace(/""/g, '"');
    assert.ok(inner.startsWith("'"), `${JSON.stringify(bad)} must be neutralised, got ${csvCell(bad)}`);
  }
  assert.equal(csvCell('Lobby screen'), 'Lobby screen', 'ordinary names are untouched');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test('the export leads with uptime AND coverage together', () => {
  /*
   * "99.9% uptime, 62% coverage" is honest. "99.9%" alone, computed over the 62%, tells a customer
   * their screens were fine during a week nobody was watching. Coverage buried at the bottom gets
   * cropped out of the screenshot that ends up in the email.
   */
  const db = freshDb();
  try {
    seed(db, { devices: 3, lastSync: NOW - DAY / 2 });
    const csv = toCsv(report(db));
    const lines = csv.split('\r\n');
    const u = lines.findIndex((l) => l.startsWith('Uptime %'));
    const c = lines.findIndex((l) => l.startsWith('Coverage %'));
    assert.ok(u > -1 && c === u + 1, 'coverage sits immediately under uptime');
    assert.match(csv, /Screen,Site,Uptime %/);
    assert.match(csv, /Incidents/);
  } finally { cleanup(db); }
});

test('the export names the client and the window it covers', () => {
  // A report with no client name and no dates is the one that gets forwarded to the wrong customer.
  const db = freshDb();
  try {
    seed(db, { devices: 1 });
    const csv = toCsv(report(db));
    assert.match(csv, /Client,Client c1/);
    assert.match(csv, /From,\d{4}-\d{2}-\d{2}T/);
  } finally { cleanup(db); }
});

test('mergeIntervals is a union, and drops empty spans', () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }]),
    [{ start: 0, end: 20 }]);
  assert.deepEqual(mergeIntervals([{ start: 0, end: 10 }, { start: 20, end: 30 }]),
    [{ start: 0, end: 10 }, { start: 20, end: 30 }]);
  assert.deepEqual(mergeIntervals([{ start: 5, end: 5 }]), []);
});
