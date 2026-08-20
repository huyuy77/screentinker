'use strict';

/*
 * The worker end of a mesh read: open the database, answer questions, post the answer back.
 *
 * ⚠️ ITS OWN CONNECTION, OPENED READ-ONLY. A better-sqlite3 handle cannot cross a thread boundary,
 * so this opens its own — and opens it readonly, which makes "the read path cannot write" a property
 * of the file descriptor rather than of the code above it. A bug in a projection then produces a
 * SQLITE_READONLY error instead of a silent mutation on a customer's server.
 *
 * ⚠️ SQLite handles concurrent READERS fine, including across threads, provided nobody expects a
 * transaction to span them. Nothing here does: each message is one question answered from one
 * consistent snapshot. WAL mode (which this codebase already runs) is what makes a reader and the
 * main thread's writer coexist without blocking each other.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { Database } = require('../../db/sqlite-driver');
const nodeData = require('./node-data');

let db = null;
try {
  db = new Database(workerData.dbPath, { readonly: true });
} catch (e) {
  /*
   * ⚠️ Reported rather than thrown into the void. The parent treats a worker that cannot open the
   * database as a worker that does not exist and falls back to answering inline — which is the same
   * path a platform without worker_threads takes, so there is one degraded mode rather than two.
   */
  parentPort.postMessage({ fatal: true, reason: (e && e.message) || 'could not open the database' });
}

parentPort.on('message', (msg) => {
  if (!msg || msg.id === undefined) return;
  if (!db) {
    parentPort.postMessage({ id: msg.id, result: { ok: false, reason: 'This node cannot read right now.' } });
    return;
  }
  try {
    parentPort.postMessage({ id: msg.id, result: nodeData.answerRead(db, msg.edge, msg.req) });
  } catch (e) {
    /*
     * A malformed request from a peer is an expected input, not an exceptional one. One bad read
     * must cost exactly one bad read — an uncaught throw here would take the worker down and, with
     * it, every other read in flight.
     */
    parentPort.postMessage({
      id: msg.id,
      result: { ok: false, reason: 'Could not read that.', detail: (e && e.message) || null },
    });
  }
});
