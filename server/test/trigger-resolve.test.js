'use strict';

/*
 * The decision half of the fire path. docs/triggers-design.md §2, §11.
 *
 * ⚠️ This module decides whether an unauthenticated packet arriving from a LAN changes what is on a
 * screen. The tests that matter are the refusals, not the happy path.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TR = require('../lib/trigger-resolve');

const SECRET = 'a'.repeat(32);
const TRIGGERS = [
  { id: 't1', name: 'Evac', match_token: 'EVAC', clear_token: 'EVAC_CLR',
    source_http: true, source_udp: true, mode: 'until_cleared' },
  { id: 't2', name: 'UDP only', match_token: 'UDPONLY', clear_token: null,
    source_http: false, source_udp: true, mode: 'once' },
  { id: 't3', name: 'HTTP only', match_token: 'HTTPONLY', clear_token: null,
    source_http: true, source_udp: false, mode: 'once' },
];
const ev = (text, over = {}) => TR.evaluate({
  text, triggers: TRIGGERS, deviceSecret: SECRET, source: 'udp', ...over });

test('a well-formed fire resolves to its trigger', () => {
  const r = ev(`ST1 ${SECRET} EVAC`);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'fire');
  assert.equal(r.trigger.id, 't1');
});

test('a clear token resolves to clear, on the same trigger', () => {
  const r = ev(`ST1 ${SECRET} EVAC_CLR`);
  assert.equal(r.action, 'clear');
  assert.equal(r.trigger.id, 't1');
});

test('a device-level clear-all resolves without naming a trigger', () => {
  const r = ev(`ST1 ${SECRET} ALLSTOP`, { clearAllToken: 'ALLSTOP' });
  assert.equal(r.action, 'clear_all');
  assert.equal(r.trigger, undefined);
});

test('a trailing newline is tolerated — most gear appends one', () => {
  assert.equal(ev(`ST1 ${SECRET} EVAC\n`).action, 'fire');
  assert.equal(ev(`ST1 ${SECRET} EVAC\r\n`).action, 'fire');
});

// ───────────────────────── refusals ─────────────────────────

test('⚠️ the wrong secret is refused, and the reason says so', () => {
  const r = ev(`ST1 ${'b'.repeat(32)} EVAC`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_secret');
});

test('⚠️ a token valid on ANOTHER screen resolves to nothing here', () => {
  // Scoping happened at sync time: this device only holds its own assigned triggers, so a token
  // that is perfectly real elsewhere is simply unknown. No cross-screen firing.
  const r = TR.evaluate({ text: `ST1 ${SECRET} SOMEONE_ELSES`, triggers: TRIGGERS,
    deviceSecret: SECRET, source: 'udp' });
  assert.equal(r.reason, 'unknown_token');
});

test('⚠️ a UDP-only trigger cannot be fired over HTTP', () => {
  // Enabling only UDP says something specific: fired by the panel wired to the alarm, not by
  // anything that can reach the box over HTTP. The device-level flag must not widen that.
  assert.equal(ev('ST1 ' + SECRET + ' UDPONLY', { source: 'http' }).reason, 'unknown_token');
  assert.equal(ev('ST1 ' + SECRET + ' UDPONLY', { source: 'udp' }).action, 'fire');
});

test('⚠️ an HTTP-only trigger cannot be fired over UDP', () => {
  assert.equal(ev('ST1 ' + SECRET + ' HTTPONLY', { source: 'udp' }).reason, 'unknown_token');
  assert.equal(ev('ST1 ' + SECRET + ' HTTPONLY', { source: 'http' }).action, 'fire');
});

test('broadcast noise is rejected on the magic, before any parsing', () => {
  // On subnet broadcast this socket sees mDNS, discovery chatter, a printer announcing itself.
  for (const junk of ['', 'hello', '{"jsonrpc":"2.0"}', 'M-SEARCH * HTTP/1.1']) {
    assert.equal(TR.parseWire(junk).reason, junk === '' ? 'bad_magic' : 'bad_magic');
  }
});

test('an oversized payload is refused before work is done on it', () => {
  const r = TR.parseWire('ST1 ' + SECRET + ' ' + 'x'.repeat(600));
  assert.equal(r.reason, 'too_large');
});

test('a token containing a space cannot arrive — the field count refuses it', () => {
  // The editor refuses this at save time; this is the second line of defence, because the wire
  // format cannot represent it either way.
  assert.equal(TR.parseWire(`ST1 ${SECRET} FIRE ALARM`).reason, 'malformed');
});

test('a missing secret field is malformed, not a bad secret', () => {
  // The distinction matters for the counters: malformed means the sender's format is wrong,
  // bad_secret means the format is right and the credential is not.
  assert.equal(TR.parseWire('ST1 EVAC').reason, 'malformed');
});

test('no configured device secret refuses everything', () => {
  // An unprovisioned device must be inert rather than open.
  const r = TR.evaluate({ text: `ST1 ${SECRET} EVAC`, triggers: TRIGGERS, deviceSecret: '', source: 'udp' });
  assert.equal(r.reason, 'bad_secret');
});

test('secret compare is length-checked', () => {
  assert.equal(TR.secretMatches('abc', 'abc'), true);
  assert.equal(TR.secretMatches('abc', 'abcd'), false);
  assert.equal(TR.secretMatches('', ''), true);
  assert.equal(TR.secretMatches(null, 'abc'), false);
});

// ───────────────────────── rate limiting ─────────────────────────

test('a burst is allowed, then throttled, then recovers', () => {
  const rl = TR.createRateLimiter({ perSec: 5, burst: 3, globalPerSec: 1000 });
  let now = 0;
  assert.equal(rl.allow('10.0.0.1', now), true);
  assert.equal(rl.allow('10.0.0.1', now), true);
  assert.equal(rl.allow('10.0.0.1', now), true);
  assert.equal(rl.allow('10.0.0.1', now), false, 'burst exhausted');
  now += 1000;                                   // one second of refill at 5/s
  assert.equal(rl.allow('10.0.0.1', now), true);
});

test('⚠️ one noisy source cannot starve another', () => {
  const rl = TR.createRateLimiter({ perSec: 1, burst: 2, globalPerSec: 1000 });
  rl.allow('10.0.0.1', 0); rl.allow('10.0.0.1', 0);
  assert.equal(rl.allow('10.0.0.1', 0), false);
  assert.equal(rl.allow('10.0.0.2', 0), true, 'a second source has its own bucket');
});

test('⚠️ a global ceiling stops a spoofed-source flood walking around the per-source limit', () => {
  const rl = TR.createRateLimiter({ perSec: 100, burst: 100, globalPerSec: 3 });
  let allowed = 0;
  for (let i = 0; i < 50; i++) if (rl.allow('10.0.0.' + i, 0)) allowed++;
  assert.equal(allowed, 3, 'each packet from a fresh source would otherwise get a fresh bucket');
});

test('the bucket map is pruned, so a flood is not a slow leak', () => {
  const rl = TR.createRateLimiter({ globalPerSec: 1000 });
  for (let i = 0; i < 20; i++) rl.allow('10.0.0.' + i, 0);
  assert.equal(rl.size, 20);
  rl.prune(400000);
  assert.equal(rl.size, 0);
});

// ───────────────────────── the UMD trap ─────────────────────────

test('⚠️ the module exports BOTH ways, not as an if/else', () => {
  /*
   * A node-enabled BrightSign widget is a browser and a CommonJS context at once. A UMD that tests
   * module.exports first and falls back to the global takes the CommonJS branch there, so
   * window.TriggerResolve is never assigned and every call site silently sees undefined. That has
   * already happened here to transitions, dayparting, mute and wall geometry.
   */
  const src = require('fs').readFileSync(require.resolve('../lib/trigger-resolve.js'), 'utf8');
  const tail = src.slice(src.indexOf('if (typeof module'));
  assert.doesNotMatch(tail, /\belse\b/,
    'an else here means the window global is skipped on a node-enabled widget');
  assert.match(tail, /window\.TriggerResolve = API/);
  assert.match(tail, /module\.exports = API/);
});
