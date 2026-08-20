'use strict';

/*
 * The mesh hard invariants, one named test each.
 *
 * ⚠️ THESE ARE NOT UNIT TESTS OF A FEATURE. They are the enforcement of architectural decisions that
 * cannot be inferred from reading any single file — which is exactly the kind of rule that erodes
 * when outside contributors and bot PRs are landing. Every one of them is listed in ARCHITECTURE.md
 * with the name of the test that holds it up, so a reviewer can check the rule is still guarded
 * without reading the implementation.
 *
 * Several are deliberately SOURCE-LEVEL assertions rather than behavioural ones. A behavioural test
 * can only prove that a downward command handler did not fire in the cases it thought to try; a
 * source assertion proves there is no handler to fire. For invariants whose whole value is absence,
 * absence is the thing to test.
 *
 * See docs/mesh-directive.md.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MESH_DIR = path.join(__dirname, '..', 'lib', 'mesh');
const grants = require('../lib/mesh/grants');
const capabilities = require('../lib/mesh/capabilities');
const envelope = require('../lib/mesh/envelope');
const identity = require('../lib/mesh/node-identity');

const meshSources = () =>
  fs.readdirSync(MESH_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(MESH_DIR, f), 'utf8') }));

// ===== I2 — upward only =====

test('test_no_downward_command_handler (I2)', () => {
  /*
   * The child implements NO downward command handler at all. Tolerance — "ignore what you don't
   * understand" — is forward-compatibility and does not enforce this: a handler that ignores unknown
   * commands still executes the ones it knows. The absence of the handler is the enforcement, so the
   * absence is what is tested.
   */
  const forbidden = /on\s*\(\s*['"]mesh:(command|exec|reboot|push|apply|set)/i;
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, forbidden,
      `${file} registers a handler for a parent-issued command — 2.0 is observation only (I2)`);
  }
});

test('write grants are modelled but refused (I2)', () => {
  // They exist in the vocabulary so an edge stored today stays valid when Phase 5 lands, and so an
  // operator reading the model is not surprised later by a permission that appeared from nowhere.
  assert.ok(grants.ALL_WRITE.length > 0, 'write categories should exist in the model');
  for (const w of grants.ALL_WRITE) {
    const v = grants.validateGrant([w]);
    assert.equal(v.ok, false, `${w} must be refused in 2.0`);
    assert.match(v.reason, /not available in this version/i);
    assert.match(v.reason, /observation only|flows upward/i,
      'the refusal must explain the direction rule, not just say no');
  }
});

test('content redistribution is refused until Phase 5 (I2)', () => {
  const v = capabilities.validateCapabilities(['redistributes-content'], { acceptEnrollment: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not available in this version/i);
  assert.ok(!capabilities.AVAILABLE_NOW.includes('redistributes-content'));
});

// ===== I3 — no cycles =====

test('test_cycle_refused_by_reachability_not_prefix (I3)', () => {
  /*
   * ⚠️ Multi-parent is permitted, so the graph is a DAG and a path-prefix check is wrong: under
   * multi-parent a legitimate message routinely arrives whose ancestry is not a prefix of anything
   * local, and prefix matching would refuse it. Membership in the recorded ancestry is the test.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 1,
    ancestry: ['node-a', 'node-b'], originTs: 1000, body: {},
  });
  assert.equal(envelope.wouldLoop(env, 'node-b'), true, 'a node already in the ancestry is a loop');
  assert.equal(envelope.wouldLoop(env, 'node-c'), false, 'an unrelated node is not a loop');

  // The DAG case: a second parent whose id is nowhere in this path must be accepted.
  const viaOtherParent = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 1,
    ancestry: ['node-a', 'node-x'], originTs: 1000, body: {},
  });
  assert.equal(envelope.wouldLoop(viaOtherParent, 'node-b'), false,
    'multi-parent delivery must not be mistaken for a cycle');
});

// ===== I4 — identity is position-independent =====

test('test_node_id_encodes_no_position (I4)', () => {
  const id = identity.newNodeId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'a node id must be a plain v4 UUID — no path, parent or role encoded in it');
  assert.notEqual(identity.newNodeId(), id, 'ids must not be derived from anything stable');
});

// ===== I5 — opaque relay =====

test('test_unknown_payload_is_relayed_not_dropped (I5)', () => {
  /*
   * An intermediate node forwards what it cannot parse. Refusing unknown types would mean every node
   * on a path had to be upgraded before any new payload could travel — the coupling the
   * envelope/body split exists to prevent.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'something-invented-in-2027', bodyVersion: 9,
    ancestry: ['node-a'], originTs: 1000, body: { opaque: true },
  });
  const v = envelope.validateEnvelope(env, { thisNodeId: 'node-b' });
  assert.equal(v.ok, true, 'an unknown payload type must not be an error');
  assert.equal(v.relayOnly, true, 'and must be marked relay-only rather than stored');
});

test('a newer version of a KNOWN payload is also relay-only, not misread (I5)', () => {
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 99,
    ancestry: ['node-a'], originTs: 1000, body: {},
  });
  const v = envelope.validateEnvelope(env, { thisNodeId: 'node-b' });
  assert.equal(v.relayOnly, true, 'a body newer than we understand must not be parsed as if it were ours');
});

// ===== I7 — no phone home =====

test('test_no_phone_home (I7)', () => {
  /*
   * No license check, no activation, no usage beacon, no central registry. Air-gapped is a
   * first-class install, and it cannot be if identity or enrollment needs the internet.
   */
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, /fetch\s*\(|https?:\/\/(?!\s)/,
      `${file} contains a network call or a hardcoded URL — mesh identity and pairing are local (I7)`);
  }
});

// ===== I9 — no built-in relay address, no automatic fallback =====

test('test_no_builtin_relay_address (I9)', () => {
  /*
   * ⚠️ This is how a peer architecture quietly becomes hub-and-spoke, and it always arrives as a bug
   * fix: a connection fails, someone adds a "sensible default" relay, and now every deployment
   * depends on a host the vendor operates. There is never a compiled-in address.
   */
  const HOSTNAME = /(screentinker\.com|relay\.|\.amazonaws\.|\.cloudfront\.|stun:|turn:)/i;
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, HOSTNAME,
      `${file} names a host — a relay address must always come from the operator (I9)`);
  }
});

test('test_no_automatic_relay_fallback (I9)', () => {
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, /fallback\s*(to)?\s*relay|relayFallback|autoRelay/i,
      `${file} suggests an automatic reroute — a failed direct connection must fail visibly (I9)`);
  }
});

// ===== I10 — enforcement lives with the data owner =====

test('test_grant_defaults_to_denied (I10)', () => {
  // An empty grant is valid and yields nothing. There is no wildcard, so a category added in a later
  // version cannot retroactively widen an edge that was agreed before it existed.
  assert.equal(grants.grantAllows([], 'health'), false);
  assert.equal(grants.grantAllows(['health'], 'proof-of-play'), false);
  assert.equal(grants.grantAllows(['health'], 'health'), true);
  for (const wildcard of ['*', 'all', 'any']) {
    assert.equal(grants.grantAllows([wildcard], 'health'), false,
      `"${wildcard}" must not act as a wildcard`);
  }
});

test('the public WAN address is separately deniable from the LAN address (I10)', () => {
  /*
   * Phase −1 found devices.ip_address populated for 509 of 509 production devices with PUBLIC
   * addresses, which locate a client's premises. A health-only grant that still shipped them would
   * fail the security review this vocabulary exists for.
   */
  assert.ok(grants.ALL_READ.includes('network-lan'));
  assert.ok(grants.ALL_READ.includes('network-wan'));
  assert.equal(grants.grantAllows(['network-lan'], 'network-wan'), false,
    'granting LAN visibility must not imply the public address');
});

test('screenshots are separately deniable from display state (I10)', () => {
  assert.equal(grants.grantAllows(['display'], 'display-capture'), false,
    'knowing the video mode must not imply permission to see the screen contents');
});

// ===== the dropped field must not reappear as a grant category =====

test('wifi_ssid is not a grant category (Phase −1)', () => {
  // 94% of its production values were not SSIDs, and the remainder were geolocatable customer
  // network names. It is being dropped, so it must never acquire a category to be granted through.
  for (const c of [...grants.ALL_READ, ...grants.ALL_WRITE]) {
    assert.doesNotMatch(c, /ssid/i, `${c} reintroduces the dropped Wi-Fi SSID field`);
  }
});

// ===== schema =====

test('every existing install becomes a node with zero edges (migration is a no-op)', () => {
  /*
   * The guarantee that Phase 0 cannot break anyone on 1.9.x: the tables exist and are empty, and
   * with both feature flags off nothing reads them.
   *
   * ⚠️ Runs in a CHILD PROCESS. config.js resolves DATA_DIR once at module load, so setting the env
   * var from inside an already-running suite is read too late and the schema lands in the developer's
   * real data directory instead of a throwaway one.
   */
  const { execFileSync } = require('node:child_process');
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-schema-'));
  try {
    const probe = `
      require('./db/database.js');
      const { Database } = require('./db/sqlite-driver');
      const db = new Database(require('path').join(process.env.DATA_DIR, 'db', 'remote_display.db'));
      const tables = db.prepare("select name from sqlite_master where type='table' and name like 'mesh%'")
        .all().map(r => r.name).sort();
      const edgeCols = db.prepare("select name from pragma_table_info('mesh_edges')").all().map(r => r.name);
      const edges = db.prepare('select count(*) c from mesh_edges').get().c;
      const mirrorCounts = {};
      for (const t of ['mesh_mirror_nodes','mesh_mirror_devices','mesh_mirror_alerts','mesh_mirror_play_logs']) {
        mirrorCounts[t] = db.prepare('select count(*) c from ' + t).get().c;
      }
      db.close();
      console.log('MESH_PROBE=' + JSON.stringify({ tables, edgeCols, edges, mirrorCounts }));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test' },
    });
    const line = out.split('\n').find((l) => l.startsWith('MESH_PROBE='));
    assert.ok(line, `probe produced no result:\n${out.slice(-500)}`);
    const { tables, edgeCols, edges, mirrorCounts } = JSON.parse(line.slice('MESH_PROBE='.length));

    /*
     * ⚠️ An EXACT list, not a subset check. It exists to notice a table appearing, which is how this
     * assertion earned its keep — the four mesh_mirror_* tables tripped it the moment Phase 2's
     * storage landed. A `.includes()` check would have accepted them silently, and a new table that
     * nobody reviewed is precisely the thing worth a failing test.
     */
    assert.deepEqual(tables, [
      'mesh_client_access', 'mesh_clients', 'mesh_edges',
      'mesh_mirror_alerts', 'mesh_mirror_devices', 'mesh_mirror_nodes', 'mesh_mirror_play_logs',
      'mesh_node', 'mesh_pairing_codes', 'mesh_tombstones',
    ]);

    // Still empty on a fresh install: tables exist, nothing is mirrored until something is paired.
    for (const t of ['mesh_mirror_nodes', 'mesh_mirror_devices', 'mesh_mirror_alerts',
                     'mesh_mirror_play_logs']) {
      assert.equal(mirrorCounts[t], 0, `${t} must be empty on an install that has never paired`);
    }
    assert.equal(edges, 0,
      'a fresh install must have zero edges — pairing is the only thing that creates one');
    // ⚠️ Edges are a table precisely so that multi-parent stays possible.
    assert.ok(!edgeCols.includes('parent_id'), 'a parent pointer forecloses multi-parent (see design)');
    for (const required of ['peer_node_id', 'role_capabilities', 'grant_categories',
                            'transport_direction', 'tls_verify', 'client_id']) {
      assert.ok(edgeCols.includes(required), `mesh_edges is missing ${required}`);
    }
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

// ===== I1 — autonomy / invisibility =====

test('test_mesh_off_by_default (I1)', () => {
  /*
   * With both flags off there is no new UI, no new route, no background work. A user who never sets
   * them must not be able to tell the mesh exists — and a node is fully functional with no parent, so
   * a parent is an observer and never a dependency.
   *
   * Read in a child process with a scrubbed environment: this developer machine, or a CI job, could
   * have either variable set for other reasons, and a default that only holds when nobody looked is
   * not a default.
   */
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.MESH_ACCEPT_ENROLLMENT;
  delete env.MESH_ALLOW_UPLINK;
  delete env.MESH_MAX_DEPTH;
  delete env.MESH_MIN_NODE_VERSION;

  const out = execFileSync(process.execPath,
    ['-e', "const c=require('./config');console.log(JSON.stringify({a:c.meshAcceptEnrollment,u:c.meshAllowUplink,d:c.meshMaxDepth,v:c.meshMinNodeVersion}))"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, env });
  const cfg = JSON.parse(out.trim().split('\n').pop());

  assert.equal(cfg.a, false, 'MESH_ACCEPT_ENROLLMENT must default OFF');
  assert.equal(cfg.u, false, 'MESH_ALLOW_UPLINK must default OFF');
  assert.equal(cfg.d, 2, 'depth stays capped at 2 until Phase 4');
  assert.equal(cfg.v, '2.0.0-0', 'the version floor must be stated, not absent');
});

test('a capability requiring enrollment is refused while the flag is off (I1)', () => {
  const v = capabilities.validateCapabilities(['accepts-enrollment'], { acceptEnrollment: false });
  assert.equal(v.ok, false);
  assert.match(v.reason, /MESH_ACCEPT_ENROLLMENT/,
    'the refusal must name the flag an operator has to set, not just decline');
});

// ===== version floor =====

test('a node below the version floor is refused with a readable reason', () => {
  assert.equal(identity.versionAcceptable('2.0.0'), true);
  assert.equal(identity.versionAcceptable('2.1.3'), true);
  assert.equal(identity.versionAcceptable('1.9.39'), false, '1.9.x cannot speak mesh at all');
  // ⚠️ An unparseable version is refused, not waved through: a peer that cannot state its version
  // cannot be held to a contract, and "unknown" is what a broken or hostile peer reports.
  assert.equal(identity.versionAcceptable('garbage'), false);
  assert.match(identity.versionRefusalReason('1.9.39'), /requires 2\.0\.0-0 or newer/);
  assert.match(identity.versionRefusalReason('garbage'), /not a version this node can compare/);
});

test('a duplicate node id on a second edge is refused, not merged', () => {
  /*
   * Cloning a VM is routine MSP practice and the clone carries its parent's node id. Two machines
   * reporting one identity interleave their histories permanently, with no field left to separate
   * them. Refusing the SECOND keeps the node that was already reporting alive while the operator
   * fixes the clone.
   */
  const existing = { edge_id: 'edge-1' };
  const same = identity.checkDuplicateNodeId('node-a', () => existing, 'edge-1');
  assert.equal(same.ok, true, 'the same edge re-presenting its own id is not a duplicate');

  const clone = identity.checkDuplicateNodeId('node-a', () => existing, 'edge-2');
  assert.equal(clone.ok, false);
  assert.equal(clone.duplicate, true);
  assert.match(clone.reason, /cloned VM|disk image/i,
    'the reason must tell the operator what actually happened, not just "duplicate"');
});

// ===== clock =====

test('skew is measured and surfaced rather than silently reordering history', () => {
  /*
   * Never order events by a single clock: the nodes are other people's machines. A site server two
   * hours ahead would silently interleave its alerts into the middle of yesterday in a hub's inbox,
   * with nothing on screen explaining why the story does not add up.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'alert-event', bodyVersion: 1,
    ancestry: ['node-a'], originTs: 1_000_000, body: {},
  });
  assert.equal(envelope.clockSkewMs(env), null, 'no receipt yet — skew is unknown, not zero');

  const stamped = envelope.stampReceipt(env, 'node-b', 1_000_500);
  assert.equal(envelope.clockSkewMs(stamped), -500, 'origin behind receiver reads negative');
  assert.equal(envelope.skewIsNotable(stamped), false, 'half a second is transit, not a story');

  const skewed = envelope.stampReceipt(env, 'node-b', 1_000_000 + 3 * 60 * 60 * 1000);
  assert.equal(envelope.skewIsNotable(skewed), true, 'three hours must be surfaced to an operator');

  // ⚠️ Receipts append. Overwriting the first would destroy the only evidence of where a delay or a
  // skew was introduced — which is the question being asked when anyone looks at this.
  const twoHops = envelope.stampReceipt(stamped, 'node-c', 1_001_000);
  assert.equal(twoHops.receipts.length, 2);
  assert.equal(twoHops.receipts[0].node_id, 'node-b');
});
