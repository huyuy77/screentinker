'use strict';

/*
 * Enrollment: the flow that actually connects two servers.
 *
 * Phase 1 built pairing, validation, transport and storage as modules and tested them thoroughly —
 * but nothing ever called them from an HTTP surface, and nothing constructed an Uplink. The pieces
 * all worked and there was no way for an operator to reach any of them, which is not "complete".
 *
 * ⚠️ THE GRANT IS CHOSEN AT MINT TIME, BY THE SIDE GIVING THE DATA. The hub operator, already
 * authenticated here, decides what a code will grant before it is handed over. Letting the redeeming
 * node ask for its own grant would make enrollment a self-service permission escalation: whoever
 * holds a code could request everything, and the only thing standing between a client's content
 * library and a stranger would be a five-minute expiry.
 *
 * ⚠️ REDEMPTION IS THE ONE UNAUTHENTICATED ROUTE, and the code IS the credential. That is deliberate
 * and it is why the code is CSPRNG, single-use, short-lived, and burned inside the same transaction
 * that creates the edge. A child enrolling has no account on the parent and never will — it is a
 * machine, not a user.
 */

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const pairing = require('../lib/mesh/pairing');
const capabilities = require('../lib/mesh/capabilities');
const grants = require('../lib/mesh/grants');
const identity = require('../lib/mesh/node-identity');
const store = require('../lib/mesh/store');
const edgeStatus = require('../lib/mesh/edge-status');

const nowSec = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();

/**
 * Who may create an uplink.
 *
 * ⚠️ NOT INSTANCE-OWNER-ONLY ANY MORE, deliberately. A workspace owner should be able to put THEIR
 * workspace under an MSP's hub without the instance owner brokering every relationship — that is the
 * ordinary case in a multi-tenant install, and requiring an escalation for it means it gets done by
 * sharing an admin login instead, which is worse.
 *
 * The blast radius is bounded by the scope check below: whatever they pair, only workspaces they
 * administer travel up, and "all workspaces" stays the instance owner's alone.
 *
 * ⚠️ THE RESIDUAL RISK IS OUTBOUND, NOT INBOUND. Creating an uplink makes this server dial an
 * address the user typed, so a workspace admin can now cause outbound connections from inside the
 * network. normalizeParentUrl() constrains the scheme and rejects embedded credentials, but it does
 * not and cannot restrict the host — an operator's own hub is frequently on a private address, so a
 * blocklist would break the main use case. Worth an allowlist if this is ever exposed to
 * lower-trust roles.
 */
function requireCanShareSomething(db) {
  return (req, res, next) => {
    if (!req.user) return res.status(403).json({ error: 'Not permitted.' });
    if (req.user.role === 'platform_admin') return next();
    let count = 0;
    try {
      count = db.prepare(`SELECT COUNT(*) AS c FROM workspace_members
                           WHERE user_id = ? AND role IN ('owner','admin')`).get(req.user.id).c;
    } catch (e) { count = 0; }
    if (!count) {
      return res.status(403).json({
        error: 'You do not administer any workspace on this server, so there is nothing you could ' +
               'share with another one.',
      });
    }
    return next();
  };
}

/** Minting a code — accepting an observer — stays an instance-level act. */
function requireInstanceOwner(req, res, next) {
  if (!req.user || req.user.role !== 'platform_admin') {
    return res.status(403).json({
      error: 'Connecting this server to another one is an instance-owner action.',
    });
  }
  return next();
}

/**
 * ⚠️ The URL an operator types is normalised and constrained here, not trusted. It becomes an
 * outbound dial target from inside their network, so an unvalidated value is a request-forgery
 * primitive pointed at whatever the server can reach.
 */
function normalizeParentUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) {
    return { ok: false, reason: 'That is not a valid URL. Include the scheme, e.g. https://hub.example.com' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'A mesh address must be http or https.' };
  }
  if (u.username || u.password) {
    // Credentials in the URL would end up in the edge row and in logs.
    return { ok: false, reason: 'Do not put credentials in the address.' };
  }
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * POST some JSON to the other node.
 *
 * ⚠️ node:https RATHER THAN fetch(), for one reason: the per-edge TLS opt-out has to apply to THIS
 * request too. global fetch() offers no way to relax certificate checking without an undici
 * dispatcher, so enrolling into a self-signed on-prem hub failed at the very first call — while the
 * schema, the UI and the socket all promised the opt-out was available. An option that exists
 * everywhere except the one call that has to happen first is not an option.
 *
 * ⚠️ tlsVerify defaults to TRUE and the caller must ask to turn it off. Nothing here infers it from
 * the failure — retrying insecurely after a certificate error is how an opt-out becomes the default.
 */
function postJson(urlStr, body, { tlsVerify = true, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const payload = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      rejectUnauthorized: tlsVerify,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(text); } catch (e) { json = {}; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
      });
    });
    // Bounded: an enrollment that hangs must not hold an operator's request open until a proxy
    // times out and shows them a page with no explanation on it.
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = function meshEnrollRoutes(db, { requireAuth, config, onUplinkChanged }) {
  const router = express.Router();

  const thisNode = () => store.ensureNodeIdentity(db);

  /*
   * This node's own chain: itself, plus everything above it. ⚠️ Used for BOTH the cycle check and
   * the depth check, because it is the half that cannot be lied about by the party enrolling.
   */
  function thisAncestry() {
    const me = thisNode();
    const ups = db.prepare(
      "SELECT peer_node_id FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL").all();
    return [me, ...ups.map((u) => u.peer_node_id)];
  }

  /* ======================= hub side: hand out a code ======================= */

  if (config.meshAcceptEnrollment) {
    router.post('/pair/code', requireAuth, requireInstanceOwner, (req, res) => {
      const caps = capabilities.validateCapabilities(req.body && req.body.capabilities, {
        acceptEnrollment: config.meshAcceptEnrollment,
        allowUplink: config.meshAllowUplink,
      });
      if (!caps.ok) return res.status(400).json({ error: caps.reason });

      const g = grants.validateGrant(req.body && req.body.grant);
      if (!g.ok) return res.status(400).json({ error: g.reason });

      const code = pairing.mintPairingCode();
      const expires = nowSec() + Math.floor(pairing.PAIRING_CODE_TTL_MS / 1000);
      db.prepare(`INSERT INTO mesh_pairing_codes
          (id, code, role_capabilities, grant_categories, client_id, retention_days,
           created_by, created_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
        /*
         * ⚠️ STORED NORMALISED, SHOWN PRETTY. mintPairingCode() returns a display form with a
         * hyphen for someone to read aloud, and normalizeCode() strips everything that is not
         * alphanumeric so an operator can retype it any way they like. Storing the display form
         * meant the lookup — which normalises — never matched, and every redemption answered
         * "that code is not valid" about a code that had been minted seconds earlier.
         */
        uid(), pairing.normalizeCode(code),
        JSON.stringify(caps.capabilities), JSON.stringify(g.categories),
        (req.body && req.body.clientId) || null,
        Number(req.body && req.body.retentionDays) || null,
        req.user.id, nowSec(), expires);

      res.json({
        code,
        expiresAt: expires,
        nodeId: thisNode(),
        nodeName: store.nodeName(db),
        grant: g.categories,
        capabilities: caps.capabilities,
        // ⚠️ Spelled out in the response so the operator reads what they are about to hand over
        // BEFORE they paste it into a chat window. A code is a bearer credential.
        grantDescription: grants.describeGrant(g.categories),
      });
    });

    /*
     * Redeem. ⚠️ NO requireAuth — the code is the credential, see the header.
     */
    router.post('/pair/redeem', (req, res) => {
      const body = req.body || {};
      const code = pairing.normalizeCode(body.code);
      const codeRecord = db.prepare('SELECT * FROM mesh_pairing_codes WHERE code = ?').get(code);

      const peer = {
        nodeId: body.nodeId,
        version: body.version,
        // ⚠️ A NAME, capped and sanitised. It is attacker-influenced text from another machine that
        // will be rendered in this server's UI and used to label a relationship, so it is treated
        // like any other remote string: bounded, and never trusted to be unique.
        name: String(body.nodeName || '').trim().slice(0, 60) || null,
        ancestry: Array.isArray(body.ancestry) ? body.ancestry : [],
      };

      const check = pairing.validateEnrollment({
        code,
        codeRecord: codeRecord
          ? { ...codeRecord, expires_at: codeRecord.expires_at, burned_at: codeRecord.burned_at }
          : null,
        capabilities: codeRecord ? JSON.parse(codeRecord.role_capabilities || '[]') : [],
        grant: codeRecord ? JSON.parse(codeRecord.grant_categories || '[]') : [],
        peer,
        deps: {
          now: nowSec(),
          thisNodeId: thisNode(),
          thisAncestry: thisAncestry(),
          maxDepth: config.meshMaxDepth,
          minNodeVersion: config.meshMinNodeVersion,
          flags: { acceptEnrollment: config.meshAcceptEnrollment, allowUplink: config.meshAllowUplink },
          mods: { identity, capabilities, grants },
          existingEdgeForPeer: (nodeId) => db.prepare(
            "SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down' AND revoked_at IS NULL")
            .get(nodeId),
          newEdgeId: '(new)',
        },
      });
      if (!check.ok) {
        // 400, not 403: this is a statement about the request, and the refusal text is written to be
        // shown to the operator on the other end verbatim.
        return res.status(400).json({ error: check.reason });
      }

      const { token, tokenHash } = pairing.mintEdgeToken();
      const peerUrl = normalizeParentUrl(body.peerUrl || '');
      const edgeId = uid();

      /*
       * ⚠️ THE CODE IS BURNED IN THE SAME TRANSACTION THAT CREATES THE EDGE. Separately, two nodes
       * redeeming the same code in the same instant both pass the burned check and both get an edge
       * — single-use enforced everywhere except under the concurrency it exists to prevent.
       */
      const commit = db.transaction(() => {
        const burn = db.prepare(
          'UPDATE mesh_pairing_codes SET burned_at = ?, burned_by_node = ? WHERE id = ? AND burned_at IS NULL')
          .run(nowSec(), peer.nodeId, codeRecord.id);
        if (burn.changes !== 1) throw new Error('code-already-burned');

        db.prepare(`INSERT INTO mesh_edges
            (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction,
             retention_days, tls_verify, peer_version, token_hash, token_expires_at, client_id,
             created_at, peer_url, peer_name)
            VALUES (?,?,'down',?,?,'they-dial',?,1,?,?,?,?,?,?,?)`).run(
          edgeId, peer.nodeId,
          JSON.stringify(check.capabilities), JSON.stringify(check.grant),
          codeRecord.retention_days || null, String(peer.version || ''),
          tokenHash, nowSec() + 365 * 86400, codeRecord.client_id || null,
          nowSec(), peerUrl.ok ? peerUrl.url : null, peer.name);
      });

      try {
        commit();
      } catch (e) {
        if (e && e.message === 'code-already-burned') {
          return res.status(400).json({ error: 'That pairing code has already been used.' });
        }
        if (e && /UNIQUE/.test(e.message || '')) {
          return res.status(400).json({
            error: 'This node is already connected here. Revoke the existing connection first.',
          });
        }
        throw e;
      }

      res.json({
        ok: true,
        edgeId,
        // So the child can show WHO it is now reporting to, by name.
        parentName: store.nodeName(db),
        // The one and only time the plaintext token leaves this node.
        edgeToken: token,
        parentNodeId: thisNode(),
        grant: check.grant,
        capabilities: check.capabilities,
        depth: check.resultingDepth,
      });
    });
  }

  /* ======================= child side: report upward ======================= */

  /*
   * ⚠️ CONSENT FROM BELOW IS READABLE WHATEVER THE FLAGS SAY. A node that has a parent must be able
   * to show its operator that it does, exactly what the parent can see, and how to sever it — even
   * if MESH_ALLOW_UPLINK was turned off afterwards. An MSP link the client cannot see or cut is a
   * contract dispute waiting to happen, and hiding it behind the flag that CREATES it would mean the
   * one configuration where it is invisible is the one where somebody turned the flag off to hide it.
   */
  /*
   * What this server can do in the mesh, so the UI can offer only what will work.
   *
   * ⚠️ ASKED, NOT ASSUMED. There is no client-side copy of the flags and there must not be: they
   * live in the environment, and a bundled duplicate drifts the moment somebody changes one — then
   * the UI offers an action that 404s, which is worse than not offering it.
   */
  /**
   * The workspaces this user could offer to a parent.
   *
   * ⚠️ SCOPED TO WHAT THEY ADMINISTER, except for the instance owner. A workspace member pairing a
   * server must not be able to hand a stranger a workspace they merely have login for — that is a
   * privilege escalation wearing the clothes of a convenience, and it is invisible afterwards
   * because the resulting edge looks exactly like a legitimate one.
   */
  router.get('/shareable-workspaces', requireAuth, (req, res) => {
    const isOwner = req.user && req.user.role === 'platform_admin';
    try {
      const rows = isOwner
        ? db.prepare(`SELECT w.id, w.name, o.name AS organization_name
                        FROM workspaces w LEFT JOIN organizations o ON o.id = w.organization_id`).all()
        : db.prepare(`SELECT w.id, w.name, o.name AS organization_name
                        FROM workspaces w
                        LEFT JOIN organizations o ON o.id = w.organization_id
                        JOIN workspace_members m ON m.workspace_id = w.id
                       WHERE m.user_id = ? AND m.role IN ('owner','admin')`).all(req.user.id);
      res.json({
        workspaces: rows,
        // ⚠️ Only the instance owner may say "all", including workspaces created LATER. Everyone
        // else names a fixed set, so a future workspace is never silently included.
        canShareAll: isOwner,
      });
    } catch (e) {
      res.json({ workspaces: [], canShareAll: isOwner });
    }
  });

  router.get('/capabilities', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'up'").all();
    res.json({
      nodeId: thisNode(),
      nodeName: store.nodeName(db),
      canMint: !!config.meshAcceptEnrollment,
      canEnroll: !!config.meshAllowUplink,
      uplinks: rows.map((e) => ({
        edgeId: e.id,
        parentNodeId: e.peer_node_id,
        parentName: e.peer_name || null,
        parentUrl: e.peer_url,
        sharing: store.safeParseArray(e.grant_categories),
        // ⚠️ null means every workspace, including ones created later. Spelled out rather than
        // rendered as an empty list, which would read as "nothing is shared".
        sharedWorkspaces: e.shared_workspaces ? store.safeParseArray(e.shared_workspaces) : null,
        lastSyncAt: e.last_sync_at ? e.last_sync_at * 1000 : null,
        revoked: !!e.revoked_at,
      })),
    });
  });

  router.get('/uplink', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'up'").all();
    res.json({
      nodeId: thisNode(),
      canEnroll: !!config.meshAllowUplink,
      uplinks: rows.map((e) => ({
        ...edgeStatus.consentView({ ...e, grant_categories: store.safeParseArray(e.grant_categories) },
                                  Date.now()),
        edgeId: e.id,
        parentNodeId: e.peer_node_id,
        parentUrl: e.peer_url,
        revoked: !!e.revoked_at,
      })),
    });
  });

  if (config.meshAllowUplink) {
    router.post('/uplink', requireAuth, requireCanShareSomething(db), async (req, res) => {
      const parsed = normalizeParentUrl(req.body && req.body.parentUrl);
      if (!parsed.ok) return res.status(400).json({ error: parsed.reason });
      const code = pairing.normalizeCode(req.body && req.body.code);
      if (!code) return res.status(400).json({ error: 'Enter the pairing code from the other server.' });

      const me = thisNode();
      const version = require('../package.json').version;
      const tlsVerify = req.body.tlsVerify !== false;

      /*
       * ⚠️ THE SCOPE IS VALIDATED HERE, AGAINST WHAT THIS USER ADMINISTERS. Sending a list from the
       * browser is a request, not a decision — a non-owner naming a workspace they do not administer
       * must be refused rather than trimmed, because silently narrowing means the operator believes
       * they shared something they did not, and finds out when a report is empty.
       */
      const isOwner = req.user.role === 'platform_admin';
      const shareAll = req.body.shareAllWorkspaces === true;
      if (shareAll && !isOwner) {
        return res.status(403).json({
          error: 'Only the instance owner can share every workspace on this server. Choose the ' +
                 'workspaces you administer instead.',
        });
      }
      let sharedWorkspaces = null;   // ⚠️ null means ALL — see the column comment.
      if (!shareAll) {
        const asked = Array.isArray(req.body.workspaceIds) ? req.body.workspaceIds.map(String) : [];
        if (!asked.length) {
          return res.status(400).json({
            error: 'Choose at least one workspace to share, or share all of them.',
          });
        }
        let allowed = [];
        try {
          allowed = isOwner
            ? db.prepare('SELECT id FROM workspaces').all().map((w) => w.id)
            : db.prepare(`SELECT w.id FROM workspaces w
                            JOIN workspace_members m ON m.workspace_id = w.id
                           WHERE m.user_id = ? AND m.role IN ('owner','admin')`)
                .all(req.user.id).map((w) => w.id);
        } catch (e) { allowed = []; }
        const refused = asked.filter((id) => !allowed.includes(id));
        if (refused.length) {
          return res.status(403).json({
            error: `You do not administer ${refused.length} of the workspaces you selected, so they ` +
                   `cannot be shared. Ask their owner to pair, or select only your own.`,
          });
        }
        sharedWorkspaces = asked;
      }

      let answer;
      try {
        const r = await postJson(`${parsed.url}/api/mesh/pair/redeem`, {
          code, nodeId: me, version,
          nodeName: store.nodeName(db),
          ancestry: thisAncestry(),
          // So the parent can deep-link back to objects here. Optional: a node behind NAT simply
          // has no useful address to give, and the hub renders a dash rather than a broken link.
          peerUrl: req.body.selfUrl || null,
        }, { tlsVerify });
        answer = r.json || {};
        if (!r.ok) return res.status(400).json({ error: answer.error || `The other server refused (${r.status}).` });
      } catch (e) {
        return res.status(400).json({
          error: `Could not reach ${parsed.url}: ${e && e.message}. Check the address is reachable ` +
                 `from this server, and that the other side has MESH_ACCEPT_ENROLLMENT set.`,
        });
      }

      if (!answer || !answer.edgeToken) {
        return res.status(400).json({ error: 'The other server did not return a token.' });
      }

      db.prepare(`INSERT INTO mesh_edges
          (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction,
           tls_verify, peer_version, up_token, client_id, created_at, peer_url, peer_name,
           shared_workspaces)
          VALUES (?,?,'up',?,?,'we-dial',?,?,?,NULL,?,?,?,?)
          ON CONFLICT(peer_node_id, direction) DO UPDATE SET
            peer_name         = excluded.peer_name,
            shared_workspaces = excluded.shared_workspaces,
            grant_categories = excluded.grant_categories,
            up_token         = excluded.up_token,
            peer_url         = excluded.peer_url,
            tls_verify       = excluded.tls_verify,
            revoked_at       = NULL`).run(
        uid(), answer.parentNodeId,
        JSON.stringify(answer.capabilities || []), JSON.stringify(answer.grant || []),
        tlsVerify ? 1 : 0, null, answer.edgeToken, nowSec(), parsed.url, answer.parentName || null,
        sharedWorkspaces ? JSON.stringify(sharedWorkspaces) : null);

      if (typeof onUplinkChanged === 'function') onUplinkChanged();
      res.json({
        ok: true,
        parentNodeId: answer.parentNodeId,
        grant: answer.grant,
        // Shown back to the operator: what they just agreed to share, in words.
        grantDescription: grants.describeGrant(answer.grant || []),
      });
    });
  }

  /*
   * Sever, from below. ⚠️ NOT gated on meshAllowUplink — see the note on GET above. Turning the flag
   * off must never be able to strand a node in a link it cannot cut.
   */
  /*
   * ⚠️ Severing is deliberately available to anyone who could have created one. A link you can make
   * but cannot cut is the shape of the problem consent-from-below exists to prevent.
   */
  router.delete('/uplink/:id', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });
    db.prepare('UPDATE mesh_edges SET revoked_at = ?, up_token = NULL WHERE id = ?')
      .run(nowSec(), edge.id);
    if (typeof onUplinkChanged === 'function') onUplinkChanged();
    res.json({
      ok: true,
      // ⚠️ Says plainly what severing does and does NOT do. The parent keeps what it already
      // received; pretending otherwise would be the more comfortable answer and the false one.
      note: 'This server has stopped reporting upward. Data already sent is still held by the other ' +
            'server until it purges it — ask them to purge if that matters.',
    });
  });

  return router;
};
