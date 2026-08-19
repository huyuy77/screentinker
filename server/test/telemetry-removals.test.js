'use strict';

/*
 * The Phase −1 removals, and a guard so they cannot come back.
 *
 * ⚠️ A REMOVAL WITHOUT A GUARD IS A DEFERRAL. These fields were dropped for reasons that are not
 * visible from the code — you cannot tell by reading `wifi_ssid` that 94% of its production values
 * were not SSIDs, or that the remaining 6% could place a customer's premises on a map. Somebody
 * adding a "network name" column back in eighteen months would be doing something perfectly
 * reasonable, which is exactly why the reason has to live in a test rather than in a commit message
 * nobody will read.
 *
 * See docs/mesh-telemetry-inventory.md for the measurements.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const COLLECTION_SITES = [
  ['ws', 'deviceSocket.js'],
  ['player', 'index.html'],
  ['routes', 'devices.js'],
];

test('⚠️ wifi_ssid is not collected, stored or served anywhere', () => {
  /*
   * TWO INDEPENDENT REASONS, either sufficient:
   *   1. 94% of it was not an SSID — 'Web Player' ×151,713 (a literal string the web player sent),
   *      'permission' ×41,060 (Android's permission refusal stored verbatim), '<unknown ssid>'
   *      ×34,894. The column had become a de-facto "what kind of player is this", which
   *      devices.client_type already records properly.
   *   2. The 6% that WAS real is the liability: customer network names are geolocatable against
   *      public wardriving databases.
   */
  for (const site of COLLECTION_SITES) {
    const src = read(...site);
    const live = src.split('\n').filter((l) => {
      const t = l.trim();
      // Comments explaining the removal are the point — only real references count.
      return t.includes('wifi_ssid')
        && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('<!--') && !t.startsWith('--');
    });
    assert.deepEqual(live, [], `${site.join('/')} still references wifi_ssid`);
  }
});

test('⚠️ temperature_c IS still collected — the audit nearly got this wrong', () => {
  /*
   * A CORRECTION TO PHASE −1, kept as a test because the reasoning is the valuable part.
   *
   * The audit measured temperature_c at 0 of 248,314 production rows and listed it as "never
   * written — drop". It was removed on that basis, and the removal was WRONG: the field is
   * BrightSign-only, arriving from deviceInfo.getTemperature() in brightsign/st-bridge.js, and
   * production has no BrightSign players at all. The zero measured the FLEET, not the field.
   *
   * This is precisely the "low population means new OR dead" trap the inventory itself warns about —
   * correctly applied to video_mode and attached_display (both BrightSign, both kept) and missed for
   * temperature_c, which is from the same family and the same week.
   *
   * ⚠️ THE GENERAL LESSON: a usage measurement is only as broad as the fleet you measured. Before
   * deleting a field for being unused, check that the platform which writes it is actually present
   * in the sample.
   */
  const src = read('ws', 'deviceSocket.js');
  assert.match(src, /telemetry\.temperature_c/,
    'temperature_c must still be stored — it works, on hardware this fleet does not happen to have');

  const bridge = fs.readFileSync(
    path.join(__dirname, '..', '..', 'brightsign', 'st-bridge.js'), 'utf8');
  assert.match(bridge, /temperature_c/, 'and the BrightSign bridge is what populates it');
});

test('the dropped fields have no grant category, so they cannot travel a mesh edge', () => {
  // A field with no category is never projected — belt and braces on top of the removal itself.
  const mirror = require('../lib/mesh/mirror');
  for (const dropped of ['wifi_ssid']) {
    assert.ok(!(dropped in mirror.FIELD_CATEGORY),
      `${dropped} has a grant category and could be mirrored upward`);
  }
});

test('cpu_usage is rounded at the source', () => {
  /*
   * Stored at full float precision — 34.700234234333, 87,297 distinct values across 248k rows — and
   * no surface has ever displayed more than a whole percent. Rounding is free bandwidth on every mesh
   * hop and a smaller index, for a digit nobody can read.
   */
  const src = read('ws', 'deviceSocket.js');
  assert.match(src, /Math\.round\(telemetry\.cpu_usage \* 10\) \/ 10/,
    'cpu_usage must be rounded before it is stored');
});

test('WHAT SURVIVED, and why — so a future cleanup does not overreach', () => {
  /*
   * ⚠️ Low population means "new" OR "dead", and they are opposite conclusions. video_mode sits at
   * 0.7% and temperature_c sat at 0.0%, but the first shipped for BrightSign nine days before the
   * audit and works correctly. Deleting it as "unused" would have removed a feature that had just
   * been built. Date the column before judging it.
   */
  const src = read('ws', 'deviceSocket.js');
  for (const kept of ['wifi_rssi', 'attached_display', 'video_mode', 'battery_level']) {
    assert.ok(src.includes(kept), `${kept} was kept deliberately and has gone missing`);
  }
});

test('signal strength survived the Wi-Fi removal', () => {
  // The network NAME was the liability; the SIGNAL is what an installer acts on. Removing the card
  // wholesale would have thrown away the useful half with the harmful half.
  const src = read('..', 'frontend', 'js', 'views', 'device-detail.js');
  assert.match(src, /telRssi/, 'the Wi-Fi card must still report signal strength');
  assert.doesNotMatch(src, /ssidLabel/, 'but not the network name');
});
