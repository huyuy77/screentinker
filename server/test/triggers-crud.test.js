'use strict';

/*
 * Trigger definitions: the CRUD surface. docs/triggers-design.md.
 *
 * The assertions that matter here are not "does POST return 200". They are the four constraints
 * that are invisible until they cost someone a site visit:
 *
 *   - a token containing a space is unparseable on the wire and must be refused at save time
 *   - a target playlist in ANOTHER workspace must be refused, or a trigger pins and displays another
 *     tenant's content and no device-side check can catch it
 *   - two triggers must not share a match_token, or one token resolves to whichever row is read first
 *   - lease_sec on a `once` trigger is a field that can never apply
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-trig-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, playlistId, deviceId;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // First user on a self-hosted install is the admin.
  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `trig${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Trig',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  const pl = await (await fetch(BASE + '/api/playlists', J(jwt, { name: 'Alarm loop' }))).json();
  playlistId = pl.id;

  /*
   * ⚠️ A device is created by PAIRING, not by an API call — POST /api/devices is a 404. So the
   * harness inserts one the way the other suites do, with a direct handle on the same file. The
   * server holds the db open; WAL makes a second writer fine.
   */
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby', workspaceId, 'offline');
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const base = () => ({
  name: 'Evacuate', match_token: 'EVAC', clear_token: 'EVAC_CLR',
  mode: 'until_cleared', target_kind: 'playlist', target_ref: playlistId,
  priority: 100, source_udp: true,
});

test('a trigger is created, read back, and carries its assignments', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'CREATE_OK',
    assignments: [{ target_type: 'device', target_id: deviceId }] }));
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.mode, 'until_cleared');
  assert.equal(t.target_kind, 'playlist');
  assert.equal(t.target_ref, playlistId);
  assert.deepEqual(t.assignments, [{ target_type: 'device', target_id: deviceId }]);

  const got = await (await fetch(BASE + '/api/triggers/' + t.id,
    { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(got.id, t.id);
});

/*
 * ⚠️ THE WIRE FORMAT DECIDES THE CHARSET. The UDP payload is `ST1 <secret> <token>` — space
 * separated, one line, because that is what a Crestron SendString can emit. A token with a space in
 * it is unparseable on arrival and a token with a newline lets one datagram look like two. Save time
 * is the only place this can be refused with an error anyone can act on.
 */
test('a match_token containing a space is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'FIRE ALARM' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no spaces/);
});

test('a match_token containing a newline is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'A\nB' }));
  assert.equal(r.status, 400);
});

test('fire and clear tokens must differ', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'SAME', clear_token: 'SAME' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /must differ/);
});

test('⚠️ two triggers cannot share a match_token', async () => {
  // Otherwise one datagram resolves to whichever row is read first, which is a coin toss that looks
  // like a flaky trigger rather than a configuration error.
  const a = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'DUP' }));
  assert.equal(a.status, 200);
  const b = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), name: 'Other', match_token: 'DUP' }));
  assert.equal(b.status, 400);
  assert.match((await b.json()).error, /already used/);
});

test('the target playlist must exist in this workspace', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'BADREF', target_ref: crypto.randomUUID() }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /playlist in this workspace/);
});

test("v1 refuses target_kind 'url' rather than storing something it cannot pin", async () => {
  // 'url' is designed (schema hook is there) and deliberately not built: an arbitrary URL cannot be
  // pinned in the offline cache, which is the guarantee the whole feature exists for.
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'URLKIND', target_kind: 'url', target_url: 'https://example.com/x.png' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not built/);
});

test('lease_sec is refused on a once trigger, where it could never apply', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'ONCELEASE', mode: 'once', lease_sec: 90 }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /until_cleared/);
});

test('lease_sec is stored on an until_cleared trigger', async () => {
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'LEASED', lease_sec: 90 }))).json();
  assert.equal(t.lease_sec, 90);
});

test('assigning a device from another workspace is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'XWS',
    assignments: [{ target_type: 'device', target_id: crypto.randomUUID() }] }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not found in this workspace/);
  // ...and the trigger row must not survive a rejected assignment.
  const list = await (await fetch(BASE + '/api/triggers',
    { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(list.triggers.filter(t => t.match_token === 'XWS').length, 0,
    'a trigger was left behind after its assignments were rejected');
});

test('delete removes the trigger and its assignments cascade', async () => {
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'DELME',
    assignments: [{ target_type: 'device', target_id: deviceId }] }))).json();
  const d = await fetch(BASE + '/api/triggers/' + t.id, J(jwt, undefined, 'DELETE'));
  assert.equal(d.status, 200);
  const after = await fetch(BASE + '/api/triggers/' + t.id, { headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(after.status, 404);
});
