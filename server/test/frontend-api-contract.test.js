'use strict';

/*
 * Every api.X() a view calls must actually exist on the api object.
 *
 * ⚠️ THIS EXISTS BECAUSE THE SERVERS VIEW SHIPPED CALLING api.get(), WHICH WAS NEVER DEFINED. The
 * whole section threw "api.get is not a function" on first render and had never worked in a browser.
 * Twelve tests around that view passed the entire time, because they assert on the view's SOURCE —
 * they confirmed it said the right things without once executing it.
 *
 * A source-text test cannot catch a missing callee, and standing up a DOM for every view is a much
 * larger commitment than this codebase has made. Checking the two files agree costs nothing and
 * catches exactly the class of error that got through: a call to something that is not there.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const API_SRC = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');

/** Property names defined on the exported api object. */
function definedApiMethods(src) {
  const body = src.slice(src.indexOf('export const api = {'));
  const names = new Set();
  // `name: (args) => ...` and `name(args) {` forms, at object-literal indentation.
  for (const m of body.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm)) names.add(m[1]);
  return names;
}

function viewFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...viewFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('⚠️ every api.X() called by a view is defined on the api object', () => {
  const defined = definedApiMethods(API_SRC);
  assert.ok(defined.size > 20, 'the api surface should have parsed');

  const missing = [];
  for (const file of viewFiles(FRONTEND)) {
    if (file.endsWith(path.join('js', 'api.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!defined.has(m[1])) {
        missing.push(`${path.relative(FRONTEND, file)} calls api.${m[1]}()`);
      }
    }
  }
  assert.deepEqual(missing, [], `these calls have no implementation:\n  ${missing.join('\n  ')}`);
});

test('the generic verbs exist, since the mesh views use them', () => {
  /*
   * Named helpers are right for a permanent endpoint. The mesh routes mount CONDITIONALLY, so a
   * named helper per route would imply a surface that is usually not there at all.
   */
  const defined = definedApiMethods(API_SRC);
  for (const verb of ['get', 'post', 'put', 'delete']) {
    assert.ok(defined.has(verb), `api.${verb} is missing`);
  }
});

test('the generic verbs go through the SAME request() as everything else', () => {
  /*
   * Which is what gives them the auth header and the 401 handling. A hand-rolled fetch inside one of
   * them would work in development and log everybody out in production — or worse, quietly succeed
   * unauthenticated on an endpoint that forgot its guard.
   */
  const block = API_SRC.slice(API_SRC.indexOf('export const api = {'),
                              API_SRC.indexOf('post:') + 400);
  assert.match(block, /get:\s*\(path\)\s*=>\s*request\(path\)/);
  assert.match(block, /post:\s*\(path,\s*body\)\s*=>\s*request\(/);
  assert.doesNotMatch(block, /fetch\(/, 'the verbs must not bypass request()');
});
