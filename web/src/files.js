// File management in the Files pane (roadmap 2.1): new file / new folder, rename, delete, reveal,
// and drag-and-drop: figures onto the editor, any files onto the tree.
//
// The rules live on the server (server/project.js: path safety, never replacing a file by accident,
// the main document stays); this module is the UI for them. It does not refresh the tree after a
// change: the server's file watcher broadcasts 'tree-changed' and main.js reloads the tree.
import { h, toast } from './util.js';

const MAX_UPLOAD = 20 * 1024 * 1024; // keep in step with UPLOAD_LIMIT in server/app.js
const FIGURE = /\.(png|jpe?g|pdf|eps|svg)$/i;
const FIGURES_DIR = 'figures';
const MAC = /Mac/i.test(navigator.platform || '');
const WIN = /Win/i.test(navigator.platform || '');

const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const baseOf = (p) => p.split('/').pop();
const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);
const q = (p) => `?path=${encodeURIComponent(p)}`;

// Like util.api, but the error carries the HTTP status and the body can be raw bytes.
async function request(method, url, { json, raw } = {}) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: json !== undefined ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'application/octet-stream' } : undefined,
    body: json !== undefined ? JSON.stringify(json) : raw,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

// A figure's file name is going into LaTeX: no spaces, accents, dots or other surprises in the stem.
function figureName(name) {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'figure';
  return { stem, ext: dot > 0 ? name.slice(dot).toLowerCase() : '' };
}

const skeleton = (path, label) => [
  '\\begin{figure}[htbp]',
  '  \\centering',
  `  \\includegraphics[width=0.8\\linewidth]{${path}}`,
  '  \\caption{}',
  `  \\label{${label}}`,
  '\\end{figure}',
].join('\n');

export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

// Files from a drop, read synchronously (the data is gone once the event returns). Folders are skipped.
export function takeFiles(e) {
  const out = [];
  let dirs = 0;
  const items = e.dataTransfer.items;
  if (items && items.length) {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      if (it.webkitGetAsEntry?.()?.isDirectory) { dirs++; continue; }
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  } else out.push(...e.dataTransfer.files);
  if (dirs) toast(`Folders cannot be dropped yet (${dirs} skipped). Drop the files inside them instead.`, 'info', 6000);
  return out;
}

// Modal confirmation. Resolves true only for the confirm button; Escape and Cancel resolve false.
export function confirmDialog({ title, lines = [], names = [], confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', 'aria-label': title },
      h('form', { method: 'dialog' },
        h('h3', {}, title),
        ...lines.map((l) => h('p', {}, l)),
        names.length ? h('ul', { class: 'names' }, names.map((n) => h('li', {}, n))) : null,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', value: 'cancel', autofocus: true }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'reject' : 'primary'}`, value: 'ok' }, confirmLabel))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function createFiles({ tree, newButton, editorEl, editor, collapsed, getTree, getCurrent, getMain, reviewItemCount, flush, render, onCreated, onRenamed, onDeleted }) {
  // The one inline text field that can be open in the tree: a new file, a new folder, or a rename.
  // { kind: 'file' | 'folder' | 'rename', parent (new) | path (rename), value, fresh, busy }
  let edit = null;

  // Nothing may be typed into the editor while a file is being renamed or deleted under it:
  // an autosave of the old name after the move would bring the old file back.
  const locked = async (fn) => {
    editor.setReadOnly(true);
    try { return await fn(); } finally { editor.setReadOnly(false); }
  };

  // ---------- menus ----------
  let menu = null;
  let menuRow = null;
  function closeMenu() { menu?.remove(); menu = null; menuRow?.classList.remove('menu-open'); menuRow = null; }

  function showMenu(x, y, items, row = null) {
    closeMenu();
    menuRow = row;
    row?.classList.add('menu-open');
    menu = h('div', { class: 'ctx-menu', role: 'menu' }, items.map((it) => (it === '-'
      ? h('div', { class: 'sep', role: 'separator' })
      : h('button', { class: `item${it.danger ? ' danger' : ''}`, role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, it.label))));
    menu.addEventListener('keydown', (e) => {
      const els = [...menu.querySelectorAll('.item')];
      const i = els.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    });
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
    menu.querySelector('.item')?.focus();
  }
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) { closeMenu(); e.stopPropagation(); } }, true);
  window.addEventListener('blur', closeMenu);
  tree.addEventListener('scroll', closeMenu);

  const newItems = (parent) => [
    { label: 'New file…', run: () => startNew('file', parent) },
    { label: 'New folder…', run: () => startNew('folder', parent) },
  ];

  function rowMenu(row, x, y) {
    const path = row.dataset.path;
    const isDir = row.dataset.kind === 'dir';
    const reveal = { label: `Reveal in ${MAC ? 'Finder' : WIN ? 'Explorer' : 'file manager'}`, run: () => reveal_(path) };
    showMenu(x, y, [
      ...(isDir ? [...newItems(path).map((it) => ({ ...it, label: it.label.replace('…', ' here…') })), '-'] : []),
      { label: 'Rename…', run: () => startRename(path) },
      reveal,
      '-',
      { label: 'Delete…', danger: true, run: () => remove(path, isDir) },
    ], row);
  }

  // A "⋯" on each row, for people who do not think of right-clicking. Rows are rebuilt on every render.
  function addRowButton(row) {
    row.append(h('button', {
      class: 'row-menu', title: 'Rename, delete, reveal', 'aria-label': `Actions for ${row.dataset.path}`, 'aria-haspopup': 'menu',
      onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); rowMenu(row, r.left, r.bottom + 2); },
    }, '⋯'));
  }

  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-item');
    if (row?.classList.contains('editing')) return;
    e.preventDefault();
    if (row) rowMenu(row, e.clientX, e.clientY); else showMenu(e.clientX, e.clientY, newItems(''));
  });
  newButton.addEventListener('click', () => { const r = newButton.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, newItems('')); });

  // ---------- inline editing in the tree ----------
  function startNew(kind, parent) {
    if (parent) collapsed.delete(parent);
    edit = { kind, parent, value: '', fresh: true };
    render();
  }
  function startRename(path) {
    edit = { kind: 'rename', path, value: baseOf(path), fresh: true };
    render();
  }
  function cancelEdit() { edit = null; render(); }

  function inputFor(placeholder, label) {
    const e = edit;
    const input = h('input', { type: 'text', class: 'tree-input', value: e.value, placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
    input.addEventListener('input', () => { e.value = input.value; });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // not the editor's or the page's shortcuts
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
    });
    // Rows are rebuilt when the tree reloads; that detaches the input, which is not a "click away".
    input.addEventListener('blur', () => setTimeout(() => { if (edit === e && !e.busy && input.isConnected) cancelEdit(); }, 0));
    for (const t of ['click', 'mousedown', 'dblclick', 'contextmenu']) input.addEventListener(t, (ev) => ev.stopPropagation());
    queueMicrotask(() => {
      input.focus();
      if (!e.fresh) { input.setSelectionRange(input.value.length, input.value.length); return; }
      e.fresh = false;
      // Rename: select the name without its extension, as file managers do.
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, e.kind === 'rename' && dot > 0 ? dot : input.value.length);
    });
    return input;
  }

  // Called by main.js's renderTree with the rows it built: adds the "⋯" buttons and, while a field is
  // open, puts it in place (so a tree reload in the middle of typing does not lose it).
  function decorateAll(items) {
    for (const el of items) addRowButton(el);
    if (!edit) return items;
    if (edit.kind === 'rename') {
      const row = items.find((el) => el.dataset.path === edit.path);
      if (!row) { edit = null; return items; }
      row.classList.add('editing');
      row.querySelector('.name').replaceWith(inputFor('', `New name for ${edit.path}`));
      return items;
    }
    const at = edit.parent ? items.findIndex((el) => el.dataset.kind === 'dir' && el.dataset.path === edit.parent) + 1 : 0;
    if (edit.parent && !at) { edit = null; return items; } // the folder is gone
    const depth = edit.parent ? edit.parent.split('/').length : 0;
    items.splice(at, 0, h('div', { class: 'tree-item editing', style: `padding-left:${10 + depth * 14 + 12}px` },
      h('span', { class: `ficon ${edit.kind === 'folder' ? 'folder' : 'tex'}` }),
      inputFor(edit.kind === 'folder' ? 'folder name' : 'name.tex, or folder/name.tex', edit.kind === 'folder' ? 'New folder name' : 'New file name')));
    return items;
  }

  async function commit() {
    const e = edit;
    if (!e || e.busy) return;
    const name = e.value.trim().replace(/\/+$/, '');
    if (!name) return cancelEdit();
    if (/^[\\/]/.test(name)) return toast('Type a name, relative to this folder, without a leading slash.', 'error', 5000);
    e.busy = true;
    try {
      if (e.kind === 'rename') {
        const to = join(parentOf(e.path), name);
        if (to === e.path) { e.busy = false; return cancelEdit(); }
        const r = await locked(async () => {
          await flush();
          return request('POST', '/file/rename', { json: { from: e.path, to } });
        });
        edit = null;
        for (const c of [...collapsed]) if (within(c, r.from)) { collapsed.delete(c); collapsed.add(r.to + c.slice(r.from.length)); }
        onRenamed(r.from, r.to);
        return;
      }
      const path = join(e.parent, name);
      if (getTree().some((t) => t.path === path)) throw new Error(`${path} already exists.`);
      if (e.kind === 'folder') {
        await request('POST', '/folder', { json: { path } });
        edit = null;
        render();
      } else {
        // exclusive: if Claude (or git) created the same file a moment ago, say so instead of emptying it.
        await request('PUT', `/file${q(path)}&exclusive=1`, { json: { content: '' } });
        edit = null;
        render();
        onCreated(path);
      }
    } catch (err) {
      e.busy = false;
      toast(err.message, 'error', 6000);
    }
  }

  // ---------- delete / reveal ----------
  async function remove(path, isDir) {
    const main = getMain();
    if (main && within(main, path)) {
      toast(`${path === main ? `${path} is the main document` : `${path} contains the main document (${main})`}. Change the main document first (Recompile ▾ → Main document), then delete it.`, 'error', 9000);
      return;
    }
    const inside = isDir ? getTree().filter((t) => t.type === 'file' && within(t.path, path)).map((t) => t.path) : [];
    const items = reviewItemCount(path);
    const lines = [isDir
      ? (inside.length ? `This deletes the folder and the ${inside.length} file${inside.length === 1 ? '' : 's'} in it from the paper folder.` : 'This deletes the empty folder from the paper folder.')
      : 'This deletes the file from the paper folder.',
    'Margin has no trash, so this cannot be undone from here.'];
    if (items) {
      lines.push(`${items} open review item${items === 1 ? '' : 's'} ${isDir ? 'on files in it' : 'on it'} will be kept, not deleted. ${items === 1 ? 'It stays' : 'They stay'} in the Review panel (under All) marked “file missing”, and attach again if a file with this name comes back.`);
    }
    const ok = await confirmDialog({
      title: `Delete ${isDir ? 'folder ' : ''}“${path}”?`,
      lines,
      names: inside.length > 8 ? [...inside.slice(0, 8), `…and ${inside.length - 8} more`] : inside,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await locked(async () => {
        await flush();
        await request('DELETE', `/file${q(path)}`);
      });
      onDeleted(path);
      toast(`Deleted ${path}`, 'ok');
    } catch (err) { toast(err.message, 'error', 8000); }
  }

  async function reveal_(path) {
    try { await request('POST', '/reveal', { json: { path } }); } catch (err) { toast(err.message, 'error', 8000); }
  }

  // ---------- drag and drop: onto the file tree (upload, nothing inserted) ----------
  function dropFolder(e) {
    const row = e.target.closest?.('.tree-item');
    if (!row?.dataset.path) return '';
    return row.dataset.kind === 'dir' ? row.dataset.path : parentOf(row.dataset.path);
  }
  function markTarget(folder) {
    for (const el of tree.querySelectorAll('.drop-over')) el.classList.remove('drop-over');
    tree.classList.toggle('drop-root', folder === '');
    if (folder) [...tree.querySelectorAll('.tree-item.dir')].find((el) => el.dataset.path === folder)?.classList.add('drop-over');
  }
  const allow = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  tree.addEventListener('dragenter', (e) => { if (hasFiles(e)) allow(e); });
  tree.addEventListener('dragover', (e) => { if (hasFiles(e)) { allow(e); markTarget(dropFolder(e)); } });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) markTarget(null); });
  tree.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const folder = dropFolder(e);
    markTarget(null);
    await uploadInto(folder, takeFiles(e));
  });

  async function uploadInto(folder, files) {
    let done = 0;
    for (const f of files) {
      const dest = join(folder, f.name);
      if (f.size > MAX_UPLOAD) { toast(`${f.name} is over 20 MB; not uploaded.`, 'error', 6000); continue; }
      const existing = getTree().find((t) => t.path === dest);
      if (existing?.type === 'dir') { toast(`${dest} is a folder; not uploaded.`, 'error', 6000); continue; }
      if (existing && !await confirmDialog({
        title: `Replace “${dest}”?`,
        lines: ['A file with this name is already there. Replacing it cannot be undone from Margin.'],
        confirmLabel: 'Replace',
      })) continue;
      try {
        await request('POST', `/upload${q(dest)}${existing ? '&overwrite=1' : ''}`, { raw: f });
        done++;
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error', 7000); }
    }
    if (done) toast(done === 1 ? `Uploaded to ${folder || 'the top level'}` : `Uploaded ${done} files to ${folder || 'the top level'}`, 'ok');
  }

  // ---------- drag and drop: onto the editor (upload to figures/, insert a figure block) ----------
  // Capture phase: CodeMirror's own drop handler would otherwise insert a dropped file's bytes as text.
  const dropEditor = (on) => editorEl.classList.toggle('drop-over', on);
  editorEl.addEventListener('dragenter', (e) => { if (hasFiles(e)) { allow(e); dropEditor(true); } }, true);
  editorEl.addEventListener('dragover', (e) => { if (hasFiles(e)) { allow(e); dropEditor(true); } }, true);
  editorEl.addEventListener('dragleave', (e) => { if (!editorEl.contains(e.relatedTarget)) dropEditor(false); }, true);
  editorEl.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropEditor(false);
    dropFigures(e, takeFiles(e));
  }, true);

  async function dropFigures(e, files) {
    const file = getCurrent();
    if (!file?.endsWith('.tex')) {
      toast('Open a .tex file to drop figures into it. To add files without inserting anything, drop them on the file tree.', 'info', 7000);
      return;
    }
    const figs = files.filter((f) => FIGURE.test(f.name));
    if (files.length > figs.length) toast(`${files.length - figs.length} file${files.length - figs.length === 1 ? '' : 's'} skipped: only png, jpg, pdf, eps and svg go into the text. Drop other files on the file tree.`, 'info', 7000);
    if (!figs.length) return;

    const view = editor.view;
    const docBefore = view.state.doc;
    // Where it was dropped, if the pointer was over the text; otherwise at the cursor. (A drop without
    // real coordinates reads as 0,0, which posAtCoords would happily map to the start of the document.)
    const box = view.dom.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    const dropped = inside ? view.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
    let pos = dropped ?? view.state.selection.main.head;

    const taken = new Set(getTree().map((t) => t.path.toLowerCase()));
    const added = [];
    for (const f of figs) {
      if (f.size > MAX_UPLOAD) { toast(`${f.name} is over 20 MB; not uploaded.`, 'error', 6000); continue; }
      try { added.push(await uploadFigure(f, taken)); } catch (err) { toast(`${f.name}: ${err.message}`, 'error', 7000); }
    }
    if (!added.length) return;
    if (getCurrent() !== file) { toast(`Uploaded to ${FIGURES_DIR}/ but not inserted: you switched files.`, 'info', 6000); return; }

    const doc = view.state.doc;
    const moved = doc !== docBefore; // typed meanwhile: the drop point is stale, use the cursor
    if (moved) pos = Math.min(view.state.selection.main.head, doc.length);
    const used = new Set([...doc.toString().matchAll(/\\label\{([^}]*)\}/g)].map((m) => m[1]));
    const blocks = added.map((a) => {
      const slug = a.stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let label = `fig:${slug}`;
      for (let n = 2; used.has(label); n++) label = `fig:${slug}-${n}`;
      used.add(label);
      return skeleton(a.path, label);
    });
    // A figure block gets its own lines, even when dropped in the middle of a paragraph.
    let line = doc.lineAt(pos);
    // A pointer drop in the middle of a source line would split a word or a sentence: go to the end of that line.
    if (dropped != null && !moved && doc.sliceString(line.from, pos).trim() && doc.sliceString(pos, line.to).trim()) { pos = line.to; line = doc.lineAt(pos); }
    const insert = (doc.sliceString(line.from, pos).trim() ? '\n\n' : '') + blocks.join('\n\n') + (doc.sliceString(pos, line.to).trim() ? '\n\n' : '\n');
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.indexOf('\\caption{') + '\\caption{'.length }, scrollIntoView: true });
    view.focus();
    const renamed = added.filter((a) => a.renamed);
    toast(renamed.length ? `Inserted ${added.length === 1 ? 'a figure' : `${added.length} figures`}. ${renamed.map((a) => `${a.original} was already in ${FIGURES_DIR}/, so it is ${a.path}`).join('; ')}.` : `Inserted ${added.length === 1 ? 'a figure' : `${added.length} figures`}; fill in the caption.`, 'ok', renamed.length ? 8000 : 4000);
  }

  // figures/<clean name>, never replacing a file that is there: foo.png, foo-2.png, foo-3.png, ...
  async function uploadFigure(f, taken) {
    const { stem, ext } = figureName(f.name);
    for (let n = 1; n < 100; n++) {
      const s = n === 1 ? stem : `${stem}-${n}`;
      const path = `${FIGURES_DIR}/${s}${ext}`;
      if (taken.has(path.toLowerCase())) continue;
      try {
        await request('POST', `/upload${q(path)}`, { raw: f });
        taken.add(path.toLowerCase());
        return { path, stem: s, renamed: n > 1, original: `${FIGURES_DIR}/${stem}${ext}` };
      } catch (err) {
        if (err.status === 409 && /Already exists/.test(err.message)) { taken.add(path.toLowerCase()); continue; } // the tree was stale
        throw err;
      }
    }
    throw new Error(`Too many files called ${stem}${ext} in ${FIGURES_DIR}/`);
  }

  return { decorateAll };
}
