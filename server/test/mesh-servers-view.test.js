'use strict';

/*
 * The Servers section: that it is wired in, and that it makes the promises the directive requires.
 *
 * Source assertions rather than a rendered DOM, for the same reason as the invariant tests: what is
 * being protected here is largely ABSENCE — that remote workspaces never enter the workspace
 * switcher, that a stale link is not painted red, that the origin node is not folded into the name.
 * A rendering test can only show that the cases somebody thought of came out right.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const front = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', ...p), 'utf8');
const VIEW = front('js', 'views', 'servers.js');
const APP = front('js', 'app.js');
const INDEX = front('index.html');

test('the view is registered, routed and reachable', () => {
  assert.match(APP, /import \* as servers from '\.\/views\/servers\.js'/);
  assert.match(APP, /hash === '#\/servers'/);
  assert.match(APP, /servers\.render\(app\)/);
  assert.match(INDEX, /id="serversNavItem"/);
  assert.match(INDEX, /href="#\/servers"/);
});

test('⚠️ the nav item is ASKED for, not assumed', () => {
  /*
   * There is no client-side flag for MESH_ACCEPT_ENROLLMENT and there should not be: the server
   * mounts /api/mesh only when it is set, so whether the API answers IS the test. A hardcoded flag
   * in the bundle would drift the moment somebody changed the env var, and would show a section that
   * 404s.
   */
  assert.match(INDEX, /id="serversNavItem" style="display:none"/,
    'it must start hidden, so an ordinary install never flashes a section it does not have');
  assert.match(APP, /api\.get\('\/mesh\/nodes'\)[\s\S]{0,200}serversNav\.style\.display = ''/,
    'and be revealed only when the hub API actually answers');
});

test('⚠️ remote workspaces do NOT enter the workspace switcher', () => {
  /*
   * The switcher mints a JWT with current_workspace_id and reloads — it assumes a LOCAL, WRITABLE
   * workspace. Putting remote ones behind it means every write surface grows a disabled state, and a
   * UI full of dead controls teaches people the product is broken.
   */
  /*
   * ⚠️ Checked against the CODE, not the file. The doc comment at the top of the view explains why
   * the switcher is avoided, and matching that would fail the test for saying the right thing —
   * which is how a guard gets deleted for being "wrong" when it was the check that was wrong.
   */
  const code = VIEW
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
    .replace(/^\s*\/\/.*$/gm, '')          // line comments
    .replace(/<!--[\s\S]*?-->/g, '');       // html comments in the templates
  assert.doesNotMatch(code, /workspaceSwitcher|current_workspace_id|switchWorkspace/,
    'the Servers view must never touch the workspace switcher');
});

test('⚠️ a stale link is AMBER, never red', () => {
  /*
   * Red says "this screen is broken" and sends an engineer to a working site. Amber says "we cannot
   * currently see it", which is the true statement and points at the network instead.
   */
  const stale = VIEW.match(/stale:\s*\{[^}]*\}/);
  assert.ok(stale, 'a stale status style must exist');
  assert.ok(!/#ef4444/.test(stale[0]), 'stale must not use the offline red');
  assert.match(stale[0], /#f59e0b/, 'it should be amber');
  assert.match(stale[0], /Last known/, 'and read as last-known rather than as a live state');
});

test('⚠️ every row shows its age, not just the stale ones', () => {
  // A green dot from ninety minutes ago is a lie by omission, and the reader cannot tell.
  assert.match(VIEW, /function statusCell[\s\S]{0,600}asOfAgeSec/,
    'the age belongs in the shared status cell, so no row can be rendered without it');
});

test('⚠️ the origin node is its own column, not folded into the name', () => {
  // "Lobby (Acme)" breaks sort and search for every row at once, and is hard to undo once customers
  // have learned to read it that way.
  assert.match(VIEW, /<th>Server<\/th>/, 'the server gets its own column header');
  assert.match(VIEW, /badge">\$\{esc\(d\.originNodeId/, 'and its own badge cell');
  assert.doesNotMatch(VIEW, /\$\{d\.name\}\s*\(\$\{d\.originNodeId/, 'never concatenated');
});

test('a device with no shared name says so rather than rendering blank', () => {
  // A health-only grant sends no name. An empty cell reads as a bug; "not shared" reads as a choice.
  assert.match(VIEW, /not shared/);
});

test('the search caveat from the server is rendered, not swallowed', () => {
  // Without it an empty result reads as a broken search, and the "fix" someone reaches for is
  // widening the grant — the outcome the grant vocabulary exists to avoid.
  assert.match(VIEW, /searchNote/);
});

test('paging is server-side, with a bounded page', () => {
  assert.match(VIEW, /limit=\$\{state\.limit\}&offset=\$\{state\.offset\}/,
    'the page must be requested from the server, not sliced in the browser');
  assert.doesNotMatch(VIEW, /devices\.slice\(/, 'no client-side pagination over a full fleet');
});

test('a new search returns to the first page', () => {
  // Otherwise a search from page 7 shows "no results" for a term that matches three screens.
  assert.match(VIEW, /state\.search = e\.target\.value;[\s\S]{0,120}state\.offset = 0/);
});

test('acting on something remote is a link to where it lives', () => {
  /*
   * ⚠️ This is what lets the hub stay read-only and still be useful. Without it every remote row is
   * a dead end, and the only way to act is to widen the hub's permissions — which is how a read-only
   * observer becomes a control plane by accident.
   */
  assert.match(VIEW, /d\.deepLink/);
  assert.match(VIEW, /target="_blank" rel="noopener"/, 'and it opens away from the hub safely');
});

test('the view writes nothing (I2)', () => {
  // No POST/PUT/PATCH/DELETE from a screen that observes other people's machines.
  for (const verb of ['api.post', 'api.put', 'api.patch', 'api.delete']) {
    assert.ok(!VIEW.includes(verb), `${verb} in a read-only view`);
  }
});

/* ===================== Phase 3 completion: the inbox, topology and report tabs ===================== */

test('⚠️ four TABS, not four nav items', () => {
  /*
   * Alerts, topology and uptime are all answers about the same set of connected servers. A nav that
   * grows an entry per question buries the section an operator starts from, and an install with no
   * mesh would gain three sidebar entries it can never use.
   */
  assert.match(VIEW, /const TABS = \[/);
  for (const tab of ['fleet', 'alerts', 'topology', 'uptime']) {
    assert.ok(VIEW.includes(`'${tab}'`), `${tab} tab missing`);
  }
  assert.equal((INDEX.match(/href="#\/servers"/g) || []).length, 1, 'still exactly one nav entry');
});

test('⚠️ the SELF-SUSPICION banner renders ABOVE the alerts it explains', () => {
  /*
   * When most sites go quiet at once the likely cause is this server's own connection, not forty
   * simultaneous outages. The reader has to see that BEFORE the forty rows — by row three they are
   * already phoning a client whose screens are fine.
   */
  const banner = VIEW.indexOf("Check this server's connection first");
  const table = VIEW.indexOf('Open alerts across all servers');
  assert.ok(banner > -1, 'the banner must exist');
  assert.ok(banner < table, 'and be rendered before the alert list');
  assert.match(VIEW, /suspectSelf/);
});

test('an alert from an unreachable site is marked last known', () => {
  // Otherwise the inbox is the one screen in the product that still implies live truth.
  assert.match(VIEW, /a\.stale[\s\S]{0,400}last known/);
});

test('local incidents share the inbox', () => {
  // A hub is a node too; its own problems are not somebody else's category.
  assert.match(VIEW, /On this server/);
  assert.match(VIEW, /data\.local/);
});

test('⚠️ version skew is measured against the COMMON version, not the hub\'s', () => {
  /*
   * A hub that has not been upgraded yet would otherwise mark its entire healthy fleet as skewed,
   * which is the fastest way to teach an operator to ignore the column.
   */
  assert.match(VIEW, /modal/);
  assert.doesNotMatch(VIEW, /ourVersion|hubVersion/,
    'skew must not be computed against this server\'s own version');
});

test('an edge with TLS verification off is surfaced, not hidden', () => {
  // A decision somebody made once and nobody revisits unless a screen shows it.
  assert.match(VIEW, /tlsVerify === false/);
  assert.match(VIEW, /TLS unverified/);
});

test('⚠️ COVERAGE IS RENDERED BESIDE UPTIME, THE SAME SIZE', () => {
  /*
   * "99.9% uptime, 62% coverage" is honest. "99.9%" alone, computed over the 62%, tells a customer
   * their screens were fine during a week nobody was watching them. Small print under the fold does
   * not carry that.
   */
  const up = VIEW.match(/Uptime<\/div>\s*<div style="font-size:(\d+)px/);
  const cov = VIEW.match(/Coverage<\/div>\s*<div style="font-size:(\d+)px/);
  assert.ok(up && cov, 'both figures must be rendered');
  assert.equal(up[1], cov[1], 'and at the same size — coverage is not a footnote');
  assert.match(VIEW, /coverageNote/);
});

test('there is no "all clients" option in the report picker', () => {
  // A report with no client name, mixing customers into one percentage, is the document that gets
  // forwarded to one of those customers.
  assert.doesNotMatch(VIEW, /All clients|value=""[^>]*>All/);
  assert.match(VIEW, /clientId=\$\{encodeURIComponent\(state\.clientId\)\}/);
});

test('⚠️ the CSV is FETCHED with the auth header, not linked', () => {
  /*
   * The API is Bearer-authenticated from localStorage, so an <a href> to the endpoint would 401 —
   * and it would 401 by REDIRECTING to login, which reads to the user as "my session expired"
   * rather than "that link cannot carry a token".
   */
  assert.match(VIEW, /Authorization: `Bearer \$\{localStorage\.getItem\('token'\)\}`/);
  assert.match(VIEW, /URL\.createObjectURL/);
  assert.doesNotMatch(VIEW, /<a href="\/api\/mesh\/uptime\.csv/, 'never a plain link');
});

test('a truncated incident list says so', () => {
  // A report quietly showing 50 of 300 reads as "that was all of them".
  assert.match(VIEW, /Showing the 50 longest of/);
  assert.match(VIEW, /CSV export contains every one/);
});

test('the view still writes nothing, across all four tabs (I2)', () => {
  for (const verb of ['api.post', 'api.put', 'api.patch', 'api.delete']) {
    assert.ok(!VIEW.includes(verb), `${verb} in a read-only view`);
  }
  // ⚠️ Including the raw fetch added for the CSV download — a GET, and it must stay one.
  const fetches = [...VIEW.matchAll(/fetch\(([^)]*)\)/g)];
  assert.ok(fetches.length <= 1, 'exactly one raw fetch, for the export');
  assert.doesNotMatch(VIEW, /method: '(POST|PUT|PATCH|DELETE)'/);
});
