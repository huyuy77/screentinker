'use strict';

/*
 * Per-child circuit breaker.
 *
 * ⚠️ THE FAILURE IT PREVENTS IS A STALLED SWEEP, NOT WASTED RETRIES (invariant I6). A hub with forty
 * children runs a periodic pass over them. One child that is unreachable does not merely fail — it
 * fails SLOWLY, holding a connect timeout while the other thirty-nine wait behind it. Ten dead
 * children and the sweep no longer completes within its own interval, at which point every healthy
 * site's data goes stale because one site's server is switched off.
 *
 * The breaker turns "try and wait" into "already known to be down, skip". A dead child costs a map
 * lookup instead of a timeout.
 *
 * ⚠️ THE HALF-OPEN STATE IS THE POINT, and it is what a bare "stop trying after N failures" gets
 * wrong. A breaker that only ever opens is a breaker that needs a human to reset it, and nobody is
 * watching. After a cooldown it lets exactly ONE attempt through: success closes it, failure re-opens
 * it with a longer cooldown. Recovery is automatic and costs one probe, not a stampede.
 *
 * Jitter on the cooldown for the #144 reason: a hub restart trips every breaker at once, and without
 * jitter they would all half-open in the same instant — the thundering herd, rebuilt inside the
 * mechanism meant to prevent it.
 */

const STATE = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' });

const DEFAULTS = Object.freeze({
  failureThreshold: 3,        // consecutive failures before giving up on a child for a while
  cooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000, // a child down for hours is probed every ~15 min, not every 30s
  jitterRatio: 0.3,
});

class ChildBreaker {
  constructor(childId, limits, rand) {
    this.childId = childId;
    this.limits = limits;
    this.rand = rand;
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.nextProbeAt = 0;
    this.lastError = null;
    this.trips = 0;
  }

  _cooldown() {
    // Doubles per trip to the ceiling, then jitters around it.
    const base = Math.min(this.limits.cooldownMs * 2 ** Math.max(0, this.trips - 1),
                          this.limits.maxCooldownMs);
    const jitter = base * this.limits.jitterRatio * (this.rand() * 2 - 1);
    return Math.max(1_000, Math.round(base + jitter));
  }
}

class CircuitBreakers {
  constructor(limits = {}, rand = Math.random) {
    this.limits = { ...DEFAULTS, ...limits };
    this.rand = rand;
    this.children = new Map();
  }

  for(childId) {
    if (!this.children.has(childId)) {
      this.children.set(childId, new ChildBreaker(childId, this.limits, this.rand));
    }
    return this.children.get(childId);
  }

  /**
   * Should the sweep attempt this child at all?
   *
   * ⚠️ Answering this is the whole value: it is a map lookup, where attempting a dead child is a
   * timeout. The sweep asks before it acts, and a down child costs nothing.
   */
  shouldAttempt(childId, now) {
    const b = this.for(childId);
    if (b.state === STATE.CLOSED) return true;
    if (b.state === STATE.HALF_OPEN) return false;   // a probe is already in flight
    if (now >= b.nextProbeAt) {
      b.state = STATE.HALF_OPEN;                     // let exactly one through
      return true;
    }
    return false;
  }

  recordSuccess(childId) {
    const b = this.for(childId);
    b.state = STATE.CLOSED;
    b.consecutiveFailures = 0;
    b.trips = 0;                 // ⚠️ reset the ESCALATION too, or a node that recovers keeps being
    b.openedAt = null;           // probed on the long cooldown it earned during an outage last week
    b.lastError = null;
    return b.state;
  }

  recordFailure(childId, now, error) {
    const b = this.for(childId);
    b.lastError = (error && error.message) || String(error || 'unknown');

    // A failed probe re-opens immediately: half-open exists to test, and one failure is the answer.
    if (b.state === STATE.HALF_OPEN) {
      b.trips += 1;
      b.state = STATE.OPEN;
      b.openedAt = now;
      b.nextProbeAt = now + b._cooldown();
      return b.state;
    }

    b.consecutiveFailures += 1;
    if (b.consecutiveFailures >= this.limits.failureThreshold) {
      b.trips += 1;
      b.state = STATE.OPEN;
      b.openedAt = now;
      b.nextProbeAt = now + b._cooldown();
    }
    return b.state;
  }

  /** For the topology view: which children are we not currently talking to, and why. */
  status(now) {
    return [...this.children.values()].map((b) => ({
      childId: b.childId,
      state: b.state,
      consecutiveFailures: b.consecutiveFailures,
      trips: b.trips,
      lastError: b.lastError,
      // ⚠️ Surfaced so a UI can say "retrying in 4 minutes" rather than "offline", which reads as
      // abandoned. The operator needs to know the system is still trying.
      nextProbeInMs: b.state === STATE.OPEN ? Math.max(0, b.nextProbeAt - now) : null,
    }));
  }

  forget(childId) { return this.children.delete(childId); }
}

module.exports = { CircuitBreakers, ChildBreaker, STATE, DEFAULTS };
