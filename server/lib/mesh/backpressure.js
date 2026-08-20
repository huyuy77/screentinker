'use strict';

/*
 * Bounding what a child may push into its parent.
 *
 * ⚠️ A CHILD IS AN AUTHENTICATED REMOTE WRITER RUNNING A VERSION YOU DO NOT CONTROL. That is a
 * different threat model from a device: a screen sends a fixed heartbeat shape written by us, while a
 * node sends whatever its build sends, including a build with a bug we have never seen. This is the
 * July unbounded-widget-telemetry lesson with the writer moved off the box.
 *
 * ⚠️ ACCOUNTED PER CHILD, AND THAT IS THE ENTIRE POINT (invariant I6).
 *
 * A single shared budget on the parent is the obvious implementation and it is a broken one: the
 * loudest child consumes it and every quiet sibling is silenced. The operator sees "the mesh is
 * down", not "that one node is noisy" — one misbehaving site takes out visibility of every other
 * site, which is precisely the failure isolation I6 exists to prevent. The earlier harness modelled
 * exactly that shared budget, and its test documented the starvation rather than hiding it.
 *
 * Three limits, because they fail differently and an operator needs to know which one was hit:
 *
 *   RATE   messages per window — a child in a reconnect loop or a hot path gone wrong
 *   BYTES  bytes per window    — a child sending few but enormous payloads
 *   STORE  rows retained       — a slow leak that would otherwise fill the parent's disk over weeks
 *
 * ⚠️ THROTTLED IS NOT DROPPED-AND-FORGOTTEN. Every refusal is counted and the child is flagged, so a
 * node that is over its limit shows as degraded rather than silently missing. Data that vanishes
 * without a trace is worse than data that arrives late, because nobody knows to look for it.
 */

const DEFAULTS = Object.freeze({
  windowMs: 10_000,
  maxMessages: 600,          // ~1/s sustained with headroom for a burst after reconnect
  /*
   * ⚠️ ITEMS, NOT JUST MESSAGES — the limit batching would otherwise walk straight past. maxMessages
   * is a proxy for volume, and one message carrying 5,000 rows sails through a cap designed to stop
   * exactly that. Without this, batching is a way AROUND the rate limit rather than a way to be
   * polite about it.
   *
   * Set well above a legitimate cycle (a 400-screen child sends ~402 items a minute) and well below
   * a runaway: a child flushing its whole 5,000-envelope buffer is admitted over a few windows
   * rather than in one gulp.
   */
  maxItems: 3_000,
  maxBytes: 4 * 1024 * 1024, // 4MB per window
  maxStoredRows: 250_000,    // per child, before the parent starts refusing new history
});

class ChildBudget {
  constructor(childId, limits) {
    this.childId = childId;
    this.limits = limits;
    this.windowStart = 0;
    this.messages = 0;
    this.items = 0;
    this.bytes = 0;
    this.storedRows = 0;
    // Counters, not just booleans: "throttled 40,000 times since Tuesday" is a different
    // conversation from "throttled twice", and the UI should be able to tell them apart.
    this.refused = { rate: 0, items: 0, bytes: 0, store: 0 };
    this.lastRefusalAt = null;
  }

  _roll(now) {
    if (now - this.windowStart >= this.limits.windowMs) {
      this.windowStart = now;
      this.messages = 0;
      // ⚠️ Reset with the others. A counter that is checked but never rolled climbs until it
      // trips permanently — the child would be throttled forever, a few windows after a busy one,
      // for traffic it is no longer sending.
      this.items = 0;
      this.bytes = 0;
    }
  }

  /** Is this child currently over any limit? Used to render "degraded" without attempting a write. */
  isThrottled(now) {
    this._roll(now);
    return this.messages >= this.limits.maxMessages
        || this.bytes >= this.limits.maxBytes
        || this.storedRows >= this.limits.maxStoredRows;
  }
}

class Backpressure {
  constructor(limits = {}) {
    this.limits = { ...DEFAULTS, ...limits };
    this.children = new Map();
  }

  budgetFor(childId) {
    if (!this.children.has(childId)) {
      this.children.set(childId, new ChildBudget(childId, this.limits));
    }
    return this.children.get(childId);
  }

  /**
   * May this message be accepted from this child right now?
   *
   * @returns {{ok: true} | {ok: false, limit: 'rate'|'bytes'|'store', reason: string, retryAfterMs: number}}
   */
  /**
   * @param {string} childId
   * @param {number} sizeBytes
   * @param {number} now
   * @param {number} [itemCount=1]  payloads carried — a batch counts every item it holds
   */
  admit(childId, sizeBytes, now, itemCount = 1) {
    const b = this.budgetFor(childId);
    b._roll(now);

    const retryAfterMs = Math.max(0, b.windowStart + this.limits.windowMs - now);

    /*
     * ⚠️ STORAGE IS CHECKED FIRST. Rate and byte limits are transient — wait a window and the child
     * is welcome again. A storage limit is not: retrying does not help, and telling an operator to
     * "try later" when the answer is "this child's retention needs attention" wastes their time on
     * the wrong problem.
     */
    if (b.storedRows >= this.limits.maxStoredRows) {
      b.refused.store++;
      b.lastRefusalAt = now;
      return {
        ok: false,
        limit: 'store',
        retryAfterMs: 0,
        reason: `This node is holding the maximum ${this.limits.maxStoredRows.toLocaleString()} ` +
                `rows for "${childId}" and will not accept more until some are pruned. Shorten the ` +
                `retention on that connection, or purge its history.`,
      };
    }

    if (b.messages + 1 > this.limits.maxMessages) {
      b.refused.rate++;
      b.lastRefusalAt = now;
      return {
        ok: false,
        limit: 'rate',
        retryAfterMs,
        reason: `"${childId}" is sending more than ${this.limits.maxMessages} messages per ` +
                `${this.limits.windowMs / 1000}s and is being throttled. Its own data is delayed; ` +
                `no other connection is affected.`,
      };
    }

    /*
     * ⚠️ The check batching exists for. A batch is ONE message carrying many payloads, so counting
     * messages alone would let a child move unlimited volume by wrapping it — the exact behaviour
     * the rate limit was written to prevent, arriving through the door we just opened.
     */
    if (b.items + itemCount > this.limits.maxItems) {
      b.refused.items++;
      b.lastRefusalAt = now;
      return {
        ok: false,
        limit: 'items',
        retryAfterMs,
        reason: `"${childId}" is sending more than ${this.limits.maxItems.toLocaleString()} ` +
                `payloads per ${this.limits.windowMs / 1000}s and is being throttled. Batching ` +
                `reduces messages, not the amount of data — its own reports are delayed, and no ` +
                `other connection is affected.`,
      };
    }

    const size = Number.isFinite(sizeBytes) ? sizeBytes : 0;
    if (b.bytes + size > this.limits.maxBytes) {
      b.refused.bytes++;
      b.lastRefusalAt = now;
      return {
        ok: false,
        limit: 'bytes',
        retryAfterMs,
        reason: `"${childId}" is sending more than ${Math.round(this.limits.maxBytes / 1048576)}MB ` +
                `per ${this.limits.windowMs / 1000}s and is being throttled. Its own data is ` +
                `delayed; no other connection is affected.`,
      };
    }

    b.messages++;

    b.items += itemCount;
    b.bytes += size;
    return { ok: true };
  }

  /** Record rows actually persisted for a child, so the storage bound means something. */
  noteStored(childId, rows, now) {
    const b = this.budgetFor(childId);
    b.storedRows = Math.max(0, b.storedRows + rows);
    if (now !== undefined) b._roll(now);
    return b.storedRows;
  }

  /** Health of one child, for the UI. */
  statusFor(childId, now) {
    const b = this.budgetFor(childId);
    return {
      childId,
      throttled: b.isThrottled(now),
      messagesThisWindow: b.messages,
      bytesThisWindow: b.bytes,
      storedRows: b.storedRows,
      refused: { ...b.refused },
      lastRefusalAt: b.lastRefusalAt,
    };
  }

  /** Every child that is currently over a limit — what a "degraded connections" panel renders. */
  throttledChildren(now) {
    return [...this.children.keys()].filter((id) => this.children.get(id).isThrottled(now));
  }

  /** Forget a child entirely (disenrollment). */
  forget(childId) {
    return this.children.delete(childId);
  }
}

module.exports = { Backpressure, ChildBudget, DEFAULTS };
