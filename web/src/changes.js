// Changes: what differs from the last sync (or the last commit), shown as per-file hunks you can
// click into, a list of suggestions accepted since a time, and a one-click latexdiff PDF.
//
// The panel sits over the PDF pane in the same slot as Logs and Find (opening one closes the
// others): it is a wide, scrolling list of text, which fits there better than in the narrow review
// rail, and the PDF it produces is shown in that same pane, one click away. The diff PDF replaces
// the normal one in view only; a bar says so, and "Back to normal PDF" undoes it.
import { api, $, h, debounce, toast, timeAgo, wordDiff } from './util.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (sha) => (sha || '').slice(0, 7);
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const HOUR = 3600000;

export function createChanges(root, { bar, downloadLink, getMain, saveIfDirty, onOpen, onJump, showPdf }) {
  const list = $('#changes-list', root);
  const note = $('#changes-note', root);
  const count = $('#changes-count', root);
  const sinceBox = $('#changes-since', root);
  const sinceSel = $('#changes-since-sel', root);
  const sinceTime = $('#changes-since-time', root);
  const expandBox = $('#changes-expand', root);
  const refSel = $('#diff-ref', root);
  const makeBtn = $('#diff-make', root);
  const status = $('#diff-status', root);
  let mode = 'sync'; // sync | head | accepted
  let seq = 0;       // only the newest request may render
  let data = null;
  let tool = null;   // GET /api/latexdiff
  let building = false;
  const collapsed = new Set(); // files the author folded; kept across refreshes
  const diff = { active: false, sent: undefined };

  const isOpen = () => !root.classList.contains('hidden');

  // ---------- panel ----------
  async function refresh() {
    const mine = ++seq;
    try {
      await saveIfDirty?.(); // what is listed must be what is on disk, including the latest typing
      if (mode === 'accepted') {
        const r = await loadAccepted();
        if (mine === seq) renderAccepted(r);
      } else {
        const r = await api(`/changes?since=${mode}`);
        if (mine !== seq) return;
        data = r;
        renderFiles(r);
        fillRefs(r);
      }
    } catch (e) {
      if (mine !== seq) return;
      list.replaceChildren();
      count.textContent = '';
      setNote(e.message, 'error');
    }
  }
  const refreshLater = debounce(() => { if (isOpen()) refresh(); }, 800);

  function setNote(text, kind = '') { note.textContent = text; note.className = `changes-note ${kind}`; note.classList.toggle('hidden', !text); }

  function describe(r) {
    if (!r.repo) return 'This paper is not a git repository, so there is nothing to compare with. Clone your Overleaf project with git first (see the README).';
    if (r.noCommits) return 'This repository has no commits yet, so there is nothing to compare with.';
    const base = `${short(r.sha)}${r.subject ? ` “${r.subject}”` : ''}${r.time ? `, ${timeAgo(r.time)}` : ''}`;
    if (r.since === 'head') return `Edits not yet committed: the paper on disk against your last commit (${base}). Sync would commit and push these.`;
    const behind = r.behind > 0 ? ` ${r.overleaf ? 'Overleaf' : 'The remote'} has ${plural(r.behind, 'newer commit')} you have not pulled; their changes are not shown here.` : '';
    if (r.kind === 'upstream') return `Compared with ${r.overleaf ? 'Overleaf' : 'the remote'} as of your last sync (${base}): everything committed or edited here that it does not have yet.${behind}`;
    // No upstream: there is no "last sync" to measure from.
    const why = !r.remote ? 'This paper has no remote' : `The branch “${r.branch}” is not tracking anything on Overleaf`;
    return `${why}, so there is no “last sync” to compare with. Showing what changed since your last commit (${base}) instead.`;
  }

  // ---------- files and hunks ----------
  function renderFiles(r) {
    expandBox.classList.toggle('hidden', !r.files.length);
    sinceBox.classList.add('hidden');
    count.textContent = r.files.length ? `${plural(r.totals.files, 'file')} · +${r.totals.additions} −${r.totals.deletions}` : '';
    setNote(describe(r), r.repo && !r.noCommits && !(r.since === 'sync' && r.kind !== 'upstream') ? '' : 'info');
    if (!r.repo || r.noCommits) { list.replaceChildren(); return; }
    if (!r.files.length) { list.replaceChildren(h('div', { class: 'empty' }, r.since === 'head' ? 'No uncommitted edits.' : r.kind === 'upstream' ? 'No changes since your last sync.' : 'No changes since your last commit.')); return; }
    const rows = r.files.map(fileBlock);
    if (r.truncated) rows.push(h('div', { class: 'changes-trunc' }, `Showing the first ${r.files.length} files only.`));
    list.replaceChildren(...rows);
  }

  function fileBlock(f) {
    const label = { A: f.untracked ? 'new' : 'added', D: 'deleted', R: 'renamed', M: 'edited' }[f.status] || f.status;
    const open = !collapsed.has(f.path);
    const first = firstChange(f);
    const canOpen = f.status !== 'D';
    const body = h('div', { class: 'ch-body' }, f.binary ? h('div', { class: 'ch-note' }, 'Binary file: no text to compare.')
      : !f.hunks.length ? h('div', { class: 'ch-note' }, f.status === 'R' ? `Renamed from ${f.oldPath}, contents unchanged.` : 'No text changes (permissions or line endings).')
      : [f.status === 'R' ? h('div', { class: 'ch-note' }, `Renamed from ${f.oldPath}`) : null, ...f.hunks.map((hk) => hunkBlock(f, hk)),
        f.truncated ? h('div', { class: 'ch-note' }, 'This file has more changed lines than are shown here.') : null]);
    const toggle = h('button', { class: 'ch-toggle', 'aria-expanded': String(open), title: open ? 'Collapse' : 'Expand', onclick: () => {
      if (collapsed.has(f.path)) collapsed.delete(f.path); else collapsed.add(f.path);
      const nowOpen = !collapsed.has(f.path);
      block.classList.toggle('collapsed', !nowOpen);
      toggle.setAttribute('aria-expanded', String(nowOpen));
      toggle.textContent = nowOpen ? '▾' : '▸';
    } }, open ? '▾' : '▸');
    const head = h('div', { class: 'ch-head' }, toggle,
      h('button', { class: 'ch-path', disabled: !canOpen, title: canOpen ? `Open ${f.path}${first ? ` at line ${first}` : ''}` : `${f.path} no longer exists`, onclick: () => onJump(f.path, first || 1) }, f.path),
      h('span', { class: `ch-status ${f.status}` }, label),
      f.additions ? h('span', { class: 'ch-add' }, `+${f.additions}`) : null,
      f.deletions ? h('span', { class: 'ch-del' }, `−${f.deletions}`) : null);
    const block = h('div', { class: `ch-file ${open ? '' : 'collapsed'}`, dataset: { path: f.path } }, head, body);
    return block;
  }

  const firstChange = (f) => { for (const hk of f.hunks) { const i = hk.lines.findIndex((l) => l.t !== ' '); if (i >= 0) return jumpLine(hk, i); } return f.hunks[0]?.newStart || 1; };

  // The line in the file on disk a click on hunk line i should land on. A deleted line is gone from the
  // file, so it points at the line that now follows it.
  function jumpLine(hk, i) {
    const l = hk.lines[i];
    if (l.n != null) return Math.max(1, l.n);
    for (let j = i + 1; j < hk.lines.length; j++) if (hk.lines[j].n != null) return Math.max(1, hk.lines[j].n);
    for (let j = i - 1; j >= 0; j--) if (hk.lines[j].n != null) return Math.max(1, hk.lines[j].n);
    return Math.max(1, hk.newStart);
  }

  function hunkBlock(f, hk) {
    // Pair a run of deleted lines with the run of added lines that replaces it, so the words that
    // changed inside each pair are marked. Only for equal-length runs: otherwise the pairing is a guess.
    const marked = new Map();
    for (let i = 0; i < hk.lines.length;) {
      if (hk.lines[i].t !== '-') { i++; continue; }
      let d = i; while (d < hk.lines.length && hk.lines[d].t === '-') d++;
      let a = d; while (a < hk.lines.length && hk.lines[a].t === '+') a++;
      if (a - d === d - i) {
        for (let k = 0; k < d - i; k++) {
          const del = hk.lines[i + k], add = hk.lines[d + k];
          if (del.text.length > 800 || add.text.length > 800) continue;
          const ops = wordDiff(del.text, add.text);
          marked.set(i + k, ops.filter((o) => o.op !== 'ins'));
          marked.set(d + k, ops.filter((o) => o.op !== 'del'));
        }
      }
      i = Math.max(a, i + 1);
    }
    const rows = hk.lines.map((l, i) => {
      const ops = marked.get(i);
      const text = ops ? ops.map((o) => (o.op === 'eq' ? o.text : h('span', { class: o.op === 'del' ? 'w-del' : 'w-ins' }, o.text))) : l.text;
      const line = jumpLine(hk, i);
      const kind = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
      return h('div', { class: `ch-line ${kind}`, tabindex: 0, role: 'button', title: `${f.path}:${line}`, dataset: { line },
        onclick: () => onJump(f.path, line),
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onJump(f.path, line); } },
      h('span', { class: 'ln' }, l.o ?? ''), h('span', { class: 'ln' }, l.n ?? ''),
      h('span', { class: 'sign' }, l.t === ' ' ? '' : l.t === '-' ? '−' : '+'), h('span', { class: 'tx' }, text.length === 0 ? ' ' : text));
    });
    return h('div', { class: 'ch-hunk' }, ...rows);
  }

  // ---------- accepted suggestions ----------
  function sinceValue() {
    const v = sinceSel.value;
    if (v === 'sync') return 'sync';
    if (v === 'custom') { const d = new Date(sinceTime.value); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
    return new Date(Date.now() - { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR }[v]).toISOString();
  }

  async function loadAccepted() {
    const since = sinceValue();
    if (!since) throw new Error('Pick a date and time.');
    try { return await api(`/changes/accepted?since=${encodeURIComponent(since)}`); }
    catch (e) {
      // Not a repo / no commit to measure "since the last sync" from: say so and use the last 24 hours instead.
      if (since !== 'sync') throw e;
      sinceSel.value = '24h';
      const r = await api(`/changes/accepted?since=${encodeURIComponent(sinceValue())}`);
      return { ...r, fallback: e.message };
    }
  }

  function renderAccepted(r) {
    expandBox.classList.add('hidden');
    sinceBox.classList.remove('hidden');
    sinceTime.classList.toggle('hidden', sinceSel.value !== 'custom');
    count.textContent = plural(r.items.length, 'suggestion');
    const basis = r.basis === 'sync' ? 'the last sync' : r.basis === 'commit' ? 'your last commit' : '';
    setNote(`${r.fallback ? `${r.fallback} ` : ''}Suggestions you accepted in Margin since ${when(r.since)}${basis ? ` (${basis})` : ''}. `
      + 'Margin does not track Claude sessions: this filters by when each suggestion was accepted, not by “this session”. Ones cleared from the review panel are included.', r.fallback ? 'info' : '');
    if (!r.items.length) { list.replaceChildren(h('div', { class: 'empty' }, 'No suggestions were accepted in that time.')); return; }
    list.replaceChildren(...r.items.map((it) => {
      const ops = wordDiff(it.quote, it.replacement);
      const canOpen = !it.fileMissing && it.line != null;
      return h('div', { class: 'ch-acc' },
        h('div', { class: 'ch-acc-head' },
          h('button', { class: 'ch-path', disabled: it.fileMissing, title: canOpen ? `Open ${it.file} at line ${it.line}` : it.fileMissing ? `${it.file} no longer exists` : `Open ${it.file} (the accepted text has been edited since)`, onclick: () => onJump(it.file, it.line || 1) },
            `${it.file}${it.line ? `:${it.line}` : ''}`),
          h('span', { class: 'fine', title: when(it.decidedAt) }, `accepted ${timeAgo(it.decidedAt)}${it.decidedBy ? ` by ${it.decidedBy}` : ''}${it.archived ? ' · cleared from the panel' : ''}`)),
        h('div', { class: 'ch-acc-diff' }, ops.map((o) => (o.op === 'eq' ? o.text : h('span', { class: o.op === 'del' ? 'w-del' : 'w-ins' }, o.text)))),
        it.rationale ? h('div', { class: 'ch-acc-why' }, it.rationale) : null);
    }));
  }

  // ---------- diff PDF ----------
  async function checkTool() {
    try { tool = await api('/latexdiff'); } catch { tool = null; }
    renderFoot();
  }

  // What the diff PDF can be made against: the default (same baseline as the list above), the last
  // commit, or an earlier commit (an Overleaf version, a tag such as the submitted manuscript).
  function fillRefs(r) {
    const keep = refSel.value;
    const opts = [];
    if (r.repo && !r.noCommits) {
      opts.push(h('option', { value: 'sync' }, !r.tracking ? `your last commit (${short(r.head)})` : r.since === 'sync' ? `your last sync (${short(r.sha)})` : 'your last sync'));
      if (r.tracking) opts.push(h('option', { value: 'HEAD' }, `your last commit (${short(r.head)})`));
      if (r.commits?.length) {
        opts.push(h('optgroup', { label: 'An earlier version' }, r.commits.map((c) => h('option', { value: c.sha },
          `${new Date(c.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${c.tags.length ? `[${c.tags.join(', ')}] ` : ''}${c.subject.length > 46 ? `${c.subject.slice(0, 46)}…` : c.subject} (${c.short})`))));
      }
    }
    refSel.replaceChildren(...opts);
    if ([...refSel.options].some((o) => o.value === keep)) refSel.value = keep;
    renderFoot();
  }

  function renderFoot() {
    const usable = data?.repo && !data.noCommits;
    const missing = tool && !tool.installed;
    makeBtn.disabled = building || !usable || missing || !tool;
    makeBtn.textContent = building ? 'Building…' : 'Make diff PDF';
    makeBtn.classList.toggle('busy', building);
    refSel.disabled = building || !usable;
    const rb = $('#diff-rebuild', bar);
    rb.disabled = building; rb.textContent = building ? 'Rebuilding…' : 'Rebuild';
    if (building) return; // the status line is the progress message
    if (missing) setStatus(tool.message, 'error');
    else if (data && !usable) setStatus('', '');
    else if (!status.dataset.keep) setStatus('Marks every change in a PDF, like Word’s Track Changes, for a resubmission. Your normal PDF is not touched.', 'hint');
  }
  function setStatus(text, kind = '', keep = false) {
    status.textContent = text; status.className = `cf-status ${kind}`;
    if (keep) status.dataset.keep = '1'; else delete status.dataset.keep;
  }

  async function make({ rebuild = false } = {}) {
    if (building) return;
    building = true;
    renderFoot();
    setStatus('Comparing and compiling… this takes a few seconds to a minute.', '');
    try {
      await saveIfDirty?.();
      // Rebuild repeats what was asked for the first time ("your last sync" is looked up again, so it follows a Sync).
      const ref = rebuild ? diff.sent : (refSel.value === 'sync' || !refSel.value ? undefined : refSel.value);
      const r = await api('/latexdiff', { method: 'POST', body: ref ? { ref } : {} });
      if (!r.ok) {
        const msg = `The diff compiled with errors and produced no PDF: ${r.errors.map((e) => e.message).slice(0, 3).join(' / ') || 'see the log'}`;
        setStatus(msg, 'error', true);
        if (r.log) status.append(h('details', {}, h('summary', {}, 'End of the LaTeX log'), h('pre', { class: 'log-ctx' }, r.log)));
        toast('Could not build the diff PDF', 'error', 6000);
        return;
      }
      diff.sent = ref;
      await showDiff(r);
      close();
      if (r.errors.length) toast(`Diff PDF built, but LaTeX reported ${plural(r.errors.length, 'error')}; parts may be missing. See the notes under the PDF toolbar.`, 'info', 8000);
    } catch (e) {
      setStatus(e.message, 'error', true);
      toast(e.message, 'error', 8000);
    } finally { building = false; renderFoot(); }
  }

  async function showDiff(r) {
    const ok = await showPdf('/pdf-diff');
    if (!ok) throw new Error('The diff PDF was built but could not be displayed.');
    diff.active = true;
    renderBar(r);
  }

  function renderBar(r) {
    const legend = r.style === 'UNDERLINE' ? 'Added text is blue and underlined, deleted text red and struck through.' : 'Added text is blue, deleted text is red and small.';
    const text = $('#diff-text', bar);
    text.replaceChildren(h('strong', {}, `Changes since ${r.ref}`), r.short ? ` (${r.short})` : '');
    text.title = `Changes since ${r.ref}${r.short ? ` (${r.short})` : ''}, built ${new Date(r.at).toLocaleTimeString([], { timeStyle: 'short' })}`;
    $('#diff-legend', bar).textContent = legend;
    const notes = [...r.errors.map((e) => `LaTeX error: ${e.message}`), ...r.warnings.map((w) => w.message)];
    const nb = $('#diff-notes-btn', bar), nd = $('#diff-notes', bar);
    nb.classList.toggle('hidden', !notes.length);
    nb.textContent = `${plural(notes.length, 'note')}`;
    nb.setAttribute('aria-expanded', 'false');
    nd.classList.add('hidden');
    nd.replaceChildren(...notes.map((n) => h('div', {}, n)));
    bar.classList.remove('hidden');
    $('#pdf-pane').classList.add('diff-mode');
    const main = (getMain?.() || 'paper').replace(/\.tex$/, '').split('/').pop();
    downloadLink.href = '/pdf-diff';
    downloadLink.setAttribute('download', `${main}-diff.pdf`);
    downloadLink.title = 'Download the diff PDF';
  }

  // Resolves true when the normal PDF is showing again.
  async function back() {
    if (!diff.active) return true;
    diff.active = false; // so the loader below is allowed to replace what is on screen
    const ok = await showPdf('/pdf');
    if (!ok) { diff.active = true; toast('There is no normal PDF to go back to yet. Recompile first.', 'info', 6000); return false; }
    bar.classList.add('hidden');
    $('#pdf-pane').classList.remove('diff-mode');
    downloadLink.href = '/pdf';
    downloadLink.setAttribute('download', `${(getMain?.() || 'paper').replace(/\.tex$/, '').split('/').pop()}.pdf`);
    downloadLink.title = 'Download PDF';
    return true;
  }

  // ---------- wiring ----------
  function setMode(m) {
    mode = m;
    for (const b of $('.changes-modes', root).querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
    list.replaceChildren();
    refresh();
  }
  for (const b of root.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const b of root.querySelectorAll('[data-expand]')) b.addEventListener('click', () => {
    if (b.dataset.expand === 'none') for (const f of data?.files || []) collapsed.add(f.path); else collapsed.clear();
    if (data) renderFiles(data);
  });
  sinceSel.addEventListener('change', () => { if (sinceSel.value === 'custom' && !sinceTime.value) { const d = new Date(Date.now() - 24 * HOUR); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); sinceTime.value = d.toISOString().slice(0, 16); } refresh(); });
  sinceTime.addEventListener('change', refresh);
  $('#changes-refresh', root).addEventListener('click', refresh);
  makeBtn.addEventListener('click', () => make());
  $('.close', root).addEventListener('click', close);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#diff-back', bar).addEventListener('click', () => back());
  $('#diff-rebuild', bar).addEventListener('click', () => make({ rebuild: true }));
  $('#diff-notes-btn', bar).addEventListener('click', (e) => {
    const hidden = $('#diff-notes', bar).classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', String(!hidden));
  });

  function open() {
    root.classList.remove('hidden');
    onOpen?.();
    refresh();
    checkTool();
    $('.changes-modes [data-mode].on', root)?.focus();
  }
  function close() { root.classList.add('hidden'); }

  return {
    open, close, isOpen,
    toggle() { if (isOpen()) close(); else open(); },
    // Files or git state changed under us (Claude, a pull, the editor's own autosave): keep an open panel honest.
    refreshSoon() { if (isOpen() && !building) refreshLater(); },
    diffActive: () => diff.active,
    back,
  };
}
