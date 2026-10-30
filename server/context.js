// Private context: the author's own background for a paper (notes, discussions with co-authors,
// drafts, a PDF of a talk) that Claude may read but that never becomes part of the manuscript.
// The files live in .review/context/ under their own names, so the author can also drop them in
// with the Finder; .review/ is local-only (LOCAL_ONLY in init.js, IGNORED in project.js, and the
// .git/info/exclude entry the server writes at startup), so none of it reaches git or Overleaf.
//
// What Margin knows about a file beyond the file itself (a description, when and by whom it was
// added) is in .review/context.json, next to the folder rather than inside it, so the folder holds
// only the author's files. This class is the only writer of both. A file put in the folder by hand
// is listed without a description; an entry whose file is gone is not listed and is dropped at the
// next write.
//
// Project.abs() and Project.read() refuse .review/ on purpose (the review history and referee
// reports are private), and that stays so. This module has its own, narrower path handling: one
// flat folder, plain file names only (no separators, no "..", no hidden files), regular files only
// (symbolic links and subfolders are skipped, never followed), and new files are created with
// O_EXCL so nothing is ever replaced.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VersionedJsonFile } from './review.js';
import { REVIEW_DIR } from './project.js';

export const CONTEXT_FOLDER = `${REVIEW_DIR}/context`; // relative to the paper folder
export const CONTEXT_MAX_BYTES = 20 * 1024 * 1024; // same as uploads (UPLOAD_LIMIT in app.js)
const TYPES = { '.md': 'md', '.markdown': 'md', '.txt': 'txt', '.text': 'txt', '.pdf': 'pdf' };
export const CONTEXT_EXTENSIONS = Object.keys(TYPES);
const MAX_NAME = 160; // characters, extension included
const MAX_DESCRIPTION = 2000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// Schema versioning works as for review.json (see the top of review.js).
export const CONTEXT_VERSION = 1;
const MIGRATIONS = { 0: (d) => ({ ...d, version: 1 }) };

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function contextType(name) {
  return TYPES[path.extname(String(name)).toLowerCase()] || null;
}

const typesList = () => '.md, .txt or .pdf';

// A name that may refer to a file in the folder: a plain file name, nothing else.
export function checkName(name) {
  if (typeof name !== 'string' || !name) throw bad('A file name is required');
  if (/[\\/]/.test(name)) throw bad(`Not a plain file name (no folders or paths): ${name}`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw bad(`File names cannot contain control characters: ${JSON.stringify(name)}`);
  if (name === '.' || name === '..' || name.startsWith('.')) throw bad(`Hidden file names are not allowed: ${name}`);
  if (!contextType(name)) throw bad(`${name}: only ${typesList()} files can be added as context`);
  return name;
}

// The name a new file gets: the author's name, tidied (characters Finder or Windows dislike become
// "-", runs of spaces collapse), never a path.
export function cleanName(raw) {
  checkName(raw);
  const ext = path.extname(raw);
  let stem = raw.slice(0, raw.length - ext.length).normalize('NFC')
    .replace(/[:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!stem || stem.startsWith('.')) stem = stem.replace(/^\.+/, '') || 'context';
  stem = stem.slice(0, MAX_NAME - ext.length);
  return stem + ext.toLowerCase();
}

// A note's file name, from its title.
export function noteName(title) {
  const stem = String(title || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/^[. -]+|[. ]+$/g, '').slice(0, 80);
  return `${stem || 'Note'}.md`;
}

export class ContextStore extends EventEmitter {
  constructor(project) {
    super();
    this.project = project;
    this.dir = path.join(project.reviewDir, 'context');
    this.indexFile = new VersionedJsonFile(path.join(project.reviewDir, 'context.json'), {
      version: CONTEXT_VERSION, migrations: MIGRATIONS, what: 'context index',
      check: (raw) => (Array.isArray(raw.items) ? null : 'no items array'),
    });
    this.data = { version: CONTEXT_VERSION, items: [] };
    const r = this.indexFile.load();
    if (r) { this.data = r.data; if (r.migrated) this.indexFile.save(this.data); }
  }

  // .review and .review/context must be plain folders: never a link to somewhere else.
  // Returns the folder, or null when it does not exist yet and `create` is false.
  #folder(create = false) {
    for (const d of [this.project.reviewDir, this.dir]) {
      let st = lstat(d);
      if (!st) {
        if (!create) return null;
        try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        st = lstat(d);
      }
      if (!st || st.isSymbolicLink() || !st.isDirectory()) {
        throw bad(`${path.relative(this.project.root, d)} is not a plain folder (a link or a file is in its place), so Margin will not use it for context.`, 409);
      }
    }
    return this.dir;
  }

  // The entries of the folder that Margin lists, and the ones it skips (with the reason).
  #scan() {
    const dir = this.#folder(false);
    const files = [], skipped = [];
    if (!dir) return { files, skipped };
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue; // .DS_Store, editors' swap files
      if (e.isSymbolicLink()) { skipped.push({ name: e.name, reason: 'a link (not followed)' }); continue; }
      if (e.isDirectory()) { skipped.push({ name: e.name, reason: 'a folder (only files directly in the context folder are used)' }); continue; }
      if (!e.isFile()) continue;
      if (!contextType(e.name) || /[\u0000-\u001f\u007f]/.test(e.name)) { skipped.push({ name: e.name, reason: `not ${typesList()}` }); continue; }
      const st = lstat(path.join(dir, e.name));
      if (st?.isFile()) files.push({ name: e.name, st });
    }
    return { files, skipped };
  }

  #meta(name) {
    const n = name.normalize('NFC');
    return this.data.items.find((m) => m.name.normalize('NFC') === n) || null;
  }

  #describe({ name, st }) {
    const m = this.#meta(name);
    return {
      name,
      type: contextType(name),
      size: st.size,
      path: `${CONTEXT_FOLDER}/${name}`,
      description: m?.description || '',
      addedAt: m?.addedAt || new Date(st.mtimeMs).toISOString(),
      source: m?.source || null, // 'you' (added in Margin), 'claude', or null (put in the folder directly)
      modifiedAt: new Date(st.mtimeMs).toISOString(),
    };
  }

  list() {
    const { files, skipped } = this.#scan();
    const items = files.map((f) => this.#describe(f)).sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.name.localeCompare(b.name)));
    return { folder: CONTEXT_FOLDER, items, skipped };
  }

  count() { return this.#scan().files.length; }

  // The folder, created if need be (for "Show in Finder" on an empty list).
  ensureFolder() { return this.#folder(true); }

  // An existing item by name: a regular file directly in the folder, never a link.
  #existing(name) {
    checkName(name);
    const dir = this.#folder(false);
    const abs = dir && path.join(dir, name);
    const st = abs && lstat(abs);
    if (!st) throw bad(`No context file named ${name}`, 404);
    if (!st.isFile()) throw bad(`${name} is not a regular file (links and folders are not used)`);
    return { name, abs, st };
  }

  get(name) { return this.#describe(this.#existing(name)); }

  // Absolute path of an item, for Claude's own Read tool (PDFs) and the "show in Finder" button.
  absPath(name) { return this.#existing(name).abs; }

  // An open file descriptor (O_NOFOLLOW) and its size, for serving the file to the browser.
  open(name) {
    const { abs } = this.#existing(name);
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); throw bad(`${name} is not a regular file`); }
    return { fd, size: st.size, type: contextType(name) };
  }

  // The text of a .md or .txt item.
  readText(name) {
    const { abs, st } = this.#existing(name);
    if (contextType(name) === 'pdf') throw bad(`${name} is a PDF; its text is not extracted here.`);
    if (st.size > CONTEXT_MAX_BYTES) throw bad(`${name} is over ${CONTEXT_MAX_BYTES / 1024 / 1024} MB`);
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
    try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  }

  // Adds a file under its own name (tidied); a name already taken gets "-2", "-3", …
  add(rawName, buf, { source = 'you', description = '' } = {}) {
    const name = cleanName(rawName);
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad(`${rawName} is empty`);
    if (buf.length > CONTEXT_MAX_BYTES) throw bad(`${rawName} is over the ${CONTEXT_MAX_BYTES / 1024 / 1024} MB limit`, 413);
    const type = contextType(name);
    if (type === 'pdf' && !buf.subarray(0, 1024).includes('%PDF-')) throw bad(`${rawName} does not look like a PDF`);
    if (type !== 'pdf' && buf.subarray(0, 8192).includes(0)) throw bad(`${rawName} does not look like plain text. Save it as UTF-8 text, or as a PDF.`);
    return this.#create(name, buf, { source, description });
  }

  // A note typed or pasted by the author, or saved by Claude: a Markdown file with its title as heading.
  addNote({ title, body, description = '' } = {}, source = 'you') {
    if (typeof body !== 'string' || !body.trim()) throw bad('The note is empty');
    const t = typeof title === 'string' && title.trim() ? title.trim().replace(/\s+/g, ' ') : firstLine(body);
    const text = `# ${t}\n\n${body.replace(/\r\n?/g, '\n').trim()}\n`;
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > CONTEXT_MAX_BYTES) throw bad(`The note is over the ${CONTEXT_MAX_BYTES / 1024 / 1024} MB limit`, 413);
    return this.#create(noteName(t), buf, { source, description });
  }

  #create(name, buf, { source, description }) {
    const dir = this.#folder(true);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    // Case-insensitively, as on the Mac's disk: "Notes.md" and "notes.md" are the same file there.
    const taken = new Set(fs.readdirSync(dir).map((n) => n.normalize('NFC').toLowerCase()));
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
      if (taken.has(candidate.toLowerCase())) continue;
      const abs = path.join(dir, candidate);
      try { fs.writeFileSync(abs, buf, { flag: 'wx' }); } catch (e) {
        if (e.code === 'EEXIST') continue; // appeared meanwhile (or a link sits there): next number
        try { fs.unlinkSync(abs); } catch { /* nothing was written */ }
        throw e;
      }
      this.#prune();
      this.data.items = this.data.items.filter((m) => m.name.normalize('NFC').toLowerCase() !== candidate.toLowerCase());
      this.data.items.push({ name: candidate, description: cleanDescription(description), addedAt: new Date().toISOString(), source: source === 'claude' ? 'claude' : 'you' });
      this.#save();
      return this.get(candidate);
    }
    throw bad(`Too many files named like ${name}`, 409);
  }

  setDescription(name, description) {
    const f = this.#existing(name);
    if (typeof description !== 'string') throw bad('description must be text');
    let m = this.#meta(name);
    if (!m) { m = { name, description: '', addedAt: new Date(f.st.mtimeMs).toISOString(), source: null }; this.data.items.push(m); }
    m.description = cleanDescription(description);
    this.#prune();
    this.#save();
    return this.get(name);
  }

  // Deletes the file from disk (not to the Trash) and what Margin knew about it.
  remove(name) {
    const { abs } = this.#existing(name);
    fs.unlinkSync(abs);
    const n = name.normalize('NFC');
    this.data.items = this.data.items.filter((m) => m.name.normalize('NFC') !== n);
    this.#prune();
    this.#save();
    return { ok: true, name };
  }

  // Entries whose file is gone (deleted or renamed in the Finder).
  #prune() {
    const present = new Set(this.#scan().files.map((f) => f.name.normalize('NFC')));
    this.data.items = this.data.items.filter((m) => present.has(m.name.normalize('NFC')));
  }

  #save() {
    this.indexFile.save(this.data);
    this.emit('change');
  }
}

function lstat(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

function cleanDescription(s) {
  if (s == null) return '';
  if (typeof s !== 'string') throw bad('description must be text');
  return s.replace(/\r\n?/g, '\n').trim().slice(0, MAX_DESCRIPTION);
}

function firstLine(body) {
  const line = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, '')}…` : line || 'Note';
}

// REST routes for the Context view, on the app's /api router, plus the page that shows one item
// (a PDF inline, text as plain text) for the view's links, which open in a new tab or window.
export function mountContextRoutes(app, api, { context, handle, broadcast, reveal, inlineName }) {
  context.on('change', () => broadcast({ type: 'context-changed' }));
  api.get('/context', handle(async () => context.list()));
  api.post('/context/upload', handle(async (req) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return context.add(String(req.query.name || ''), buf, { source: 'you' });
  }));
  api.post('/context/note', handle(async (req) => context.addNote({ title: req.body?.title, body: req.body?.body, description: req.body?.description }, 'you')));
  api.put('/context/item', handle(async (req) => context.setDescription(String(req.query.name || ''), req.body?.description)));
  api.delete('/context/item', handle(async (req) => context.remove(String(req.query.name || ''))));
  api.post('/context/reveal', handle(async (req) => {
    const name = req.body?.name;
    if (name == null || name === '') {
      await reveal(context.ensureFolder(), true);
    } else {
      await reveal(context.absPath(String(name)), false);
    }
    return { ok: true };
  }));
  // Only from Margin's own page or a typed address: no other site can link a page here.
  app.get('/context/file', (req, res) => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).send('Cross-site request refused');
    let f;
    try { f = context.open(String(req.query.name || '')); } catch (e) { return res.status(e.status || 400).type('text/plain').send(e.message); }
    const name = String(req.query.name);
    res.set({
      'Content-Type': f.type === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
      'Content-Length': String(f.size),
      'Content-Disposition': inlineName(name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (f.type !== 'pdf') res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const stream = fs.createReadStream(null, { fd: f.fd, autoClose: true });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}
