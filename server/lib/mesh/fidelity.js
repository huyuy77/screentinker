'use strict';

/*
 * Aggregate fidelity: what survives a hop, and what is allowed to be thinned.
 *
 * ⚠️ SPECIFIED, NOT EMERGENT — which is the whole instruction. Per-sample data does not survive many
 * hops, and the failure is not that it gets lost: it is that it silently gets AVERAGED, and the
 * consumer cannot tell a smooth line from a real one. This is precisely where Prometheus federation
 * disappoints people, and it disappoints them late, after they have built a report on it.
 *
 * THE RULES:
 *
 *   FULL FIDELITY AT ANY DEPTH   alerts, and current state. An alert is an event, not a
 *                                measurement — averaging it is meaningless, and "current state" that
 *                                has been smoothed is not current. These are also small: a fleet
 *                                has thousands of screens, not millions of alerts.
 *
 *   DOWNSAMPLED PER HOP          historical telemetry. Storage per hop is the product of the subtree
 *                                below it, so raw samples from a thousand screens at four hops is
 *                                the one thing that genuinely will not fit.
 *
 *   NEVER DOWNSAMPLED            anything carrying a `no-downsample` grant property. Proof-of-play
 *                                is the case: averaged evidence is not evidence, and a bill built on
 *                                it cannot be defended. Costs bandwidth proportional to depth, and
 *                                that cost is documented rather than discovered.
 *
 * ⚠️ THE SAMPLING INTERVAL TRAVELS WITH THE DATA. This is the part that is easy to skip and is the
 * difference between a thinned series and a lie. Without it, a consumer three hops away sees a
 * sparse series and cannot distinguish "sampled every 15 minutes" from "the screen was off". Any UI
 * drawing this has to be able to say what resolution it is drawing.
 */

/** Payload types that must arrive intact however deep the tree gets. */
const FULL_FIDELITY_TYPES = Object.freeze(new Set([
  'alert-event',     // an event, not a measurement
  'node-health',     // current state
  'device-summary',  // current state
  'tombstone',       // a deletion is not a quantity
]));

/**
 * Types that may be thinned, and the base interval to thin them to.
 * The interval WIDENS with depth — see intervalFor().
 */
const DOWNSAMPLABLE = Object.freeze({
  'telemetry-series': 60,     // seconds at hop 1
});

/** A grant property that opts a category out of thinning entirely. */
const NO_DOWNSAMPLE_PROPERTY = 'no-downsample';

/**
 * Categories that are refused thinning REGARDLESS of grant properties.
 *
 * ⚠️ proof-of-play is here rather than merely defaulting to no-downsample, because the failure is
 * unrecoverable and silent: an averaged play log still looks like a play log, and nobody discovers
 * the problem until they are defending an invoice. A property somebody has to remember to set is the
 * wrong shape for that.
 */
const NEVER_DOWNSAMPLE = Object.freeze(new Set(['proof-of-play']));

/**
 * How coarse the data becomes at a given depth.
 *
 * ⚠️ WIDENS GEOMETRICALLY, because the volume it is defending against grows the same way: each hop
 * carries the whole subtree beneath it. A linear widening would keep the ratio constant and lose the
 * argument at depth four, which is exactly where it needs to hold.
 */
function intervalFor(type, hops, opts = {}) {
  if (isFullFidelity(type, opts)) return null;      // null = not downsampled
  const base = DOWNSAMPLABLE[type] || 60;
  const depth = Math.max(1, Number(hops) || 1);
  return base * 2 ** (depth - 1);
}

function isFullFidelity(type, { grantProperties = [], category = null } = {}) {
  if (FULL_FIDELITY_TYPES.has(type)) return true;
  if (category && NEVER_DOWNSAMPLE.has(category)) return true;
  if (NEVER_DOWNSAMPLE.has(type)) return true;
  return Array.isArray(grantProperties) && grantProperties.includes(NO_DOWNSAMPLE_PROPERTY);
}

/**
 * Thin a series to one point per interval.
 *
 * ⚠️ KEEPS THE EXTREMES, NOT THE MEAN. A mean is the wrong summary for the questions asked of this
 * data: nobody asks "what was the average free storage", they ask "did it ever run out". Averaging a
 * five-minute spike to 100% CPU into an hour of 30% erases the only interesting thing in the window,
 * and it erases it in a way that looks like clean data.
 *
 * Each bucket therefore carries min, max and the count behind them, so a consumer can see both what
 * happened and how much was folded to say it.
 */
function downsample(points, intervalSec, { valueKey = 'value', timeKey = 't' } = {}) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (!intervalSec || intervalSec <= 0) return points.slice();

  const buckets = new Map();
  for (const p of points) {
    const t = Number(p[timeKey]);
    const v = Number(p[valueKey]);
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / intervalSec) * intervalSec;
    let b = buckets.get(key);
    if (!b) {
      b = { [timeKey]: key, min: v, max: v, count: 0, sum: 0 };
      buckets.set(key, b);
    }
    if (Number.isFinite(v)) {
      b.min = Math.min(b.min, v);
      b.max = Math.max(b.max, v);
      b.sum += v;
      b.count += 1;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a[timeKey] - b[timeKey])
    .map((b) => ({
      [timeKey]: b[timeKey],
      min: b.count ? b.min : null,
      max: b.count ? b.max : null,
      // The mean is offered but is NOT the summary — min/max are, for the reason above.
      mean: b.count ? Math.round((b.sum / b.count) * 10) / 10 : null,
      samples: b.count,
    }));
}

/**
 * Apply the fidelity rules to a payload about to cross a hop.
 *
 * ⚠️ ALWAYS RETURNS THE RESOLUTION, even when nothing was thinned. A consumer must never have to
 * infer whether it is looking at raw data — "the field was absent so it is probably raw" is exactly
 * the assumption that turns a thinned series into a wrong conclusion.
 */
function forHop(type, body, hops, opts = {}) {
  const full = isFullFidelity(type, opts);
  const interval = full ? null : intervalFor(type, hops, opts);

  if (full || !Array.isArray(body && body.points)) {
    return {
      body,
      fidelity: {
        downsampled: false,
        intervalSec: null,
        hops,
        reason: full ? reasonForFull(type, opts) : 'not a series',
      },
    };
  }

  const before = body.points.length;
  const points = downsample(body.points, interval);
  return {
    body: { ...body, points },
    fidelity: {
      downsampled: points.length < before,
      intervalSec: interval,
      hops,
      samplesBefore: before,
      samplesAfter: points.length,
      // ⚠️ Phrased for a person, because it ends up on a chart axis. "60s buckets" means nothing to
      // an operator wondering why their graph looks different from the one on the site's own server.
      label: `one point per ${humanInterval(interval)} (thinned ${hops} hop${hops === 1 ? '' : 's'} from the source)`,
    },
  };
}

function reasonForFull(type, opts = {}) {
  if (FULL_FIDELITY_TYPES.has(type)) return 'events and current state are never thinned';
  if (NEVER_DOWNSAMPLE.has(type) || NEVER_DOWNSAMPLE.has(opts.category)) {
    return 'this data is evidence — averaged evidence is not evidence';
  }
  return 'the grant asks for raw data at any depth';
}

function humanInterval(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec / 3600)} hours`;
}

/**
 * What a no-downsample grant costs, so it can be shown BEFORE it is agreed.
 *
 * ⚠️ Documented rather than discovered. The cost is proportional to depth and to the subtree, and an
 * operator who turns this on for a 400-screen site four hops up should see the number first — not in
 * a bandwidth bill.
 */
function noDownsampleCost({ devices, samplesPerHour = 240, hops = 1, bytesPerSample = 64 }) {
  const perHour = devices * samplesPerHour * bytesPerSample;
  return {
    bytesPerHourAtOrigin: perHour,
    // Every hop carries it again — this is the part people do not expect.
    bytesPerHourAcrossMesh: perHour * hops,
    hops,
    note: `Raw data is re-sent at every hop, so ${hops} hop${hops === 1 ? '' : 's'} costs ` +
          `${hops}× the origin's bandwidth. Thinned telemetry does not grow this way.`,
  };
}

module.exports = {
  FULL_FIDELITY_TYPES, DOWNSAMPLABLE, NEVER_DOWNSAMPLE, NO_DOWNSAMPLE_PROPERTY,
  isFullFidelity, intervalFor, downsample, forHop, noDownsampleCost, humanInterval,
};
