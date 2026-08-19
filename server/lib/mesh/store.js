'use strict';

/*
 * The database side of the mesh: this node's identity, and the edges it holds.
 *
 * ⚠️ EVERY FUNCTION HERE IS A NO-OP UNLESS THE MESH TABLES EXIST AND A FLAG IS ON. This module is
 * required at boot, so it must be safe on an install that has never heard of the mesh — that is the
 * "invisible by default" guarantee (I1), and it is easy to break by assuming a table.
 */

const { newNodeId } = require('./node-identity');

/**
 * This node's own id, created on first call and stable forever after.
 *
 * ⚠️ GENERATED LOCALLY, REGISTERED NOWHERE (I7). No licence check, no activation, no registry to be
 * down. An air-gapped install is first-class and cannot be if identity needs the internet.
 *
 * ⚠️ Created LAZILY rather than at boot, so an install with the mesh switched off never writes a row
 * it has no use for. A node that is never paired should be byte-identical to one on 1.9.x.
 */
function ensureNodeIdentity(db) {
  try {
    const row = db.prepare('SELECT node_id FROM mesh_node WHERE singleton = 1').get();
    if (row && row.node_id) return row.node_id;

    const id = newNodeId();
    // INSERT OR IGNORE, not INSERT: two workers booting together would otherwise race, and the
    // CHECK(singleton = 1) means the loser throws rather than being harmlessly redundant.
    db.prepare('INSERT OR IGNORE INTO mesh_node (singleton, node_id, created_at) VALUES (1, ?, ?)')
      .run(id, Math.floor(Date.now() / 1000));
    const after = db.prepare('SELECT node_id FROM mesh_node WHERE singleton = 1').get();
    return after ? after.node_id : id;
  } catch (e) {
    // No table yet (an install that has never migrated) — the mesh simply does not exist here.
    return null;
  }
}

/**
 * Find an edge by the hash of the token a caller presented.
 *
 * ⚠️ Takes the HASH, never the token. The plaintext has no reason to reach this layer, and a
 * signature that accepted one would invite it being logged by a future caller.
 */
function findEdgeByTokenHash(db, tokenHash) {
  if (!tokenHash) return null;
  try {
    const row = db.prepare(`
      SELECT id, peer_node_id, direction, role_capabilities, grant_categories,
             transport_direction, retention_days, tombstone_purge_days, tls_verify,
             peer_version, client_id, created_at, last_sync_at, revoked_at
        FROM mesh_edges
       WHERE token_hash = ? AND direction = 'down'
    `).get(tokenHash);
    if (!row) return null;
    return {
      ...row,
      // Stored as JSON text; callers expect arrays and must not each re-parse.
      role_capabilities: safeParseArray(row.role_capabilities),
      grant_categories: safeParseArray(row.grant_categories),
    };
  } catch (e) {
    return null;
  }
}

function safeParseArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    // ⚠️ A corrupt grant reads as NO grant, never as every grant. Failing closed is the only safe
    // direction when the field decides what leaves this node.
    return [];
  }
}

/** Note that an edge just heard from its peer — what the connection view calls "last synced". */
function touchEdge(db, edgeId, atSeconds) {
  try {
    db.prepare('UPDATE mesh_edges SET last_sync_at = ? WHERE id = ?')
      .run(atSeconds || Math.floor(Date.now() / 1000), edgeId);
    return true;
  } catch (e) {
    return false;
  }
}

/** Every active downward edge, for a parent's own topology view. */
function listChildEdges(db) {
  try {
    return db.prepare(`
      SELECT id, peer_node_id, grant_categories, client_id, last_sync_at, created_at
        FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL
    `).all().map((r) => ({ ...r, grant_categories: safeParseArray(r.grant_categories) }));
  } catch (e) {
    return [];
  }
}

module.exports = { ensureNodeIdentity, findEdgeByTokenHash, touchEdge, listChildEdges, safeParseArray };
