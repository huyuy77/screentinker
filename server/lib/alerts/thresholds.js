'use strict';

/*
 * Threshold alert rules: when a condition opens, when it closes, and when it is just noise.
 *
 * ⚠️ A BARE THRESHOLD IS AN ALERT GENERATOR, NOT AN ALERT. A screen sitting at 10.0% free storage
 * with a "below 10%" rule crosses the line every time it writes a log file: open, close, open, close,
 * every sixty seconds, for days. The operator does not learn that storage is low — they learn to mute
 * the alerts, which is strictly worse than having none.
 *
 * Two mechanisms, because they stop different things:
 *
 *   SUSTAIN     the condition must hold for N seconds before it opens. Kills the transient — a CPU
 *               spike while a video decodes is not a fault, and alerting on it teaches people that
 *               alerts are wrong.
 *   HYSTERESIS  once open, it closes at a DIFFERENT value than it opened at. Kills the flap at the
 *               boundary, which sustain alone cannot: a device parked at exactly the threshold
 *               satisfies "held for 5 minutes" over and over.
 *
 * Sustain without hysteresis still flaps at the line. Hysteresis without sustain still fires on
 * spikes. Both, or neither is worth having.
 *
 * ⚠️ AN ALERT HAS A LIFECYCLE, NOT JUST A MOMENT. It opens, it stays open, it closes. That is what
 * makes "your 40 screens were up 99.2%, here are the three incidents" answerable at all — a stream of
 * notifications with no close events can never be turned into a duration.
 */

/**
 * What can be alerted on, and how to read it from a telemetry row.
 *
 * ⚠️ Drawn from the Phase −1 inventory: everything here is a field confirmed to be populated by real
 * devices. Alerting on a field that is always NULL produces a rule that silently never fires, which
 * is worse than no rule because someone believes they are covered.
 */
const METRICS = Object.freeze({
  offline_seconds: {
    label: 'Offline for',
    unit: 's',
    direction: 'above',
    read: (t, ctx) => (t.last_heartbeat ? ctx.now - t.last_heartbeat : null),
  },
  storage_free_pct: {
    label: 'Free storage',
    unit: '%',
    direction: 'below',
    read: (t) => (t.storage_total_mb > 0 ? (t.storage_free_mb / t.storage_total_mb) * 100 : null),
  },
  ram_free_pct: {
    label: 'Free memory',
    unit: '%',
    direction: 'below',
    read: (t) => (t.ram_total_mb > 0 ? (t.ram_free_mb / t.ram_total_mb) * 100 : null),
  },
  cpu_usage: {
    label: 'CPU usage',
    unit: '%',
    direction: 'above',
    read: (t) => (typeof t.cpu_usage === 'number' ? t.cpu_usage : null),
  },
  battery_level: {
    label: 'Battery',
    unit: '%',
    direction: 'below',
    // ⚠️ Android-only in practice — the web player has no battery API and correctly reports null.
    // A null reading is NOT a breach; see evaluate().
    read: (t) => (typeof t.battery_level === 'number' ? t.battery_level : null),
  },
  wifi_rssi: {
    label: 'Wi-Fi signal',
    unit: 'dBm',
    direction: 'below',
    read: (t) => (typeof t.wifi_rssi === 'number' ? t.wifi_rssi : null),
  },
});

const DEFAULT_SUSTAIN_SECONDS = 300;

/**
 * The value at which an open alert closes again.
 *
 * ⚠️ Defaults to a 10% margin on the RIGHT SIDE of the threshold, which depends on the direction: a
 * "below 10%" rule must close ABOVE 10, a "above 80%" rule must close BELOW 80. Getting that
 * backwards produces a rule that can never close, and an alert that never closes is indistinguishable
 * from a broken sweep.
 */
function clearValueFor(rule) {
  if (typeof rule.clear_threshold === 'number') return rule.clear_threshold;
  const dir = METRICS[rule.metric] ? METRICS[rule.metric].direction : 'above';
  const margin = Math.abs(rule.threshold) * 0.1 || 1;
  return dir === 'below' ? rule.threshold + margin : rule.threshold - margin;
}

function breaches(rule, value) {
  const dir = METRICS[rule.metric] ? METRICS[rule.metric].direction : 'above';
  return dir === 'below' ? value < rule.threshold : value > rule.threshold;
}

function cleared(rule, value) {
  const dir = METRICS[rule.metric] ? METRICS[rule.metric].direction : 'above';
  const clear = clearValueFor(rule);
  return dir === 'below' ? value > clear : value < clear;
}

/**
 * Decide what should happen to one (rule, device) pair.
 *
 * @param {object} rule    {metric, threshold, clear_threshold?, sustain_seconds?, severity}
 * @param {object} sample  a telemetry row
 * @param {object} state   {breaching_since, open_event_id} — persisted between ticks
 * @param {object} ctx     {now}
 * @returns {{action: 'open'|'close'|'pending'|'none', value: number|null, reason?: string}}
 */
function evaluate(rule, sample, state, ctx) {
  const metric = METRICS[rule.metric];
  if (!metric) return { action: 'none', value: null, reason: `unknown metric ${rule.metric}` };

  const value = metric.read(sample || {}, ctx);

  /*
   * ⚠️ NO READING IS NOT A BREACH, AND IT IS ALSO NOT A CLEAR.
   *
   * A web player reports null battery because it genuinely cannot know. Treating null as 0 would
   * open a critical battery alert on every browser-based screen in the fleet; treating it as "fine"
   * and CLOSING an open alert would silently resolve a real problem the moment a device stopped
   * reporting. Absence of evidence is neither, so the state is left exactly as it is.
   */
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { action: 'none', value: null, reason: 'no reading' };
  }

  const sustain = typeof rule.sustain_seconds === 'number'
    ? rule.sustain_seconds : DEFAULT_SUSTAIN_SECONDS;
  const isOpen = !!(state && state.open_event_id);

  if (isOpen) {
    // Hysteresis: closing needs the value to come back PAST the clear point, not merely to the line.
    if (cleared(rule, value)) return { action: 'close', value };
    return { action: 'none', value, reason: 'still breaching' };
  }

  if (!breaches(rule, value)) return { action: 'none', value };

  const since = state && state.breaching_since ? state.breaching_since : ctx.now;
  if (ctx.now - since >= sustain) return { action: 'open', value };

  // Breaching, but not for long enough yet. The caller records `breaching_since` so the clock
  // survives a restart — otherwise a service that restarts every hour can never open a 5-minute
  // sustained alert, and the failure is invisible.
  return { action: 'pending', value, reason: 'sustaining' };
}

/** Human summary for the notification and the incident list. */
function describe(rule, value) {
  const m = METRICS[rule.metric];
  if (!m) return `${rule.metric} ${value}`;
  const rounded = Math.round(value * 10) / 10;
  if (rule.metric === 'offline_seconds') {
    return `Offline for ${Math.floor(value / 60)} minutes`;
  }
  return `${m.label} ${m.direction === 'below' ? 'below' : 'above'} ${rule.threshold}${m.unit} ` +
         `(currently ${rounded}${m.unit})`;
}

/** Validate a rule an operator is trying to save, with a readable refusal. */
function validateRule(rule) {
  if (!rule || !METRICS[rule.metric]) {
    return { ok: false, reason: `"${rule && rule.metric}" is not something that can be measured. ` +
                                `Available: ${Object.keys(METRICS).join(', ')}.` };
  }
  if (typeof rule.threshold !== 'number' || Number.isNaN(rule.threshold)) {
    return { ok: false, reason: 'A threshold must be a number.' };
  }
  if (rule.sustain_seconds !== undefined &&
      (typeof rule.sustain_seconds !== 'number' || rule.sustain_seconds < 0)) {
    return { ok: false, reason: 'The sustain time must be zero or more seconds.' };
  }
  /*
   * ⚠️ A clear threshold on the wrong side means the alert can NEVER close, and an alert that never
   * closes looks exactly like a broken sweep. Refuse it at save time rather than letting someone
   * discover it during an incident.
   */
  if (typeof rule.clear_threshold === 'number') {
    const dir = METRICS[rule.metric].direction;
    const wrong = dir === 'below'
      ? rule.clear_threshold < rule.threshold
      : rule.clear_threshold > rule.threshold;
    if (wrong) {
      return {
        ok: false,
        reason: dir === 'below'
          ? `This alert opens below ${rule.threshold} so it must clear ABOVE that, not at ` +
            `${rule.clear_threshold} — otherwise it could never close.`
          : `This alert opens above ${rule.threshold} so it must clear BELOW that, not at ` +
            `${rule.clear_threshold} — otherwise it could never close.`,
      };
    }
  }
  return { ok: true };
}

module.exports = {
  METRICS, DEFAULT_SUSTAIN_SECONDS,
  evaluate, describe, validateRule, clearValueFor, breaches, cleared,
};
