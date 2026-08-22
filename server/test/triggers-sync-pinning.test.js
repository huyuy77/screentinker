'use strict';

/*
 * Getting trigger definitions onto a device, and keeping their media alive there.
 * docs/triggers-design.md §1 and §"Data model".
 *
 * ⚠️ The pinning half is the one that will bite. The service worker's pruneToPlaylist() deletes any
 * content-cache entry not in the set the player declares — so a trigger target left out of that set
 * is not merely un-prefetched, it is DELETED, and the trigger then fires against nothing on exactly
 * the day the WAN is down. That is the whole feature failing quietly, which is why it is asserted
 * here rather than left to review.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const { triggersForDevice, projectTrigger, triggerMediaUrls } = require('../lib/device-triggers');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trig-sync-'));
  const db = new Database(path.join(dir, 't.db'));
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT);
    CREATE TABLE device_group_members (device_id TEXT, group_id TEXT);
    CREATE TABLE triggers (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, match_token TEXT, clear_token TEXT,
      source_http INTEGER DEFAULT 1, source_udp INTEGER DEFAULT 0,
      target_kind TEXT DEFAULT 'playlist', target_ref TEXT, target_url TEXT,
      position TEXT, width INTEGER, height INTEGER, opacity REAL, border_radius INTEGER,
      mode TEXT, max_duration_sec INTEGER, lease_sec INTEGER,
      priority INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1);
    CREATE TABLE trigger_assignments (trigger_id TEXT, target_type TEXT, target_id TEXT);
  `);
  db.prepare("INSERT INTO devices VALUES ('d1','ws1')").run();
  return db;
}

const addTrigger = (db, over = {}) => {
  const t = { id: 't1', workspace_id: 'ws1', name: 'Evac', match_token: 'EVAC',
    mode: 'until_cleared', target_ref: 'pl1', priority: 10, enabled: 1, ...over };
  db.prepare(`INSERT INTO triggers (id, workspace_id, name, match_token, mode, target_ref, priority, enabled)
              VALUES (@id,@workspace_id,@name,@match_token,@mode,@target_ref,@priority,@enabled)`).run(t);
  return t;
};

test('a trigger assigned to the device is returned', () => {
  const db = freshDb();
  addTrigger(db);
  db.prepare("INSERT INTO trigger_assignments VALUES ('t1','device','d1')").run();
  assert.equal(triggersForDevice(db, 'd1').length, 1);
});

test('a trigger assigned to a GROUP the device belongs to is returned', () => {
  const db = freshDb();
  addTrigger(db);
  db.prepare("INSERT INTO device_group_members VALUES ('d1','g1')").run();
  db.prepare("INSERT INTO trigger_assignments VALUES ('t1','group','g1')").run();
  assert.equal(triggersForDevice(db, 'd1').length, 1,
    'group assignment is what makes this survive a 40-screen deployment');
});

test('⚠️ assigned to BOTH a group and the screen yields ONE trigger, not two', () => {
  // A perfectly normal configuration — assign to the group, then to one screen in it. Without
  // DISTINCT the device syncs two rows with the same match_token and its resolver has to guess.
  const db = freshDb();
  addTrigger(db);
  db.prepare("INSERT INTO device_group_members VALUES ('d1','g1')").run();
  db.prepare("INSERT INTO trigger_assignments VALUES ('t1','group','g1')").run();
  db.prepare("INSERT INTO trigger_assignments VALUES ('t1','device','d1')").run();
  assert.equal(triggersForDevice(db, 'd1').length, 1);
});

test('a disabled trigger, and another workspace\'s trigger, are both excluded', () => {
  const db = freshDb();
  addTrigger(db, { id: 'off', match_token: 'OFF', enabled: 0 });
  addTrigger(db, { id: 'other', match_token: 'OTHER', workspace_id: 'ws2' });
  db.prepare("INSERT INTO trigger_assignments VALUES ('off','device','d1')").run();
  db.prepare("INSERT INTO trigger_assignments VALUES ('other','device','d1')").run();
  assert.deepEqual(triggersForDevice(db, 'd1'), []);
});

test('a device with no assignment gets nothing', () => {
  const db = freshDb();
  addTrigger(db);
  assert.deepEqual(triggersForDevice(db, 'd1'), []);
});

test('the projection carries the items INLINE, because a device cannot resolve a playlist offline', () => {
  const p = projectTrigger(
    { id: 't1', name: 'Evac', match_token: 'EVAC', mode: 'until_cleared', target_kind: 'playlist',
      target_ref: 'pl1', max_duration_sec: null, lease_sec: 90, priority: 10 },
    [{ content_id: 'c1', filepath: 'a.mp4' }]);
  assert.equal(p.items.length, 1);
  assert.equal(p.lease_sec, 90);
  assert.equal(p.max_duration_sec, 0, 'a null cap normalises to 0 = no cap, not to null');
});

test('⚠️ PINNING: every trigger item contributes a URL the worker must not prune', () => {
  const urls = triggerMediaUrls(
    [{ items: [{ filepath: 'a.mp4' }, { filepath: 'b.mp4' }] }, { items: [{ filepath: 'c.mp4' }] }],
    (i) => '/uploads/content/' + i.filepath);
  assert.deepEqual(urls, ['/uploads/content/a.mp4', '/uploads/content/b.mp4', '/uploads/content/c.mp4']);
});

/*
 * The player half, asserted against the shipped source rather than described in a comment.
 */
test('the player pins trigger media in the SAME call as the base playlist', () => {
  assert.match(PLAYER, /requestOfflineCache\(\s*Array\.isArray\(data\.assignments\)[^;]*triggerItems\(triggers\)\)/,
    'trigger media must travel in the st-cache-playlist call, or pruneToPlaylist deletes it');
});

test('⚠️ triggers are NOT part of the item fingerprint', () => {
  // Entering it would restart playback on every trigger edit, which is #234.
  const fp = PLAYER.slice(PLAYER.indexOf('const fingerprint = (items)'));
  const line = fp.slice(0, fp.indexOf('\n'));
  assert.doesNotMatch(line, /trigger/i,
    'a trigger edit would send the screen back to item 1');
});

test('the player caches definitions locally and seeds them at declaration', () => {
  // A trigger that needs the socket to have connected has already failed the offline promise.
  assert.match(PLAYER, /let triggers = loadTriggersCache\(\);/);
  assert.match(PLAYER, /localStorage\.setItem\(TRIGGERS_CACHE_KEY/);
});

test('the signature covers the target items, so editing the trigger playlist re-syncs', () => {
  const sigSrc = PLAYER.slice(PLAYER.indexOf('function triggersSig('),
    PLAYER.indexOf('/** Every media item the assigned triggers need'));
  // eslint-disable-next-line no-new-func
  const triggersSig = new Function(`${sigSrc}; return triggersSig;`)();
  const a = [{ id: 't1', match_token: 'E', mode: 'once', items: [{ content_id: 'c1' }] }];
  const b = [{ id: 't1', match_token: 'E', mode: 'once', items: [{ content_id: 'c2' }] }];
  assert.notEqual(triggersSig(a), triggersSig(b), 'a changed target playlist must re-pin');
  assert.equal(triggersSig(a), triggersSig(JSON.parse(JSON.stringify(a))),
    'a rebuilt-but-identical payload is not a change');
});
