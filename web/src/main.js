import { api, $, $$, h, debounce, toast } from './util.js';
import { createEditor, selectionInfo } from './editor.js';
import { createPdfView } from './pdfview.js';
import { createReviewPanel } from './review.js';
import { initWordCount } from './wordcount.js';
import { createOutline } from './outline.js';
import { initSettings } from './settings.js';
import { initAsk } from './ask.js';

const state = {
  project: null,
  tree: [],
  file: null,
  savedContent: '',
  dirty: false,
  saving: null,
  collapsed: new Set(),
  lastCompile: null,
};

// ---------- editor ----------
const editor = createEditor($('#editor'), {
  onChange: () => { outlineSoon(); state.dirty = true; setSaveState('Unsaved'); saveSoon(); },
  onSelection: (s) => { outline.setCursor(s.doc.lineAt(s.selection.main.head).number); reportEditorState(s); updateCommentButton(s); },
  onReviewClick: (id) => { const it = review.items.find((x) => x.id === id); if (it) focusItem(it, { fromEditor: true }); },
  keys: [
    { key: 'Mod-Enter', run: () => { compile(); return true; } },
    { key: 'Mod-s', run: () => { save().then(compile); return true; } },
    { key: 'Mod-Alt-ArrowRight', run: () => { forwardSearch(); return true; } },
    { key: 'Mod-Alt-c', run: () => { openCommentBox(); return true; } },
    { key: 'Mod-Alt-a', run: () => { ask.open(); return true; } },
  ],
});

initWordCount(editor);
initSettings(editor);

// ---------- outline ----------
const outline = createOutline($('#outline'), {
  getText: () => (state.file?.endsWith('.tex') ? editor.getDoc() : null),
  onJump: (line) => editor.gotoLine(line),
});
const outlineSoon = debounce(() => outline.update(), 250);
$('#outline .outline-toggle').addEventListener('click', (e) => {
  const closed = $('#outline').classList.toggle('collapsed');
  e.currentTarget.setAttribute('aria-expanded', String(!closed));
  e.currentTarget.textContent = closed ? '▸' : '▾';
});

function setSaveState(t) { $('#save-state').textContent = t; }

const saveSoon = debounce(() => save(), 700);
async function save() {
  if (!state.file || !state.dirty) return;
  const content = editor.getDoc();
  const file = state.file;
  state.saving = api(`/file?path=${encodeURIComponent(file)}`, { method: 'PUT', body: { content } });
  try {
    await state.saving;
    if (file === state.file) {
      state.savedContent = content;
      state.dirty = editor.getDoc() !== content;
      setSaveState(state.dirty ? 'Unsaved' : 'Saved');
      if (!state.dirty && state.reviewStale) refreshReview();
    }
  } catch (e) {
    setSaveState('Save failed');
    toast(`Could not save ${file}: ${e.message}`, 'error', 8000);
  } finally { state.saving = null; }
}

const reportEditorState = debounce((s) => {
  if (!state.file) return;
  const info = selectionInfo(s);
  api('/editor-state', { method: 'POST', body: { file: state.file, ...info } }).catch(() => {});
}, 250);

// ---------- files ----------
async function loadTree() {
  state.tree = await api('/tree');
  renderTree();
}

function renderTree() {
  const root = $('#tree');
  const items = [];
  for (const entry of state.tree) {
    const parts = entry.path.split('/');
    const parent = parts.slice(0, -1).join('/');
    // hide children of collapsed folders
    let hidden = false;
    for (let i = 1; i < parts.length; i++) if (state.collapsed.has(parts.slice(0, i).join('/'))) hidden = true;
    if (hidden) continue;
    const depth = parts.length - 1;
    const name = parts[parts.length - 1];
    if (entry.type === 'dir') {
      const closed = state.collapsed.has(entry.path);
      items.push(h('div', { class: 'tree-item dir', style: `padding-left:${10 + depth * 14}px`, onclick: () => { closed ? state.collapsed.delete(entry.path) : state.collapsed.add(entry.path); renderTree(); } },
        h('span', { class: 'twisty' }, closed ? '▸' : '▾'), h('span', { class: 'name' }, name)));
    } else {
      const count = review ? review.items.filter((it) => it.file === entry.path && it.status === 'open').length : 0;
      items.push(h('div', {
        class: `tree-item file ${entry.path === state.file ? 'active' : ''} ${entry.text ? '' : 'binary'} ${entry.path === state.project?.main ? 'main' : ''}`,
        style: `padding-left:${10 + depth * 14 + 12}px`,
        title: entry.path,
        dataset: { parent },
        onclick: () => openFile(entry.path),
      }, h('span', { class: `ficon ${ext(name)}` }), h('span', { class: 'name' }, name), count ? h('span', { class: 'count' }, count) : null));
    }
  }
  root.replaceChildren(...items);
}

function ext(name) { const m = name.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }

async function openFile(path, { line } = {}) {
  if (state.dirty) await save();
  const entry = state.tree.find((e) => e.path === path);
  state.file = path;
  localStorage.setItem(`margin:${state.project.root}:file`, path);
  $('#current-file').textContent = path;
  renderTree();
  if (entry && !entry.text) {
    $('#editor').classList.add('hidden');
    const iv = $('#image-view');
    iv.classList.remove('hidden');
    iv.replaceChildren(/\.(png|jpe?g|gif|svg|webp)$/i.test(path)
      ? h('img', { src: `/api/raw?path=${encodeURIComponent(path)}&t=${Date.now()}`, alt: path })
      : h('div', { class: 'empty' }, h('p', {}, 'Binary file — not editable here.'), h('p', {}, h('a', { href: `/api/raw?path=${encodeURIComponent(path)}`, target: '_blank' }, 'Open'))));
    setSaveState('');
    review.render();
    outline.update();
    return;
  }
  $('#image-view').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  const { content } = await api(`/file?path=${encodeURIComponent(path)}`);
  editor.setDoc(content);
  state.savedContent = content;
  state.dirty = false;
  setSaveState('Saved');
  hideBanner();
  applyReviewToEditor();
  applyDiagnostics();
  review.render();
  outline.update();
  if (line) editor.gotoLine(line);
}

async function reloadCurrentFromDisk() {
  const { content } = await api(`/file?path=${encodeURIComponent(state.file)}`);
  if (content === editor.getDoc()) { state.savedContent = content; state.dirty = false; return; }
  editor.replaceDocPreserving(content);
  outline.update();
  state.savedContent = content;
  state.dirty = false;
  setSaveState('Saved');
  hideBanner();
}

function showBanner(msg, actions) {
  const b = $('#banner');
  b.replaceChildren(h('span', {}, msg), ...actions.map(([label, fn]) => h('button', { class: 'btn sm', onclick: fn }, label)));
  b.classList.remove('hidden');
}
function hideBanner() { $('#banner').classList.add('hidden'); }

// ---------- review ----------
const review = createReviewPanel($('#review'), {
  getCurrentFile: () => state.file,
  onFocus: (it) => focusItem(it),
  onChanged: () => refreshReview(),
  saveIfDirty: () => (state.dirty ? save() : Promise.resolve()),
  extra: (it, items) => ask.cardExtra(it, items),
});

const ask = initAsk({
  editor,
  getFile: () => state.file,
  saveIfDirty: () => (state.dirty ? save() : Promise.resolve()),
  refreshReview: () => refreshReview(),
  focusItem: (it) => focusItem(it),
  showReview: () => { if ($('#review').classList.contains('collapsed')) $('#btn-review').click(); },
});

async function refreshReview() {
  await review.refresh();
  applyReviewToEditor();
  const open = review.openCount();
  const badge = $('#review-badge');
  badge.textContent = open;
  badge.classList.toggle('hidden', open === 0);
  ask.update(review.items);
  renderTree();
}

function applyReviewToEditor() {
  if (!state.file) return;
  // Locations come from the server for the saved file; only trust them when the editor matches disk.
  // While there are unsaved edits, the existing decorations keep being mapped through the changes instead.
  if (state.dirty) { state.reviewStale = true; return; }
  state.reviewStale = false;
  editor.setReview(review.itemsForFile(state.file));
}

async function focusItem(it, { fromEditor = false } = {}) {
  if (it.file !== state.file) await openFile(it.file);
  review.setActive(it.id, { scroll: fromEditor || true });
  editor.setActive(it.id);
  if (!fromEditor && it.from != null) editor.gotoRange(it.from, it.from);
}

// Comment on selection
function updateCommentButton(s) {
  const has = !s.selection.main.empty;
  $('#btn-comment').disabled = !has;
  $('#btn-ask').disabled = !has;
}

function openCommentBox() {
  const info = selectionInfo(editor.view.state);
  if (!info.selection) { toast('Select some text to comment on', 'info'); return; }
  const box = $('#new-comment');
  box.classList.remove('hidden');
  const quote = info.selection.text;
  box.querySelector('.quote').textContent = quote.length > 200 ? quote.slice(0, 200) + '…' : quote;
  box.dataset.quote = quote;
  box.dataset.line = String(info.selection.fromLine);
  const ta = box.querySelector('textarea');
  ta.value = '';
  ta.focus();
}

async function submitComment() {
  const box = $('#new-comment');
  const comment = box.querySelector('textarea').value.trim();
  if (!comment) return;
  if (state.dirty) await save();
  try {
    await api('/review/comment', { method: 'POST', body: { file: state.file, quote: box.dataset.quote, comment, line: Number(box.dataset.line) } });
    box.classList.add('hidden');
    await refreshReview();
  } catch (e) { toast(e.message, 'error', 6000); }
}

$('#btn-comment').addEventListener('click', openCommentBox);
$('#new-comment .submit').addEventListener('click', submitComment);
$('#new-comment .cancel').addEventListener('click', () => $('#new-comment').classList.add('hidden'));
$('#new-comment textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitComment();
  if (e.key === 'Escape') $('#new-comment').classList.add('hidden');
});

// ---------- PDF ----------
const pdf = createPdfView($('#pdf-scroll'), $('#pdf-pages'), {
  onInverse: async (page, x, y) => {
    try {
      const loc = await api(`/synctex/inverse?page=${page}&x=${x}&y=${y}`);
      if (!loc || !loc.file) return toast('No source location for that spot', 'info');
      if (loc.file !== state.file) await openFile(loc.file, { line: loc.line });
      else editor.gotoLine(loc.line);
    } catch (e) { toast(e.message, 'error'); }
  },
  onStatus: (t) => { $('#page-label').textContent = t; },
});

async function loadPdf() {
  const ok = await pdf.load('/pdf');
  $('#pdf-empty').classList.toggle('hidden', ok || pdf.loaded);
  $('#zoom-label').textContent = pdf.zoomLabel;
}

async function forwardSearch() {
  if (!state.file || !state.file.endsWith('.tex')) return;
  if (state.dirty) await save();
  const info = selectionInfo(editor.view.state);
  try {
    const loc = await api(`/synctex/forward?file=${encodeURIComponent(state.file)}&line=${info.cursorLine}`);
    if (!loc) return toast('That line is not in the PDF (recompile?)', 'info');
    pdf.showLocation(loc);
  } catch (e) { toast(e.message, 'error'); }
}

$('#btn-forward').addEventListener('click', forwardSearch);
$('#zoom-in').addEventListener('click', async () => { await pdf.zoomIn(); $('#zoom-label').textContent = pdf.zoomLabel; });
$('#zoom-out').addEventListener('click', async () => { await pdf.zoomOut(); $('#zoom-label').textContent = pdf.zoomLabel; });
$('#zoom-fit').addEventListener('click', async () => { await pdf.setZoom('fit'); $('#zoom-label').textContent = pdf.zoomLabel; });

// ---------- compile ----------
async function compile() {
  if (state.dirty) await save();
  if (state.saving) await state.saving;
  try { await api('/compile', { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
}

function onCompileStart(by) {
  const btn = $('#btn-compile');
  btn.classList.add('busy');
  btn.querySelector('.label').textContent = by === 'claude' ? 'Claude is compiling…' : 'Compiling…';
}

async function onCompileDone(msg) {
  const btn = $('#btn-compile');
  btn.classList.remove('busy');
  btn.querySelector('.label').textContent = 'Recompile';
  state.lastCompile = msg;
  renderLogs();
  applyDiagnostics();
  const errs = msg.errors.length;
  const warns = msg.warnings.filter((w) => w.kind !== 'box').length;
  const badge = $('#log-badge');
  badge.textContent = errs ? errs : warns || '';
  badge.className = `badge ${errs ? 'error' : warns ? 'warn' : 'hidden'}`;
  $('#compile-status').textContent = `${errs ? `${errs} error${errs > 1 ? 's' : ''}` : 'Compiled'} · ${(msg.durationMs / 1000).toFixed(1)}s${msg.by === 'claude' ? ' · by Claude' : ''}`;
  $('#compile-status').className = errs ? 'error' : '';
  if (msg.pdf) await loadPdf();
  else if (errs) { toast('Compile failed — see Logs', 'error'); showLogs(true); }
}

function renderLogs() {
  const r = state.lastCompile;
  const list = $('#log-list');
  if (!r) { list.replaceChildren(h('div', { class: 'empty' }, 'Not compiled yet.')); return; }
  const row = (it, kind) => h('div', { class: `log-item ${kind}`, onclick: () => it.file && openFile(it.file, { line: it.line || 1 }).then(() => it.line && editor.gotoLine(it.line)) },
    it.file ? h('div', { class: 'log-loc' }, `${it.file}${it.line ? ':' + it.line : ''}`) : null,
    h('div', { class: 'log-msg' }, it.message),
    it.context ? h('pre', { class: 'log-ctx' }, it.context) : null);
  const groups = [];
  if (r.errors.length) groups.push(h('h4', {}, `Errors (${r.errors.length})`), ...r.errors.map((e) => row(e, 'error')));
  const warns = r.warnings.filter((w) => w.kind !== 'box');
  const boxes = r.warnings.filter((w) => w.kind === 'box');
  if (warns.length) groups.push(h('h4', {}, `Warnings (${warns.length})`), ...warns.map((w) => row(w, 'warn')));
  if (boxes.length) groups.push(h('details', {}, h('summary', {}, `Typesetting (${boxes.length} over/underfull boxes)`), ...boxes.map((w) => row(w, 'box'))));
  if (!groups.length) groups.push(h('div', { class: 'empty' }, 'No errors or warnings.'));
  list.replaceChildren(...groups);
}

// Gutter markers for the open file's compile errors and (non-box) warnings; a click reveals the entry in Logs.
function applyDiagnostics() {
  const r = state.lastCompile;
  const items = r ? [...r.errors.map((e) => ({ ...e, severity: 'error' })), ...r.warnings.filter((w) => w.kind !== 'box').map((w) => ({ ...w, severity: 'warn' }))] : [];
  editor.setDiagnostics(items.filter((it) => it.line && it.file === state.file), (hit) => {
    showLogs(true);
    const d = hit[0];
    const row = [...document.querySelectorAll('#log-list .log-item')].find((el) => el.querySelector('.log-loc')?.textContent === `${d.file}:${d.line}` && el.querySelector('.log-msg')?.textContent === d.message);
    row?.scrollIntoView({ block: 'center' });
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 1500);
  });
}

function showLogs(on) {
  const open = on ?? $('#logs').classList.contains('hidden');
  $('#logs').classList.toggle('hidden', !open);
  $('#btn-logs').classList.toggle('active', open);
}

$('#btn-compile').addEventListener('click', compile);
$('#btn-logs').addEventListener('click', () => showLogs());
$('#logs .close').addEventListener('click', () => showLogs(false));
$('#btn-rawlog').addEventListener('click', async () => {
  const { log } = await api('/compile/log');
  const w = window.open('', '_blank');
  if (w) { w.document.title = 'LaTeX log'; const pre = w.document.createElement('pre'); pre.textContent = log; w.document.body.append(pre); }
});

// Compile settings popover
$('#btn-compile-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#compile-menu').classList.toggle('hidden'); });
document.addEventListener('click', (e) => { if (!e.target.closest('#compile-menu')) $('#compile-menu').classList.add('hidden'); });
$('#set-engine').addEventListener('change', (e) => updateSettings({ engine: e.target.value }));
$('#set-auto').addEventListener('change', (e) => updateSettings({ autoCompile: e.target.checked }));
$('#set-main').addEventListener('change', (e) => updateSettings({ main: e.target.value }));
async function updateSettings(body) {
  try {
    const r = await api('/settings', { method: 'PUT', body });
    state.project.settings = r.settings;
    state.project.main = r.main;
    $('#main-file').textContent = r.main;
    renderTree();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- review panel toggle ----------
$('#btn-review').addEventListener('click', () => {
  const hidden = $('#review').classList.toggle('collapsed');
  $('#btn-review').classList.toggle('active', !hidden);
  localStorage.setItem('margin:review-hidden', hidden ? '1' : '');
});

// ---------- git ----------
async function refreshGit() {
  try {
    const g = await api('/git/status');
    const el = $('#git-status');
    if (!g.repo) { el.textContent = 'Not a git repo'; el.title = ''; return; }
    const bits = [`${g.overleaf ? 'Overleaf' : g.remote ? 'remote' : 'local only'} · ${g.branch}`];
    if (g.changed.length) bits.push(`${g.changed.length} changed`);
    if (g.ahead) bits.push(`${g.ahead} to push`);
    if (g.behind) bits.push(`${g.behind} to pull`);
    // If the fetch keeps failing, "to pull" is stale: say so instead of looking up to date.
    const unreachable = g.remoteCheck && g.remoteCheck.failures > 1;
    if (unreachable) bits.push("can't reach Overleaf");
    // A branch with no upstream has no "to pull" at all; without this it looks up to date.
    const untracked = g.remote && g.tracking === false;
    if (untracked) bits.push('not tracking Overleaf');
    if (g.conflicted?.length) bits.push(`unresolved conflict in ${g.conflicted.join(', ')}`);
    el.textContent = bits.join(' · ');
    el.title = untracked ? `"${g.branch}" has no upstream, so co-authors' changes are not shown here and Sync cannot push. Overleaf supports one branch: switch back with "git checkout master".`
      : unreachable ? `Last fetch failed, so "to pull" may be out of date: ${g.remoteCheck.error}` : (g.remote || '');
  } catch { /* ignore */ }
}

// Overleaf has commits we have not pulled (server fetches every few minutes). Unsaved edits are
// flushed first, as for sync: git pull --autostash then rebases onto what is on disk, not a stale copy.
async function pullFromOverleaf() {
  try {
    if (state.dirty) await save();
    const r = await api('/git/pull', { method: 'POST' });
    // A conflicted pull leaves both versions in the file with <<<<<<< markers. Keep a
    // banner up explaining that, and still refresh everything below, so the editor shows
    // what is actually on disk instead of text the file no longer contains.
    if (r.ok) { hideBanner(); toast('Pulled from Overleaf', 'ok'); }
    else if (r.conflict?.length) showBanner(r.hint, [[`Open ${r.conflict[0]}`, () => openFile(r.conflict[0])]]);
    else { toast(`Pull failed: ${r.out || 'unknown error'}`, 'error', 12000); return; }
    await loadTree();
    await Promise.all([refreshGit(), refreshReview()]);
    if (state.file && !state.dirty && state.tree.some((e) => e.path === state.file)) await reloadCurrentFromDisk();
    applyReviewToEditor();
  } catch (e) { toast(e.message, 'error'); }
}
function onGitChanged(msg) {
  refreshGit();
  if (!(msg.behind > 0)) return;
  const n = msg.behind;
  const hit = state.file && (msg.files || []).includes(state.file);
  const text = hit ? `${state.file} was changed on Overleaf (${n} new commit${n === 1 ? '' : 's'}). Pull before you keep editing it.`
    : `Overleaf has ${n} new commit${n === 1 ? '' : 's'} you haven't pulled.`;
  showBanner(text, [['Pull from Overleaf', () => pullFromOverleaf()], ['Dismiss', () => hideBanner()]]);
}

$('#btn-sync').addEventListener('click', async () => {
  if (state.dirty) await save();
  // Sync stages everything in the paper folder, so list what is about to reach the
  // co-authors before asking for a message, rather than just saying "your changes".
  let intro = 'Commit message for your changes (they will be pushed to Overleaf):';
  try {
    const g = await api('/git/status');
    if (g.conflicted?.length) { toast(`Resolve the conflict in ${g.conflicted.join(', ')} before syncing.`, 'error', 12000); return; }
    const files = (g.changed || []).map((c) => c.path);
    if (files.length) {
      intro = `These ${files.length} file${files.length > 1 ? 's' : ''} will be committed and pushed to Overleaf:\n\n${files.slice(0, 15).join('\n')}${files.length > 15 ? `\n…and ${files.length - 15} more` : ''}\n\nCommit message:`;
    } else {
      intro = 'Nothing has changed locally; Sync will just pull from Overleaf.\n\nCommit message:';
    }
  } catch { /* fall back to the plain prompt */ }
  const msg = prompt(intro, 'Edits via Margin');
  if (msg === null) return;
  const btn = $('#btn-sync');
  btn.classList.add('busy');
  try {
    const r = await api('/git/sync', { method: 'POST', body: { message: msg } });
    if (r.ok) toast('Synced with Overleaf', 'ok');
    else if (r.conflict) toast(`${r.hint} (${r.conflict.join(', ')})`, 'error', 12000);
    else toast(`Sync failed: ${r.steps.filter((s) => !s.ok).map((s) => `${s.label}: ${s.out}`).join(' / ')}`, 'error', 12000);
  } catch (e) { toast(e.message, 'error'); }
  btn.classList.remove('busy');
  await Promise.all([loadTree(), refreshGit()]);
  if (state.file) await reloadCurrentFromDisk().catch(() => {});
});

// ---------- splitter ----------
(() => {
  const split = $('#splitter');
  const pdfPane = $('#pdf-pane');
  const saved = Number(localStorage.getItem('margin:pdf-width'));
  if (saved) pdfPane.style.flexBasis = `${saved}px`;
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.min(window.innerWidth * 0.7, Math.max(280, window.innerWidth - ev.clientX));
      pdfPane.style.flexBasis = `${w}px`;
    };
    const up = () => {
      split.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      localStorage.setItem('margin:pdf-width', String(parseInt(pdfPane.style.flexBasis, 10)));
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up, { once: true });
  });
})();

// ---------- live updates ----------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $('#conn').className = 'dot on'; $('#conn').title = 'Connected to Margin server'; };
  ws.onclose = () => { $('#conn').className = 'dot off'; $('#conn').title = 'Disconnected — retrying'; setTimeout(connect, 1500); };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'review-changed': await refreshReview(); break;
      case 'tree-changed': await loadTree(); refreshGit(); break;
      case 'file-changed':
        refreshGit();
        if (msg.path === state.file && msg.external) {
          if (!state.dirty) await reloadCurrentFromDisk();
          else showBanner(`${msg.path} changed on disk (Claude or git).`, [['Load disk version', () => reloadCurrentFromDisk()], ['Keep mine', () => { hideBanner(); save(); }]]);
          applyReviewToEditor();
        }
        break;
      case 'git-changed': onGitChanged(msg); break;
      case 'compile-start': onCompileStart(msg.by); break;
      case 'claude-activity': ask.onActivity(msg); break;
      case 'compile-done': await onCompileDone(msg); break;
      case 'goto':
        await openFile(msg.file);
        editor.gotoLine(msg.line);
        toast(`Claude pointed you to ${msg.file}:${msg.line}`, 'claude');
        if (msg.file.endsWith('.tex')) forwardSearch();
        break;
      default: break;
    }
  };
}

// ---------- boot ----------
async function boot() {
  state.project = await api('/project');
  document.title = `${state.project.name} — Margin`;
  $('#project-name').textContent = state.project.name;
  $('#main-file').textContent = state.project.main;
  $('#set-engine').value = state.project.settings.engine;
  $('#set-auto').checked = !!state.project.settings.autoCompile;
  if (localStorage.getItem('margin:review-hidden')) { $('#review').classList.add('collapsed'); $('#btn-review').classList.remove('active'); }
  await loadTree();
  const mainSel = $('#set-main');
  mainSel.replaceChildren(...state.tree.filter((e) => e.type === 'file' && e.path.endsWith('.tex')).map((e) => h('option', { value: e.path, selected: e.path === state.project.main }, e.path)));
  await refreshReview();
  const remembered = localStorage.getItem(`margin:${state.project.root}:file`);
  const start = state.tree.some((e) => e.path === remembered) ? remembered : state.project.main;
  if (state.tree.some((e) => e.path === start)) await openFile(start);
  refreshGit();
  connect();
  if (state.project.lastCompile) onCompileDone(state.project.lastCompile);
  else {
    // Show an existing PDF right away, then compile fresh.
    loadPdf().then(() => compile());
  }
}

window.addEventListener('beforeunload', (e) => { if (state.dirty) { save(); e.preventDefault(); } });
boot().catch((e) => toast(`Failed to start: ${e.message}`, 'error', 20000));
