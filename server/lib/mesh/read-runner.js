'use strict';

/*
 * Where a mesh read actually runs: a worker thread if this platform has one, this thread if not.
 *
 * ⚠️ THE FALLBACK IS NOT A DEGRADED FEATURE — IT IS THE SAME ANSWER, COMPUTED SOMEWHERE ELSE. Both
 * paths call the identical function in node-data.js, so a platform without worker_threads returns
 * byte-identical results. That property is the whole design: the moment the two paths can disagree,
 * the one nobody develops on is the one that is wrong, and it is wrong only in the field.
 *
 * ⚠️ DETECTED BY TRYING, NEVER BY SNIFFING THE PLATFORM. BrightSign runs a patched Node whose
 * capabilities do not follow from its version number, and a check like "is this BrightSign" would
 * be wrong in both directions the moment either side changes — a future OS that gains workers stays
 * slow forever, and a platform nobody thought of crashes. Requiring the module and constructing a
 * worker either works or it does not.
 *
 * WHY BOTHER: better-sqlite3 is synchronous, so a read served inline runs on the same event loop
 * that answers every player's heartbeat. On a large node that is the parent's convenience paid for
 * out of the child's own responsiveness, which is precisely what I1 forbids.
 */

const path = require('node:path');

/** Long enough for a real query on a slow box; short enough that a wedged worker is not forever. */
const READ_TIMEOUT_MS = 15_000;

function workerThreadsAvailable() {
  try {
    // eslint-disable-next-line global-require
    return require('node:worker_threads');
  } catch (e) {
    try {
      // Older builds expose it unprefixed; BrightSign's Node is patched and worth trying both.
      // eslint-disable-next-line global-require
      return require('worker_threads');
    } catch (e2) {
      return null;
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {object} opts.db          the main-thread handle, for the inline fallback
 * @param {object} opts.nodeData
 * @param {boolean} [opts.preferWorker=true]
 */
function createReadRunner({ dbPath, db, nodeData, logger = console, preferWorker = true }) {
  let worker = null;
  let mode = 'inline';
  let nextId = 1;
  const pending = new Map();

  const inline = (edge, req) => {
    try {
      return Promise.resolve(nodeData.answerRead(db, edge, req));
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'Could not read that.' });
    }
  };

  /*
   * ⚠️ EVERY IN-FLIGHT READ IS ANSWERED WHEN THE WORKER DIES, and then the runner reverts to inline.
   * Leaving them pending would hang the parent's request until its own timeout — the operator sees a
   * spinner and concludes the product is broken, which is a worse outcome than the slow path.
   */
  function tearDown(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* already gone */ } }
    worker = null;
    mode = 'inline';
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: 'This server could not answer that just now. Try again.' });
    }
    pending.clear();
    if (reason) logger.warn(`[mesh] read worker stopped (${reason}); answering reads inline`);
  }

  if (preferWorker) {
    const wt = workerThreadsAvailable();
    if (!wt) {
      // Not an error, and deliberately not a warning: it is the expected state on some platforms.
      logger.log('[mesh] no worker threads on this platform — mesh reads run inline');
    } else {
      try {
        worker = new wt.Worker(path.join(__dirname, 'read-worker.js'), { workerData: { dbPath } });
        mode = 'worker';
        // ⚠️ Never hold the process open for a reader. A node must be able to exit.
        if (worker.unref) worker.unref();

        worker.on('message', (msg) => {
          if (msg && msg.fatal) return tearDown(msg.reason);
          const p = msg && pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg.result);
        });
        worker.on('error', (e) => tearDown((e && e.message) || 'error'));
        worker.on('exit', (code) => { if (worker) tearDown(`exit ${code}`); });
        logger.log('[mesh] mesh reads run on a worker thread');
      } catch (e) {
        // The capability check that matters: constructing one either works or it does not.
        logger.log(`[mesh] could not start a read worker (${e && e.message}) — answering reads inline`);
        worker = null;
        mode = 'inline';
      }
    }
  }

  return {
    get mode() { return mode; },

    run(edge, req) {
      if (!worker) return inline(edge, req);
      const id = nextId++;
      return new Promise((resolve) => {
        /*
         * ⚠️ A TIMEOUT THAT FALLS BACK RATHER THAN FAILING. A worker wedged on a slow query would
         * otherwise turn every subsequent read into a 15-second wait; answering this one inline is
         * slower than a healthy worker and enormously faster than waiting for a sick one.
         */
        const timer = setTimeout(() => {
          pending.delete(id);
          logger.warn('[mesh] read worker did not answer in time — falling back for this read');
          inline(edge, req).then(resolve);
        }, READ_TIMEOUT_MS);

        pending.set(id, { resolve, timer });
        try {
          worker.postMessage({ id, edge, req });
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          inline(edge, req).then(resolve);
        }
      });
    },

    stop() { tearDown(null); },
  };
}

module.exports = { createReadRunner, workerThreadsAvailable, READ_TIMEOUT_MS };
