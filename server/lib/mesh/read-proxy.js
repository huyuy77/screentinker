'use strict';

/*
 * Reading a child's own API from the parent, so a remote org can render with the SAME screens the
 * child would draw rather than a reduced summary of it.
 *
 * ⚠️ THIS CHANGES THE SHAPE OF I2, AND THE CHANGE IS WORTH STATING PLAINLY.
 *
 * I2 was "there is no downward channel", enforced by the absence of a mechanism: the parent listened
 * and never spoke. That is no longer true — the parent can now ASK. What must remain true is that it
 * cannot TELL, and "we only send reads" is a convention, which is exactly the kind of thing that
 * holds until somebody adds one convenient endpoint.
 *
 * So the enforcement is an ALLOWLIST OF EXACT PATHS, checked on the CHILD, with the method pinned to
 * GET. A parent that asked for anything else gets a refusal from the side that owns the data — not
 * from the side that wants it. A blocklist would have been the natural shape and is the wrong one:
 * it fails open for every route added after it was written.
 *
 * ⚠️ IT RUNS OVER THE EXISTING SOCKET, NOT OVER HTTP. The child dialled out precisely because it may
 * sit behind NAT with no inbound route — the deployment shape this whole feature exists for. A parent
 * making an HTTP request to a child would work on a lab bench and fail at every real site.
 */

/**
 * Exactly what a parent may read, and nothing else.
 *
 * ⚠️ Each entry names the grant it needs. A hub with a health-only edge asking for the device list
 * gets health-shaped rows and no names — the same degradation as the mirror, because the grant is
 * the client's decision and a proxy must not become the way around it.
 */
const READABLE = Object.freeze({
  '/api/devices':  { grant: 'health', scope: 'workspace' },
  '/api/groups':   { grant: 'identity', scope: 'workspace' },
  '/api/playlists': { grant: 'content-metadata', scope: 'workspace' },
});

function isReadable(path) {
  return Object.prototype.hasOwnProperty.call(READABLE, path);
}

/**
 * May this edge read this path?
 *
 * @param {object} edge         the edge the request arrived on (child side)
 * @param {string} path
 * @param {string} method
 * @param {string[]} grants     the edge's granted categories
 */
function authorize(edge, path, method, grants) {
  if (String(method || 'GET').toUpperCase() !== 'GET') {
    return {
      ok: false,
      reason: 'This connection can read, and cannot write. Only GET is accepted.',
    };
  }
  if (!isReadable(path)) {
    /*
     * ⚠️ The refusal does not distinguish "no such route" from "not allowed", because a parent has
     * no business mapping this server's API surface. It only needs to know the answer is no.
     */
    return { ok: false, reason: 'That is not something this connection may read.' };
  }
  const need = READABLE[path].grant;
  if (!grants.includes(need)) {
    return {
      ok: false,
      reason: `This connection was not granted "${need}", so it cannot read that.`,
    };
  }
  return { ok: true, rule: READABLE[path] };
}

/**
 * Narrow a payload to the workspaces this edge may see.
 *
 * ⚠️ APPLIED HERE RATHER THAN TRUSTED FROM THE QUERY. The parent asks for a path, not for a filter —
 * if the parent could pass a workspace id, a parent that asked for the wrong one would be answered,
 * and the scope would be enforced by the side that benefits from ignoring it.
 */
function scopeRows(rows, sharedWorkspaces) {
  if (!Array.isArray(rows)) return rows;
  // null / empty means every workspace, which only the instance owner can have chosen.
  if (!sharedWorkspaces || !sharedWorkspaces.length) return rows;
  return rows.filter((r) => !r || r.workspace_id == null || sharedWorkspaces.includes(r.workspace_id));
}

/**
 * Strip fields the grant does not cover.
 *
 * ⚠️ Built by ADDING what is allowed, never by deleting what is not — the same rule as the mirror
 * projections. A delete-based filter silently starts shipping every column added afterwards, and
 * nobody discovers it until a client asks why their hub knows something they never shared.
 */
function projectRows(rows, grants, projectOne) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => projectOne(r, grants));
}

module.exports = { READABLE, isReadable, authorize, scopeRows, projectRows };
