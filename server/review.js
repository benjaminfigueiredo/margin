// Review layer: suggestions (proposed replacements) and comments, anchored to
// quoted text rather than line numbers so they survive edits around them.
// Stored in .review/review.json inside the repo, which `margin init` keeps out of
// git so it never reaches Overleaf. The server is the only writer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const CONTEXT = 48;

export class ReviewStore extends EventEmitter {
  constructor(project) {
    super();
    this.project = project;
    this.file = path.join(project.reviewDir, 'review.json');
    this.data = { version: 1, items: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.items)) this.data = raw;
    } catch { /* first run */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  get(id) {
    const item = this.data.items.find((it) => it.id === id || it.id.startsWith(id));
    if (!item) throw new Error(`No review item with id ${id}`);
    return item;
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
    if (!loc) return { ...item, orphaned: item.status !== 'accepted', from: null, to: null, line: null };
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

  clearClosed() {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((it) => it.status === 'open');
    this.save();
    return before - this.data.items.length;
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

function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
