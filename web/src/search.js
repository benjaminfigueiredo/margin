// Find in project: a panel over the PDF pane (same slot as Logs) that searches every text file,
// groups the hits by file, jumps to a hit on click, and replaces in the whole project, one file,
// or one match. The server never replaces from a query alone: every replace names its files or
// matches, and the panel shows the counts (and the review items at risk) before it applies one.
import { api, $, h, debounce, toast } from './util.js';

export function createSearch(root, { saveIfDirty, onJump, onReplaced, getSelection, onOpen }) {
  const qInput = $('#search-q', root);
  const rInput = $('#search-r', root);
  const results = $('#search-results', root);
  const count = $('#search-count', root);
  const note = $('#search-note', root);
  const confirmBar = $('#search-confirm', root);
  const allBtn = $('#search-all', root);
  const opts = { case: false, whole: false, regex: false };
  let shown = null;   // the last response, with the options it was run with
  let seq = 0;        // only the newest search may render
  let pending = null; // the replace awaiting confirmation

  const isOpen = () => !root.classList.contains('hidden');
  const qs = (o) => new URLSearchParams({ q: o.q, regex: o.regex ? '1' : '0', case: o.case ? '1' : '0', whole: o.whole ? '1' : '0' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const matches = (n) => `${n} match${n === 1 ? '' : 'es'}`;

  function setNote(text, kind = '') { note.textContent = text; note.className = `search-note ${kind}`; }

  async function run() {
    const q = qInput.value;
    const mine = ++seq;
    cancelConfirm();
    if (!q) { shown = null; results.replaceChildren(); count.textContent = ''; setNote(''); allBtn.disabled = true; return; }
    const query = { q, ...opts };
    try {
      await saveIfDirty?.(); // results must describe what is on disk, including the author's latest typing
      const res = await api(`/search?${qs(query)}`);
      if (mine !== seq) return;
      shown = { ...res, query };
      setNote('');
      render();
    } catch (e) {
      if (mine !== seq) return;
      shown = null;
      results.replaceChildren();
      count.textContent = '';
      allBtn.disabled = true;
      setNote(e.message, 'error');
    }
  }
  const runSoon = debounce(run, 250);
  // A background refresh (a file changed on disk) must not throw away a confirmation the author
  // opened in the meantime, so it checks for one when it fires, not when it is scheduled.
  const refreshLater = debounce(() => { if (isOpen() && qInput.value && !pending) run(); }, 250);

  function hitRow(file, m) {
    const lead = m.text.length - m.text.trimStart().length;
    const text = m.text.slice(lead);
    const start = Math.max(0, m.column - 1 - m.textOffset - lead);
    const end = Math.min(text.length, start + m.length);
    return h('div', { class: 'search-hit', dataset: { line: m.line }, tabindex: 0, title: `${file.path}:${m.line}`,
      onclick: (e) => { if (!e.target.closest('button')) onJump(file.path, m.line, m.column, m.length); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onJump(file.path, m.line, m.column, m.length); } },
    h('span', { class: 'hit-line' }, m.line),
    h('span', { class: 'hit-text' }, text.slice(0, start), h('mark', {}, text.slice(start, end)), text.slice(end)),
    h('button', { class: 'btn sm ghost hit-replace', title: 'Replace this match', onclick: () => request({ matches: [{ file: file.path, from: m.from, to: m.to }] }, 'match') }, 'Replace'));
  }

  function render() {
    const files = shown.files;
    const nFiles = files.length;
    count.textContent = shown.total ? `${shown.truncated ? `first ${shown.shown} of ` : ''}${matches(shown.total)} in ${plural(nFiles, 'file')}` : '';
    allBtn.disabled = !shown.total;
    if (!shown.total) { results.replaceChildren(h('div', { class: 'empty' }, 'No matches.')); return; }
    const groups = [];
    if (shown.truncated) groups.push(h('div', { class: 'search-trunc' }, `Showing the first ${shown.shown} of ${shown.total} matches. Narrow the search to see the rest. Replace still covers every match in the files you choose.`));
    for (const f of files) {
      groups.push(h('div', { class: 'search-file', dataset: { path: f.path } },
        h('span', { class: 'sf-path' }, f.path),
        h('span', { class: 'sf-count' }, f.count),
        h('button', { class: 'btn sm sf-replace', title: `Replace all ${f.count} in ${f.path}`, onclick: () => request({ files: [f.path] }, 'file') }, 'Replace in file')));
      for (const m of f.matches) groups.push(hitRow(f, m));
    }
    results.replaceChildren(...groups);
  }

  function cancelConfirm() { pending = null; confirmBar.classList.add('hidden'); confirmBar.replaceChildren(); }

  // Dry-run first: the server reports exactly how many matches and files the replace would touch
  // and how many open review items quote text inside them. Replace-all always asks; a single
  // file or match only asks when review items are at risk.
  async function request(target, kind) {
    if (!shown) return;
    const body = { ...shown.query, replacement: rInput.value, ...target };
    try {
      await saveIfDirty?.();
      const plan = await api('/replace', { method: 'POST', body: { ...body, dryRun: true } });
      if (!plan.replaced) { toast('Nothing to replace (the text changed since the search)', 'info'); run(); return; }
      if (kind === 'all' || plan.reviewAffected) { ask(body, plan, kind); return; }
      await apply(body);
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  function ask(body, plan, kind) {
    pending = body;
    const n = plan.reviewAffected;
    const to = body.replacement === '' ? 'nothing (delete)' : `\u201c${body.replacement.length > 40 ? body.replacement.slice(0, 40) + '\u2026' : body.replacement}\u201d`;
    const scope = kind === 'match' ? 'this match' : `${matches(plan.replaced)} in ${plural(plan.files.length, 'file')}`;
    const lines = [h('div', { class: 'sc-main' }, `Replace ${scope} with ${to}?`)];
    if (kind !== 'match') lines.push(h('div', { class: 'sc-files' }, plan.files.map((f) => `${f.path} (${f.replaced})`).join(', ')));
    if (n) lines.push(h('div', { class: 'sc-warn' }, `${plural(n, 'open review item')} quote${n === 1 ? 's' : ''} text this would change. ${n === 1 ? 'Its card' : 'Their cards'} will be flagged \u201ctext changed\u201d and can no longer be accepted.`));
    lines.push(h('div', { class: 'row' },
      h('button', { class: 'btn sm primary sc-go', onclick: () => apply(body) }, 'Replace'),
      h('button', { class: 'btn sm', onclick: cancelConfirm }, 'Cancel')));
    confirmBar.replaceChildren(...lines);
    confirmBar.classList.remove('hidden');
    $('.sc-go', confirmBar).focus();
  }

  async function apply(body) {
    cancelConfirm();
    try {
      const r = await api('/replace', { method: 'POST', body });
      toast(`Replaced ${matches(r.replaced)} in ${plural(r.files.length, 'file')}`, 'ok');
      await onReplaced?.(r.files.map((f) => f.path));
    } catch (e) { toast(e.message, 'error', 6000); }
    await run();
  }

  function open(prefill) {
    root.classList.remove('hidden');
    onOpen?.();
    const sel = prefill ?? getSelection?.();
    if (sel) { qInput.value = sel; run(); }
    else if (qInput.value && !shown) run();
    qInput.focus();
    qInput.select();
  }
  function close() { root.classList.add('hidden'); cancelConfirm(); }

  for (const b of root.querySelectorAll('[data-opt]')) {
    b.addEventListener('click', () => {
      opts[b.dataset.opt] = !opts[b.dataset.opt];
      b.classList.toggle('on', opts[b.dataset.opt]);
      b.setAttribute('aria-pressed', String(opts[b.dataset.opt]));
      run();
    });
  }
  qInput.addEventListener('input', runSoon);
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (pending) cancelConfirm(); else close(); } });
  allBtn.addEventListener('click', () => shown && request({ files: shown.files.map((f) => f.path) }, 'all'));
  $('.close', root).addEventListener('click', close);
  // Ctrl/Cmd+Shift+F from anywhere, including inside the editor.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); open(); }
  });

  return {
    open, close, isOpen,
    toggle() { if (isOpen()) close(); else open(); },
    // Files changed on disk (Claude, git, another editor): keep the visible results honest.
    refreshSoon() { refreshLater(); },
  };
}
