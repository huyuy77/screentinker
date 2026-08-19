'use strict';

/*
 * What a hub user may do with one client.
 *
 * ⚠️ THE OBVIOUS MODEL IS WRONG FOR 2.0. "Read-only on Acme, full on Contoso" sounds like a
 * read/write split, but a hub cannot write to a client's screens at all in 2.0 — invariant I2 makes
 * the mesh upward-only, and there is no downward command handler to authorise. A "full access" role
 * would grant a capability that does not exist, which is worse than no role at all: it reads as a
 * promise the product does not keep, and an operator would reasonably assume their tech can act on a
 * screen when they cannot.
 *
 * So the axis that genuinely differs per client today is not read versus write on the CLIENT'S DATA.
 * It is read versus control of the RELATIONSHIP:
 *
 *   viewer   — see this client's mirrored data, bounded by whatever the client granted
 *   manager  — additionally change the edge itself: retention, token rotation, disenrollment,
 *              and which nodes belong to this client
 *
 * That is a real and consequential distinction. A tech who can view Acme's screens is a very
 * different risk from one who can sever Acme's edge or shorten what is retained about them — and the
 * second is exactly the sort of thing a client asks about when they ask who at the MSP can do what.
 *
 * ⚠️ A THIRD ROLE ARRIVES WITH PHASE 5 and is deliberately NOT modelled here.
 *
 * That is a considered asymmetry with grants.js, which DOES model its write categories and refuse
 * them. The difference is where the value is negotiated. A grant is agreed between two nodes across a
 * version boundary, so the vocabulary has to be stable or an edge stored today becomes unreadable
 * later. A role is local to this hub's database and is never sent anywhere, so adding an enum value
 * later is purely additive and invalidates nothing. Pre-modelling a role whose semantics cannot yet
 * be pinned down would mean guessing at them, and the guess would be load-bearing by the time anyone
 * checked.
 */

const ROLES = Object.freeze({
  viewer: {
    rank: 1,
    summary: 'See this client\'s screens and health',
    can: Object.freeze(['view-mirrored-data']),
  },
  manager: {
    rank: 2,
    summary: 'See this client, and manage the connection to them',
    can: Object.freeze([
      'view-mirrored-data',
      'manage-edge',        // retention, tombstone purge, TLS verification, token rotation
      'disenroll',          // sever the edge from this side
      'assign-nodes',       // move a node into or out of this client
    ]),
  },
});

const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
const DEFAULT_ROLE = 'viewer';

/** Every action a client role can gate. Named so a caller cannot invent one silently. */
const ACTIONS = Object.freeze([
  'view-mirrored-data', 'manage-edge', 'disenroll', 'assign-nodes',
]);

function isKnownRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

/**
 * May a user holding `role` on a client perform `action`?
 *
 * ⚠️ Fails CLOSED on anything unrecognised. An unknown role — a typo, a row written by a newer
 * version, a value someone set by hand — grants nothing rather than defaulting to the lowest role,
 * because "lowest role" still means seeing a client's data. An unknown ACTION is refused for the same
 * reason: a caller checking a permission this module has never heard of has almost certainly
 * mistyped it, and answering true would silently wave it through.
 */
function roleAllows(role, action) {
  if (!isKnownRole(role)) return false;
  if (!ACTIONS.includes(action)) return false;
  return ROLES[role].can.includes(action);
}

/**
 * Resolve a user's effective role on a client.
 *
 * ⚠️ DEFAULT DENY BY ABSENCE. No access row means no role and no visibility, so a newly added client
 * is invisible until somebody is named on it. The alternative — visible unless denied — exposes every
 * new client to every tech the moment it is created, which is the wrong direction for a mistake to
 * fail in.
 *
 * ⚠️ platform_admin IS NOT CONTAINED, and this is deliberate rather than an oversight. The instance
 * owner can edit the database, rotate any token and grant themselves any row; pretending otherwise
 * would be security theatre that complicates the code without protecting anyone. What this model DOES
 * deliver is the property a client actually asks about: that an ordinary MSP technician sees the
 * clients they were named on and no others.
 *
 * @param {{role?: string} | null} accessRow  the mesh_client_access row, or null if none
 * @param {{role?: string}} user              the platform user
 * @returns {string|null} effective role, or null for no access
 */
function effectiveRole(accessRow, user) {
  if (user && user.role === 'platform_admin') return 'manager';
  if (!accessRow || !isKnownRole(accessRow.role)) return null;
  return accessRow.role;
}

/** Convenience: the whole question in one call. */
function userMay(accessRow, user, action) {
  const role = effectiveRole(accessRow, user);
  return role !== null && roleAllows(role, action);
}

/** Validate a role being assigned, with an operator-readable refusal. */
function validateRole(role) {
  if (isKnownRole(role)) return { ok: true, role };
  return {
    ok: false,
    reason: `"${role}" is not a client role. Available roles are: ` +
            ROLE_NAMES.map((r) => `${r} (${ROLES[r].summary.toLowerCase()})`).join(', ') + '.',
  };
}

module.exports = {
  ROLES, ROLE_NAMES, DEFAULT_ROLE, ACTIONS,
  isKnownRole, roleAllows, effectiveRole, userMay, validateRole,
};
