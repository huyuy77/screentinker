'use strict';

/*
 * The UDP transport, EXECUTED against real sockets. docs/triggers-design.md §3.
 *
 * ⚠️ The claim being tested is that unicast, subnet broadcast and multicast are ONE socket and one
 * code path, not three. A structural reading cannot establish that; sending three genuinely
 * different kinds of datagram at one bind and watching all three arrive can.
 *
 * ⚠️ And the rejoin is the part with real field risk. A switch doing IGMP snooping stops forwarding
 * a group when it misses a membership report, and NOTHING on the host looks wrong — the socket is
 * bound, the membership is still held locally, datagrams just stop. Calling addMembership() again
 * when already a member returns EADDRINUSE and emits no fresh report, so the obvious "re-add on a
 * timer" is a no-op against the exact failure it was written for. Drop-then-add is what puts a real
 * report on the wire, and that is asserted here.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const os = require('node:os');
const TR = require('../lib/trigger-resolve.js');
const { freePort } = require('./helpers/free-port');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SECRET = 'u'.repeat(16);
const GROUP = '239.255.42.9';         // test group, out of the way of the shipped default

let api, fired, PORT;
/*
 * ⚠️ Whether a multicast datagram loops back to this host is a property of the ENVIRONMENT, not of
 * the code under test. A container or CI runner can perfectly reasonably not deliver it. Probing
 * once and skipping with a named reason is honest; asserting blindly would make this file flaky,
 * and a flaky test in a suite this size teaches people to re-run rather than to read.
 */
let multicastWorks = false;

function boot(port, over = {}) {
  const start = PLAYER.indexOf('    let triggerActive = null;');
  const end = PLAYER.indexOf('    // ==================== PiP overlay');
  const src = PLAYER.slice(start, end);
  const out = [];
  const env = {
    window: { TriggerResolve: TR, __debugLog_push() {} },
    document: {
      getElementById: () => ({ innerHTML: '', appendChild() {}, style: {} }),
      createElement: () => ({ style: { cssText: '' }, className: '', appendChild() {} }),
    },
    console: { log() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Number, Array, String, Math, require,
    socket: null,
    config: { deviceId: 'd1' },
    triggers: [{
      id: 't1', name: 'Evac', match_token: 'EVAC', clear_token: 'EVAC_CLR',
      source_http: false, source_udp: true, mode: 'until_cleared',
      items: [{ content_id: 'c1', duration_sec: 5 }],
    }],
    triggerConfig: { accept_udp: true, secret: SECRET, udp_port: port, multicast_group: GROUP },
    showZoneItem: (zone, div, items, i) => out.push({ zone: zone.id, i }),
    ...over,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return { handleTrigger, startTriggerUdp, stats: triggerStats,
      active: () => triggerActive,
      joinGroup: (why) => triggerJoinGroup(triggerUdpSocket, ${JSON.stringify(GROUP)}, why),
      stop: () => {
        try { if (triggerRejoinTimer) clearInterval(triggerRejoinTimer); } catch (e) {}
        try { if (triggerUdpSocket) triggerUdpSocket.close(); } catch (e) {}
        try { if (triggerHttpServer) triggerHttpServer.close(); } catch (e) {}
      } };`);
  return { api: fn(...names.map((n) => env[n])), out };
}

/** Send one datagram and wait a beat for it to be handled. */
function send(text, host, port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.bind(() => {
      try { s.setBroadcast(true); } catch (e) { /* not needed for unicast */ }
      s.send(Buffer.from(text), port, host, (err) => {
        s.close();
        if (err) return reject(err);
        setTimeout(resolve, 150);
      });
    });
  });
}

before(async () => {
  PORT = await freePort();
  const b = boot(PORT);
  api = b.api; fired = b.out;
  api.startTriggerUdp();
  await new Promise((r) => setTimeout(r, 300));

  const before = api.stats.received;
  try { await send(`ST1 ${SECRET} PROBE_NOT_A_TOKEN`, GROUP, PORT); } catch (e) { /* no route */ }
  multicastWorks = api.stats.received > before;
});
// ⚠️ A bound socket and a live interval both hold the process open.
after(() => { try { api && api.stop(); } catch (e) { /* already gone */ } });

test('the socket binds and reports its port', () => {
  assert.equal(api.stats.listeners.udp, PORT);
});

test('it joined the multicast group, on a named interface', () => {
  const m = api.stats.multicast;
  assert.ok(m, 'no multicast state recorded');
  assert.equal(m.group, GROUP);
  assert.ok(m.joined_at, 'join time is what tells an installer the membership is current');
  assert.equal(m.last_join_error, null, `join failed: ${m.last_join_error}`);
});

test('⚠️ UNICAST arrives at the same bind', async () => {
  const before = api.stats.accepted;
  await send(`ST1 ${SECRET} EVAC`, '127.0.0.1', PORT);
  assert.equal(api.stats.accepted, before + 1);
  assert.equal(api.active().trigger.name, 'Evac');
});

test('⚠️ MULTICAST arrives at the same bind — no second socket, no second code path', async (t) => {
  if (!multicastWorks) return t.skip('multicast does not loop back in this environment');
  const before = api.stats.received;
  await send(`ST1 ${SECRET} EVAC_CLR`, GROUP, PORT);
  assert.ok(api.stats.received > before, 'the multicast datagram never reached the handler');
  assert.equal(api.active(), null, 'and it resolved to the clear, through the shared handler');
});

test('a datagram that is not ours is rejected, but still counted as arriving', async () => {
  const before = { r: api.stats.received, bad: api.stats.rejected.bad_magic };
  await send('SSDP NOTIFY * HTTP/1.1', '127.0.0.1', PORT);
  assert.equal(api.stats.received, before.r + 1);
  assert.equal(api.stats.rejected.bad_magic, before.bad + 1);
  /*
   * ⚠️ This is the distinction the whole diagnostic rests on. An installer asking "is multicast
   * reaching this player?" gets a real answer only because noise increments last_datagram_at too:
   * traffic arriving with zero accepts is a token/secret problem, nothing arriving is a network
   * problem, and they are different site visits.
   */
  assert.ok(api.stats.last_datagram_at);
});

test('an oversized datagram is refused without doing work on it', async () => {
  const before = api.stats.rejected.too_large;
  await send(`ST1 ${SECRET} ${'x'.repeat(700)}`, '127.0.0.1', PORT);
  assert.equal(api.stats.rejected.too_large, before + 1);
});

test('⚠️ REJOIN drops before it adds, so a real IGMP report goes out', () => {
  /*
   * addMembership() on a group you are already in returns EADDRINUSE and emits nothing. If the
   * rejoin were add-only it would throw here on the second call and record a join error — and,
   * worse, would never have refreshed the membership a snooping switch is waiting to hear about.
   * A clean rejoin with no error is the evidence that the drop happened first.
   */
  const before = api.stats.multicast.rejoin_count || 0;
  api.joinGroup('rejoin');
  const m = api.stats.multicast;
  assert.equal(m.last_join_error, null,
    'a re-add without a drop reports EADDRINUSE — the membership was never refreshed');
  assert.equal(m.rejoin_count, before + 1);
  assert.ok(m.joined_at, 'the join timestamp advances so staleness is visible');
});

test('multicast still receives AFTER a rejoin', async (t) => {
  if (!multicastWorks) return t.skip('multicast does not loop back in this environment');
  // The rejoin must leave the socket in a working state, not merely in a state that logs cleanly.
  const before = api.stats.received;
  await send(`ST1 ${SECRET} EVAC`, GROUP, PORT);
  assert.ok(api.stats.received > before, 'the group stopped being received after a rejoin');
});

test('the interface picker skips loopback and bridges', () => {
  const pick = TR.pickMulticastInterface({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'br-abc': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    eth0: [{ family: 'IPv4', address: '192.168.1.50', internal: false }],
  });
  assert.equal(pick, '192.168.1.50',
    'joining on a docker bridge succeeds silently and receives nothing — the worst outcome');
  assert.equal(TR.pickMulticastInterface({}), null);
  assert.equal(TR.pickMulticastInterface(null), null);
});

test('the picker accepts the numeric family older Node reports', () => {
  assert.equal(TR.pickMulticastInterface({ eth0: [{ family: 4, address: '10.0.0.5', internal: false }] }),
    '10.0.0.5');
});

test('the listener stays shut when the device was never told to open it', async () => {
  const b = boot(await freePort(), { triggerConfig: { accept_udp: false, secret: SECRET } });
  b.api.startTriggerUdp();
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.ok(!b.api.stats.listeners.udp,
      'one datagram to a broadcast address reaches every player on the LAN — this must be opt-in');
  } finally { b.api.stop(); }
});

test('a real interface exists to join on, so the test above is not vacuous', () => {
  // If CI had no non-loopback IPv4 the join would silently fall back to the default interface and
  // the multicast assertions would prove less than they appear to.
  assert.ok(TR.pickMulticastInterface(os.networkInterfaces()),
    'no usable interface on this host — the multicast results here are not meaningful');
});
