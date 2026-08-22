'use strict';

/*
 * The fire path, EXECUTED — the player's trigger engine lifted out of index.html, wired to the real
 * shared resolver, and fired at over a real HTTP socket.
 *
 * ⚠️ Structural assertions about this code are worth something, but they cannot tell you whether a
 * datagram actually changes what is on a screen. This can. It caught a real bug on its first run:
 * startTriggerHttp() is called at boot AND on config change, and without an idempotence guard the
 * second call bound the same port, took EADDRINUSE, and its error handler marked the listener DOWN
 * while the first one was up and serving — so `listeners.http` reported false with a working
 * listener behind it. That is the single diagnostic an installer trusts, reporting the opposite of
 * the truth.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TR = require('../lib/trigger-resolve.js');
const { freePort } = require('./helpers/free-port');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SECRET = 's'.repeat(16);

let api, rendered, PORT;

/** Instantiate the engine with fakes for the DOM and the rotation engine. */
function boot(port, over = {}) {
  const start = PLAYER.indexOf('    let triggerActive = null;');
  const end = PLAYER.indexOf('    // ==================== PiP overlay');
  assert.ok(start > 0 && end > start, 'the trigger engine is still in index.html');
  const src = PLAYER.slice(start, end);

  const out = [];
  const env = {
    window: { TriggerResolve: TR, __debugLog_push() {} },
    document: {
      getElementById: () => ({ innerHTML: '', appendChild() {}, style: {} }),
      createElement: () => ({ style: { cssText: '' }, className: '', appendChild() {} }),
    },
    console: { log() {}, warn() {} },
    setTimeout, clearTimeout, Date, JSON, Number, Array, String, Math, require,
    socket: null,
    config: { deviceId: 'd1' },
    triggers: [{
      id: 't1', name: 'Evac', match_token: 'EVAC', clear_token: 'EVAC_CLR',
      source_http: true, source_udp: false, mode: 'until_cleared',
      items: [{ content_id: 'c1', duration_sec: 5 }, { content_id: 'c2', duration_sec: 5 }],
    }, {
      id: 't2', name: 'Promo', match_token: 'PROMO', clear_token: null,
      source_http: true, source_udp: false, mode: 'once', max_duration_sec: 3,
      items: [{ content_id: 'c3', duration_sec: 30 }],
    }, {
      id: 't3', name: 'Empty', match_token: 'EMPTY', source_http: true, mode: 'once', items: [],
    }],
    triggerConfig: { accept_http: true, secret: SECRET, http_port: port, clear_all_token: 'ALLSTOP' },
    showZoneItem: (zone, div, items, i) => out.push({ zone: zone.id, count: items.length, i }),
    ...over,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return { handleTrigger, startTriggerHttp, stats: triggerStats,
      active: () => triggerActive,
      stop: () => { try { if (triggerHttpServer) triggerHttpServer.close(); } catch (e) {} } };`);
  return { api: fn(...names.map((n) => env[n])), out };
}

const post = async (body, ct) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  PORT = await freePort();
  const b = boot(PORT);
  api = b.api; rendered = b.out;
  // The slice contains the boot call, so the listener is already coming up; give it a tick.
  await new Promise((r) => setTimeout(r, 300));
});
// ⚠️ A bound listener holds the process open, so node --test would never exit without this.
after(() => { try { api && api.stop(); } catch (e) { /* already gone */ } });

test('the listener binds and reports the port it bound', () => {
  assert.equal(api.stats.listeners.http, PORT,
    'a bound listener must report its port — this is what declares the capability');
});

test('a raw one-line fire renders the trigger playlist', async () => {
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.deepEqual(r.body, { ok: true, action: 'fire' });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].zone, '__trigger__', 'rendered by the shared rotation engine');
  assert.equal(rendered[0].count, 2, 'the whole trigger playlist, not one item');
  assert.equal(api.active().trigger.name, 'Evac');
});

test('⚠️ a re-fire of the already-active trigger does NOT restart it', async () => {
  // PLC and Crestron gear re-assert on a timer. A restart per repeat would freeze a multi-item
  // emergency loop on item 1 for as long as the sender keeps talking, and it would look like the
  // playlist was broken rather than like the sender was chatty.
  const before = rendered.length;
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.equal(r.body.ok, true);
  assert.equal(rendered.length, before, 'the rotation was restarted');
});

test('the wrong secret is refused with 400 and a named reason', async () => {
  const r = await post(`ST1 ${'x'.repeat(16)} EVAC`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_secret');
});

test('a JSON envelope works too, because some gear can only POST JSON', async () => {
  const r = await post(JSON.stringify({ secret: SECRET, token: 'EVAC_CLR' }), 'application/json');
  assert.deepEqual(r.body, { ok: true, action: 'clear' });
  assert.equal(api.active(), null, 'the overlay was torn down');
});

test('an unknown token is refused', async () => {
  const r = await post(`ST1 ${SECRET} NOT_A_TOKEN`);
  assert.equal(r.body.error, 'unknown_token');
});

test('broadcast noise is refused on the magic', async () => {
  const r = await post('M-SEARCH * HTTP/1.1');
  assert.equal(r.body.error, 'bad_magic');
});

test('a device-level clear-all tears down whatever is showing', async () => {
  await post(`ST1 ${SECRET} EVAC`);
  assert.ok(api.active());
  const r = await post(`ST1 ${SECRET} ALLSTOP`);
  assert.deepEqual(r.body, { ok: true, action: 'clear_all' });
  assert.equal(api.active(), null);
});

test('⚠️ a trigger whose playlist did not reach this device fires nothing, loudly', async () => {
  // This is the failure the pinning work exists to prevent, so it must not look like success.
  const r = await post(`ST1 ${SECRET} EMPTY`);
  assert.equal(r.body.ok, true, 'the token resolved — the payload was valid');
  assert.equal(api.active(), null, 'but nothing is showing, because there was nothing to show');
});

test('the counters break down by reason, and count rejected traffic', () => {
  const s = api.stats;
  assert.ok(s.received > s.accepted, 'rejections were counted');
  assert.equal(s.rejected.bad_secret, 1);
  assert.equal(s.rejected.unknown_token, 1);
  assert.equal(s.rejected.bad_magic, 1);
  /*
   * ⚠️ The distinction the whole diagnostic rests on: last_datagram_at is stamped for REJECTED
   * traffic too. Recent timestamp with zero accepts means packets are arriving and the secret is
   * wrong; null means nothing is arriving and it is the network. Two different site visits.
   */
  assert.ok(s.last_datagram_at, 'a rejected packet still proves something arrived');
});

test('⚠️ starting twice does not mark a working listener as down', async () => {
  // The bug this file caught: boot starts it, a config change starts it again, the duplicate takes
  // EADDRINUSE and its error handler cleared the flag for the listener that was actually serving.
  api.startTriggerHttp();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(api.stats.listeners.http, PORT,
    'a duplicate start reported the listener down while it was up');
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.equal(r.body.ok, true, 'and it is still serving');
});

test('the listener stays shut when the device was never told to open it', async () => {
  const b = boot(await freePort(), { triggerConfig: { accept_http: false, secret: SECRET } });
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.ok(!b.api.stats.listeners.http, 'a port that changes a screen must not default to open');
  } finally { b.api.stop(); }
});
