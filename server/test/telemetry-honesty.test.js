'use strict';

/*
 * Telemetry must not assert what it cannot know.
 *
 * Phase −1 of the mesh directive audited every collected field against production and found one that
 * was simply false: the web player sent `battery_charging: false`, which asserts "this screen is
 * running on battery and is not charging". The web cannot know that — Firefox removed the Battery
 * Status API and Chrome gates it — and the same payload correctly sent `battery_level: null`.
 *
 * The give-away was in the data, not the code: `battery_charging` was populated on 100% of 248,314
 * production rows while `battery_level` sat at 36.4%. A field more complete than the field it
 * qualifies is a field being invented. Nothing in the UI displayed it, so nothing ever looked wrong.
 *
 * ⚠️ WHY THIS MATTERS MORE UNDER THE MESH. A fabricated value on one node is a local curiosity. The
 * same value mirrored upward becomes a fleet-wide fact in someone else's database — and the node
 * receiving it has no way to tell an invented `false` from a measured one. Honesty at the source is
 * the only place this can be fixed, which is invariant I10 applied to correctness rather than access.
 *
 * See docs/mesh-telemetry-inventory.md.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(
  path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** The object literal the web player sends as `telemetry` in its heartbeat. */
function telemetryBlock() {
  const at = PLAYER.indexOf('telemetry: {');
  assert.notEqual(at, -1, 'the heartbeat telemetry block moved or was renamed');
  const open = PLAYER.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < PLAYER.length; i++) {
    if (PLAYER[i] === '{') depth++;
    else if (PLAYER[i] === '}') { depth--; if (depth === 0) return PLAYER.slice(open, i + 1); }
  }
  throw new Error('unbalanced telemetry block');
}

test('the web player reports unknown battery state as null, never as a value', () => {
  const block = telemetryBlock();

  assert.match(block, /battery_charging:\s*null/,
    'battery_charging must be null on a platform with no battery API — false is a claim, not a blank');
  assert.doesNotMatch(block, /battery_charging:\s*(false|true)/,
    'a hardcoded battery_charging asserts something the web cannot measure');
});

test('a field is never more certain than the field it qualifies', () => {
  /*
   * battery_charging only means anything if battery_level is known. If level is hardcoded null here
   * (the web case) then charging must be too — otherwise the payload says "I have no idea what the
   * charge is, but I am certain it is not charging", which is what shipped.
   */
  const block = telemetryBlock();
  const levelNull = /battery_level:\s*null/.test(block);
  if (levelNull) {
    assert.match(block, /battery_charging:\s*null/,
      'battery_level is null, so battery_charging cannot be anything else');
  }
});

test('no telemetry field is hardcoded to a non-null literal it cannot measure', () => {
  /*
   * A guard against the whole shape rather than the one instance. The web player genuinely measures
   * uptime and reports a few labels; everything else it cannot see must be null. A future edit that
   * fills a blank with a plausible-looking constant fails here.
   */
  const block = telemetryBlock();
  const MEASURABLE = new Set([
    'uptime_seconds',       // performance.now(), genuinely known
    'reported_timezone',    // Intl, genuinely known
    'reported_utc',         // the clock, genuinely known
    'wifi_ssid',            // a label today; see the inventory — slated to be dropped entirely
  ]);
  const offenders = [];
  for (const m of block.matchAll(/(\w+):\s*(false|true|0)\s*,/g)) {
    if (!MEASURABLE.has(m[1])) offenders.push(`${m[1]}: ${m[2]}`);
  }
  assert.deepEqual(offenders, [],
    'these assert a measurement the web player cannot take — use null for unknown');
});
