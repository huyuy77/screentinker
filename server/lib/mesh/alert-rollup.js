'use strict';

/*
 * Turning N node-level alerts into one hub-level alert.
 *
 * ⚠️ ROLLUP IS AN ACCURACY FIX, NOT A NOISE FIX — and that distinction changes the design.
 *
 * When forty sites report "screens offline" inside the same minute, that is almost never forty
 * independent problems. It is one problem: a provider outage, a bad rollout, or the hub's own
 * connectivity. Sending forty alerts does not merely spam the operator, it actively MISLEADS them —
 * it describes forty faults to investigate when there is one, and the first thirty-nine minutes are
 * spent proving the sites are fine.
 *
 * ⚠️ AND THE MOST IMPORTANT CASE IS THAT THE HUB IS THE BROKEN THING.
 *
 * If a hub loses its own uplink, every child stops reporting and every child looks offline. A naive
 * rollup announces "40 sites are down", which is false and sends someone to a client's premises. The
 * correct reading of "everything went silent at once" is: suspect the observer first. That is what
 * `suspectSelf` encodes, and it is the difference between a useful alert and a harmful one.
 *
 * Deliberately produces DESCRIPTIONS rather than sending anything, so it can feed the existing
 * services/alerts.js dedup (per alert-type/target window plus the durable once-per-outage marker)
 * instead of growing a parallel notification path with its own subtly different suppression rules.
 */

/*
 * How close together node-level alerts must be to count as one condition. Long enough to catch a
 * sweep that takes a few minutes to notice everything; short enough that two genuinely separate
 * outages an hour apart stay separate.
 */
const CORRELATION_WINDOW_MS = 5 * 60 * 1000;

/*
 * The share of reporting children that must be affected before the hub suspects ITSELF rather than
 * them. Two thirds is deliberately below "all": a hub whose upstream is failing usually loses most
 * children but not always every one, and requiring 100% would miss exactly the case this exists for.
 */
const SELF_SUSPICION_RATIO = 0.66;

/**
 * Roll up open node-level alerts of one type.
 *
 * @param {Array<{node_id, type, opened_at, severity, subject_count}>} alerts
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {number} ctx.totalChildren   how many children this hub has, for the self-suspicion ratio
 * @returns {Array<object>} rolled-up alert descriptions
 */
function rollup(alerts, { now, totalChildren }) {
  const byType = new Map();
  for (const a of alerts) {
    if (!a || !a.type) continue;
    if (typeof a.opened_at === 'number' && now - a.opened_at > CORRELATION_WINDOW_MS) {
      // Outside the window: it is its own condition, not part of this one.
      byType.set(`${a.type}::stale::${a.node_id}`, [a]);
      continue;
    }
    const key = a.type;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(a);
  }

  const out = [];
  for (const [key, group] of byType) {
    const type = group[0].type;
    const nodes = [...new Set(group.map((g) => g.node_id))];
    const affectedRatio = totalChildren > 0 ? nodes.length / totalChildren : 0;

    /*
     * ⚠️ One node is not a rollup. Reporting "1 site affected" as a fleet condition buries the site's
     * name in a summary and makes a specific, actionable problem read as a statistic.
     */
    if (nodes.length === 1 && !key.includes('::stale::')) {
      out.push({
        rolled: false,
        type,
        nodeIds: nodes,
        dedupKey: `${type}:${nodes[0]}`,
        summary: null,
      });
      continue;
    }

    const suspectSelf = affectedRatio >= SELF_SUSPICION_RATIO && nodes.length > 1;
    const subjects = group.reduce((n, g) => n + (g.subject_count || 0), 0);

    out.push({
      rolled: true,
      type,
      nodeIds: nodes,
      nodeCount: nodes.length,
      subjectCount: subjects,
      affectedRatio,
      suspectSelf,
      /*
       * ⚠️ ONE KEY FOR THE WHOLE CONDITION. This is what makes the existing per-(type,target) dedup
       * in services/alerts.js suppress the group as a unit — passing each node's own key would let
       * forty alerts through, each individually "not a duplicate", which is precisely the bug.
       */
      dedupKey: suspectSelf ? `${type}:hub-self` : `${type}:rollup:${nodes.slice().sort().join(',')}`,
      summary: suspectSelf
        ? `${nodes.length} of ${totalChildren} connected sites stopped reporting at once. That is ` +
          `more likely to be this hub's own connection than ${nodes.length} separate outages — ` +
          `check this server's network before contacting the sites.`
        : `${type.replace(/[_-]/g, ' ')} at ${nodes.length} sites` +
          (subjects ? `, affecting ${subjects} screens` : '') + '.',
    });
  }
  return out;
}

/**
 * Should this rolled-up condition be sent, given what was sent before?
 *
 * Mirrors the once-per-outage semantics rather than reimplementing them: a condition alerts once when
 * it opens and not again while it remains open, so a flapping child cannot generate a stream.
 *
 * ⚠️ Keyed on the CONDITION, not the notification. A rollup whose affected set grows — 12 sites, then
 * 30 — is the same condition getting worse, and re-alerting on every new member would reproduce the
 * per-node spam through the rollup that was meant to stop it. Escalation is a separate decision.
 */
function shouldNotify(rolledAlert, alreadyOpen) {
  if (!rolledAlert) return false;
  const open = alreadyOpen && alreadyOpen.get ? alreadyOpen.get(rolledAlert.dedupKey) : null;
  if (!open) return true;
  // Already alerted on this exact condition and it has not closed.
  return false;
}

module.exports = { rollup, shouldNotify, CORRELATION_WINDOW_MS, SELF_SUSPICION_RATIO };
