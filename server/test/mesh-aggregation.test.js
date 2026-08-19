'use strict';

/*
 * Phase 2 — upward aggregation: what is sent, in what order, and what happens when it goes wrong.
 *
 * The four properties worth guarding, each with a failure mode that is invisible until it matters:
 *
 *   MIRROR      filtering happens at the SOURCE, so a denied field never crosses the wire
 *   BACKFILL    current state before history, or a hub spends its first hour learning about March
 *   BREAKER     one dead child must not stall a sweep over forty healthy ones
 *   ROLLUP      forty sites reporting at once is one condition — possibly the hub's own
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mirror = require('../lib/mesh/mirror');
const { BackfillQueue, PRIORITY, priorityFor } = require('../lib/mesh/backfill');
const { CircuitBreakers, STATE } = require('../lib/mesh/circuit-breaker');
const { rollup, shouldNotify, SELF_SUSPICION_RATIO } = require('../lib/mesh/alert-rollup');

const T0 = 1_700_000_000_000;

// ===== mirror: filtering at the source =====

const fullDevice = Object.freeze({
  id: 'dev-1', name: 'Lobby', status: 'online', last_heartbeat: 123,
  battery_level: 80, cpu_usage: 12, hardware_serial: 'SN-9', app_version: '1.9.39',
  local_ip: '192.168.1.50', ip_address: '80.51.0.7',
  orientation: 'landscape', screenshot_url: '/uploads/screenshots/dev-1.jpg',
  playlist_name: 'Q4 Campaign', offline_reason: 'network',
});

test('a health-only grant sends health and nothing else', () => {
  const out = mirror.projectDevice(fullDevice, ['health']);
  assert.equal(out.status, 'online');
  assert.equal(out.battery_level, 80);
  // ⚠️ Everything else must be ABSENT, not null or empty — an explicit null still tells the parent
  // the field exists and that this device has none.
  for (const f of ['name', 'hardware_serial', 'ip_address', 'local_ip', 'playlist_name',
                   'screenshot_url', 'offline_reason']) {
    assert.ok(!(f in out), `${f} must not be sent under a health-only grant`);
  }
});

test('the id is always present, because a grant hides WHAT a screen is, not that it exists', () => {
  const out = mirror.projectDevice(fullDevice, []);
  assert.deepEqual(Object.keys(out), ['id'],
    'an empty grant yields an identifier and nothing else');
});

test('⚠️ the public address is separable from the LAN address', () => {
  /*
   * The Phase −1 audit found ip_address populated for 509 of 509 production devices with PUBLIC
   * addresses, which locate a client's premises. A health-only grant that still shipped them would
   * fail the review this vocabulary exists for.
   */
  const lan = mirror.projectDevice(fullDevice, ['network-lan']);
  assert.equal(lan.local_ip, '192.168.1.50');
  assert.ok(!('ip_address' in lan), 'granting LAN visibility must not imply the public address');

  const wan = mirror.projectDevice(fullDevice, ['network-wan']);
  assert.equal(wan.ip_address, '80.51.0.7');
  assert.ok(!('local_ip' in wan));
});

test('⚠️ screenshots are separable from display state', () => {
  const d = mirror.projectDevice(fullDevice, ['display']);
  assert.equal(d.orientation, 'landscape');
  assert.ok(!('screenshot_url' in d), 'knowing the video mode is not consent to see the screen');
});

test('a field with no category is NEVER sent, whatever the grant', () => {
  /*
   * ⚠️ The default for anything new is silence. Adding a column to `devices` must not quietly start
   * exporting it to every hub a client has ever paired with.
   */
  const row = { ...fullDevice, wifi_ssid: 'RealEstate5167788777', some_new_column: 'x' };
  const everything = Object.keys(mirror.FIELD_CATEGORY)
    .map((f) => mirror.FIELD_CATEGORY[f]);
  const out = mirror.projectDevice(row, [...new Set(everything)]);
  assert.ok(!('wifi_ssid' in out), 'the dropped Wi-Fi SSID must not travel');
  assert.ok(!('some_new_column' in out), 'an unmapped column must not travel');
});

test('an alert travels under a health grant but stops naming screens without identity', () => {
  /*
   * ⚠️ An alert naming a device is a statement ABOUT that device. Letting the subject list through on
   * a health-only edge would leak by description what the grant refused by field.
   */
  const alert = { id: 'a1', type: 'devices_offline', severity: 'warn', opened_at: T0,
                  subject_count: 3, subjects: ['Lobby', 'Foyer', 'Cafe'] };

  const healthOnly = mirror.projectAlert(alert, ['health']);
  assert.equal(healthOnly.subject_count, 3, 'the hub learns something is wrong');
  assert.ok(!('subjects' in healthOnly), 'but not which screens');

  const withNames = mirror.projectAlert(alert, ['health', 'identity']);
  assert.deepEqual(withNames.subjects, ['Lobby', 'Foyer', 'Cafe']);

  assert.equal(mirror.projectAlert(alert, ['content-metadata']), null,
    'an edge with no health grant gets no alerts at all');
});

// ===== backfill: order =====

test('THE ORDER: current state first, history last', () => {
  /*
   * ⚠️ Chronological is the naive order and the worst one. A site with 400 screens and eight months
   * of history sent oldest-first leaves the hub unable to answer "is anything down right now" — the
   * only question anyone asks in the first five minutes.
   */
  const q = new BackfillQueue({ urgentPerTick: 2, historyPerTick: 2 });
  q.addMany(PRIORITY.HISTORY, ['h1', 'h2', 'h3']);
  q.add(PRIORITY.OPEN_ALERTS, 'alert');
  q.addMany(PRIORITY.CURRENT_STATE, ['now1', 'now2']);

  assert.equal(q.nextBatch().name, 'current-state');
  assert.equal(q.nextBatch().name, 'open-alerts');
  assert.equal(q.nextBatch().name, 'history', 'history only once nobody is waiting');
});

test('strict priority, not weighted — history waits entirely', () => {
  /*
   * A weighted share feels fairer and delays the only part with someone waiting on it — and the delay
   * would scale with the size of the history, so the biggest sites wait longest.
   */
  const q = new BackfillQueue({ urgentPerTick: 1, historyPerTick: 10 });
  q.addMany(PRIORITY.HISTORY, Array.from({ length: 100 }, (_, i) => i));
  q.addMany(PRIORITY.CURRENT_STATE, ['a', 'b', 'c']);

  for (let i = 0; i < 3; i++) {
    assert.equal(q.nextBatch().name, 'current-state', 'no history escapes while state is pending');
  }
  assert.equal(q.nextBatch().name, 'history');
});

test('history is rate-capped so catching up cannot starve the live path', () => {
  const q = new BackfillQueue({ historyPerTick: 50 });
  q.addMany(PRIORITY.HISTORY, Array.from({ length: 500 }, (_, i) => i));
  assert.equal(q.nextBatch().items.length, 50, 'a trickle, not a flood');
  assert.equal(q.progress().historyEtaMs, 9_000, 'and the remaining time is knowable');
});

test('progress reports the urgent part separately', () => {
  // ⚠️ "12% complete" on a node that already knows every screen's state is needlessly alarming, and
  // it is the number a single progress bar would show.
  const q = new BackfillQueue({ urgentPerTick: 10 });
  q.addMany(PRIORITY.CURRENT_STATE, ['a', 'b']);
  q.addMany(PRIORITY.HISTORY, Array.from({ length: 1000 }, (_, i) => i));

  assert.equal(q.progress().urgentDone, false);
  q.nextBatch();
  const p = q.progress();
  assert.equal(p.urgentDone, true, 'the useful part is finished in one tick');
  assert.equal(p.historyPending, 1000, 'while the bulk is still arriving');
});

test('an unknown payload type trickles rather than jumping the queue', () => {
  // A newer child must not be able to starve the live path by claiming urgency.
  assert.equal(priorityFor('invented-in-2027'), PRIORITY.HISTORY);
  assert.equal(priorityFor('device-summary'), PRIORITY.CURRENT_STATE);
  assert.equal(priorityFor('alert-event', { open: true }), PRIORITY.OPEN_ALERTS);
  assert.equal(priorityFor('alert-event', { open: false }), PRIORITY.HISTORY,
    'a CLOSED alert needs no action and nobody is waiting for it');
});

// ===== circuit breaker =====

test('THE POINT: a dead child stops being attempted, so the sweep does not stall', () => {
  const cb = new CircuitBreakers({ failureThreshold: 3 }, () => 0.5);
  for (let i = 0; i < 3; i++) {
    assert.equal(cb.shouldAttempt('dead', T0), true);
    cb.recordFailure('dead', T0, new Error('ETIMEDOUT'));
  }
  assert.equal(cb.shouldAttempt('dead', T0), false, 'now it is skipped, not waited on');
  assert.equal(cb.shouldAttempt('healthy', T0), true, 'and its neighbours are unaffected');
});

test('half-open lets exactly ONE probe through, and recovery is automatic', () => {
  /*
   * ⚠️ A breaker that only opens needs a human to reset it, and nobody is watching. After the
   * cooldown it admits one attempt: success closes it, failure re-opens with a longer wait.
   */
  const cb = new CircuitBreakers({ failureThreshold: 1, cooldownMs: 1000 }, () => 0.5);
  cb.recordFailure('c', T0, new Error('down'));
  assert.equal(cb.shouldAttempt('c', T0), false);

  assert.equal(cb.shouldAttempt('c', T0 + 1001), true, 'the cooldown elapsed — one probe');
  assert.equal(cb.shouldAttempt('c', T0 + 1002), false, 'and only one');

  cb.recordSuccess('c');
  assert.equal(cb.shouldAttempt('c', T0 + 1003), true, 'success closes it again');
});

test('a failed probe backs off further, and success resets the escalation', () => {
  const cb = new CircuitBreakers({ failureThreshold: 1, cooldownMs: 1000 }, () => 0.5);
  cb.recordFailure('c', T0, new Error('down'));
  const first = cb.for('c').nextProbeAt - T0;

  cb.shouldAttempt('c', T0 + 5000);                       // half-open
  cb.recordFailure('c', T0 + 5000, new Error('still down'));
  const second = cb.for('c').nextProbeAt - (T0 + 5000);
  assert.ok(second > first, 'a child down for hours is probed less often, not every 30s');

  // ⚠️ Recovery must reset the ESCALATION, or a node that comes back keeps the long cooldown it
  // earned during last week's outage.
  cb.recordSuccess('c');
  assert.equal(cb.for('c').trips, 0);
  assert.equal(cb.for('c').state, STATE.CLOSED);
});

test('the status says when it will retry, not just that it is down', () => {
  // "offline" reads as abandoned. "retrying in 4 minutes" says the system is still working.
  const cb = new CircuitBreakers({ failureThreshold: 1, cooldownMs: 60_000 }, () => 0.5);
  cb.recordFailure('c', T0, new Error('ECONNREFUSED'));
  const s = cb.status(T0)[0];
  assert.equal(s.state, STATE.OPEN);
  assert.ok(s.nextProbeInMs > 0);
  assert.match(s.lastError, /ECONNREFUSED/, 'and why, because the action differs by cause');
});

// ===== cross-node rollup =====

test('one node is not a rollup', () => {
  // Reporting "1 site affected" buries the site's name and makes a specific problem read as a stat.
  const [r] = rollup([{ node_id: 'n1', type: 'devices_offline', opened_at: T0, subject_count: 2 }],
    { now: T0, totalChildren: 40 });
  assert.equal(r.rolled, false);
  assert.equal(r.dedupKey, 'devices_offline:n1');
});

test('many nodes with one condition roll into one alert with ONE dedup key', () => {
  /*
   * ⚠️ The single key is what makes the existing per-(type,target) suppression treat the group as a
   * unit. Passing each node's own key would let forty alerts through, each individually "not a
   * duplicate" — precisely the bug rollup exists to prevent.
   */
  const alerts = ['n1', 'n2', 'n3'].map((n) => ({
    node_id: n, type: 'devices_offline', opened_at: T0, subject_count: 5,
  }));
  const [r] = rollup(alerts, { now: T0, totalChildren: 40 });
  assert.equal(r.rolled, true);
  assert.equal(r.nodeCount, 3);
  assert.equal(r.subjectCount, 15);
  assert.equal(r.dedupKey.split(':').length, 3, 'one key for the whole condition');
  assert.match(r.summary, /3 sites/);
});

test('⚠️ THE HUB SUSPECTS ITSELF when nearly everything goes silent at once', () => {
  /*
   * If a hub loses its own uplink, every child stops reporting and every child LOOKS offline. A naive
   * rollup announces "40 sites are down", which is false and sends somebody to a client's premises.
   * The correct reading of "everything went quiet at once" is: suspect the observer first.
   */
  const alerts = Array.from({ length: 38 }, (_, i) => ({
    node_id: `n${i}`, type: 'devices_offline', opened_at: T0, subject_count: 10,
  }));
  const [r] = rollup(alerts, { now: T0, totalChildren: 40 });

  assert.equal(r.suspectSelf, true);
  assert.ok(r.affectedRatio >= SELF_SUSPICION_RATIO);
  assert.match(r.summary, /this hub's own connection/i);
  assert.match(r.summary, /check this server's network before contacting the sites/i,
    'the summary must send the operator to the right place first');
  assert.equal(r.dedupKey, 'devices_offline:hub-self',
    'and it is ONE condition about the hub, not forty about the sites');
});

test('a handful of sites is NOT the hub — that would hide real outages', () => {
  const alerts = ['n1', 'n2', 'n3'].map((n) => ({
    node_id: n, type: 'devices_offline', opened_at: T0, subject_count: 4,
  }));
  const [r] = rollup(alerts, { now: T0, totalChildren: 40 });
  assert.equal(r.suspectSelf, false, '3 of 40 is three real outages');
});

test('an alert outside the correlation window is its own condition', () => {
  const alerts = [
    { node_id: 'n1', type: 'devices_offline', opened_at: T0, subject_count: 1 },
    { node_id: 'n2', type: 'devices_offline', opened_at: T0 - 60 * 60 * 1000, subject_count: 1 },
  ];
  const out = rollup(alerts, { now: T0, totalChildren: 10 });
  assert.equal(out.length, 2, 'two outages an hour apart are two conditions, not one');
});

test('a condition alerts once and not again while it stays open', () => {
  const [r] = rollup(['n1', 'n2'].map((n) => ({
    node_id: n, type: 'devices_offline', opened_at: T0, subject_count: 1,
  })), { now: T0, totalChildren: 10 });

  const open = new Map();
  assert.equal(shouldNotify(r, open), true);
  open.set(r.dedupKey, { openedAt: T0 });
  assert.equal(shouldNotify(r, open), false,
    'a flapping child must not generate a stream of identical alerts');
});
