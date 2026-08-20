'use strict';

/*
 * The Node half of "ScreenTinker server, running on the player it serves".
 *
 * BrightScript launches this with roNodeJs: a REAL Node process, not an roHtmlWidget. That
 * distinction is the whole reason this file got simpler. Inside a widget the server is a Node
 * context inside an Electron renderer, and four separate things break — shebangs are not stripped,
 * require(ESM) is unsupported, setInterval is the DOM's and returns a number, and worker_threads
 * cannot create a thread at all. BrightSign's own notes say to use roNodeJs "for long running
 * processes like gathering metrics or running a web server", and roHtmlWidget "for browser-based
 * apps". The server is the former. Their cra-template examples do exactly this: server in
 * roNodeJs, widget pointed at localhost.
 *
 * It also fixes the durability problem: a widget's server shares the PAGE's lifecycle, so a load
 * error or a deploy tears down the server and its open SQLite WAL with it. roNodeJs "will run in
 * the background uninterrupted".
 *
 * This file is the only thing between that arrangement and the ordinary server:
 *
 *   1. capture console output into a ring buffer, so the screen can show a log tail on a box with
 *      no monitor attached to its serial port,
 *   2. post a status frame — IP, disk, memory, uptime, recent log — to BrightScript on a timer,
 *   3. start the real server unmodified.
 *
 * ⚠️ It must never be the reason the server fails to boot. Everything here is wrapped: a broken
 * status frame is worth less than a running server, and on a device with no console the difference
 * between "crashed" and "started but silent" is invisible.
 */

const os = require('os');
const net = require('net');
const http = require('http');

/*
 * ⚠️ GIVE THE PAGE NODE'S TIMERS.
 *
 * This runs inside an roHtmlWidget, which is a BROWSER as well as a Node context, and the browser
 * wins for globals. The DOM's setInterval returns a NUMBER; Node's returns a Timeout object with
 * .unref(). So ordinary server code that has always worked dies here:
 *
 *     TypeError: setInterval(...).unref is not a function
 *       at server/routes/widgets.js:359
 *
 * Swapping the globals for node:timers fixes every call site at once - the two unguarded ones and
 * the sixteen written as `if (t.unref) t.unref()`, which on this platform were silently NOT
 * unreffing. Done here rather than in the server so the product keeps one timer idiom, and because
 * this is a property of the host, not of the code.
 *
 * The same trap as the shebang and as require(ESM): plain Node is not what this runs on, and a
 * local test under plain Node cannot see any of it.
 */
const nodeTimers = require('timers');
for (const name of ['setTimeout', 'setInterval', 'setImmediate',
                    'clearTimeout', 'clearInterval', 'clearImmediate']) {
  if (typeof nodeTimers[name] === 'function') globalThis[name] = nodeTimers[name];
}
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------------------------
// Talking to BrightScript
//
// roNodeJs delivers whatever we write to stdout as a message when it is valid JSON on one line;
// the BrightScript side reads it off the message port. Newline-delimited JSON keeps the framing
// trivial on a side that has no JSON streaming parser.
// ---------------------------------------------------------------------------------------------
// Kept for the case where this is run directly with `node bs-server-boot.js` (how it is tested on
// a desktop). Inside the widget nothing reads stdout — the PAGE calls status() and renders it, so
// this is a debugging aid, not the channel.
function post(obj) {
  try { if (process.stdout && process.stdout.write) process.stdout.write(JSON.stringify(obj) + '\n'); }
  catch (e) { /* never fatal */ }
}

// What the screen shows. Set when the server cannot start, so the page can say so instead of
// displaying a frozen "starting..." forever.
let fatalMessage = null;

// ---------------------------------------------------------------------------------------------
// The log ring
//
// Bounded on purpose: this runs for months. An unbounded array fed by a chatty server is a slow
// leak on the one device nobody is watching, which is the same reasoning the bridge's pending
// queue uses.
// ---------------------------------------------------------------------------------------------
const LOG_MAX = 200;
const logRing = [];
function remember(level, args) {
  try {
    const line = args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a, { depth: 1 }))).join(' ');
    for (const part of line.split('\n')) {
      if (!part.trim()) continue;
      logRing.push({ t: Date.now(), level, m: part.slice(0, 300) });
      if (logRing.length > LOG_MAX) logRing.shift();
    }
  } catch (e) { /* logging must not throw */ }
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { remember(level, args); original(...args); };
}

// ---------------------------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------------------------
function firstIPv4() {
  try {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if (/^(lo|docker|veth)/.test(name)) continue;
      for (const a of addrs || []) {
        // Node 18+ reports family as the string 'IPv4'; older builds used the number 4. The player
        // is on 24, but this costs one comparison and removes a version dependency.
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

/* Disk usage for the volume the server actually writes to, via statfs. */
function diskFor(dir) {
  try {
    // The data directory may not exist on the first frame — the server creates it during boot, and
    // the whole point of that first frame is to show something before the server is up. statfs on
    // any path on the same volume gives the same answer, so fall back to where we are installed.
    const target = fs.existsSync(dir) ? dir : __dirname;
    const s = fs.statfsSync(target);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalMb: Math.round(total / 1048576), freeMb: Math.round(free / 1048576),
             usedPct: total ? Math.round(((total - free) / total) * 100) : null };
  } catch (e) { return null; }
}

function dbBytes(dir) {
  let sum = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.db(-wal|-shm)?$/.test(f)) continue;
      try { sum += fs.statSync(path.join(dir, f)).size; } catch (e) { /* skip */ }
    }
  } catch (e) { return null; }
  return Math.round(sum / 1048576);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

/*
 * ⚠️ EXPORT IT, do not merely compute it. This line is load-bearing twice over.
 *
 * server/config.js reads process.env.DATA_DIR and falls back to its own __dirname, so without this
 * the server puts its database, uploads and .jwt_secret INSIDE server/ - inside the payload tree.
 * That tree is deleted and replaced wholesale on the next payload update, so the first update would
 * have silently destroyed the database, the uploaded content and the signing secret.
 *
 * It also made the diagnostic screen lie: it reported "database n/a" because it looked in
 * DATA_DIR/db while the server was writing to server/db, which reads as "there is no database" when
 * there is a perfectly good one a directory away.
 */
process.env.DATA_DIR = DATA_DIR;

/*
 * Tell the server it is hosting the display it serves. The only thing this currently unlocks is
 * letting the local diagnostic page frame /player over loopback — helmet's X-Frame-Options
 * SAMEORIGIN otherwise renders that iframe black, because this page is served from file://.
 */
process.env.ST_PLAYER_HOST = '1';

/*
 * Read at FRAME time, not at load time. server.env is applied below, after this module's constants
 * would have been evaluated — so a PORT captured here would show the default on screen while the
 * server was actually listening on the configured one. The screen exists to tell an operator where
 * to point a browser; a plausible wrong number is worse than no number.
 */
const currentPort = () => process.env.PORT || 3001;

/*
 * Local configuration, seeded once and then owned by the device.
 *
 * The packager REFUSES to bundle a .env — that guard exists because the first build of this package
 * swept up the developer's real one along with a 33MB database and 105MB of uploads. So the package
 * carries a template instead, and the first boot copies it into DATA_DIR, where it sits alongside
 * the data: a package update replaces the code and leaves the operator's settings intact.
 *
 * Precedence is deliberate: anything already in process.env — which is how autorun.brs passes
 * DATA_DIR and PORT through roNodeJs — wins. The file fills in what the launcher did not say.
 *
 * No secrets live here. The JWT signing secret is generated per install into
 * DATA_DIR/certs/.jwt_secret by server/config.js, so every player gets its own; one shipped in a
 * package would be identical on every device that installed it.
 */
function loadLocalEnv() {
  const template = path.join(__dirname, 'server.env.example');
  let source = path.join(DATA_DIR, 'server.env');
  try {
    if (!fs.existsSync(source)) {
      if (!fs.existsSync(template)) return;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        /*
         * ⚠️ NOT fs.copyFileSync. On the player this failed with
         *     EPERM: operation not permitted, copyfile '...server.env.example' -> '.../server.env'
         * copyFileSync does not merely copy bytes: it opens the destination and then fchmods it to
         * match the source's mode. /storage/ssd is exFAT, which has no permission bits, so the
         * chmod is refused. Writing the bytes ourselves never asks for a mode and works fine — which
         * is also why unpacking the zip onto the same volume was never a problem.
         */
        fs.writeFileSync(source, fs.readFileSync(template));
        remember('log', [`created ${source} from the template — edit it on the device`]);
      } catch (e) {
        /*
         * Persisting is a convenience; APPLYING the configuration is not. Read the template directly
         * rather than giving up, or a read-only data directory silently downgrades the server to
         * defaults — which is precisely what happened here: PORT=8080 never applied and the screen
         * advertised :3001 while claiming to be running.
         */
        remember('warn', ['could not persist server.env, using the packaged template',
                          String(e && e.message ? e.message : e)]);
        source = template;
      }
    }
    for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      // Already set by the launcher: leave it alone.
      if (process.env[k] !== undefined) continue;
      process.env[k] = t.slice(eq + 1).trim();
    }
  } catch (e) {
    // A malformed config must not stop the server booting: it comes up on defaults and says so.
    remember('error', ['could not read server.env', String(e && e.message ? e.message : e)]);
  }
}
loadLocalEnv();

/*
 * Turn off the native-dependency preflight.
 *
 * preflight-deps.js exists to catch better-sqlite3 compiled against the wrong NODE_MODULE_VERSION:
 * it probes with a real `new Database(':memory:')`, runs `npm rebuild`, and hard-exits if the
 * module still will not load. That is the correct behaviour on a normal install and it is exactly
 * wrong here — this build has no better-sqlite3 at all, by design, because it reaches SQLite
 * through node:sqlite. Left on, it finds the module missing, tries to rebuild a package that is not
 * in package.json, fails, and refuses to boot the server.
 *
 * Set here rather than relying on BrightScript to pass it: the check runs on require of the server,
 * and a package that boots only when the launcher remembers an environment variable is a package
 * that will eventually not boot.
 */
process.env.ST_SKIP_DEP_PREFLIGHT = '1';

/*
 * Declared HERE, above statusFrame, and not down beside the installer that maintains it.
 *
 * `let` is hoisted but not initialised, so a reference before this line throws ReferenceError
 * rather than reading undefined. statusFrame() is called on the first tick — long before the
 * install block further down — so declaring it next to its logic put the whole boot in a temporal
 * dead zone: one frame, one ReferenceError, no server, and a blank screen to debug it with.
 */
let installState = { phase: 'idle', detail: '', pct: null };
let lastLoggedInstall = null;

/*
 * Is anything actually LISTENING?
 *
 * The screen showed http://192.168.1.46:8080 in large green type while the server was still
 * downloading its own code, and again while it was dead from a failed require. An address that
 * does not answer is worse than no address: someone reads it off the screen, the browser hangs,
 * and the player looks broken in a way that has nothing to do with the real fault.
 *
 * So prove it rather than infer it - a real TCP connect to the port, on the same interval as the
 * status frame. Cheap, and it cannot be fooled by the server having got halfway up.
 */
/*
 * Has anyone created the first account yet?
 *
 * The screen has three states, and this is the one the server has to be asked about: a server that
 * is up but has no users is not ready to show a player, it is waiting for someone to open the
 * dashboard and create an admin. /api/auth/config answers it and is public by design.
 *
 * Asked HERE rather than from the page because the page is loaded from file:// - origin "null" -
 * and the server sets no CORS headers on its own API. This process is already talking to it.
 *
 * null means "not known yet", which is deliberately distinct from false: the page must not flip to
 * the player on a probe that has not answered.
 */
let needsSetup = null;
function probeSetup() {
  if (!serving) { needsSetup = null; return; }
  const req = http.request(
    { host: '127.0.0.1', port: Number(currentPort()), path: '/api/auth/config', timeout: 3000 },
    (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { needsSetup = !!JSON.parse(body).needsSetup; }
        catch (e) { /* a malformed answer is not an answer */ }
      });
    });
  req.on('error', () => { /* server not answering yet; leave the previous value */ });
  req.on('timeout', () => req.destroy());
  req.end();
}

let serving = false;
function probeListening() {
  const port = Number(currentPort());
  if (!port) { serving = false; return; }
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = (ok) => { serving = ok; sock.destroy(); };
  sock.setTimeout(1500);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
}

function statusFrame() {
  const mem = process.memoryUsage();
  return {
    type: 'st-server-status',
    ip: firstIPv4(),
    port: currentPort(),
    pid: process.pid,
    node: process.versions.node,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    disk: diskFor(DATA_DIR),
    install: installState,
    serving,
    needsSetup,
    dbMb: dbBytes(path.join(DATA_DIR, 'db')),
    log: logRing.slice(-14),
  };
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
post({ type: 'st-server-boot', node: process.versions.node, arch: process.arch, dataDir: DATA_DIR });

// A frame straight away so the screen is never blank while the server warms up, then on a timer.
// 2s is a compromise: fast enough to watch a boot, slow enough that a 3-core player is not being
// asked to serialise state constantly while it is also serving.
const timer = setInterval(() => { probeListening(); probeSetup(); post(statusFrame()); }, 2000);
if (typeof timer.unref === 'function') timer.unref();
post(statusFrame());

process.on('uncaughtException', (e) => {
  remember('error', ['UNCAUGHT', e && e.stack ? e.stack : String(e)]);
  post(statusFrame());
  fatalMessage = String(e && e.message ? e.message : e);
  post({ type: 'st-server-fatal', message: fatalMessage });
  // NOT process.exit() any more. Inside a widget that would take the page down with it, losing the
  // one surface that can report what went wrong. The screen shows FAILED and the reason instead.
});
process.on('unhandledRejection', (e) => remember('error', ['UNHANDLED REJECTION', String(e)]));

/*
 * Is the server payload here — and if not, go and get it.
 *
 * The boot files and the ~71MB of server + node_modules ship separately: BrightSignOS cannot open an
 * autorun.zip that big (it renames it to autorun.zip_invalid and forces recovery), while a 32KB one
 * boots fine. So this downloads and unpacks the rest itself, which Node has no trouble with, and
 * means the payload can also be updated without re-provisioning the device.
 */
const SERVER_ENTRY = path.join(__dirname, 'server', 'server.js');


/*
 * ---------------------------------------------------------------------------------------------
 * Media tools (ffprobe/ffmpeg) — staged into /tmp, then put on PATH.
 * ---------------------------------------------------------------------------------------------
 *
 * Without this the server logs, on every boot:
 *
 *     [MEDIA] ffmpeg, ffprobe not found on PATH — video thumbnails and durations are DISABLED
 *
 * ⚠️ /tmp IS NOT LAZINESS, IT IS THE ONLY OPTION. Every writable volume on this player is mounted
 * noexec — the exFAT SSD, the ext4 flash, even /storage/tmp — and we run as uid 994 (nodejs), so
 * `mount -o remount,exec` answers "permission denied (are you root?)". A symlink does not help
 * either: noexec is a property of the filesystem holding the inode, not of the path used to reach
 * it, so a link in /tmp pointing at flash still fails with EACCES. Copying is what moves the inode
 * onto a filesystem that permits execution. /tmp is tmpfs and is the one writable place without
 * noexec, so the binaries are unpacked there at every boot. They are shipped gzipped because the
 * unpacked pair is ~7MB of RAM and the compressed pair is ~3MB on disk.
 *
 * ⚠️ THE BINARIES MUST BE OURS. BrightSignOS ships the whole ffmpeg 5.1 shared-library stack
 * (libavformat/libavcodec/...) to back GStreamer, and a stock Debian ffprobe linked against them
 * starts, prints its banner — and then SIGSEGVs the instant it opens a file, because their Yocto
 * build is patched for hardware decode. So these are cross-built here, --disable-gpl (LGPL 2.1+),
 * fully static, linking nothing of theirs. ffprobe carries no decoders at all: durations and stream
 * geometry come from the container, which is why it is 1.8MB against ffmpeg's 5MB.
 */
const MEDIA_BIN_DIR = '/tmp/screentinker-bin';

function stageMediaTools() {
  const zlib = require('zlib');
  const staged = [];
  try {
    fs.mkdirSync(MEDIA_BIN_DIR, { recursive: true });
    for (const name of ['ffprobe', 'ffmpeg']) {
      // Shipped in the payload for a real install; DATA_DIR is the fallback so a device can be
      // given the tools without recutting the package.
      const candidates = [path.join(__dirname, 'bin', name + '.gz'),
                          path.join(DATA_DIR, 'bin', name + '.gz')];
      const src = candidates.find((c) => fs.existsSync(c));
      if (!src) continue;
      const bytes = zlib.gunzipSync(fs.readFileSync(src));
      const dest = path.join(MEDIA_BIN_DIR, name);
      fs.writeFileSync(dest, bytes);
      fs.chmodSync(dest, 0o755);
      staged.push(name + ' ' + Math.round(bytes.length / 1024) + 'KB');
    }
    if (!staged.length) {
      console.log('[media] no bundled ffprobe/ffmpeg found — thumbnails and durations stay disabled');
      return;
    }
    // The server probes for these BY NAME with execFile, so the directory has to be on PATH before
    // server.js is required. That is the whole reason this runs where it does.
    process.env.PATH = MEDIA_BIN_DIR + (process.env.PATH ? ':' + process.env.PATH : '');
    console.log('[media] staged ' + staged.join(', ') + ' into ' + MEDIA_BIN_DIR + ' (on PATH)');

    // Prove it actually RUNS, and put the banner on the diagnostic screen and the serial console.
    // Asynchronous: a hung binary must not hold up the server, and this is only reporting.
    require('child_process').execFile(path.join(MEDIA_BIN_DIR, 'ffprobe'), ['-hide_banner', '-version'],
      { timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          console.warn('[media] staged ffprobe did not run: ' + (err && err.message));
          return;
        }
        console.log('[media] ' + String(stdout).split('\n')[0]);
      });
  } catch (e) {
    // Never fatal. A player with no thumbnails is worth more than a player that would not boot.
    console.warn('[media] could not stage media tools: ' + (e && e.message ? e.message : e));
  }
}

function startServer() {
  try {
    stageMediaTools();
    require('./server/server.js');
  } catch (e) {
    remember('error', ['server failed to start', e && e.stack ? e.stack : String(e)]);
    fatalMessage = String(e && e.message ? e.message : e);
    post(statusFrame());
    post({ type: 'st-server-fatal', message: fatalMessage });
  }
}

/*
 * ⚠️ WHERE THE PAYLOAD COMES FROM IS CONFIGURABLE, and it has to be. The default points at alpha,
 * which is right for our own boxes and wrong for everyone else: a self-hosted site should not reach
 * across the internet to us to update the server on their own hardware. st-config.json sits on the
 * storage root beside the flag that already decides whether this device hosts a server, so it is a
 * file the operator is already editing.
 */
function stConfig() {
  for (const dir of [__dirname, path.dirname(__dirname)]) {
    try {
      const f = path.join(dir, 'st-config.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (e) { /* a malformed config must never stop a boot */ }
  }
  return {};
}

const ST_CFG = stConfig();
const PAYLOAD_URL = process.env.ST_PAYLOAD_URL || ST_CFG.payloadUrl
  || 'https://alpha.screentinker.com/scripts/server-payload.zip';
const MANIFEST_URL = String(PAYLOAD_URL).replace(/\.zip$/, '.json');
// Set "autoUpdate": false to pin a box to what it has. Absent means updates are on.
const AUTO_UPDATE = ST_CFG.autoUpdate !== false && ST_CFG.autoUpdate !== 0;

function installedVersion() {
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); }
  catch (e) { return null; }
}

/**
 * Is a different payload published?
 *
 * ⚠️ ASKS A MANIFEST, NEVER THE ARCHIVE. Downloading 80MB to read a version number would make every
 * boot cost the whole payload — a check has to be cheaper than the thing it avoids.
 *
 * ⚠️ AND IT FAILS SAFE. No network, a malformed manifest, a captive portal answering with HTML —
 * each returns null and the installed server starts. A box that will not boot because it could not
 * reach an update server is a far worse outcome than one running last month's build, and it is the
 * failure an operator cannot fix remotely.
 */
function fetchManifest(cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  try {
    const mod = MANIFEST_URL.indexOf('https:') === 0 ? require('https') : require('http');
    const req = mod.get(MANIFEST_URL, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let body = '';
      res.setEncoding('utf8');
      // Bounded: a manifest is a few hundred bytes and anything larger is not one.
      res.on('data', (c) => { body += c; if (body.length > 8192) { req.destroy(); finish(null); } });
      res.on('end', () => {
        try {
          const m = JSON.parse(body);
          finish(m && typeof m.version === 'string' ? m : null);
        } catch (e) { finish(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  } catch (e) { finish(null); }
}

function runInstall(manifest) {
  const payloadUrl = PAYLOAD_URL;
  installState = { phase: 'starting', detail: payloadUrl, pct: null };
  remember('log', [(manifest ? 'updating to ' + manifest.version : 'server payload not installed') +
                   ' — fetching ' + payloadUrl]);

  let installer;
  try {
    installer = require(path.join(__dirname, 'bs-payload-install.js'));
  } catch (e) {
    fatalMessage = 'installer missing: ' + String(e && e.message ? e.message : e);
    remember('error', [fatalMessage]);
    return;
  }

  installer.install({
    url: payloadUrl,
    installDir: __dirname,
    // Present only when a manifest was read; the installer treats absence as "cannot verify".
    expectSha256: manifest && typeof manifest.sha256 === 'string' ? manifest.sha256 : null,
    onState: (st) => {
      installState = st;
      /*
       * One line per PHASE CHANGE or per quarter of progress - not per tick.
       *
       * The first version logged when pct was 0, 100 or null, which reads as "the interesting
       * moments" and is not: a download fires its progress callback on every chunk, so once it
       * reached 100% it logged on every one of them. The 200-entry ring filled with dozens of
       * copies of "downloading: 73MB of 73MB" and pushed out everything worth reading.
       */
      const bucket = st.pct === null || st.pct === undefined ? 'x' : Math.floor(st.pct / 25);
      const key = st.phase + ':' + bucket;
      if (key !== lastLoggedInstall) {
        lastLoggedInstall = key;
        remember('log', [st.phase + ': ' + st.detail]);
      }
    },
  }).then((r) => {
    remember('log', ['payload installed (' + r.files + ' files) — starting the server']);
    startServer();
  }).catch((e) => {
    installState = { phase: 'failed', detail: String(e && e.message ? e.message : e), pct: null };
    /*
     * ⚠️ A FAILED *UPDATE* IS NOT FATAL — a failed first install is. If a server is already on disk
     * it is still perfectly good, and refusing to boot because a newer one could not be fetched
     * would turn an unreachable update server into an outage at every site at once.
     */
    if (manifest && fs.existsSync(SERVER_ENTRY)) {
      remember('error', ['update to ' + manifest.version + ' failed (' + installState.detail +
                         ') — starting the installed server instead']);
      return startServer();
    }
    fatalMessage = 'could not install the server payload: ' + installState.detail;
    remember('error', [fatalMessage]);
    post({ type: 'st-server-fatal', message: fatalMessage });
  });
}

if (fs.existsSync(SERVER_ENTRY) && !AUTO_UPDATE) {
  installState = { phase: 'installed', detail: 'already present (updates off)', pct: 100 };
  startServer();
} else if (fs.existsSync(SERVER_ENTRY)) {
  const have = installedVersion();
  installState = { phase: 'checking', detail: 'checking for a newer server', pct: null };
  fetchManifest((m) => {
    if (!m || m.version === have) {
      /*
       * ⚠️ "Same version" and "could not ask" take the SAME branch deliberately: the only safe
       * reading of an unanswerable question is to change nothing.
       */
      installState = { phase: 'installed', detail: 'already present (' + (have || '?') + ')', pct: 100 };
      return startServer();
    }
    remember('log', ['payload ' + m.version + ' published, have ' + (have || 'none')]);
    runInstall(m);
  });
} else {
  runInstall(null);
}

/*
 * The diagnostic page lives in a DIFFERENT PROCESS now, so it cannot require() this file the way
 * it did when both ran inside the widget. It polls this instead.
 *
 * Deliberately a separate tiny listener rather than a route on the real server: its entire job is
 * to report on a server that is downloading, extracting, or failing to start — exactly the states
 * in which the real server cannot answer anything. It binds immediately, before the payload exists.
 */
function status() {
  const f = statusFrame();
  f.fatal = fatalMessage;
  return f;
}

const STATUS_PORT = Number(process.env.ST_STATUS_PORT || 8182);
try {
  const statusServer = http.createServer((req, res) => {
    // The page is loaded from file://, whose origin is "null" - it needs CORS to read this at all.
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    let body;
    try { body = JSON.stringify(status()); }
    catch (e) { body = JSON.stringify({ fatal: 'status unavailable: ' + (e && e.message) }); }
    res.end(body);
  });
  statusServer.on('error', (e) => {
    // Losing the screen must never cost us the server.
    remember('error', ['status listener failed', String(e && e.message ? e.message : e)]);
  });
  /*
   * ⚠️ LOOPBACK ONLY. Its only consumer is node-server.html running on this same device.
   *
   * Bound to every interface - which is what listen(port) does - it answered from anywhere on the
   * customer's LAN with the install progress, disk usage, the device's own address and a tail of
   * the server's console. That last one is the problem: a log tail carries whatever the server
   * last printed, which is not a thing to hand to an unauthenticated caller on a network we do
   * not control.
   */
  statusServer.listen(STATUS_PORT, '127.0.0.1', () => remember('log', [
    'status listener on 127.0.0.1:' + STATUS_PORT +
    ' - loopback only, it feeds THIS diagnostics screen (install progress, uptime, the log below)' +
    // currentPort(), not a captured constant: server.env is read after this module is evaluated, so
    // a value captured here would print the 3001 default rather than the port actually in use.
    ' while the app on :' + currentPort() + ' is downloading, starting, or down. Not part of the' +
    ' app; nothing' +
    ' off-device can reach it.',
  ]));
  if (statusServer.unref) statusServer.unref();
} catch (e) {
  remember('error', ['could not start the status listener', String(e && e.message ? e.message : e)]);
}



module.exports = { status };
