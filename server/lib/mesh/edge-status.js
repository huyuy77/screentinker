'use strict';

/*
 * Ending a relationship, and showing it honestly from below while it lasts.
 *
 * ⚠️ CONSENT HAS TO BE VISIBLE FROM THE SIDE BEING OBSERVED. A child's own dashboard must show which
 * parent is linked, exactly what that parent can see, when it last synced, and a revoke button. An
 * MSP link a client cannot see or sever is a contract dispute waiting to happen — and in the ordinary
 * case, visibility is the thing that makes a client comfortable agreeing in the first place.
 *
 * The asymmetry to resist: it is the PARENT that gets a topology view and an inbox, so it is the
 * parent's UI that naturally gets built. The child's view is the one that protects the person who did
 * not ask for any of this, which is why it is modelled here rather than left to a template.
 */

const grants = require('./grants');

/** A parent that has not been heard from in this long is shown as stale rather than healthy. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * What the CHILD shows about its parent.
 *
 * ⚠️ States the grant in terms of what the other side CAN SEE, not in terms of category names. "This
 * hub can see: health, identity" tells a client nothing they can evaluate; "whether your screens are
 * up, and what each one is called" is a sentence they can agree or object to. The consequences come
 * from grants.js so the wording cannot drift from what is actually enforced.
 */
function consentView(edge, now) {
  if (!edge || edge.direction !== 'up') return null;

  const categories = Array.isArray(edge.grant_categories) ? edge.grant_categories : [];
  const lastSync = typeof edge.last_sync_at === 'number' ? edge.last_sync_at : null;
  const revoked = !!edge.revoked_at;

  return {
    parentNodeId: edge.peer_node_id,
    linked: !revoked,
    revokedAt: edge.revoked_at || null,

    // Exactly what it can see, in plain language.
    sharing: categories,
    sharingExplained: grants.describeGrant(categories),

    lastSyncAt: lastSync,
    // ⚠️ "Never synced" is NOT stale — it is a connection that has not started, and telling a client
    // their brand-new link is unhealthy sends them debugging something that is merely new.
    stale: lastSync !== null && (now - lastSync) > STALE_AFTER_MS,

    // The child can always sever. This is not a permission the parent grants.
    canRevoke: !revoked,

    // ⚠️ Stated explicitly because it is the question a client actually asks, and the answer is
    // reassuring only if it is written down somewhere they can read it.
    parentCanControlThisNode: false,
  };
}

/**
 * Sever an edge, from either side.
 *
 * ⚠️ RETAINED AND MARKED STALE BY DEFAULT; PURGE IS A SEPARATE, EXPLICIT ACT.
 *
 * Deleting the mirrored data on disenrollment is the intuitive behaviour and it is wrong: last
 * month's uptime report would silently change because somebody disconnected a client today, and a
 * report that rewrites itself cannot be cited in an invoice dispute. So the default keeps history and
 * stops the flow.
 *
 * The client's right to have their data removed is real, which is why `purge` exists — but it is a
 * decision someone makes, with the consequence stated, rather than a side effect of clicking
 * disconnect.
 *
 * ⚠️ NOTHING IS SENT DOWNWARD. Revocation is enforced at this edge; a subtree below simply stops
 * flowing through it and is never notified, because notifying it would be a downward command (I2).
 */
function disenroll(edge, { by, now, purge = false, reason = null }) {
  if (!edge) return { ok: false, reason: 'No such connection.' };
  if (edge.revoked_at) {
    return { ok: false, reason: 'That connection was already disconnected.' };
  }
  if (by !== 'parent' && by !== 'child') {
    return { ok: false, reason: 'A disconnection must record which side ended it.' };
  }

  return {
    ok: true,
    edge: {
      ...edge,
      revoked_at: now,
      revoked_by: by,
      revoked_reason: reason,
      // Mirrored rows stay; they are simply no longer being added to.
      mirrored_state: purge ? 'purge-requested' : 'retained-stale',
    },
    // What to tell the operator, distinguishing the two very different outcomes.
    summary: purge
      ? 'Disconnected, and the mirrored data is queued for deletion. Reports that included this ' +
        'node will change once the purge completes.'
      : 'Disconnected. No further data will be shared. What was already received is kept and marked ' +
        'stale, so existing reports stay accurate — purge it separately if it should be removed.',
  };
}

/**
 * A node that has lost its parent.
 *
 * ⚠️ REVERTS TO STANDALONE SILENTLY (I1). Losing an observer is not an incident: scheduling,
 * playback, local alerting and the local dashboard are unchanged, so raising an alarm would train an
 * operator to ignore alarms. It is surfaced in the connection view, and nowhere else.
 */
function onParentLost(edge, now) {
  return {
    stillFullyFunctional: true,
    buffering: true,          // hold observations for backfill when the link returns
    alarm: false,
    connectionView: consentView({ ...edge, last_sync_at: edge.last_sync_at }, now),
  };
}

module.exports = { STALE_AFTER_MS, consentView, disenroll, onParentLost };
