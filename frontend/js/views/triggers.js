import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Triggers — externally-fired interrupt content. docs/triggers-design.md.
 *
 * ⚠️ ASSIGNMENT IS THE POINT OF THIS SCREEN, not decoration. A trigger assigned to a screen is what
 * makes that screen download and PIN the target playlist's media, and pinned media is the only kind
 * that survives with the WAN down — which is the entire feature. An unassigned trigger is a row in a
 * database that will never fire anywhere.
 */

let cache = { triggers: [], playlists: [], devices: [], groups: [] };

function modeLabel(m) {
  return m === 'until_cleared' ? t('trigger.mode_until_cleared') : t('trigger.mode_once');
}

/*
 * ⚠️ THE STUCK-SCREEN CONFIGURATION, named where it is created.
 *
 * A clear is a single unacked datagram. On UDP, if it drops or the sender dies mid-alarm, an
 * until_cleared overlay holds forever and someone drives to the site. A lease renews on the
 * sender's own re-assert and expires if it stops, so it is the backstop — but it is opt-in, which
 * means the dangerous combination is reachable and has to be visible rather than merely documented.
 */
function leaseRisk(tr) {
  return tr.mode === 'until_cleared' && tr.source_udp && (tr.lease_sec == null || tr.lease_sec === '');
}

function targetName(tr) {
  const pl = cache.playlists.find(p => p.id === tr.target_ref);
  return pl ? pl.name : t('trigger.target_missing');
}

function assignmentSummary(tr) {
  const a = tr.assignments || [];
  if (!a.length) return `<span class="badge badge-warn">${esc(t('trigger.unassigned'))}</span>`;
  const names = a.map((x) => {
    const list = x.target_type === 'device' ? cache.devices : cache.groups;
    const hit = list.find(i => i.id === x.target_id);
    return esc(hit ? hit.name : x.target_id.slice(0, 8));
  });
  return names.join(', ');
}

function rowHtml(tr) {
  const risk = leaseRisk(tr);
  return `
    <tr data-id="${esc(tr.id)}">
      <td>
        <strong>${esc(tr.name)}</strong>
        ${tr.enabled ? '' : `<span class="badge">${esc(t('trigger.disabled'))}</span>`}
      </td>
      <td><code>${esc(tr.match_token)}</code>${tr.clear_token ? ` / <code>${esc(tr.clear_token)}</code>` : ''}</td>
      <td>${esc(targetName(tr))}</td>
      <td>${esc(modeLabel(tr.mode))}${risk ? ` <span class="badge badge-warn" title="${esc(t('trigger.lease_risk'))}">${esc(t('trigger.no_lease'))}</span>` : ''}</td>
      <td>${tr.source_http ? 'HTTP' : ''}${tr.source_http && tr.source_udp ? ' + ' : ''}${tr.source_udp ? 'UDP' : ''}</td>
      <td>${tr.priority}</td>
      <td>${assignmentSummary(tr)}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-sm btn-danger" data-act="del">${esc(t('common.delete'))}</button>
      </td>
    </tr>`;
}

function formHtml(tr) {
  const isNew = !tr.id;
  const opt = (list, sel) => list.map(x =>
    `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const assigned = new Set((tr.assignments || []).map(a => `${a.target_type}:${a.target_id}`));
  const checks = (list, type) => list.map(x => `
      <label class="check">
        <input type="checkbox" data-assign="${type}:${esc(x.id)}"
               ${assigned.has(`${type}:${x.id}`) ? 'checked' : ''}> ${esc(x.name)}
      </label>`).join('') || `<p class="muted">${esc(t('trigger.none_available'))}</p>`;

  return `
  <div class="modal-backdrop" id="trigModal">
    <div class="modal">
      <h2>${esc(isNew ? t('trigger.new') : t('trigger.edit'))}</h2>

      <label>${esc(t('trigger.name'))}
        <input id="tgName" value="${esc(tr.name || '')}" maxlength="200"></label>

      <label>${esc(t('trigger.match_token'))}
        <input id="tgToken" value="${esc(tr.match_token || '')}" maxlength="64"></label>
      <p class="hint">${esc(t('trigger.token_hint'))}</p>

      <label>${esc(t('trigger.clear_token'))}
        <input id="tgClear" value="${esc(tr.clear_token || '')}" maxlength="64"></label>

      <label>${esc(t('trigger.target'))}
        <select id="tgTarget">${opt(cache.playlists, tr.target_ref)}</select></label>
      <p class="hint">${esc(t('trigger.target_hint'))}</p>

      <label>${esc(t('trigger.mode'))}
        <select id="tgMode">
          <option value="once"${tr.mode === 'once' ? ' selected' : ''}>${esc(t('trigger.mode_once'))}</option>
          <option value="until_cleared"${tr.mode === 'until_cleared' ? ' selected' : ''}>${esc(t('trigger.mode_until_cleared'))}</option>
        </select></label>

      <label>${esc(t('trigger.max_duration'))}
        <input id="tgMaxDur" type="number" min="0" max="86400" value="${tr.max_duration_sec || 0}"></label>
      <p class="hint">${esc(t('trigger.max_duration_hint'))}</p>

      <label>${esc(t('trigger.lease'))}
        <input id="tgLease" type="number" min="5" max="86400" value="${tr.lease_sec == null ? '' : tr.lease_sec}"></label>
      <p class="hint" id="tgLeaseHint">${esc(t('trigger.lease_hint'))}</p>

      <label>${esc(t('trigger.priority'))}
        <input id="tgPriority" type="number" min="-1000" max="1000" value="${tr.priority || 0}"></label>

      <label class="check"><input type="checkbox" id="tgHttp" ${tr.source_http === false ? '' : 'checked'}> HTTP</label>
      <label class="check"><input type="checkbox" id="tgUdp" ${tr.source_udp ? 'checked' : ''}> UDP</label>
      <label class="check"><input type="checkbox" id="tgEnabled" ${tr.enabled === 0 ? '' : 'checked'}> ${esc(t('trigger.enabled'))}</label>

      <h3>${esc(t('trigger.assign'))}</h3>
      <p class="hint">${esc(t('trigger.assign_hint'))}</p>
      <div class="assign-grid">
        <div><h4>${esc(t('nav.displays'))}</h4>${checks(cache.devices, 'device')}</div>
        <div><h4>${esc(t('trigger.groups'))}</h4>${checks(cache.groups, 'group')}</div>
      </div>

      <div class="modal-actions">
        <button class="btn" id="tgCancel">${esc(t('common.cancel'))}</button>
        <button class="btn btn-primary" id="tgSave">${esc(t('common.save'))}</button>
      </div>
    </div>
  </div>`;
}

function collect() {
  const mode = document.getElementById('tgMode').value;
  const leaseRaw = document.getElementById('tgLease').value;
  const assignments = [...document.querySelectorAll('[data-assign]')]
    .filter(el => el.checked)
    .map(el => {
      const [target_type, target_id] = el.dataset.assign.split(':');
      return { target_type, target_id };
    });
  return {
    name: document.getElementById('tgName').value.trim(),
    match_token: document.getElementById('tgToken').value.trim(),
    clear_token: document.getElementById('tgClear').value.trim() || null,
    target_kind: 'playlist',
    target_ref: document.getElementById('tgTarget').value,
    mode,
    max_duration_sec: Number(document.getElementById('tgMaxDur').value) || 0,
    // Sent only when it applies; the server refuses lease_sec on a `once` trigger rather than
    // storing a field that could never fire.
    lease_sec: mode === 'until_cleared' && leaseRaw !== '' ? Number(leaseRaw) : null,
    priority: Number(document.getElementById('tgPriority').value) || 0,
    source_http: document.getElementById('tgHttp').checked,
    source_udp: document.getElementById('tgUdp').checked,
    enabled: document.getElementById('tgEnabled').checked,
    assignments,
  };
}

function openForm(app, tr) {
  const host = document.createElement('div');
  host.innerHTML = formHtml(tr || {});
  document.body.appendChild(host);

  /*
   * ⚠️ PREFILL THE LEASE FOR UDP, do not silently default it. The stored meaning of "unset" stays
   * "hold indefinitely" — this only makes the safe value the one an operator has to REMOVE rather
   * than the one they have to know to look for.
   */
  const udp = document.getElementById('tgUdp');
  const lease = document.getElementById('tgLease');
  const mode = document.getElementById('tgMode');
  const syncLease = () => {
    const risky = mode.value === 'until_cleared' && udp.checked;
    if (risky && lease.value === '' && !tr?.id) lease.value = '90';
    document.getElementById('tgLeaseHint').textContent =
      risky && lease.value === '' ? t('trigger.lease_risk') : t('trigger.lease_hint');
    lease.disabled = mode.value !== 'until_cleared';
  };
  udp.addEventListener('change', syncLease);
  mode.addEventListener('change', syncLease);
  lease.addEventListener('input', syncLease);
  syncLease();

  const close = () => host.remove();
  document.getElementById('tgCancel').addEventListener('click', close);
  document.getElementById('tgSave').addEventListener('click', async () => {
    const body = collect();
    try {
      if (tr && tr.id) await api.put(`/triggers/${tr.id}`, body);
      else await api.post('/triggers', body);
      close();
      showToast(t('trigger.saved'), 'success');
      render(app);
    } catch (e) {
      // The server's message is the useful one — it names the actual rule (token charset, a
      // cross-workspace playlist, a duplicate token) far better than anything generic here.
      showToast((e && e.message) || t('common.error'), 'error');
    }
  });
}

export async function render(app) {
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.triggers'))}</h1>
    <p class="muted">${esc(t('trigger.intro'))}</p><div id="trigBody"></div></div>`;
  const body = document.getElementById('trigBody');

  try {
    const [trg, pls, devs, grps] = await Promise.all([
      api.get('/triggers'), api.get('/playlists'), api.get('/devices'), api.get('/groups'),
    ]);
    cache = {
      triggers: trg.triggers || [],
      playlists: Array.isArray(pls) ? pls : (pls.playlists || []),
      devices: Array.isArray(devs) ? devs : (devs.devices || []),
      groups: Array.isArray(grps) ? grps : (grps.groups || []),
    };
  } catch (e) {
    body.innerHTML = `<p class="error">${esc((e && e.message) || t('common.error'))}</p>`;
    return;
  }

  const risky = cache.triggers.filter(leaseRisk).length;
  body.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-primary" id="tgNew">${esc(t('trigger.new'))}</button>
    </div>
    ${risky ? `<div class="banner banner-warn">${esc(t('trigger.lease_risk_banner'))}</div>` : ''}
    ${cache.triggers.length ? `
    <table class="table">
      <thead><tr>
        <th>${esc(t('trigger.name'))}</th><th>${esc(t('trigger.tokens'))}</th>
        <th>${esc(t('trigger.target'))}</th><th>${esc(t('trigger.mode'))}</th>
        <th>${esc(t('trigger.sources'))}</th><th>${esc(t('trigger.priority'))}</th>
        <th>${esc(t('trigger.assigned'))}</th><th></th>
      </tr></thead>
      <tbody>${cache.triggers.map(rowHtml).join('')}</tbody>
    </table>` : `<p class="muted">${esc(t('trigger.empty'))}</p>`}`;

  document.getElementById('tgNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('tr[data-id]').forEach((row) => {
    const tr = cache.triggers.find(x => x.id === row.dataset.id);
    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => openForm(app, tr));
    row.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm(t('trigger.confirm_delete'))) return;
      try { await api.delete(`/triggers/${tr.id}`); showToast(t('trigger.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
  });
}
