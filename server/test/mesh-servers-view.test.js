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
