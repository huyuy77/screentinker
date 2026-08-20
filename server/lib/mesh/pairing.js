'use strict';

/*
 * Forming an edge: minting a code, validating an enrollment, issuing a token, revoking it.
 *
 * Deliberately the same SHAPE as adding a screen — mint a code on one side, type it on the other —
 * because that flow is understood, and a second unfamiliar ceremony for "add a server" would be
 * learned separately for no benefit. What differs is what is at stake, and that shows up in the
 * strength of the code and in how much is validated before an edge exists.
 *
 * ⚠️ HOW A REVOCATION AT HOP TWO REACHES A LEAF AT HOP FOUR — the question the directive asks, and
 * the answer is constrained by an invariant rather than chosen freely:
 *
 *   IT IS NOT PROPAGATED, BECAUSE PROPAGATING IT WOULD BE A DOWNWARD COMMAND (I2).
 *
 * Revocation is enforced at the revoked edge itself and nowhere else. Cut the edge at hop two and
 * everything below it simply stops flowing through that path — the leaf at hop four is never told,
 * needs no handler, and cannot be made to obey one. It keeps running standalone (I1), and if it has a
 * second parent (the DAG case) that path is unaffected, which is correct: the revocation was of one
 * relationship, not of the leaf's existence.
 *
 * Anything else would require a parent to reach down and change a child's state, and there is no
 * mechanism for that in 2.0 by design. This is a case where the invariant produced a simpler answer
 * than the one that would have been designed without it.
 */

const crypto = require('crypto');

/*
 * ⚠️ NOT the six-digit device code.
 *
 * lib/numeric-code.js mints 6 digits for pairing a screen — ~900k values, fine for a panel on a wall
 * behind a rate limit. An edge is a different proposition: it can carry a client's device inventory,
 * addresses and proof-of-play into somebody else's database, and it is typed ONCE by an administrator
 * between two servers rather than repeatedly by an installer. Paying for that with a longer string is
 * the right trade.
 *
 * Crockford-style alphabet: no I, L, O or U. The first three are unreadable next to 1 and 0 in the
 * fonts a terminal or a support ticket will use, and dropping U keeps accidental words out of a code
 * an operator has to read aloud over a phone.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;                      // 32^10 ≈ 2^50
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;  // long enough to walk to another machine, short enough to matter

/** Group for reading aloud: XXXXX-XXXXX. */
function mintPairingCode() {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // randomInt rejection-samples, so the distribution stays uniform rather than skewing the way a
    // modulo over randomBytes would — same reasoning as lib/numeric-code.js.
    raw += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Accept what an operator actually types: any case, spaces, missing or extra dashes. */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * ⚠️ Constant-time comparison. A pairing code is a secret with a short life and a small space, and
 * an early-exit compare leaks its prefix to anyone who can time the endpoint. `timingSafeEqual`
 * throws on a length mismatch, so the lengths are checked first — and that check is safe to leak,
 * since the length is a constant of the protocol.
 */
function codesMatch(a, b) {
  const x = Buffer.from(normalizeCode(a));
  const y = Buffer.from(normalizeCode(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * The durable per-edge token.
 *
 * ⚠️ STORED HASHED, exactly like a session or API token. The parent needs to VERIFY a token, never to
 * reproduce it, so keeping the plaintext buys nothing and turns one stolen database into standing
 * access to every child that ever enrolled.
 */
const TOKEN_BYTES = 32;

function mintEdgeToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashEdgeToken(token) };
}

function hashEdgeToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function edgeTokenMatches(presented, storedHash) {
  const a = Buffer.from(hashEdgeToken(presented));
  const b = Buffer.from(String(storedHash || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Validate an enrollment request against a minted code.
 *
 * ⚠️ ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE. The code is checked FIRST and everything else
 * after, so that an unauthenticated caller cannot use the other refusals as an oracle: version,
 * depth and cycle answers all describe the parent's topology, and a stranger guessing codes should
 * learn nothing about it. Only a caller holding a valid code gets to see a specific reason.
 *
 * Every refusal is operator-readable (directive: never accept-and-silently-degrade) — but the
 * unauthenticated one is deliberately vague.
 *
 * @param {object} req
 * @param {string} req.code                 as typed by the operator on the child
 * @param {object|null} req.codeRecord      the minted code row: {code, expires_at, burned_at}
 * @param {object} req.peer                 {nodeId, version, ancestry}
 * @param {string[]} req.capabilities       requested role capabilities
 * @param {string[]} req.grant              requested data categories
 * @param {object} req.deps                 {now, thisNodeId, maxDepth, flags, roles: {identity, capabilities, grants}}
 */
function validateEnrollment({ code, codeRecord, peer, capabilities, grant, deps }) {
  const { now, thisNodeId, maxDepth, flags, mods } = deps;

  const refuseQuietly = {
    ok: false,
    reason: 'That pairing code is not valid. Codes expire, and each one may be used once — ' +
            'generate a new one and try again.',
  };

  if (!codeRecord) return refuseQuietly;
  if (!codesMatch(code, codeRecord.code)) return refuseQuietly;
  if (codeRecord.burned_at) return refuseQuietly;
  if (typeof codeRecord.expires_at === 'number' && codeRecord.expires_at <= now) return refuseQuietly;

  // --- from here the caller has proven it holds a live code, so reasons may be specific ---

  if (!flags || !flags.acceptEnrollment) {
    return {
      ok: false,
      reason: 'This node is not configured to accept enrollments. Set MESH_ACCEPT_ENROLLMENT=1 and ' +
              'restart it, then generate a new code.',
    };
  }

  if (!peer || typeof peer.nodeId !== 'string' || !peer.nodeId) {
    return { ok: false, reason: 'The other node did not identify itself. Enrollment refused.' };
  }
  if (peer.nodeId === thisNodeId) {
    return { ok: false, reason: 'A node cannot enroll with itself.' };
  }

  /*
   * ⚠️ ALREADY CONNECTED IS CHECKED BEFORE CYCLES, and the order is about the MESSAGE, not the
   * outcome. Re-enrolling a node that is already a child trips the cycle rule too — the parent is
   * genuinely already above it — and answering "that would make a loop" sends an operator hunting
   * through their topology for a loop that does not exist. What actually happened is either a
   * double-click or a cloned VM, and those are what the reason should say.
   */
  if (typeof deps.existingEdgeForPeer === 'function') {
    const dup = mods.identity.checkDuplicateNodeId(
      peer.nodeId, deps.existingEdgeForPeer, deps.newEdgeId || '(new)');
    if (!dup.ok) return { ok: false, reason: dup.reason, duplicate: true };
  }

  /*
   * ⚠️ The floor comes from deps, defaulting to the module's own. MESH_MIN_NODE_VERSION was declared
   * in config.js and asserted in a test, but nothing ever passed it here — so an operator who set it
   * changed nothing at all, and would have had no way to find that out short of reading this line.
   */
  const floor = deps.minNodeVersion || undefined;
  if (!mods.identity.versionAcceptable(peer.version, floor)) {
    return { ok: false, reason: mods.identity.versionRefusalReason(peer.version, floor) };
  }

  /*
   * ⚠️ CYCLES ARE CHECKED IN BOTH DIRECTIONS, and THIS NODE'S OWN ancestry is the authoritative half.
   *
   * The obvious check — "is the parent in the child's declared ancestry" — catches only half the
   * cases and is the half told to us by the other party. It misses the one that actually happens:
   * A already has B below it, and somebody now tries to enroll A *under* B. A's ancestry is just
   * [A] — it has no parent — so nothing in what A says reveals the loop. The loop is visible only
   * from B, which knows A is above it.
   *
   * The topology harness caught this as a cycle refused with the wrong message; the underlying bug
   * was that a genuine three-node loop would have been ACCEPTED.
   *
   * The parent's own chain is also the one that cannot be lied about, which is why depth below is
   * measured from it too.
   */
  const thisAncestry = Array.isArray(deps.thisAncestry) ? deps.thisAncestry : [thisNodeId];
  if (thisAncestry.includes(peer.nodeId)) {
    return {
      ok: false,
      reason: `"${peer.nodeId}" is already above this node in the mesh, so enrolling it below would ` +
              `make a loop. Disconnect the existing path first.`,
    };
  }

  const declared = Array.isArray(peer.ancestry) ? peer.ancestry : [];
  if (declared.includes(thisNodeId)) {
    return {
      ok: false,
      reason: `This node is already somewhere above "${peer.nodeId}" in the mesh, so enrolling it ` +
              `here would make a loop. Disconnect the existing path first.`,
    };
  }

  /*
   * ⚠️ DEPTH IS MEASURED FROM THE PARENT'S CHAIN, not the child's declared one. A leaf enrolling
   * under a node that is itself two deep makes three, and the leaf's own ancestry (just itself)
   * says nothing about that. Using the child's number let a third tier through under a cap of two.
   */
  const resultingDepth = thisAncestry.length + 1;
  if (resultingDepth > maxDepth) {
    return {
      ok: false,
      reason: `This node is already ${thisAncestry.length} level(s) deep, and the connection would ` +
              `make ${resultingDepth}. This node allows ${maxDepth}. Raise MESH_MAX_DEPTH only once ` +
              `a two-tier mesh has been proven on real hardware.`,
    };
  }

  const caps = mods.capabilities.validateCapabilities(capabilities, flags);
  if (!caps.ok) return { ok: false, reason: caps.reason };

  const g = mods.grants.validateGrant(grant);
  if (!g.ok) return { ok: false, reason: g.reason };

  return { ok: true, capabilities: caps.capabilities, grant: g.categories, resultingDepth };
}

/**
 * Is an edge currently usable?
 *
 * ⚠️ A REVOKED EDGE IS NOT DELETED. Its mirrored data is retained-and-marked-stale by default, with
 * purge as an explicit act, because a hub's uptime report for last month must not silently change
 * when somebody disconnects a client today.
 */
function edgeIsActive(edge, now) {
  if (!edge) return false;
  if (edge.revoked_at) return false;
  if (typeof edge.token_expires_at === 'number' && edge.token_expires_at <= now) return false;
  return true;
}

/**
 * Why an edge stopped working, in words an operator can act on.
 *
 * An expired token and a revoked edge look identical from a child's point of view — sync stops — and
 * they need opposite responses: one is renewed, the other was somebody's decision.
 */
function edgeInactiveReason(edge, now) {
  if (!edge) return 'No such connection.';
  if (edge.revoked_at) {
    return 'This connection was revoked. Data is no longer being shared, and the other side kept ' +
           'whatever it had already received unless it was also purged.';
  }
  if (typeof edge.token_expires_at === 'number' && edge.token_expires_at <= now) {
    return 'This connection\'s token expired. Renew it from either side — no data was lost, and ' +
           'nothing was shared while it was expired.';
  }
  return null;
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  TOKEN_BYTES,
  mintPairingCode,
  normalizeCode,
  codesMatch,
  mintEdgeToken,
  hashEdgeToken,
  edgeTokenMatches,
  validateEnrollment,
  edgeIsActive,
  edgeInactiveReason,
};
