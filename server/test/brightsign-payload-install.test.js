'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const installer = require('../../brightsign/server/bs-payload-install.js');

/*
 * THE POINT OF THIS FILE: a payload update must never eat the database.
 *
 * The installer replaces the server tree wholesale - it deletes each top-level directory before
 * moving the new one into place. That is only safe because runtime state (database, uploads,
 * certs, .jwt_secret) lives in DATA_DIR, OUTSIDE that tree. On the first player this was not true:
 * the launcher computed DATA_DIR for its own display but never exported it, so server/config.js
 * fell back to its own __dirname and wrote the database into server/db - inside the tree the
 * installer deletes. Nothing failed. The database was simply going to disappear on the first
 * update, silently, on a device in someone else's building.
 *
 * So these tests assert the property directly - update, then check the bytes are still there -
 * rather than asserting that some variable is set.
 */

/* --------------------------------------------------------------------------------------------
 * A minimal STORED zip writer.
 *
 * Built here rather than shelling out to `zip` so the test has no external dependency, and because
 * hand-writing the format is what lets the malformed cases below exist at all - there is no way to
 * ask `zip` for an entry named "../escape.txt".
 * ------------------------------------------------------------------------------------------ */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contentRaw] of entries) {
    const content = Buffer.from(contentRaw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(content) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // method 0 = STORED
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, nameBuf, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);          // method
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + content.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

/* Serve one buffer over real HTTP - install() speaks http, so the test should too. */
async function serve(buf) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/payload.zip`,
           close: () => new Promise((r) => server.close(r)) };
}

const PAYLOAD = [
  ['server/', ''],
  ['server/server.js', 'module.exports = "v1";\n'],
  ['server/routes/', ''],
  ['server/routes/api.js', 'module.exports = 1;\n'],
  ['frontend/', ''],
  ['frontend/index.html', '<h1>v1</h1>\n'],
];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a fresh install unpacks the tree', async () => {
  const { dir, cleanup } = scratch();
  const s = await serve(makeZip(PAYLOAD));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    const r = await installer.install({ url: s.url, installDir: dir });
    assert.strictEqual(fs.existsSync(path.join(dir, 'server', 'server.js')), true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'frontend', 'index.html'), 'utf8'), '<h1>v1</h1>\n');
    assert.ok(r.files >= 3);
    // The archive is 70-odd MB in production and useless once unpacked.
    assert.strictEqual(fs.existsSync(path.join(dir, 'server-payload.zip')), false);
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('THE POINT: an update leaves the database, uploads and jwt secret untouched', async () => {
  const { dir, cleanup } = scratch();
  const dataDir = path.join(dir, 'data');
  try {
    // A device that has been running: state in DATA_DIR, and a previous payload installed.
    fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'uploads', 'content'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'certs'), { recursive: true });
    const dbBytes = Buffer.from('SQLite format 3\0real customer data');
    fs.writeFileSync(path.join(dataDir, 'db', 'remote_display.db'), dbBytes);
    fs.writeFileSync(path.join(dataDir, 'uploads', 'content', 'video.mp4'), 'MP4');
    fs.writeFileSync(path.join(dataDir, 'certs', '.jwt_secret'), 'per-install-secret');
    process.env.DATA_DIR = dataDir;

    const first = await serve(makeZip(PAYLOAD));
    await installer.install({ url: first.url, installDir: dir });
    await first.close();

    // Now push an update: different contents, same shape.
    const v2 = PAYLOAD.map(([n, c]) => [n, String(c).replace(/v1/g, 'v2')]);
    const second = await serve(makeZip(v2));
    await installer.install({ url: second.url, installDir: dir });
    await second.close();

    // The new code is in place...
    assert.strictEqual(fs.readFileSync(path.join(dir, 'frontend', 'index.html'), 'utf8'), '<h1>v2</h1>\n');
    // ...and every byte of state survived it.
    assert.deepStrictEqual(fs.readFileSync(path.join(dataDir, 'db', 'remote_display.db')), dbBytes);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'uploads', 'content', 'video.mp4'), 'utf8'), 'MP4');
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'certs', '.jwt_secret'), 'utf8'), 'per-install-secret');
  } finally { cleanup(); delete process.env.DATA_DIR; }
});

test('refuses to install at all if DATA_DIR sits inside the tree it replaces', async () => {
  // The exact misconfiguration that shipped to the first player: state under server/, which the
  // installer deletes. Refusing loudly beats deleting a database quietly.
  const { dir, cleanup } = scratch();
  const s = await serve(makeZip(PAYLOAD));
  try {
    const dataDir = path.join(dir, 'server');
    fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'db', 'remote_display.db'), 'precious');
    process.env.DATA_DIR = dataDir;

    await assert.rejects(() => installer.install({ url: s.url, installDir: dir }),
                         /DATA_DIR .* is inside the payload tree/);
    // and it did not take the database with it on the way out
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'db', 'remote_display.db'), 'utf8'), 'precious');
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('a payload missing server/server.js is rejected without touching a working install', async () => {
  // A truncated or wrong archive must not be able to destroy a device that is currently working.
  const { dir, cleanup } = scratch();
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    const good = await serve(makeZip(PAYLOAD));
    await installer.install({ url: good.url, installDir: dir });
    await good.close();

    const bad = await serve(makeZip([['frontend/index.html', 'nope']]));
    await assert.rejects(() => installer.install({ url: bad.url, installDir: dir }),
                         /no server\/server\.js/);
    await bad.close();

    // still the working v1 install
    assert.strictEqual(fs.readFileSync(path.join(dir, 'server', 'server.js'), 'utf8'), 'module.exports = "v1";\n');
  } finally { cleanup(); delete process.env.DATA_DIR; }
});

test('an entry that escapes the destination is skipped, not written', async () => {
  const { dir, cleanup } = scratch();
  const outside = path.join(dir, 'escaped.txt');
  const s = await serve(makeZip([...PAYLOAD, ['../escaped.txt', 'pwned']]));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    const target = path.join(dir, 'install');
    fs.mkdirSync(target);
    const r = await installer.install({ url: s.url, installDir: target });
    assert.strictEqual(fs.existsSync(outside), false);
    assert.ok(r.skipped >= 1, 'the escaping entry should be counted as skipped');
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('a 404 fails cleanly and leaves no half-downloaded file behind', async () => {
  const { dir, cleanup } = scratch();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('no'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    await assert.rejects(
      () => installer.install({ url: `http://127.0.0.1:${server.address().port}/x.zip`, installDir: dir }),
      /HTTP 404/);
    assert.strictEqual(fs.existsSync(path.join(dir, 'server-payload.zip')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'server-payload.zip.part')), false);
  } finally { await new Promise((r) => server.close(r)); cleanup(); delete process.env.DATA_DIR; }
});

test('a corrupted file is caught by its checksum instead of landing on disk', async () => {
  /*
   * Without this check a damaged byte reaches the player intact-looking and surfaces later as
   * something unrelated - a SyntaxError from a file nobody edited. Flip one byte in the payload
   * and the install must refuse rather than commit it.
   */
  const { dir, cleanup } = scratch();
  const zip = makeZip(PAYLOAD);
  const marker = Buffer.from('module.exports = "v1";');
  const at = zip.indexOf(marker);
  assert.ok(at > 0, 'fixture should contain the entry body');
  zip[at] = zip[at] ^ 0xff;                     // corrupt one byte, leave the CRC claiming otherwise
  const s = await serve(zip);
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    await assert.rejects(() => installer.install({ url: s.url, installDir: dir }), /checksum mismatch/);
    assert.strictEqual(fs.existsSync(path.join(dir, 'server', 'server.js')), false);
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

/*
 * ⚠️ THE DIGEST MUST OUTLIVE EVERYTHING OPTIONAL THAT FOLLOWS IT.
 *
 * A real XT245 took 2.0.0-alpha1, ran it, and reported it up the mesh — then came back with no
 * .payload-sha256 at all and an install log that simply stopped after "checksum verified". The
 * digest was written AFTER the launcher self-refresh, a step whose own comment calls it the riskiest
 * copy in the project, so the durable fact depended on the fragile step.
 *
 * The cost is invisible and permanent: the digest is what detects a REBUILD of an unchanged version
 * string, and on an alpha line every build is "2.0.0-alpha1". differs() falls back to comparing
 * versions, so the box keeps booting happily and simply never sees another payload.
 */
test('the digest is recorded even when a launcher check goes wrong', async () => {
  const { dir, cleanup } = scratch();
  const withLauncher = PAYLOAD.concat([
    ['brightsign/', ''], ['brightsign/server/', ''],
    ['brightsign/server/bs-server-boot.js', 'module.exports = "new launcher";\n'],
  ]);
  const s = await serve(makeZip(withLauncher));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    // A root entry that cannot be read as text, so the launcher comparison throws.
    fs.mkdirSync(path.join(dir, 'bs-server-boot.js'), { recursive: true });

    const r = await installer.install({ url: s.url, installDir: dir });

    const sha = path.join(dir, '.payload-sha256');
    assert.strictEqual(fs.existsSync(sha), true,
      'the digest must be on disk regardless of what the launcher check did');
    assert.match(fs.readFileSync(sha, 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.ok(r.files >= 3);
    const log = fs.readFileSync(path.join(dir, '.payload-install.log'), 'utf8');
    assert.match(log, /launcher bs-server-boot\.js/, 'the launcher outcome is logged either way');
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

/*
 * ⚠️ THE BUG THIS REPLACED, AND WHY IT WAS INVISIBLE.
 *
 * The installer used to copy the payload's brightsign/server/bs-*.js up to the install root itself.
 * On a real XT245 that copy silently did nothing, twice — both files present, both different, no
 * .prev written — and the only account of the failure went to a listener bound to localhost. The
 * payload installed, the server ran, and the launcher stayed frozen at whatever the boot zip first
 * dropped, so no launcher fix could ever reach a player.
 *
 * Now the payload carries the launcher at its TOP LEVEL and the ordinary tree replace installs it:
 * the same rmSync+renameSync that lands the other 9,630 files.
 */
test('THE FIX: a top-level launcher in the payload replaces the one at the install root', async () => {
  const { dir, cleanup } = scratch();
  const withTopLevel = PAYLOAD.concat([
    ['bs-server-boot.js', 'module.exports = "LAUNCHER v2";\n'],
    ['bs-payload-install.js', 'module.exports = "INSTALLER v2";\n'],
  ]);
  const s = await serve(makeZip(withTopLevel));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    fs.writeFileSync(path.join(dir, 'bs-server-boot.js'), 'module.exports = "LAUNCHER v1";\n');
    fs.writeFileSync(path.join(dir, 'bs-payload-install.js'), 'module.exports = "INSTALLER v1";\n');

    await installer.install({ url: s.url, installDir: dir });

    assert.match(fs.readFileSync(path.join(dir, 'bs-server-boot.js'), 'utf8'), /LAUNCHER v2/,
      'the launcher was not updated — every future launcher fix would be unreachable in the field');
    assert.match(fs.readFileSync(path.join(dir, 'bs-payload-install.js'), 'utf8'), /INSTALLER v2/);
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('a payload with NO top-level launcher says so instead of failing silently', async () => {
  // Exactly the archives 2.0.0-alpha0 through alpha2 shipped. Installing one is not an error, but
  // it leaves the launcher frozen, and the log has to say that out loud.
  const { dir, cleanup } = scratch();
  const subdirOnly = PAYLOAD.concat([
    ['brightsign/', ''], ['brightsign/server/', ''],
    ['brightsign/server/bs-server-boot.js', 'module.exports = "LAUNCHER v2";\n'],
  ]);
  const s = await serve(makeZip(subdirOnly));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    fs.writeFileSync(path.join(dir, 'bs-server-boot.js'), 'module.exports = "LAUNCHER v1";\n');

    await installer.install({ url: s.url, installDir: dir });

    assert.match(fs.readFileSync(path.join(dir, 'bs-server-boot.js'), 'utf8'), /LAUNCHER v1/,
      'unchanged, as expected for such a payload');
    const log = fs.readFileSync(path.join(dir, '.payload-install.log'), 'utf8');
    assert.match(log, /NOT updated/, 'the log must name it rather than leaving no trace at all');
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('the install log narrates the risky middle, not just its ends', async () => {
  // Between "checksum verified" and the end, the installer extracts, replaces the entire tree and
  // rewrites its own launcher — ~90 lines that used to write nothing to disk. That is why a real
  // failure left a log that stopped dead and gave no way to tell how far it had got.
  const { dir, cleanup } = scratch();
  const s = await serve(makeZip(PAYLOAD));
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    await installer.install({ url: s.url, installDir: dir });
    const log = fs.readFileSync(path.join(dir, '.payload-install.log'), 'utf8');
    for (const stage of [/install starting/, /downloaded \d+ bytes/, /tree replaced, \d+ files/,
                         /recorded \.payload-sha256=/, /installed \d+ files/]) {
      assert.match(log, stage, `the log is missing a stage: ${stage}`);
    }
    // Ordering matters: the digest must be durable before the launcher stage is attempted.
    assert.ok(log.indexOf('recorded .payload-sha256') < log.indexOf('installed '),
      'the digest is recorded before the install is declared finished');
  } finally { await s.close(); cleanup(); delete process.env.DATA_DIR; }
});

test('a digest that does not read back is reported, not silently degraded to version-only', async () => {
  const { dir, cleanup } = scratch();
  const s = await serve(makeZip(PAYLOAD));
  const realWrite = fs.writeFileSync;
  try {
    process.env.DATA_DIR = path.join(dir, 'data');
    // Simulate the write that appears to succeed and leaves nothing behind — the state the XT245
    // was actually found in. Without the read-back this is indistinguishable from success.
    fs.writeFileSync = function (p, data, ...rest) {
      if (String(p).endsWith('.payload-sha256')) return realWrite.call(fs, p, '', ...rest);
      return realWrite.call(fs, p, data, ...rest);
    };
    await installer.install({ url: s.url, installDir: dir });
    fs.writeFileSync = realWrite;
    const log = fs.readFileSync(path.join(dir, '.payload-install.log'), 'utf8');
    assert.match(log, /could NOT record \.payload-sha256/, 'an empty digest must be reported');
    assert.match(log, /will not detect a rebuild/, 'and it must say what that costs');
  } finally { fs.writeFileSync = realWrite; await s.close(); cleanup(); delete process.env.DATA_DIR; }
});
