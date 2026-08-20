'use strict';

/*
 * Phase 4 — depth: multi-hop relay, deep skew, subtree re-parenting, and aggregate fidelity.
 *
 * ⚠️ THE CAP IS NOT RAISED HERE, AND THAT IS DELIBERATE. The directive gates it: "raise
 * MESH_MAX_DEPTH only after two-tier has run against real hardware." Nothing has been deployed, so
 * the machinery is built and tested at depth while the DEFAULT stays at 2 — an operator raises it
 * knowingly. A test at the bottom asserts the default has not drifted, because the easiest way to
 * lose a gate like this is for somebody to bump a constant while making the tests pass.
 *
 * ⚠️ AGGREGATE FIDELITY IS THE KNOWN HARD PROBLEM. Per-sample data does not survive many hops, and
 * the failure is not that it gets lost — it is that it gets silently AVERAGED, and a consumer cannot
 * tell a smooth line from a real one. That is where Prometheus federation disappoints people, and it
 * disappoints them late, after a report has been built on it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Mesh } = require('./helpers/mesh-topology');
const envelope = require('../lib/mesh/envelope');
const fidelity = require('../lib/mesh/fidelity');

// A deep chain needs nodes willing to sit at depth; the harness takes the cap per node.
const deep = (m, id, maxDepth = 6) => m.addNode(id, { maxDepth });

// ===== multi-hop relay =====

test('a payload crosses four hops and arrives intact', () => {
  const m = new Mesh();
  ['top', 'region', 'site', 'leaf'].forEach((id) => deep(m, id));
  assert.equal(m.enroll('region', 'top').ok, true);
  assert.equal(m.enroll('site', 'region').ok, true);
  assert.equal(m.enroll('leaf', 'site').ok, true);

  const r = m.emit('leaf', { body: { note: 'from the bottom' } });
  assert.deepEqual(r.delivered, ['site', 'region', 'top'], 'every tier saw it, in order');

  const atTop = m.nodes.get('top').received[0];
  assert.equal(atTop.origin_node_id, 'leaf', 'the ORIGIN survives the journey, not the last sender');
  assert.equal(atTop.body.note, 'from the bottom', 'and the body is unmodified');
});

test('ancestry records the whole path, and each hop stamps its own receipt', () => {
  /*
   * ⚠️ Receipts APPEND. At depth the chain of receipts is the only way to answer "where did the
   * delay happen" — overwriting would leave a single number that says a message was slow without
   * saying which link was slow.
   */
  const m = new Mesh();
  ['top', 'region', 'site'].forEach((id) => deep(m, id));
  m.enroll('region', 'top');
  m.enroll('site', 'region');

  m.emit('site');
  const atTop = m.nodes.get('top').received[0];
  assert.deepEqual(atTop.ancestry, ['site', 'region', 'top']);
  assert.equal(atTop.receipts.length, 2, 'one per hop that handled it');
  assert.deepEqual(atTop.receipts.map((r) => r.node_id), ['region', 'top']);
});

test('an unknown payload relays the whole way down a deep chain (I5)', () => {
  // The relay property has to hold at depth, not just at one hop — a mid-tier node installed a year
  // ago must still carry a payload type invented afterwards.
  const m = new Mesh();
  ['top', 'region', 'site', 'leaf'].forEach((id) => deep(m, id));
  m.enroll('region', 'top'); m.enroll('site', 'region'); m.enroll('leaf', 'site');

  const r = m.emit('leaf', { type: 'invented-in-2028', bodyVersion: 7 });
  assert.deepEqual(r.delivered, ['site', 'region', 'top']);
  for (const id of ['site', 'region', 'top']) {
    assert.equal(m.nodes.get(id).relayed.length, 1, `${id} relayed it`);
    assert.equal(m.nodes.get(id).received.length, 0, `${id} did not try to store it`);
  }
});

// ===== deep skew =====

test('⚠️ DEEP SKEW: the origin\'s clock is still measurable four hops away', () => {
  /*
   * Skew is measured against the FIRST receipt, not the last. At depth the later receipts accumulate
   * real transit time, so comparing against them would measure the network and report it as a clock
   * problem — sending someone to fix an NTP config because a link is slow.
   */
  const m = new Mesh();
  ['top', 'region', 'site'].forEach((id) => deep(m, id));
  m.addNode('skewed', { maxDepth: 6, clockSkewMs: 4 * 60 * 60 * 1000 });
  m.enroll('region', 'top'); m.enroll('site', 'region'); m.enroll('skewed', 'site');

  m.emit('skewed');
  const atTop = m.nodes.get('top').received[0];

  const skew = envelope.clockSkewMs(atTop);
  assert.ok(skew >= 4 * 3600 * 1000 - 5000, `expected ~4h of skew, got ${skew}`);
  assert.equal(envelope.skewIsNotable(atTop), true, 'and it is still flagged at the top');
});

test('transit across hops is not mistaken for clock skew', () => {
  const m = new Mesh();
  ['top', 'region', 'site', 'leaf'].forEach((id) => deep(m, id));
  m.enroll('region', 'top'); m.enroll('site', 'region'); m.enroll('leaf', 'site');

  m.emit('leaf');
  const atTop = m.nodes.get('top').received[0];
  assert.equal(envelope.skewIsNotable(atTop), false,
    'a healthy deep chain must not read as a clock problem');
});

// ===== subtree re-parenting =====

test('⚠️ RE-PARENTING A SUBTREE: identity survives, so history still resolves (I4)', () => {
  /*
   * Moving a site from one region to another is an ordinary MSP event. Because ids encode no
   * position, everything the leaf ever emitted still resolves to the leaf — the display path changes
   * and nothing else. An id that encoded its parent would orphan every historical row at this moment,
   * silently, and only for the customer who reorganised.
   */
  const m = new Mesh();
  ['top', 'regionA', 'regionB', 'site', 'leaf'].forEach((id) => deep(m, id));
  m.enroll('regionA', 'top');
  m.enroll('regionB', 'top');
  const siteEdge = m.enroll('site', 'regionA');
  m.enroll('leaf', 'site');

  m.emit('leaf');
  assert.equal(m.nodes.get('top').received[0].origin_node_id, 'leaf');
  const pathBefore = m.nodes.get('top').received[0].ancestry;

  // Move the whole subtree (site + its leaf) under the other region.
  m.revoke(siteEdge.edgeId);
  assert.equal(m.enroll('site', 'regionB').ok, true, 're-parenting is not a cycle');

  m.emit('leaf');
  const after = m.nodes.get('top').received[1];
  assert.equal(after.origin_node_id, 'leaf', 'the SAME id — history still joins');
  assert.notDeepEqual(after.ancestry, pathBefore, 'only the path changed');
  assert.ok(after.ancestry.includes('regionB'));
});

test('the leaf below a re-parented node needs no changes of its own', () => {
  // It is not told, and does not need to be — its edge is to its site, which did not move.
  const m = new Mesh();
  ['top', 'regionA', 'regionB', 'site', 'leaf'].forEach((id) => deep(m, id));
  m.enroll('regionA', 'top'); m.enroll('regionB', 'top');
  const e = m.enroll('site', 'regionA');
  m.enroll('leaf', 'site');

  const leafEdgesBefore = [...m.nodes.get('leaf').edges.values()].map((x) => x.id);
  m.revoke(e.edgeId);
  m.enroll('site', 'regionB');
  const leafEdgesAfter = [...m.nodes.get('leaf').edges.values()].map((x) => x.id);
  assert.deepEqual(leafEdgesAfter, leafEdgesBefore, 'the leaf is untouched by its grandparent moving');
});

// ===== aggregate fidelity =====

test('⚠️ alerts and current state are FULL FIDELITY at any depth', () => {
  // An alert is an event, not a measurement — averaging it is meaningless. "Current state" that has
  // been smoothed is not current.
  for (const type of ['alert-event', 'node-health', 'device-summary', 'tombstone']) {
    for (const hops of [1, 4, 12]) {
      assert.equal(fidelity.isFullFidelity(type), true, `${type} must survive ${hops} hops intact`);
      assert.equal(fidelity.intervalFor(type, hops), null);
    }
  }
});

test('⚠️ proof-of-play is NEVER downsampled, and not merely by default', () => {
  /*
   * It is on a refuse-list rather than relying on a grant property somebody has to remember to set.
   * The failure is unrecoverable and silent: an averaged play log still LOOKS like a play log, and
   * nobody discovers the problem until they are defending an invoice.
   */
  assert.equal(fidelity.isFullFidelity('proof-of-play'), true);
  assert.equal(fidelity.isFullFidelity('telemetry-series', { category: 'proof-of-play' }), true);
  assert.equal(fidelity.intervalFor('proof-of-play', 5), null, 'at any depth');
});

test('historical telemetry thins per hop, and the interval WIDENS with depth', () => {
  const one = fidelity.intervalFor('telemetry-series', 1);
  const four = fidelity.intervalFor('telemetry-series', 4);
  assert.ok(four > one, 'deeper means coarser');
  // ⚠️ Geometric, because the volume it defends against grows the same way — each hop carries the
  // whole subtree beneath it. Linear widening keeps the ratio constant and loses at depth four.
  assert.equal(four, one * 8);
});

test('a no-downsample grant property overrides thinning', () => {
  assert.equal(
    fidelity.isFullFidelity('telemetry-series', { grantProperties: ['no-downsample'] }), true);
  assert.equal(fidelity.isFullFidelity('telemetry-series', { grantProperties: [] }), false);
});

test('⚠️ THINNING KEEPS THE EXTREMES, NOT THE MEAN', () => {
  /*
   * Nobody asks "what was the average free storage"; they ask "did it ever run out". Averaging a
   * five-minute spike to 100% CPU into an hour of 30% erases the only interesting thing in the
   * window — and erases it in a way that looks like clean data.
   */
  const points = [
    { t: 0, value: 10 }, { t: 10, value: 12 }, { t: 20, value: 100 }, { t: 30, value: 11 },
    { t: 60, value: 9 },
  ];
  const out = fidelity.downsample(points, 60);
  assert.equal(out.length, 2);
  assert.equal(out[0].max, 100, 'the spike survives');
  assert.equal(out[0].min, 10);
  assert.equal(out[0].samples, 4, 'and it says how much was folded to say that');
});

test('⚠️ THE RESOLUTION TRAVELS WITH THE DATA, always', () => {
  /*
   * The part that is easy to skip and is the difference between a thinned series and a lie. Without
   * it a consumer three hops away sees a sparse series and cannot distinguish "sampled every fifteen
   * minutes" from "the screen was off".
   */
  const body = { points: Array.from({ length: 120 }, (_, i) => ({ t: i * 10, value: i })) };
  const r = fidelity.forHop('telemetry-series', body, 3);
  assert.equal(r.fidelity.downsampled, true);
  assert.ok(r.fidelity.intervalSec > 0);
  assert.equal(r.fidelity.hops, 3);
  // Phrased for a person — it ends up on a chart axis, and "240s buckets" means nothing to an
  // operator wondering why their graph differs from the one on the site's own server.
  assert.match(r.fidelity.label, /one point per/);
  assert.match(r.fidelity.label, /thinned 3 hops from the source/);
});

test('even UNTHINNED payloads report their resolution', () => {
  // A consumer must never have to infer that it is looking at raw data. "The field was absent so it
  // is probably raw" is exactly the assumption that turns a thinned series into a wrong conclusion.
  const r = fidelity.forHop('alert-event', { id: 'a1' }, 4);
  assert.equal(r.fidelity.downsampled, false);
  assert.equal(r.fidelity.intervalSec, null);
  assert.match(r.fidelity.reason, /never thinned/i);

  const pop = fidelity.forHop('proof-of-play', { points: [{ t: 1, value: 1 }] }, 4);
  assert.equal(pop.fidelity.downsampled, false);
  assert.match(pop.fidelity.reason, /averaged evidence is not evidence/i);
});

test('the cost of a no-downsample grant is stated BEFORE it is agreed', () => {
  /*
   * ⚠️ Documented rather than discovered. Raw data is re-sent at every hop, which is the part people
   * do not expect — an operator turning this on for a 400-screen site four hops up should see the
   * number, not a bandwidth bill.
   */
  const cost = fidelity.noDownsampleCost({ devices: 400, hops: 4 });
  assert.ok(cost.bytesPerHourAcrossMesh > cost.bytesPerHourAtOrigin);
  assert.equal(cost.bytesPerHourAcrossMesh, cost.bytesPerHourAtOrigin * 4);
  assert.match(cost.note, /re-sent at every hop/i);
});

// ===== the gate =====

test('⚠️ THE DEPTH CAP IS STILL 2 — the machinery is built, not unlocked', () => {
  /*
   * The directive gates this: raise it only after two-tier has run against real hardware. Nothing has
   * been deployed, so the default must not have moved. The easiest way to lose a gate like this is
   * for somebody to bump a constant while making a deep test pass, which is exactly what this
   * catches.
   */
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const env = { ...process.env };
  delete env.MESH_MAX_DEPTH;
  const out = execFileSync(process.execPath,
    ['-e', "console.log(require('./config').meshMaxDepth)"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, env });
  assert.equal(out.trim().split('\n').pop(), '2',
    'MESH_MAX_DEPTH must still default to 2 until two tiers have run on real hardware');
});

test('a third tier is refused under the default cap, with a reason that says how to change it', () => {
  const m = new Mesh();
  m.addNode('top', { maxDepth: 2 });
  m.addNode('mid', { maxDepth: 2 });
  m.addNode('leaf', { maxDepth: 2 });
  m.enroll('mid', 'top');

  const r = m.enroll('leaf', 'mid');
  assert.equal(r.ok, false);
  assert.match(r.reason, /MESH_MAX_DEPTH/);
  assert.match(r.reason, /proven on real hardware/i,
    'the refusal must state the gate, not just the number');
});
