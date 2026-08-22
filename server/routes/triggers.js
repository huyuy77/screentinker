'use strict';

/*
 * Triggers — externally-fired interrupt content. See docs/triggers-design.md.
 *
 * This router is the DEFINITION surface only: create, edit, assign. ⚠️ Nothing here is on the fire
 * path. A trigger fires on the device, against its own synced copy, with the WAN down — that is the
 * entire feature, and any lookup that reached back here would defeat it.
 *
 * Scoping is by req.workspaceId on every query, which is what makes a token bound to workspace A
 * unable to see or address a trigger in workspace B. Same guarantee, same mechanism, as pip.js.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');

/*
 * A trigger changes what appears on a screen, so it is a fleet-affecting write and carries the same
 * pairing pip.js uses: requireScope('full') gates API TOKENS (and is a deliberate pass-through for
 * JWT sessions), and this adds the role check that scope alone does not give a dashboard session.
 */
function requireFleetWrite(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  next();
}

const MODES = ['once', 'until_cleared'];
const POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];
const TARGET_KINDS = ['playlist'];   // 'url' is designed for and deliberately not built yet

/*
 * ⚠️ THE TOKEN CHARSET IS A WIRE-FORMAT CONSTRAINT, NOT A STYLE PREFERENCE.
 *
 * The UDP payload is `ST1 <secret> <token>` — space-separated, one line, because that is what a
 * Crestron SendString or a PLC socket block can actually emit. A token containing a space would be
 * unparseable on arrival, and one containing a newline would let a single datagram look like two
 * messages. Rejecting them here is the only place that can be enforced before the field is saved;
 * on the wire it is already too late to give anyone a useful error.
 */
const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;      // printable ASCII, no space, 1-64
const TOKEN_HINT = 'tokens must be 1-64 printable ASCII characters with no spaces — they travel in a ' +
                   'space-separated single-line datagram';

function intInRange(v, def, lo, hi) {
  if (v === undefined || v === null || v === '') return { ok: true, val: def };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  const r = Math.round(n);
  if (r < lo || r > hi) return { ok: false };
  return { ok: true, val: r };
}

/** Shape a row for the API. Assignments come along because a trigger without them does nothing. */
function withAssignments(row) {
  if (!row) return row;
  const assignments = db.prepare(
    'SELECT target_type, target_id FROM trigger_assignments WHERE trigger_id = ?').all(row.id);
  return { ...row, assignments };
}

function validate(req, b, { id = null } = {}) {
  if (!b.name || !String(b.name).trim()) return 'name required';

  if (!TOKEN_RE.test(String(b.match_token || ''))) return `invalid match_token — ${TOKEN_HINT}`;
  if (b.clear_token != null && b.clear_token !== '' && !TOKEN_RE.test(String(b.clear_token))) {
    return `invalid clear_token — ${TOKEN_HINT}`;
  }
  if (b.clear_token && String(b.clear_token) === String(b.match_token)) {
    return 'clear_token and match_token must differ, or a fire and a clear are the same message';
  }

  if (!MODES.includes(b.mode)) return `invalid mode, use one of: ${MODES.join(', ')}`;

  const kind = b.target_kind == null || b.target_kind === '' ? 'playlist' : String(b.target_kind);
  if (!TARGET_KINDS.includes(kind)) {
    return `invalid target_kind — v1 supports ${TARGET_KINDS.join(', ')} ('url' is designed but not built)`;
  }
  /*
   * ⚠️ The playlist must exist IN THIS WORKSPACE. Accepting a bare id would let a caller point a
   * trigger at another tenant's playlist and have the device pin and display it — the assignment
   * check on the device would never catch it, because by then it is just a playlist id.
   */
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?')
    .get(String(b.target_ref || ''), req.workspaceId);
  if (!pl) return 'target_ref must be a playlist in this workspace';

  const position = b.position == null || b.position === '' ? 'center' : b.position;
  if (!POSITIONS.includes(position)) return `invalid position, use one of: ${POSITIONS.join(', ')}`;

  if (!intInRange(b.max_duration_sec, 0, 0, 86400).ok) return 'max_duration_sec must be 0-86400 (0 = no cap)';
  if (!intInRange(b.priority, 0, -1000, 1000).ok) return 'priority must be -1000..1000';

  // lease_sec is until_cleared-only: on a `once` trigger there is nothing to renew, and accepting it
  // would silently store a field that never applies.
  if (b.lease_sec != null && b.lease_sec !== '') {
    if (b.mode !== 'until_cleared') return 'lease_sec applies to until_cleared triggers only';
    if (!intInRange(b.lease_sec, 0, 5, 86400).ok) return 'lease_sec must be 5-86400 seconds';
  }

  const clash = id
    ? db.prepare('SELECT id FROM triggers WHERE workspace_id = ? AND match_token = ? AND id != ?')
      .get(req.workspaceId, String(b.match_token), id)
    : db.prepare('SELECT id FROM triggers WHERE workspace_id = ? AND match_token = ?')
      .get(req.workspaceId, String(b.match_token));
  if (clash) return 'match_token is already used by another trigger in this workspace';

  return null;
}

function columnsFrom(b) {
  return {
    name: String(b.name).trim().slice(0, 200),
    match_token: String(b.match_token),
    clear_token: b.clear_token ? String(b.clear_token) : null,
    source_http: b.source_http === false || b.source_http === 0 ? 0 : 1,
    source_udp: b.source_udp === true || b.source_udp === 1 ? 1 : 0,
    target_kind: b.target_kind || 'playlist',
    target_ref: String(b.target_ref),
    position: b.position || 'center',
    width: intInRange(b.width, null, 40, 3840).val,
    height: intInRange(b.height, null, 40, 3840).val,
    opacity: b.opacity == null || b.opacity === '' ? null : Math.max(0, Math.min(1, Number(b.opacity))),
    border_radius: intInRange(b.border_radius, null, 0, 512).val,
    mode: b.mode,
    max_duration_sec: intInRange(b.max_duration_sec, 0, 0, 86400).val,
    lease_sec: b.mode === 'until_cleared' && b.lease_sec != null && b.lease_sec !== ''
      ? intInRange(b.lease_sec, null, 5, 86400).val : null,
    priority: intInRange(b.priority, 0, -1000, 1000).val,
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
  };
}

/** Replace a trigger's assignments, validating every target is in this workspace. */
function setAssignments(req, triggerId, assignments) {
  if (!Array.isArray(assignments)) return null;
  const rows = [];
  for (const a of assignments) {
    const type = a && a.target_type;
    const tid = a && String(a.target_id || '');
    if (type !== 'device' && type !== 'group') return `invalid target_type: ${type}`;
    const found = type === 'device'
      ? db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId)
      : db.prepare('SELECT id FROM device_groups WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId);
    if (!found) return `${type} ${tid} not found in this workspace`;
    rows.push({ type, tid });
  }
  db.prepare('DELETE FROM trigger_assignments WHERE trigger_id = ?').run(triggerId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(triggerId, r.type, r.tid);
  return null;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const rows = db.prepare('SELECT * FROM triggers WHERE workspace_id = ? ORDER BY priority DESC, name')
    .all(req.workspaceId);
  res.json({ triggers: rows.map(withAssignments) });
});

router.get('/:id', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const row = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'trigger not found' });
  res.json(withAssignments(row));
});

router.post('/', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const bad = validate(req, b);
  if (bad) return res.status(400).json({ error: bad });

  const id = uuidv4();
  const c = columnsFrom(b);
  db.prepare(`INSERT INTO triggers
      (id, workspace_id, name, match_token, clear_token, source_http, source_udp,
       target_kind, target_ref, position, width, height, opacity, border_radius,
       mode, max_duration_sec, lease_sec, priority, enabled)
      VALUES (@id, @workspace_id, @name, @match_token, @clear_token, @source_http, @source_udp,
              @target_kind, @target_ref, @position, @width, @height, @opacity, @border_radius,
              @mode, @max_duration_sec, @lease_sec, @priority, @enabled)`)
    .run({ id, workspace_id: req.workspaceId, ...c });

  const aErr = setAssignments(req, id, b.assignments);
  if (aErr) { db.prepare('DELETE FROM triggers WHERE id = ?').run(id); return res.status(400).json({ error: aErr }); }

  console.log(`[trigger] created ${id} "${c.name}" token=${c.match_token} mode=${c.mode}`);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(id)));
});

router.put('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });

  const b = req.body || {};
  const bad = validate(req, b, { id: existing.id });
  if (bad) return res.status(400).json({ error: bad });

  const c = columnsFrom(b);
  db.prepare(`UPDATE triggers SET
      name=@name, match_token=@match_token, clear_token=@clear_token,
      source_http=@source_http, source_udp=@source_udp,
      target_kind=@target_kind, target_ref=@target_ref, position=@position,
      width=@width, height=@height, opacity=@opacity, border_radius=@border_radius,
      mode=@mode, max_duration_sec=@max_duration_sec, lease_sec=@lease_sec,
      priority=@priority, enabled=@enabled, updated_at=strftime('%s','now')
      WHERE id=@id`).run({ id: existing.id, ...c });

  if (b.assignments !== undefined) {
    const aErr = setAssignments(req, existing.id, b.assignments);
    if (aErr) return res.status(400).json({ error: aErr });
  }

  console.log(`[trigger] updated ${existing.id} "${c.name}"`);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(existing.id)));
});

router.delete('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT id FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });
  // trigger_assignments cascades on this delete (FK declared inline, foreign_keys is ON).
  db.prepare('DELETE FROM triggers WHERE id = ?').run(existing.id);
  console.log(`[trigger] deleted ${existing.id}`);
  res.json({ success: true });
});

module.exports = router;
