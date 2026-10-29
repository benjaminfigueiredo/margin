// Project-wide find and replace. Search never writes. Replace only touches files (or
// individual matches) the caller names explicitly, so the UI has to show what it is about to
// do; there is no "replace everywhere" from a query alone. Writes go through Project.write.
const MAX_SHOWN = 2000;        // matches returned in detail
const MAX_FILE_BYTES = 5e6;    // bigger "text" files (data dumps) are skipped
const LINE_CAP = 300;          // characters of context returned per match

// Throws Error(message) for an empty query or an invalid regex; the API turns that into a 400.
export function buildRegex({ q, regex = false, caseSensitive = false, whole = false }) {
  if (typeof q !== 'string' || q === '') throw new Error('Search text is required');
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (whole) src = `(?<!\\w)(?:${src})(?!\\w)`;
  try { return new RegExp(src, caseSensitive ? 'gm' : 'gim'); } catch (e) { throw new Error(`Invalid regular expression: ${e.message}`); }
}

// Every non-empty match in text, in order. Empty matches (e.g. /a*/) are skipped: replacing
// them would insert text between every character.
function scan(text, re, onMatch) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (onMatch(m) === false) break;
  }
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function lineAt(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

function readText(project, rel) {
  try { return project.read(rel); } catch { return null; }
}

// Text files in the project, minus data dumps too big to scan on every keystroke.
function searchable(project) {
  return project.tree().filter((f) => f.type === 'file' && f.text && f.size <= MAX_FILE_BYTES).map((f) => f.path);
}

export function search(project, query) {
  const re = buildRegex(query);
  const files = [];
  let total = 0, shown = 0;
  for (const rel of searchable(project)) {
    const text = readText(project, rel);
    if (text == null) continue;
    let starts = null;
    const matches = [];
    let count = 0;
    scan(text, re, (m) => {
      count++; total++;
      if (shown >= MAX_SHOWN) return true; // keep counting so confirmations are exact
      starts ??= lineIndex(text);
      const ln = lineAt(starts, m.index);
      const end = text.indexOf('\n', starts[ln]);
      let lineText = text.slice(starts[ln], end < 0 ? text.length : end).replace(/\r$/, '');
      let column = m.index - starts[ln] + 1;
      // Keep the match visible when the line is very long.
      let shift = 0;
      if (lineText.length > LINE_CAP) {
        shift = Math.max(0, Math.min(column - 1 - 40, lineText.length - LINE_CAP));
        lineText = lineText.slice(shift, shift + LINE_CAP);
      }
      matches.push({ from: m.index, to: m.index + m[0].length, line: ln + 1, column, length: m[0].length, text: lineText, textOffset: shift, match: m[0].slice(0, 200) });
      shown++;
      return true;
    });
    if (count) files.push({ path: rel, count, matches });
  }
  return { query: { q: query.q, regex: !!query.regex, case: !!query.caseSensitive, whole: !!query.whole }, files, total, shown, truncated: total > shown, limit: MAX_SHOWN };
}

// Expand $1, $&, $<name>, $$ in a regex-mode replacement, as String.prototype.replace does.
function expand(replacement, m) {
  return replacement.replace(/\$(\$|&|<[^>]*>|\d{1,2})/g, (all, g) => {
    if (g === '$') return '$';
    if (g === '&') return m[0];
    if (g[0] === '<') return m.groups?.[g.slice(1, -1)] ?? '';
    const n = Number(g);
    if (n >= 1 && n < m.length) return m[n] ?? '';
    return all;
  });
}

// Plan (and optionally apply) a replacement.
//   files:   rel paths; every match in each is replaced
//   matches: [{ file, from, to }] from a previous search; only those spans, and only if the
//            text there still matches (the file may have changed since the search)
// Returns per-file counts and how many open review items quote text inside the spans.
// dryRun reports without writing anything.
export function replace(project, review, body) {
  const { replacement, files, matches, dryRun = false } = body;
  if (typeof replacement !== 'string') throw new Error('replacement is required (use an empty string to delete)');
  const re = buildRegex({ q: body.q, regex: body.regex, caseSensitive: body.case, whole: body.whole });
  const fileList = Array.isArray(files) ? files : [];
  const matchList = Array.isArray(matches) ? matches : [];
  if (!fileList.length && !matchList.length) throw new Error('Name the files or matches to change; Margin does not replace from a query alone');

  const wanted = new Map(); // file -> null (all matches) | Set of "from:to"
  for (const f of fileList) { if (typeof f !== 'string') throw new Error('files must be paths'); wanted.set(f, null); }
  for (const mt of matchList) {
    if (!mt || typeof mt.file !== 'string' || !Number.isInteger(mt.from) || !Number.isInteger(mt.to)) throw new Error('each match needs file, from and to');
    if (wanted.get(mt.file) === null) continue; // whole file already requested
    if (!wanted.has(mt.file)) wanted.set(mt.file, new Set());
    wanted.get(mt.file).add(`${mt.from}:${mt.to}`);
  }

  const known = new Set(searchable(project));
  const plans = [];
  for (const [rel, only] of wanted) {
    project.abs(rel); // throws on traversal; the only way a client path reaches the disk
    if (!known.has(rel)) throw new Error(`Not a searchable text file: ${rel}`);
    const text = project.read(rel);
    const spans = [];
    scan(text, re, (m) => {
      if (only && !only.has(`${m.index}:${m.index + m[0].length}`)) return true;
      spans.push({ from: m.index, to: m.index + m[0].length, with: body.regex ? expand(replacement, m) : replacement });
      return true;
    });
    if (spans.length) plans.push({ rel, text, spans });
  }

  // Open review items whose quoted text overlaps a span that is about to change.
  const affected = [];
  for (const p of plans) {
    for (const it of review.list({ file: p.rel, status: 'open' })) {
      if (it.from == null) continue; // already orphaned: nothing left to lose
      if (p.spans.some((s) => s.from < it.to && it.from < s.to)) affected.push({ id: it.id, file: it.file, kind: it.kind, line: it.line, quote: it.quote.slice(0, 120) });
    }
  }

  const result = {
    dryRun,
    files: plans.map((p) => ({ path: p.rel, replaced: p.spans.length })),
    replaced: plans.reduce((n, p) => n + p.spans.length, 0),
    reviewAffected: affected.length,
    reviewItems: affected,
  };
  if (dryRun) return result;
  for (const p of plans) {
    let out = '', at = 0;
    for (const s of p.spans) { out += p.text.slice(at, s.from) + s.with; at = s.to; }
    out += p.text.slice(at);
    if (out !== p.text) project.write(p.rel, out);
  }
  return result;
}
