'use strict';

/*
 * The order a newly-paired child sends its world in, and how fast.
 *
 * ⚠️ THE NAIVE ORDER IS CHRONOLOGICAL, AND IT IS THE WORST ONE. A site with 400 screens and eight
 * months of history has hundreds of thousands of rows. Sent oldest-first, the hub spends its first
 * hour learning what happened in March and still cannot answer "is anything down right now" — which
 * is the only question anybody asks in the first five minutes after pairing.
 *
 * So priority is by USEFULNESS, not by age:
 *
 *   1. CURRENT STATE   what every screen is doing now. Small, bounded by the fleet size, and it is
 *                      the entire reason someone paired the node. Seconds.
 *   2. OPEN ALERTS     what is wrong now. Also small, and actionable — an operator who can see a
 *                      problem can start on it while the rest is still arriving.
 *   3. HISTORY         everything else, trickled. Large, unbounded, and nobody is waiting on it.
 *
 * ⚠️ AND THE RATE IS CAPPED, which matters more than the order. A hub taking on ten sites at once
 * would otherwise meet ten simultaneous floods, and the parent's own backpressure would start
 * throttling — so the fleet's history arrives by fighting for the same budget its live telemetry
 * needs. Trickling history is what keeps the live path clear.
 */

const PRIORITY = Object.freeze({
  CURRENT_STATE: 0,
  OPEN_ALERTS: 1,
  HISTORY: 2,
});

const PRIORITY_NAME = Object.freeze(['current-state', 'open-alerts', 'history']);

const DEFAULTS = Object.freeze({
  // Live telemetry is emitted as it happens and is NOT paced by this — the cap here applies to
  // backfill only, so catching up never delays what is happening now.
  historyPerTick: 50,
  tickMs: 1_000,
  // Current state and alerts are bounded by fleet size, so they go out in larger bites: the point is
  // to be useful in seconds, and a 400-screen site should not take 8 ticks to describe itself.
  urgentPerTick: 500,
});

class BackfillQueue {
  constructor(limits = {}) {
    this.limits = { ...DEFAULTS, ...limits };
    // One array per priority. Deliberately not a single sorted list: re-sorting on every push is
    // wasted work when there are exactly three tiers, and it makes "is the urgent part done?"
    // a length check rather than a scan.
    this.tiers = [[], [], []];
    this.sent = 0;
    this.startedAt = null;
  }

  add(priority, item) {
    const tier = this.tiers[priority];
    if (!tier) throw new Error(`unknown backfill priority: ${priority}`);
    tier.push(item);
    if (this.startedAt === null) this.startedAt = Date.now();
    return this;
  }

  addMany(priority, items) {
    for (const i of items) this.add(priority, i);
    return this;
  }

  get pending() { return this.tiers.reduce((n, t) => n + t.length, 0); }

  /** Is the part anybody is actually waiting for finished? */
  get urgentDone() {
    return this.tiers[PRIORITY.CURRENT_STATE].length === 0
        && this.tiers[PRIORITY.OPEN_ALERTS].length === 0;
  }

  /**
   * Take the next batch to send.
   *
   * ⚠️ STRICT PRIORITY, NOT WEIGHTED. History waits entirely until current state and open alerts are
   * done. A weighted share would feel fairer and would delay the only part with someone waiting on
   * it — and the delay would scale with the size of the history, so the biggest sites (the ones most
   * worth impressing) would wait longest.
   */
  nextBatch() {
    for (const p of [PRIORITY.CURRENT_STATE, PRIORITY.OPEN_ALERTS]) {
      if (this.tiers[p].length) {
        const batch = this.tiers[p].splice(0, this.limits.urgentPerTick);
        this.sent += batch.length;
        return { priority: p, name: PRIORITY_NAME[p], items: batch };
      }
    }
    if (this.tiers[PRIORITY.HISTORY].length) {
      const batch = this.tiers[PRIORITY.HISTORY].splice(0, this.limits.historyPerTick);
      this.sent += batch.length;
      return { priority: PRIORITY.HISTORY, name: 'history', items: batch };
    }
    return null;
  }

  /**
   * What to show an operator watching a node come online.
   *
   * ⚠️ Reports the urgent part separately from the total. "12% complete" on a node that already knows
   * every screen's state is a needlessly alarming number, and it is the one a single progress bar
   * would show.
   */
  progress() {
    const urgent = this.tiers[0].length + this.tiers[1].length;
    return {
      pending: this.pending,
      urgentPending: urgent,
      urgentDone: this.urgentDone,
      historyPending: this.tiers[PRIORITY.HISTORY].length,
      sent: this.sent,
      // Rough, and only for history — the urgent tiers finish in seconds and a countdown on them
      // would be noise.
      historyEtaMs: Math.ceil(this.tiers[PRIORITY.HISTORY].length / this.limits.historyPerTick)
                    * this.limits.tickMs,
    };
  }
}

/**
 * Classify a payload into a tier.
 *
 * Kept beside the queue so a new payload type has one obvious place to be considered, rather than
 * defaulting into whichever tier the first caller happened to pass.
 */
function priorityFor(type, { open = false } = {}) {
  switch (type) {
    case 'device-summary':
    case 'node-health':
      return PRIORITY.CURRENT_STATE;
    case 'alert-event':
      // A CLOSED alert is history: it needs no action and nobody is waiting for it.
      return open ? PRIORITY.OPEN_ALERTS : PRIORITY.HISTORY;
    case 'proof-of-play':
    case 'tombstone':
      return PRIORITY.HISTORY;
    default:
      // ⚠️ Unknown types trickle rather than jumping the queue. An unrecognised payload from a newer
      // child must not be able to starve the live path by claiming urgency.
      return PRIORITY.HISTORY;
  }
}

module.exports = { BackfillQueue, PRIORITY, PRIORITY_NAME, priorityFor, DEFAULTS };
