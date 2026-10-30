import { api, store, $, $$, h, debounce, toast } from './util.js';
import { createEditor, selectionInfo } from './editor.js';
import { createPdfView } from './pdfview.js';
import { initPdfFind } from './pdffind.js';
import { createReviewPanel } from './review.js';
import { initWordCount } from './wordcount.js';
import { createOutline } from './outline.js';
import { initSettings } from './settings.js';
import { createFiles, hasFiles } from './files.js';
import { createSearch } from './search.js';
import { createResponsePanel } from './response.js';
import { createContextPanel } from './context.js';
import { initAsk } from './ask.js';
import { createChanges } from './changes.js';
import { region, merge3, sameText } from './merge.js';

const state = {
  project: null,
  tree: [],
  file: null,
  doc: 0,          // bumped whenever the editor switches to another file (or none)
  base: null,      // { content, hash }: the text on disk the buffer was loaded from or last saved as
  dirty: false,    // the buffer has edits that are not on disk
  conflict: null,  // { missing, hash }: a save was refused and the author has not chosen yet
  collapsed: new Set(),
  lastCompile: null,
};

// ---------- editor ----------
const editor = createEditor($('#editor'), {
  onChange: () => { outlineSoon(); state.dirty = true; setSaveState(state.conflict ? CONFLICT_LABEL : 'Unsaved'); saveSoon(); },
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

// ---------- saving, and keeping the editor in step with the file on disk ----------
// Rule: nothing the author typed is ever dropped, and nothing written to disk by someone else
// (an accepted suggestion, a replace, Claude, git) is ever overwritten by a stale buffer.
//  - state.base is the text on disk the buffer was last loaded from or saved as, with the server's
//    hash of it. Every save sends that hash, and the server refuses (409) to write over anything else.
//  - When the file changes on disk, or a save is refused, syncNow() reads it again and merges the
//    change into the buffer if the author's unsaved edits are elsewhere in the file; if they touch
//    the same text, the banner asks, and nothing is saved until the author chooses.
//  - Saves, reloads, opening a file and git pull/sync run one at a time, in order (serial), so a
//    save can never land in the middle of one of the others.
const KEEPALIVE_BYTES = 30000; // two such requests stay under the browsers' 64 KB keepalive budget
const CONFLICT_LABEL = 'Not saved: changed on disk';
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
let inflight = null; // the save being sent: { id, content, keepalive }
const saveId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const fileUrl = (file) => `/file?path=${encodeURIComponent(file)}`;

const saveSoon = debounce(() => save(), 700);
// Saves the buffer if it has unsaved edits (after anything already queued). Never throws.
function save() { return serial(flushNow); }
// The same, for actions that rewrite the source or read it back from disk (review, replace, rename):
// they must not run on a disk version that is missing what the author sees in the editor.
async function saveFirst() {
  await save();
  if (state.dirty && state.file) throw new Error(`${state.file} has edits that are not saved yet (see the bar above the editor).`);
}

async function flushNow() {
  // A save merged with a change on disk leaves the merged text to save: up to a few rounds.
  for (let i = 0; i < 4; i++) if ((await saveNow()) !== 'merged') return;
}

async function saveNow() {
  if (!state.file || !state.dirty || !state.base || state.conflict) return 'none';
  const { file, doc } = state;
  const base = state.base;
  const content = editor.getDoc();
  if (content === base.content) { state.dirty = false; setSaveState('Saved'); return 'saved'; }
  // The change against the base text, not the whole file: small enough to outlive the page.
  const id = saveId();
  const body = JSON.stringify({ id, base: base.hash, edit: region(base.content, content) });
  const keepalive = new Blob([body]).size <= KEEPALIVE_BYTES;
  inflight = { id, content, keepalive };
  let r;
  try {
    r = await api(fileUrl(file), { method: 'PUT', body, keepalive });
  } catch (e) {
    if (doc !== state.doc) return 'none';
    if (e.status === 409 && e.data?.stale) return syncNow({ missing: !!e.data.missing });
    setSaveState('Save failed');
    toast(`Could not save ${file}: ${e.message}`, 'error', 8000);
    return 'failed';
  } finally { inflight = null; }
  if (doc !== state.doc) return 'none';
  state.base = { content, hash: r.hash };
  state.dirty = editor.getDoc() !== content;
  setSaveState(state.dirty ? 'Unsaved' : 'Saved');
  if (!state.dirty && state.reviewStale) refreshReview();
  return 'saved';
}

// Brings the editor up to date with the file on disk without dropping anything typed.
function syncFromDisk() { return serial(() => syncNow()); }

async function syncNow({ missing = false } = {}) {
  if (!state.file || !state.base) return 'none';
  const { file, doc } = state;
  let disk = null;
  if (!missing) {
    try { disk = await api(fileUrl(file)); } catch (e) {
      if (e.status !== 404) { toast(`Could not read ${file}: ${e.message}`, 'error', 8000); return 'failed'; }
    }
  }
  if (doc !== state.doc) return 'none';
  if (!disk) {
    // Deleted or moved outside Margin. Unsaved text stays in the editor until the author chooses;
    // a clean buffer just waits (typing into it brings this back through the refused save).
    if (state.dirty) conflict({ missing: true });
    return 'conflict';
  }
  if (disk.hash === state.base.hash) {
    if (state.conflict) { endConflict(); saveSoon(); } // the other change was undone
    return 'none';
  }
  const mine = editor.getDoc(); // read after the await: includes whatever was typed meanwhile
  const adopt = (dirty) => {
    state.base = { content: disk.content, hash: disk.hash };
    state.dirty = dirty;
    endConflict();
    setSaveState(dirty ? 'Unsaved' : 'Saved');
    outline.update();
  };
  if (sameText(mine, disk.content)) { adopt(false); return 'saved'; }
  if (!state.dirty || sameText(mine, state.base.content)) {
    editor.replaceDocPreserving(disk.content);
    adopt(false);
    return 'reloaded';
  }
  const change = merge3(state.base.content, mine, disk.content);
  if (!change) { conflict({ hash: disk.hash }); return 'conflict'; }
  editor.applyExternal(change);
  adopt(true);
  saveSoon();
  return 'merged';
}

// The author's unsaved edits and a change on disk touch the same text (or the file is gone).
// Nothing is saved until the author picks one; the buffer is kept either way.
function conflict({ missing = false, hash = null }) {
  state.conflict = { missing, hash };
  setSaveState(CONFLICT_LABEL);
  if (missing) {
    showBanner(`${state.file} is no longer on disk (deleted or moved outside Margin). Your text is still here, not saved.`,
      [[`Save it again as ${state.file}`, () => keepMine()], ['Close without saving', () => closeUnsaved()]]);
  } else {
    showBanner(`${state.file} changed on disk (Claude, git or another editor) where you have unsaved edits. Your text is still here, not saved.`,
      [['Load disk version', () => loadDiskVersion()], ['Keep mine', () => keepMine()]]);
  }
}
function endConflict() {
  if (!state.conflict) return;
  state.conflict = null;
  hideBanner();
}

// "Keep mine": the buffer replaces whatever is on disk now (and only that: if the file changes
// again before the save arrives, the author is asked again).
function keepMine() {
  return serial(async () => {
    if (!state.conflict || !state.file) return;
    const { file, doc } = state;
    const content = editor.getDoc();
    try {
      if (state.conflict.missing) {
        // Create-only: if the file has come back meanwhile, it is not replaced; see below.
        const r = await api(`${fileUrl(file)}&exclusive=1`, { method: 'PUT', body: { content } });
        if (doc !== state.doc) return;
        state.base = { content, hash: r.hash };
        state.dirty = editor.getDoc() !== content;
        endConflict();
        setSaveState(state.dirty ? 'Unsaved' : 'Saved');
        if (state.dirty) saveSoon();
        await loadTree();
        return;
      }
      const disk = await api(fileUrl(file));
      if (doc !== state.doc) return;
      state.base = { content: disk.content, hash: disk.hash };
      state.dirty = true;
      endConflict();
      await flushNow();
    } catch (e) {
      if (doc !== state.doc) return;
      if (e.status === 404 || e.status === 409) { state.conflict = null; await syncNow({ missing: e.status === 404 }); return; }
      toast(`Could not save ${file}: ${e.message}`, 'error', 8000);
    }
  });
}

// "Load disk version": the author's unsaved edits give way to the file on disk.
function loadDiskVersion() {
  return serial(async () => {
    if (!state.file) return;
    const { file, doc } = state;
    let disk;
    try { disk = await api(fileUrl(file)); } catch (e) {
      if (e.status === 404) return syncNow({ missing: true });
      toast(e.message, 'error');
      return;
    }
    if (doc !== state.doc) return;
    editor.replaceDocPreserving(disk.content);
    state.base = { content: disk.content, hash: disk.hash };
    state.dirty = false;
    endConflict();
    setSaveState('Saved');
    outline.update();
    applyReviewToEditor();
  });
}

function closeUnsaved() {
  state.dirty = false;
  endConflict();
  openFile(state.project.main).catch((e) => toast(e.message, 'error'));
}

// The page is going away (closing the tab or window, a web view torn down, a reload). beforeunload
// does not always come first, so send what is unsaved in a keepalive request, which outlives the
// page. It is the edit against the last saved text, small whatever the size of the file; if a save
// is still on its way, `after` gives the same edit against that one, and the server applies
// whichever matches what it has.
function saveOnExit() {
  if (!state.file || !state.base || state.conflict) return;
  const content = editor.getDoc();
  const pending = inflight;
  if (pending ? pending.keepalive && pending.content === content : content === state.base.content) return;
  const body = { id: saveId(), base: state.base.hash, edit: region(state.base.content, content) };
  if (pending) body.after = { id: pending.id, edit: region(pending.content, content) };
  const json = JSON.stringify(body);
  api(fileUrl(state.file), { method: 'PUT', body: json, keepalive: new Blob([json]).size <= KEEPALIVE_BYTES }).catch(() => {});
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
  syncMainOptions();
}

// The "Main document" choices follow the tree, so a file created or renamed here can be picked.
function syncMainOptions() {
  $('#set-main').replaceChildren(...state.tree.filter((e) => e.type === 'file' && e.path.endsWith('.tex')).map((e) => h('option', { value: e.path, selected: e.path === state.project?.main }, e.path)));
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
      items.push(h('div', { class: 'tree-item dir', dataset: { path: entry.path, kind: 'dir' }, style: `padding-left:${10 + depth * 14}px`, onclick: () => { closed ? state.collapsed.delete(entry.path) : state.collapsed.add(entry.path); renderTree(); } },
        h('span', { class: 'twisty' }, closed ? '▸' : '▾'), h('span', { class: 'name' }, name)));
    } else {
      const count = review ? review.items.filter((it) => it.file === entry.path && it.status === 'open').length : 0;
      items.push(h('div', {
        class: `tree-item file ${entry.path === state.file ? 'active' : ''} ${entry.text ? '' : 'binary'} ${entry.path === state.project?.main ? 'main' : ''}`,
        style: `padding-left:${10 + depth * 14 + 12}px`,
        title: entry.path,
        dataset: { parent, path: entry.path, kind: 'file' },
        onclick: () => openFile(entry.path),
      }, h('span', { class: `ficon ${ext(name)}` }), h('span', { class: 'name' }, name), count ? h('span', { class: 'count' }, count) : null));
    }
  }
  root.replaceChildren(...files.decorateAll(items));
}

// ---------- file management (new / rename / delete / drag-and-drop; see files.js) ----------
const files = createFiles({
  tree: $('#tree'), newButton: $('#btn-new'), editorEl: $('#editor'), editor, collapsed: state.collapsed,
  getTree: () => state.tree, getCurrent: () => state.file, getMain: () => state.project?.main,
  reviewItemCount: (p) => review.items.filter((it) => it.status === 'open' && (it.file === p || it.file.startsWith(`${p}/`))).length,
  flush: () => saveFirst(),
  render: () => renderTree(),
  onCreated: (p) => openFile(p),
  onRenamed: (from, to) => {
    // Renaming the open file (or its folder) keeps it open under the new name; the editor is not reloaded.
    if (state.file === from || state.file?.startsWith(`${from}/`)) {
      state.file = to + state.file.slice(from.length);
      store.set(`margin:${state.project.root}:file`, state.file);
      $('#current-file').textContent = state.file;
    }
    renderTree();
  },
  onDeleted: (p) => {
    // Deleting the open file (or its folder): nothing of it may be saved again; fall back to the main document.
    if (state.file === p || state.file?.startsWith(`${p}/`)) {
      state.dirty = false; state.file = null; state.base = null; state.doc++; endConflict();
      openFile(state.project.main).catch((e) => toast(e.message, 'error'));
    }
    renderTree();
  },
});

function ext(name) { const m = name.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }

// Resolves to false if the open file's edits could not be saved first (the editor then stays on it).
function openFile(path, opts) { return serial(() => openNow(path, opts)); }
async function openNow(path, { line } = {}) {
  await flushNow();
  if (state.dirty && state.file) {
    toast(`${state.file} has edits that are not saved yet. Save them (or choose in the bar above the editor) before opening another file.`, 'error', 8000);
    return false;
  }
  const entry = state.tree.find((e) => e.path === path);
  state.doc++;
  state.base = null; // nothing is saved until the new file has loaded
  state.file = path;
  store.set(`margin:${state.project.root}:file`, path);
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
    return true;
  }
  $('#image-view').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  // Read-only while it loads: anything typed now would go into the previous file's text.
  editor.setReadOnly(true);
  let disk;
  try { disk = await api(fileUrl(path)); } finally { editor.setReadOnly(false); }
  editor.setDoc(disk.content);
  state.base = { content: disk.content, hash: disk.hash };
  state.dirty = false;
  setSaveState('Saved');
  hideBanner();
  applyReviewToEditor();
  applyDiagnostics();
  review.render();
  outline.update();
  if (line) editor.gotoLine(line);
  return true;
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
  // Accept and Undo rewrite the source: show the file as it is now before the cards re-anchor.
  onChanged: async () => { await syncFromDisk(); await refreshReview(); },
  saveIfDirty: () => saveFirst(),
  extra: (it, items) => ask.cardExtra(it, items),
});

const ask = initAsk({
  editor,
  getFile: () => state.file,
  saveIfDirty: () => save(),
  refreshReview: () => refreshReview(),
  focusItem: (it) => focusItem(it),
  showReview: () => { if ($('#review').classList.contains('collapsed')) $('#btn-review').click(); },
});

// Response to referees: a second view in the review rail (web/src/response.js).
const response = createResponsePanel($('#review'), {
  onJump: (link) => jumpToLink(link),
  onChanged: async () => { await syncFromDisk(); await refreshReview(); },
  saveIfDirty: () => saveFirst(),
});
// Private context for Claude: a third view in the review rail (web/src/context.js).
const context = createContextPanel($('#review'));

// The rail's views: Review (the cards), Response and Context. The last one shown is remembered.
const RAIL_VIEWS = ['review', 'response', 'context'];
function setRail(view) {
  if (!RAIL_VIEWS.includes(view)) view = 'review';
  const rail = $('#review');
  rail.classList.toggle('response-mode', view === 'response');
  rail.classList.toggle('context-mode', view === 'context');
  $('#response').classList.toggle('hidden', view !== 'response');
  $('#context').classList.toggle('hidden', view !== 'context');
  $$('[data-rail]', rail).forEach((b) => b.classList.toggle('on', b.dataset.rail === view));
  store.set('margin:rail', view);
  if (view === 'response') response.refresh();
  if (view === 'context') context.refresh();
}
$$('#review [data-rail]').forEach((b) => b.addEventListener('click', () => setRail(b.dataset.rail)));
setRail(store.get('margin:rail'));

// A file dropped where nothing takes it (the top bar, the PDF, a pane header) would make the browser
// show that file in place of Margin. The file tree, the editor and the Context view take drops and
// say so first (defaultPrevented); anywhere else a drop is simply not allowed.
window.addEventListener('dragover', (e) => { if (!e.defaultPrevented && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
window.addEventListener('drop', (e) => { if (!e.defaultPrevented && hasFiles(e)) e.preventDefault(); });

async function jumpToLink(link) {
  const it = review.items.find((x) => x.id === link.id);
  if (it && it.status === 'open' && it.from != null) return focusItem(it);
  if (link.file !== state.file) await openFile(link.file, { line: link.line });
  else if (link.line) editor.gotoLine(link.line);
}

async function refreshReview() {
  response.refresh(); // point statuses are derived from the review items
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
  if (it.file !== state.file && !(await openFile(it.file))) return;
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
  await save();
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
    // SyncTeX belongs to the normal build; the diff PDF has other page positions.
    if (changes.diffActive()) return toast('This is the diff PDF. Go back to the normal PDF to jump to the source.', 'info');
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
  if (changes.diffActive()) return; // a recompile must not swap the diff PDF out from under the reader
  const ok = await pdf.load('/pdf');
  $('#pdf-empty').classList.toggle('hidden', ok || pdf.loaded);
  $('#zoom-label').textContent = pdf.zoomLabel;
}

async function forwardSearch() {
  if (!state.file || !state.file.endsWith('.tex')) return;
  if (changes.diffActive() && !(await changes.back())) return; // forward search is for the normal PDF
  await save();
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
initPdfFind($('#pdf-find'), pdf, { reveal: () => { showLogs(false); search.close(); } });

// ---------- find in project ----------
const search = createSearch($('#search'), {
  saveIfDirty: () => save(),
  getSelection: () => { const s = selectionInfo(editor.view.state).selection; return s && s.fromLine === s.toLine ? s.text : ''; },
  onOpen: () => { showLogs(false); changes.close(); },
  onJump: async (file, line, column, length) => {
    if (file !== state.file && !(await openFile(file))) return;
    const doc = editor.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const from = Math.min(l.from + column - 1, l.to);
    editor.gotoRange(from, Math.min(from + length, l.to));
    editor.focus();
  },
  // The server wrote these files; show the new text in the editor and let the cards re-anchor.
  onReplaced: async (files) => {
    if (state.file && files.includes(state.file)) await syncFromDisk();
    await refreshReview();
  },
});
$('#btn-search').addEventListener('click', () => search.toggle());

// ---------- changes and the diff PDF (web/src/changes.js; server/changes.js, server/latexdiff.js) ----------
const changes = createChanges($('#changes'), {
  bar: $('#diff-bar'),
  downloadLink: $('#pdf-pane a[download]'),
  getMain: () => state.project?.main,
  saveIfDirty: () => save(),
  onOpen: () => { showLogs(false); search.close(); },
  onJump: async (file, line) => {
    if (file !== state.file) { if (!(await openFile(file, { line }))) return; } else editor.gotoLine(line);
    editor.focus();
  },
  showPdf: async (url) => {
    const ok = await pdf.load(url);
    if (url === '/pdf') $('#pdf-empty').classList.toggle('hidden', ok || pdf.loaded);
    return ok;
  },
});
$('#btn-changes').addEventListener('click', () => changes.toggle());

// ---------- compile ----------
async function compile() {
  await save();
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
  const row = (it, kind) => h('div', { class: `log-item ${kind}`, onclick: () => it.file && openFile(it.file, { line: it.line || 1 }).then((ok) => ok && it.line && editor.gotoLine(it.line)) },
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
  if (open) { search.close(); changes.close(); }
  $('#logs').classList.toggle('hidden', !open);
  $('#btn-logs').classList.toggle('active', open);
}

$('#btn-compile').addEventListener('click', compile);
$('#btn-logs').addEventListener('click', () => showLogs());
$('#logs .close').addEventListener('click', () => showLogs(false));
// The raw log is a plain link to a text page (#btn-rawlog in index.html): opening a window after an
// await is no longer a user gesture, and Safari blocks it as a popup.

// Compile settings popover
$('#btn-compile-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#compile-menu').classList.toggle('hidden'); });
document.addEventListener('click', (e) => { if (!e.target.closest('#compile-menu')) $('#compile-menu').classList.add('hidden'); });
$('#set-engine').addEventListener('change', (e) => updateSettings({ engine: e.target.value }));
$('#set-auto').addEventListener('change', (e) => updateSettings({ autoCompile: e.target.checked }));
$('#set-main').addEventListener('change', (e) => updateSettings({ main: e.target.value }));
// The Download link names the file after the main document (Safari and the Mac app would otherwise
// offer "pdf"). Left alone while the diff PDF is showing: changes.js names that one.
function setPdfDownloadName() {
  const a = $('#pdf-pane a[download]');
  if (a.getAttribute('href') === '/pdf') a.setAttribute('download', `${state.project.main.replace(/\.tex$/, '').split('/').pop()}.pdf`);
}
async function updateSettings(body) {
  try {
    const r = await api('/settings', { method: 'PUT', body });
    state.project.settings = r.settings;
    state.project.main = r.main;
    $('#main-file').textContent = r.main;
    setPdfDownloadName();
    renderTree();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- review panel toggle ----------
$('#btn-review').addEventListener('click', () => {
  const hidden = $('#review').classList.toggle('collapsed');
  $('#btn-review').classList.toggle('active', !hidden);
  store.set('margin:review-hidden', hidden ? '1' : '');
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
// No save is sent while it runs (serial); what is typed meanwhile is merged with the pulled file after.
async function pullFromOverleaf() {
  try {
    await save();
    const r = await serial(() => api('/git/pull', { method: 'POST' }));
    // A conflicted pull leaves both versions in the file with <<<<<<< markers. Keep a
    // banner up explaining that, and still refresh everything below, so the editor shows
    // what is actually on disk instead of text the file no longer contains.
    if (r.ok) { hideBanner(); toast('Pulled from Overleaf', 'ok'); }
    else if (r.conflict?.length) showBanner(r.hint, [[`Open ${r.conflict[0]}`, () => openFile(r.conflict[0])]]);
    else { toast(`Pull failed: ${r.out || 'unknown error'}`, 'error', 12000); return; }
    await loadTree();
    await Promise.all([refreshGit(), refreshReview()]);
    if (state.file && state.tree.some((e) => e.path === state.file)) await syncFromDisk();
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
  await save();
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
    const r = await serial(() => api('/git/sync', { method: 'POST', body: { message: msg } })); // no save lands mid-rebase
    if (r.ok) toast('Synced with Overleaf', 'ok');
    else if (r.conflict) toast(`${r.hint} (${r.conflict.join(', ')})`, 'error', 12000);
    else toast(`Sync failed: ${r.steps.filter((s) => !s.ok).map((s) => `${s.label}: ${s.out}`).join(' / ')}`, 'error', 12000);
  } catch (e) { toast(e.message, 'error'); }
  btn.classList.remove('busy');
  await Promise.all([loadTree(), refreshGit()]);
  if (state.file) await syncFromDisk();
});

// ---------- splitter ----------
(() => {
  const split = $('#splitter');
  const pdfPane = $('#pdf-pane');
  const saved = Number(store.get('margin:pdf-width'));
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
      store.set('margin:pdf-width', String(parseInt(pdfPane.style.flexBasis, 10)));
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
      case 'review-changed': changes.refreshSoon(); await refreshReview(); break;
      case 'responses-changed': response.refresh(); break;
      case 'context-changed': context.refresh(); break;
      case 'tree-changed': changes.refreshSoon(); await loadTree(); refreshGit(); break;
      case 'file-changed':
        refreshGit();
        changes.refreshSoon();
        if (msg.external) search.refreshSoon();
        if (msg.path === state.file && msg.external) {
          await syncFromDisk(); // merged with unsaved edits, or the banner asks
          applyReviewToEditor();
        }
        break;
      case 'git-changed': changes.refreshSoon(); onGitChanged(msg); break;
      case 'compile-start': onCompileStart(msg.by); break;
      case 'claude-activity': ask.onActivity(msg); break;
      case 'compile-done': await onCompileDone(msg); break;
      case 'goto':
        if (msg.file !== state.file && !(await openFile(msg.file))) break;
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
  // Started from the hub: a plain link back to it (another origin, so no requests to it from here).
  if (state.project.hub) { $('#hub-link').href = state.project.hub; $('#hub-link').classList.remove('hidden'); }
  $('#main-file').textContent = state.project.main;
  setPdfDownloadName();
  $('#set-engine').value = state.project.settings.engine;
  $('#set-auto').checked = !!state.project.settings.autoCompile;
  if (store.get('margin:review-hidden')) { $('#review').classList.add('collapsed'); $('#btn-review').classList.remove('active'); }
  await loadTree();
  await refreshReview();
  context.refresh(); // the count on the Context tab
  const remembered = store.get(`margin:${state.project.root}:file`);
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

// Leaving with unsaved edits: save now and ask the browser to confirm. (The Mac app does not rely on
// this: it calls window.marginBeforeClose, below, before it closes a paper window or quits.)
window.addEventListener('beforeunload', (e) => { if (state.dirty) { save(); e.preventDefault(); } });
// Hidden (another tab, minimised, the screen locked): save now rather than in 0.7 s, in case the page
// is never shown again. pagehide: last chance, and it may come without beforeunload.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
window.addEventListener('pagehide', () => saveOnExit());
// The Mac app calls this before it closes a paper window or quits: save now, then say what is still
// unsaved ('' when nothing is), so it can ask instead of closing over edits it cannot save.
window.marginBeforeClose = async () => {
  try { await save(); } catch { /* the editor reports it */ }
  if (!state.dirty || !state.file) return '';
  return state.conflict
    ? `Your edits to ${state.file} conflict with a change on disk and are not saved.`
    : `Your edits to ${state.file} could not be saved.`;
};
boot().catch((e) => toast(`Failed to start: ${e.message}`, 'error', 20000));
