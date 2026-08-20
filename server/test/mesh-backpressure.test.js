'use strict';

/*
 * Bounding what a child may push into its parent.
 *
 * ⚠️ THE PROPERTY THAT MATTERS IS ISOLATION, NOT THE CAP (invariant I6). Any cap stops a parent
 * falling over. Only a PER-CHILD cap stops one noisy site taking out visibility of every other site —
 * and a shared budget is the obvious implementation, which is exactly why it needs a test that would
 * catch someone simplifying back to one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Backpressure, DEFAULTS } = require('../lib/mesh/backpressure');

const T0 = 1_700_000_000_000;

test('THE ISOLATION PROPERTY: one child exhausting its budget leaves the others untouched', () => {
  const bp = new Backpressure({ maxMessages: 5, windowMs: 1000 });
  for (let i = 0; i < 5; i++) assert.equal(bp.admit('loud', 10, T0).ok, true);

  const refused = bp.admit('loud', 10, T0);
  assert.equal(refused.ok, false);
  assert.equal(refused.limit, 'rate');

  assert.equal(bp.admit('quiet', 10, T0).ok, true, 'a sibling must be entirely unaffected');
  assert.deepEqual(bp.throttledChildren(T0), ['loud'], 'and only the offender is named');
});

test('the window rolls, so a throttled child recovers rather than being locked out', () => {
  const bp = new Backpressure({ maxMessages: 2, windowMs: 1000 });
  bp.admit('a', 1, T0); bp.admit('a', 1, T0);
  assert.equal(bp.admit('a', 1, T0).ok, false);
  assert.equal(bp.admit('a', 1, T0 + 1001).ok, true, 'the next window is a clean slate');
});

test('three limits, because they fail differently and the operator must know which', () => {
  // Rate: too many messages.
  const rate = new Backpressure({ maxMessages: 1, windowMs: 1000 });
  rate.admit('a', 1, T0);
  assert.equal(rate.admit('a', 1, T0).limit, 'rate');

  // Bytes: few messages, enormous payloads.
  const bytes = new Backpressure({ maxBytes: 100, windowMs: 1000 });
  assert.equal(bytes.admit('a', 90, T0).ok, true);
  const big = bytes.admit('a', 90, T0);
  assert.equal(big.limit, 'bytes', 'a byte limit catches what a message count cannot');

  // Store: a slow leak that would fill the disk over weeks.
  const store = new Backpressure({ maxStoredRows: 10 });
  store.noteStored('a', 10, T0);
  assert.equal(store.admit('a', 1, T0).limit, 'store');
});

test('⚠️ the STORAGE refusal is not "try again later", because retrying will not help', () => {
  /*
   * Rate and byte limits are transient — wait a window. A storage limit is not, and telling an
   * operator to retry sends them at the wrong problem. It is checked FIRST for the same reason.
   */
  const bp = new Backpressure({ maxStoredRows: 5, maxMessages: 1000 });
  bp.noteStored('a', 5, T0);
  const r = bp.admit('a', 1, T0);
  assert.equal(r.limit, 'store');
  assert.equal(r.retryAfterMs, 0, 'no retry is offered, because none would succeed');
  assert.match(r.reason, /retention|purge/i, 'the reason names the action that WOULD help');

  const rate = new Backpressure({ maxMessages: 1, windowMs: 5000 });
  rate.admit('a', 1, T0);
  assert.ok(rate.admit('a', 1, T0).retryAfterMs > 0, 'a transient limit does say when to retry');
});

test('a refusal names the child and says the blast radius is limited to it', () => {
  // The operator's first question is "is this everything, or just that one?" — answer it in the text.
  const bp = new Backpressure({ maxMessages: 1, windowMs: 1000 });
  bp.admit('acme-site-3', 1, T0);
  const r = bp.admit('acme-site-3', 1, T0);
  assert.match(r.reason, /acme-site-3/);
  assert.match(r.reason, /no other connection is affected/i);
});

test('throttling is COUNTED, not just signalled', () => {
  /*
   * "Throttled 40,000 times since Tuesday" is a different conversation from "throttled twice". Data
   * that vanishes without a trace is worse than data that arrives late, because nobody knows to look.
   */
  const bp = new Backpressure({ maxMessages: 1, windowMs: 1000 });
  bp.admit('a', 1, T0);
  for (let i = 0; i < 7; i++) bp.admit('a', 1, T0);

  const st = bp.statusFor('a', T0);
  assert.equal(st.refused.rate, 7);
  assert.equal(st.lastRefusalAt, T0);
  assert.equal(st.throttled, true);
});

test('a child under its limits reports healthy', () => {
  const bp = new Backpressure({ maxMessages: 10, windowMs: 1000 });
  bp.admit('a', 1, T0);
  const st = bp.statusFor('a', T0);
  assert.equal(st.throttled, false);
  assert.equal(st.messagesThisWindow, 1);
  // ⚠️ `items` joined the counters when batching landed: a batch is one message carrying many
  // payloads, so counting messages alone would let batching walk past the rate limit entirely.
  assert.deepEqual(st.refused, { rate: 0, items: 0, bytes: 0, store: 0 });
});

test('disenrolling a child forgets its budget', () => {
  const bp = new Backpressure({ maxMessages: 1, windowMs: 1000 });
  bp.admit('a', 1, T0);
  assert.equal(bp.admit('a', 1, T0).ok, false);
  assert.equal(bp.forget('a'), true);
  assert.equal(bp.admit('a', 1, T0).ok, true, 're-enrolling starts clean');
});

test('the defaults are sane for a real fleet', () => {
  // A site with 400 screens heartbeating every 10s is ~40/s; the default must not throttle normal
  // operation, or the first thing anyone learns about backpressure is that it is in the way.
  assert.ok(DEFAULTS.maxMessages / (DEFAULTS.windowMs / 1000) >= 40,
    'the sustained rate must clear a large site comfortably');
  assert.ok(DEFAULTS.maxBytes >= 1024 * 1024);
  assert.ok(DEFAULTS.maxStoredRows >= 100_000);
});
