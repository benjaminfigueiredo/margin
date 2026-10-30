// Response view in the review rail: the referee reports, split into numbered points,
// each with the author's stance, the reply and the suggestions that implement it.
// Statuses come from the server, derived from the linked suggestions' current state
// (server/responses.js). The author is the only one who confirms a stance.
import { api, h, toast, wordDiff } from './util.js';

const STANCES = [['agree', 'Agree'], ['partly_agree', 'Partly agree'], ['disagree', 'Disagree'], ['clarify', 'Clarify']];
const STATUS_LABEL = { done: 'Done', pending: 'Pending', mismatch: 'Mismatch' };

export function createResponsePanel(rail, { onJump, onChanged, saveIfDirty }) {
  const root = rail.querySelector('#response');
  const badge = rail.querySelector('#response-badge');
  let view = null;
  let round = null; // null: the latest
  let adding = false;
  const drafts = new Map(); // point id -> unsaved reply text
  const openReports = new Set();
  const expanded = new Set();

  // Same rule as the review cards: flush the editor before anything that changes the source.
  async function act(fn, okMsg, { text = false } = {}) {
    try {
      if (text) await saveIfDirty?.();
      await fn();
      if (okMsg) toast(okMsg, 'ok', 1800);
      await (text ? onChanged?.() : refresh()); // onChanged refreshes the review and this view
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  // ---------- static parts ----------
  const summary = h('span', { class: 'resp-summary' });
  const roundSel = h('select', { class: 'resp-round hidden', title: 'Revision round', onchange: () => { round = Number(roundSel.value); refresh(); } });
  const exportBtn = (format, label) => h('button', { class: 'btn sm ghost', title: `Download the response letter as ${label} (nothing is written to the paper folder)`, onclick: () => exportLetter(format) }, label);
  const bar = h('div', { class: 'resp-bar' }, summary, roundSel, h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => { adding = !adding; renderAdd(); } }, '+ Report'),
    h('span', { class: 'resp-export', title: 'Download the response letter' }, h('span', { class: 'fine' }, 'Export'), exportBtn('md', '.md'), exportBtn('tex', '.tex')));
  const alert = h('div', { class: 'resp-alert hidden', role: 'alert' });

  const who = h('input', { class: 'resp-reviewer', placeholder: 'Reviewer 1', 'aria-label': 'Reviewer' });
  const roundIn = h('input', { class: 'resp-round-in', type: 'number', min: '1', placeholder: '1', title: 'Revision round', 'aria-label': 'Round' });
  const reportText = h('textarea', { rows: 8, placeholder: 'Paste the referee report here' });
  const addBox = h('div', { class: 'resp-add hidden' },
    h('div', { class: 'row' }, who, h('label', { class: 'fine' }, 'Round ', roundIn)),
    reportText,
    h('div', { class: 'row' },
      h('button', { class: 'btn sm primary', onclick: saveReport }, 'Save report'),
      h('button', { class: 'btn sm', onclick: () => { adding = false; renderAdd(); } }, 'Cancel')),
    h('p', { class: 'fine' }, 'Stays on this computer (in .review/); never committed or sent to Overleaf. Then ask Claude: /respond-to-reviewers'));
  const list = h('div', { class: 'resp-list' });
  root.append(bar, alert, addBox, list);

  function renderAdd() {
    const show = adding || (view && !view.reports.length && !view.rounds.length);
    addBox.classList.toggle('hidden', !show);
    if (show) {
      if (!who.value) who.placeholder = `Reviewer ${(view?.reports.length || 0) + 1}`;
      if (!roundIn.value) roundIn.placeholder = String(view?.round || 1);
    }
  }

  async function saveReport() {
    if (!reportText.value.trim()) { toast('Paste the report first', 'info'); return; }
    await act(async () => {
      const r = await api('/responses/reports', { method: 'POST', body: { reviewer: who.value.trim() || who.placeholder, round: roundIn.value ? Number(roundIn.value) : undefined, text: reportText.value } });
      round = r.round;
      reportText.value = ''; who.value = ''; roundIn.value = ''; adding = false;
    }, 'Report saved');
  }

  function exportLetter(format) {
    if (!view || !view.reports.length) { toast('No report to respond to yet', 'info'); return; }
    const { pending, mismatch } = view.summary;
    if ((pending || mismatch) && !confirm(`${pending + mismatch} point${pending + mismatch === 1 ? ' is' : 's are'} not done${mismatch ? ` (${mismatch} mismatch: the reply may claim a change that is not in the manuscript)` : ''}. Export anyway?`)) return;
    const a = h('a', { href: `/api/responses/export?format=${format}${view.round ? `&round=${view.round}` : ''}`, download: `response-to-reviewers.${format}` });
    document.body.append(a); a.click(); a.remove();
  }

  // ---------- points ----------
  function linkCard(p, l) {
    if (l.missing) {
      return h('div', { class: 'resp-link missing' },
        h('div', { class: 'resp-link-head' }, h('span', { class: 'status rejected' }, 'deleted'), h('span', { class: 'fine' }, `suggestion ${l.id.slice(0, 8)}`), h('span', { class: 'spacer' }), unlinkBtn(p, l)));
    }
    const open = l.status === 'open';
    const parts = wordDiff(l.quote || '', (l.status === 'accepted' ? l.appliedReplacement : l.replacement) ?? '');
    return h('div', {
      class: `resp-link ${l.status} ${l.orphaned ? 'orphaned' : ''}`,
      title: 'Show in the editor',
      onclick: (e) => { if (!e.target.closest('button')) onJump(l); },
    },
      h('div', { class: 'resp-link-head' },
        h('span', { class: `status ${l.orphaned ? 'orphan' : l.status}` }, l.orphaned ? (open ? 'text changed' : 'accepted, then edited away') : l.status),
        h('span', { class: 'fine' }, `${l.file}${l.line ? ':' + l.line : ''}`),
        h('span', { class: 'spacer' }),
        open && !l.orphaned ? h('button', { class: 'btn sm accept', title: 'Accept (apply to source)', onclick: () => act(() => api(`/review/${l.id}/accept`, { method: 'POST', body: {} }), 'Accepted', { text: true }) }, '✓') : null,
        open ? h('button', { class: 'btn sm reject', title: 'Reject', onclick: () => act(() => api(`/review/${l.id}/reject`, { method: 'POST', body: {} }), null, { text: true }) }, '✕') : null,
        unlinkBtn(p, l)),
      h('div', { class: 'diff' }, parts.map((x) => (x.op === 'eq' ? h('span', {}, x.text) : h(x.op === 'del' ? 'del' : 'ins', {}, x.text)))));
  }

  const unlinkBtn = (p, l) => h('button', { class: 'btn sm ghost', title: 'Unlink from this point (the suggestion stays)', onclick: () => act(() => api(`/responses/points/${p.id}/unlink`, { method: 'POST', body: { itemId: l.id } })) }, 'Unlink');

  function pointCard(p) {
    const el = h('div', { class: `resp-point ${p.status}`, dataset: { id: p.id } });
    el.append(h('div', { class: 'resp-point-head' },
      h('span', { class: 'resp-num' }, p.label),
      h('span', { class: `resp-chip ${p.status}` }, STATUS_LABEL[p.status]),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', title: 'Delete this point', onclick: () => confirm(`Delete point ${p.label}? Its linked suggestions stay.`) && act(() => api(`/responses/points/${p.id}`, { method: 'DELETE' })) }, 'Delete')));

    const long = p.refereeText.length > 260;
    el.append(h('div', {
      class: `quote resp-referee ${long && !expanded.has(p.id) ? 'clipped' : ''}`,
      title: long ? 'Click to show all' : null,
      onclick: () => { if (!long) return; expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id); render(); },
    }, long && !expanded.has(p.id) ? p.refereeText.slice(0, 260) + '…' : p.refereeText));

    const sel = h('select', { class: 'resp-stance', 'aria-label': `Stance on ${p.label}`, onchange: () => act(() => api(`/responses/points/${p.id}`, { method: 'POST', body: { stance: sel.value } }), `Stance on ${p.label}: ${sel.selectedOptions[0].textContent}`) },
      p.stance ? null : h('option', { value: '', selected: true, disabled: true }, 'Choose…'),
      STANCES.map(([v, label]) => h('option', { value: v, selected: v === p.stance }, label)));
    el.append(h('div', { class: `resp-stance-row ${p.confirmed ? 'confirmed' : 'proposed'}` },
      h('span', { class: 'fine' }, p.confirmed ? 'Your stance' : p.stance ? 'Claude proposes' : 'Stance'),
      sel,
      p.confirmed ? h('span', { class: 'resp-confirmed' }, '✓ confirmed')
        : p.stance ? h('button', { class: 'btn sm primary', title: 'Claude implements only points whose stance you confirmed', onclick: () => act(() => api(`/responses/points/${p.id}`, { method: 'POST', body: { confirmed: true } }), `${p.label} confirmed`) }, 'Confirm') : null));

    if (p.status === 'mismatch') {
      el.append(h('div', { class: 'resp-reason mismatch' },
        h('strong', {}, 'The reply may claim a change that is not in the manuscript. '),
        p.reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join('. ') + '.'));
    } else if (p.status === 'pending') {
      el.append(h('div', { class: 'resp-reason' }, p.reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join(' · ')));
    }

    const ta = h('textarea', { class: 'resp-reply', rows: Math.min(10, Math.max(3, Math.ceil((drafts.get(p.id) ?? p.reply).length / 44))), placeholder: 'Reply to the referee', 'aria-label': `Reply to ${p.label}` });
    ta.value = drafts.get(p.id) ?? p.reply;
    const saveReply = () => {
      if (!drafts.has(p.id)) return;
      const value = ta.value;
      if (value === p.reply) { drafts.delete(p.id); return; }
      act(async () => { await api(`/responses/points/${p.id}`, { method: 'POST', body: { reply: value } }); drafts.delete(p.id); });
    };
    ta.addEventListener('input', () => drafts.set(p.id, ta.value));
    ta.addEventListener('blur', saveReply);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveReply(); } });
    el.append(h('div', { class: 'resp-reply-head' }, h('span', { class: 'fine' }, 'Reply'),
      p.reply && p.replyBy ? h('span', { class: 'fine' }, p.replyBy === 'you' ? ' · edited by you' : ' · drafted by Claude') : null), ta);

    if (p.links.length) el.append(h('div', { class: 'resp-links' }, p.links.map((l) => linkCard(p, l))));
    else if (p.stance === 'agree' || p.stance === 'partly_agree') el.append(h('p', { class: 'fine' }, p.confirmed ? 'No suggestion linked yet. Ask Claude to implement it: /respond-to-reviewers' : 'Confirm the stance, then Claude can implement it.'));
    return el;
  }

  function render() {
    if (!view) return;
    const { summary: s, rounds, reports, points } = view;
    summary.replaceChildren(...(points.length ? [
      h('span', { class: 'resp-chip done' }, `${s.done} done`),
      h('span', { class: 'resp-chip pending' }, `${s.pending} pending`),
      s.mismatch ? h('span', { class: 'resp-chip mismatch' }, `${s.mismatch} mismatch`) : null,
    ] : []));
    roundSel.classList.toggle('hidden', rounds.length < 2);
    roundSel.replaceChildren(...rounds.map((r) => h('option', { value: r, selected: r === view.round }, `Round ${r}`)));

    const bad = points.filter((p) => p.status === 'mismatch');
    alert.classList.toggle('hidden', !bad.length);
    alert.replaceChildren(...(bad.length ? [
      h('span', {}, `${bad.length === 1 ? '1 reply claims' : `${bad.length} replies claim`} a change that is not in the manuscript: ${bad.map((p) => p.label).join(', ')}.`),
      h('button', { class: 'btn sm', onclick: () => list.querySelector(`.resp-point[data-id="${bad[0].id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, 'Show'),
    ] : []));
    badge.textContent = view.mismatchAll || '';
    badge.classList.toggle('hidden', !view.mismatchAll);
    badge.title = view.mismatchAll ? `${view.mismatchAll} point${view.mismatchAll > 1 ? 's' : ''} with a mismatch` : '';
    renderAdd();

    // Keep the author's place in a reply they are typing across re-renders.
    const active = document.activeElement;
    const focusId = active?.classList?.contains('resp-reply') ? active.closest('.resp-point')?.dataset.id : null;
    const sel = focusId ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = list.scrollTop;

    if (!reports.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('p', {}, 'No referee report yet.'),
        h('p', { class: 'hint' }, 'Paste a report above. Claude splits it into numbered points and proposes a stance and a reply for each; you confirm the stances here before it changes anything.')));
      return;
    }
    list.replaceChildren(...reports.map((r) => {
      const pts = points.filter((p) => p.reportId === r.id);
      const showing = openReports.has(r.id);
      return h('section', { class: 'resp-group' },
        h('div', { class: 'resp-group-head' },
          h('strong', {}, r.reviewer),
          h('span', { class: 'fine' }, `${pts.length} point${pts.length === 1 ? '' : 's'}`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm ghost', 'aria-expanded': String(showing), onclick: () => { showing ? openReports.delete(r.id) : openReports.add(r.id); render(); } }, showing ? 'Hide report' : 'Report'),
          h('button', { class: 'btn sm ghost danger', title: 'Delete this report and its points', onclick: () => confirm(`Delete ${r.reviewer}'s report and its ${pts.length} point${pts.length === 1 ? '' : 's'}? Linked suggestions stay.`) && act(() => api(`/responses/reports/${r.id}`, { method: 'DELETE' })) }, 'Delete')),
        showing ? h('div', { class: 'quote resp-report' }, r.text) : null,
        pts.length ? pts.map(pointCard) : h('p', { class: 'fine resp-wait' }, 'Not split into points yet. Ask Claude: /respond-to-reviewers'));
    }));
    list.scrollTop = scroll;
    if (focusId) {
      const ta = list.querySelector(`.resp-point[data-id="${focusId}"] .resp-reply`);
      if (ta) { ta.focus(); ta.setSelectionRange(...sel); }
    }
  }

  async function refresh() {
    try { view = await api(`/responses${round ? `?round=${round}` : ''}`); } catch (e) { toast(e.message, 'error'); return; }
    if (round && !view.rounds.includes(round)) { round = null; return refresh(); }
    render();
  }

  return { refresh };
}
