// Review layer: suggestions (proposed replacements) and comments, anchored to
// quoted text rather than line numbers so they survive edits around them.
// Stored in .review/review.json inside the repo, which `margin init` keeps out of
// git so it never reaches Overleaf. The server is the only writer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ResponseStore } from './responses.js';

const CONTEXT = 48;

// Schema versioning. review.json is a paper's whole review history and is not in
// git, so it must never be silently dropped or overwritten.
//
// To change the schema: bump CURRENT_VERSION and add MIGRATIONS[<old version>] = a
// function taking the parsed data at <old version> and returning it at <old
// version + 1>. load() runs them in order, so every old file reaches the current
// shape. Never edit an existing migration. A file newer than CURRENT_VERSION is
// refused (see load()), never rewritten.
export const CURRENT_VERSION = 1;
const MIGRATIONS = {
  // 0 -> 1: files written before versioning existed (no or 0 `version`) hold the same items.
  0: (d) => ({ ...d, version: 1 }),
};
const BACKUPS_KEPT = 3;

// A JSON file under .review/ with a `version` field, migrations, rotating backups and
// quarantine of unreadable files. review.json (below) and responses.json (responses.js)
// both use it, so the two get exactly the same protections. Owned by ReviewStore, which
// stays the only writer of .review/.
export class VersionedJsonFile {
  // what: the name used in messages ("review", "response"); check(raw) returns why the
  // parsed data is unusable, or null if it is fine.
  constructor(file, { version, migrations, check, what }) {
    Object.assign(this, { file, version, migrations, check, what });
  }

  // Returns { data, migrated } or null when there is nothing to load (first run, or the
  // file was unreadable and has been moved aside). Throws (with a message naming the
  // file) if the file is from a newer Margin; startServer propagates that and
  // bin/margin.js prints it and exits 1.
  load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null; // first run
      throw new Error(`Cannot read ${this.file}: ${e.message}`);
    }
    let raw;
    try {
      raw = JSON.parse(text);
      const problem = !raw || typeof raw !== 'object' ? 'not an object' : this.check(raw);
      if (problem) throw new Error(problem);
    } catch (e) {
      const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(this.file, aside);
      console.warn(`margin: ${this.file} could not be read (${e.message}). Moved it to ${aside}; starting with an empty ${this.what}. Recover by hand from that file or from ${path.basename(this.file)}.bak*.`);
      return null;
    }
    let v = Number.isInteger(raw.version) ? raw.version : 0;
    if (v > this.version) {
      throw new Error(`${this.file} was written by a newer version of Margin (${this.what} format ${v}; this build understands up to ${this.version}). Update Margin to open this paper. The file has not been modified.`);
    }
    const migrated = v < this.version;
    while (v < this.version) {
      const m = this.migrations[v];
      if (!m) throw new Error(`${this.file}: no migration from ${this.what} format ${v}. The file has not been modified.`);
      raw = m(raw);
      v = raw.version;
    }
    return { data: raw, migrated }; // the caller saves a migrated file; save() keeps the old one as a backup
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    this.rotateBackups();
    fs.renameSync(tmp, this.file); // atomic; the file is never missing or partial
  }

  // Keep the last BACKUPS_KEPT versions: <file>.bak (newest), .bak2, .bak3.
  // Copies, not renames, so the file stays in place until the atomic rename.
  rotateBackups() {
    if (!fs.existsSync(this.file)) return;
    for (let i = BACKUPS_KEPT; i >= 2; i--) {
      const from = this.file + (i === 2 ? '.bak' : `.bak${i - 1}`);
      if (fs.existsSync(from)) fs.copyFileSync(from, this.file + `.bak${i}`);
    }
    fs.copyFileSync(this.file, this.file + '.bak');
  }
}

export class ReviewStore extends EventEmitter {
  constructor(project) {
    super();
    this.project = project;
    this.file = path.join(project.reviewDir, 'review.json');
    this.store = new VersionedJsonFile(this.file, {
      version: CURRENT_VERSION, migrations: MIGRATIONS, what: 'review',
      check: (raw) => (Array.isArray(raw.items) ? null : 'no items array'),
    });
    this.data = { version: CURRENT_VERSION, items: [] };
    this.load();
    // The response to referees (.review/responses.json): a separate file, same writer.
    this.responses = new ResponseStore(this);
  }

  load() {
    const r = this.store.load();
    if (!r) return;
    this.data = r.data;
    if (r.migrated) this.save();
  }

  save() {
    this.store.save(this.data);
    this.emit('change');
  }

  get(id) {
    const item = this.data.items.find((it) => it.id === id || it.id.startsWith(id));
    if (!item) throw new Error(`No review item with id ${id}`);
    return item;
  }

  // ---------- files ----------

  // Items on `rel`, or on any file inside it when it is a folder.
  itemsUnder(rel) {
    return this.data.items.filter((it) => it.file === rel || it.file.startsWith(rel + '/'));
  }

  // A file or folder was renamed in Margin: its comments and suggestions follow it.
  moveFile(from, to) {
    const moved = this.itemsUnder(from);
    for (const it of moved) it.file = to + it.file.slice(from.length);
    if (moved.length) this.save();
    return moved.length;
  }

  // ---------- queries ----------

  list({ file, status, kind, author } = {}) {
    const texts = new Map();
    const textOf = (f) => {
      if (!texts.has(f)) { try { texts.set(f, this.project.read(f)); } catch { texts.set(f, null); } }
      return texts.get(f);
    };
    return this.data.items
      .filter((it) => (!file || it.file === file) && (!status || status === 'all' || it.status === status) && (!kind || it.kind === kind) && (!author || it.author === author))
      .map((it) => this.withLocation(it, textOf(it.file)))
      .sort((a, b) => (a.file === b.file ? (a.from ?? Infinity) - (b.from ?? Infinity) : a.file.localeCompare(b.file)));
  }

  withLocation(item, text) {
    const loc = text == null || item.status === 'accepted' ? null : locate(item, text);
    // text == null: the file itself is gone (deleted or renamed outside Margin). Its items are kept, not dropped.
    if (!loc) return { ...item, orphaned: item.status !== 'accepted', fileMissing: text == null, from: null, to: null, line: null };
    return { ...item, orphaned: false, from: loc.from, to: loc.to, line: lineOf(text, loc.from), endLine: lineOf(text, loc.to) };
  }

  // ---------- creation ----------

  addSuggestion({ file, original, replacement, rationale = '', author = 'claude', line, contextBefore }) {
    if (original === replacement) throw new Error('replacement is identical to original');
    if (typeof replacement !== 'string') throw new Error('replacement is required (use an empty string to propose a deletion)');
    const { text, match } = this.findUnique(file, original, { line, contextBefore });
    const overlapping = this.list({ file, status: 'open', kind: 'suggestion' })
      .find((s) => s.from != null && s.from < match.to && match.from < s.to);
    if (overlapping) {
      throw new Error(`This text overlaps open suggestion ${overlapping.id.slice(0, 8)} (line ${overlapping.line}). Reply to or withdraw that one first, or make one combined suggestion.`);
    }
    return this.insert({ kind: 'suggestion', file, text, match, replacement, body: rationale, author });
  }

  addComment({ file, quote, comment, author = 'claude', line, contextBefore }) {
    if (!comment || !comment.trim()) throw new Error('comment text is required');
    const { text, match } = this.findUnique(file, quote, { line, contextBefore });
    return this.insert({ kind: 'comment', file, text, match, body: comment, author });
  }

  insert({ kind, file, text, match, replacement, body, author }) {
    const item = {
      id: crypto.randomUUID(),
      kind,
      file,
      quote: text.slice(match.from, match.to),
      contextBefore: text.slice(Math.max(0, match.from - CONTEXT), match.from),
      contextAfter: text.slice(match.to, match.to + CONTEXT),
      hintOffset: match.from,
      ...(kind === 'suggestion' ? { replacement } : {}),
      body,
      author,
      status: 'open',
      createdAt: new Date().toISOString(),
      replies: [],
    };
    this.data.items.push(item);
    this.save();
    return this.withLocation(item, text);
  }

  findUnique(file, quote, { line, contextBefore } = {}) {
    if (!quote || !quote.trim()) throw new Error('The quoted text is empty');
    let text;
    try { text = this.project.read(file); } catch { throw new Error(`Cannot read ${file}`); }
    let matches = findAll(text, quote);
    if (matches.length === 0) {
      throw new Error(`Text not found in ${file}. Quote it exactly as it appears in the source (LaTeX commands included); whitespace and line breaks may differ.`);
    }
    if (matches.length > 1 && contextBefore) {
      const narrowed = matches.filter((m) => normWs(text.slice(Math.max(0, m.from - contextBefore.length - 40), m.from)).endsWith(normWs(contextBefore)));
      if (narrowed.length > 0) matches = narrowed;
    }
    if (matches.length > 1 && line) {
      matches.sort((a, b) => Math.abs(lineOf(text, a.from) - line) - Math.abs(lineOf(text, b.from) - line));
      matches = [matches[0]];
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => lineOf(text, m.from)).join(', ');
      throw new Error(`The quoted text appears ${matches.length} times in ${file} (lines ${lines}). Quote a longer passage, or pass "line" to pick one.`);
    }
    return { text, match: matches[0] };
  }

  // ---------- actions ----------

  accept(id, { replacement, by = 'you' } = {}) {
    const item = this.get(id);
    if (item.kind !== 'suggestion') throw new Error('Only suggestions can be accepted');
    if (item.status !== 'open') throw new Error(`Suggestion is already ${item.status}`);
    const text = this.project.read(item.file);
    const loc = locate(item, text);
    if (!loc) throw new Error('The original text is no longer in the file (it was edited since). Reject this suggestion or ask for a new one.');
    const finalText = typeof replacement === 'string' ? replacement : item.replacement;
    const updated = text.slice(0, loc.from) + finalText + text.slice(loc.to);
    this.project.write(item.file, updated);
    item.status = 'accepted';
    item.appliedReplacement = finalText;
    item.decidedBy = by;
    item.decidedAt = new Date().toISOString();
    item.hintOffset = loc.from;
    this.save();
    return item;
  }

  // Undo an accepted suggestion: put the original text back where the applied
  // replacement now sits. Only when the applied text is still in the file as accepted.
  unaccept(id) {
    const item = this.get(id);
    if (item.kind !== 'suggestion' || item.status !== 'accepted') throw new Error('Only accepted suggestions can be undone');
    const text = this.project.read(item.file);
    const span = locateApplied(item, text);
    if (!span) throw new Error('The accepted text has been edited since; undo would not restore the original. Edit the text by hand.');
    this.project.write(item.file, text.slice(0, span.from) + item.quote + text.slice(span.to));
    item.status = 'open';
    delete item.appliedReplacement; delete item.decidedBy; delete item.decidedAt;
    item.hintOffset = span.from;
    this.save();
    return this.withLocation(item, this.project.read(item.file));
  }

  reject(id, { by = 'you', reason } = {}) {
    const item = this.get(id);
    if (item.status !== 'open') throw new Error(`Item is already ${item.status}`);
    item.status = item.kind === 'suggestion' ? 'rejected' : 'resolved';
    item.decidedBy = by;
    item.decidedAt = new Date().toISOString();
    if (reason) item.replies.push({ author: by, body: reason, createdAt: item.decidedAt });
    this.save();
    return item;
  }

  resolve(id, { by = 'you' } = {}) {
    const item = this.get(id);
    item.status = 'resolved';
    item.decidedBy = by;
    item.decidedAt = new Date().toISOString();
    this.save();
    return item;
  }

  reopen(id) {
    const item = this.get(id);
    if (item.status === 'accepted') throw new Error('An accepted suggestion is already in the text; edit the text instead');
    item.status = 'open';
    delete item.decidedBy; delete item.decidedAt;
    this.save();
    return item;
  }

  reply(id, { body, author = 'you' }) {
    if (!body || !body.trim()) throw new Error('reply text is required');
    const item = this.get(id);
    item.replies.push({ author, body, createdAt: new Date().toISOString() });
    this.save();
    return item;
  }

  updateReplacement(id, replacement) {
    const item = this.get(id);
    if (item.kind !== 'suggestion' || item.status !== 'open') throw new Error('Only open suggestions can be revised');
    item.replacement = replacement;
    item.revisedAt = new Date().toISOString();
    this.save();
    return item;
  }

  remove(id) {
    const item = this.get(id);
    this.data.items = this.data.items.filter((it) => it !== item);
    this.save();
    return item;
  }

  // Removes accepted/rejected items. They are appended to .review/archive.json first,
  // so this is recoverable by hand.
  clearClosed() {
    const removed = this.data.items.filter((it) => it.status !== 'open');
    if (!removed.length) return 0;
    const archive = path.join(path.dirname(this.file), 'archive.json');
    let old = [];
    try { old = JSON.parse(fs.readFileSync(archive, 'utf8')).items || []; } catch { /* none yet */ }
    const stamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive + '.tmp', JSON.stringify({ items: [...old, ...removed.map((it) => ({ ...it, archivedAt: stamp }))] }, null, 2));
    fs.renameSync(archive + '.tmp', archive);
    this.data.items = this.data.items.filter((it) => it.status === 'open');
    this.save();
    return removed.length;
  }
}

// ---------- anchoring helpers ----------

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normWs(s) { return s.replace(/\s+/g, ' ').trim(); }

// Find every occurrence of quote, treating any run of whitespace as equivalent
// (so a quote typed on one line still matches a paragraph wrapped across lines).
export function findAll(text, quote) {
  const parts = quote.trim().split(/\s+/).map(escapeRe);
  const re = new RegExp(parts.join('\\s+'), 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export function locate(item, text) {
  const matches = findAll(text, item.quote);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const before = normWs(item.contextBefore || '');
  const after = normWs(item.contextAfter || '');
  let best = null;
  for (const m of matches) {
    const b = normWs(text.slice(Math.max(0, m.from - CONTEXT * 2), m.from));
    const a = normWs(text.slice(m.to, m.to + CONTEXT * 2));
    const score = commonSuffix(b, before) + commonPrefix(a, after);
    const dist = Math.abs(m.from - (item.hintOffset ?? 0));
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { ...m, score, dist };
  }
  return { from: best.from, to: best.to };
}

// Where an accepted suggestion's replacement now sits, or null if it was edited away.
// Non-empty replacements reuse findAll/locate with the item's original context and the
// offset recorded at accept time. A deletion leaves nothing to match, so the gap is found
// between the surrounding context instead (shrinking the window if that context was edited).
export function locateApplied(item, text) {
  const applied = item.appliedReplacement ?? '';
  const core = applied.trim();
  if (core) {
    const m = locate({ quote: core, contextBefore: item.contextBefore, contextAfter: item.contextAfter, hintOffset: item.hintOffset }, text);
    if (!m) return null;
    const lead = applied.slice(0, applied.length - applied.trimStart().length);
    const trail = applied.slice(applied.trimEnd().length);
    let { from, to } = m;
    if (lead && text.slice(from - lead.length, from) === lead) from -= lead.length;
    if (trail && text.slice(to, to + trail.length) === trail) to += trail.length;
    return { from, to };
  }
  const hint = item.hintOffset ?? 0;
  if (applied) { // whitespace-only replacement: exact match nearest the recorded offset
    const hits = []; for (let i = text.indexOf(applied); i >= 0; i = text.indexOf(applied, i + 1)) hits.push(i);
    if (!hits.length) return null;
    const i = hits.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint))[0];
    return { from: i, to: i + applied.length };
  }
  const before = item.contextBefore || '';
  const after = item.contextAfter || '';
  for (const n of [CONTEXT, 24, 12]) {
    const b = before.slice(-n), a = after.slice(0, n);
    if (!b && !a) break;
    const needle = b + a;
    const hits = []; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) hits.push(i + b.length);
    if (!hits.length) continue;
    hits.sort((x, y) => Math.abs(x - hint) - Math.abs(y - hint));
    if (hits.length > 1 && n < CONTEXT && Math.abs(hits[0] - hint) === Math.abs(hits[1] - hint)) return null;
    return { from: hits[0], to: hits[0] };
  }
  return null;
}

function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
