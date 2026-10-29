// Built-in word counter for LaTeX sources (no texcount; deterministic and testable).
// This file has no imports, so the browser bundle can reuse countLatex() for the editor selection.
//
// What counts as a word
//   A run of letters/digits, optionally joined by internal hyphens, en dashes or
//   apostrophes ("well-known" and "don't" are one word). Numbers count as words;
//   "3.5" is two (a decimal point is not a joiner).
//
// What is excluded
//   - Comments: everything after an unescaped % on a line.
//   - The preamble (everything before \begin{document}) and everything after \end{document}.
//   - Math: $...$, $$...$$, \(...\), \[...\] and the equation, align, alignat, gather,
//     multline, flalign, eqnarray, displaymath and math environments (starred forms too).
//   - Contents of tabular, tabularx, tabulary, longtable, array, tikzpicture, verbatim,
//     lstlisting, minted and thebibliography; \verb.
//   - LaTeX commands themselves. The braced argument of a command is COUNTED when the
//     command is text-ish (\emph, \textbf, \section, ... and any command that is not on
//     the skip list: unknown commands are treated as formatting). It is SKIPPED for known
//     non-text commands: \label, \ref and friends, the \cite family, \includegraphics,
//     \usepackage, \url, \href/\textcolor (first argument only), \vspace, \newcommand, ...
//
// Reported separately (and NOT in `words`)
//   Captions (\caption, \captionof) and footnotes (\footnote, \footnotetext, \thanks) go to
//   `captions` / `footnotes`. `total` = words + captions + footnotes, so the headline can be
//   compared with a journal limit either way.
//
// Sections
//   Buckets: "Abstract" (the abstract environment), "(front matter)" (text before the first
//   \section/\chapter, only if non-empty), then one per \section / \chapter. Subsections
//   belong to their parent section. A section title counts as words of its section.
//
// \input and \include are followed from the main file (relative to the project root, .tex
// optional, include cycles and missing files ignored).

const MATH_ENVS = ['equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray', 'displaymath', 'math'];
const VERBATIM_ENVS = ['tabular', 'tabularx', 'tabulary', 'longtable', 'array', 'tikzpicture', 'verbatim', 'lstlisting', 'minted', 'thebibliography'];
const EXCLUDED_RE = new RegExp(String.raw`\\begin\{(${[...MATH_ENVS, ...VERBATIM_ENVS].join('|')})(\*?)\}[\s\S]*?\\end\{\1\2\}`, 'g');

const SKIP_ARGS = new Set(['label', 'ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref',
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite', 'autocite', 'footcite',
  'includegraphics', 'includepdf', 'usepackage', 'RequirePackage', 'documentclass', 'input', 'include', 'subfile', 'bibliography', 'bibliographystyle',
  'url', 'path', 'vspace', 'hspace', 'vskip', 'hskip', 'setlength', 'addtolength', 'setcounter', 'addtocounter', 'newcommand', 'renewcommand',
  'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'graphicspath', 'hypersetup', 'geometry', 'pagestyle',
  'thispagestyle', 'newtheorem', 'color', 'definecolor', 'numberwithin', 'bibitem', 'tag', 'phantom', 'hphantom', 'vphantom', 'rule']);
const SKIP_FIRST = new Set(['href', 'textcolor', 'colorbox', 'hyperlink', 'hypertarget']); // first argument is not text
const CAPTION = new Set(['caption', 'captionof']);
const FOOTNOTE = new Set(['footnote', 'footnotetext', 'thanks']);
const SECTIONING = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);
const WORD = /[\p{L}\p{N}]+(?:['’\-–][\p{L}\p{N}]+)*/gu;

export function stripComments(src) {
  return src.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '%') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function stripMath(s) {
  s = s.replace(/\\\$/g, '\u0003'); // protect escaped dollars
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  s = s.replace(/\$(?:(?!\n[ \t]*\n)[^$])*\$/g, ' ');
  s = s.replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ');
  return s.replace(/\u0003/g, ' ');
}

const clean = (text) => stripMath(text.replace(EXCLUDED_RE, ' '));

// Index just past the balanced {...} group starting at s[i] === '{'; -1 if unbalanced.
function groupEnd(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
// Skip spaces and at most one line break (not a paragraph break).
function skipWs(s, i) {
  while (i < s.length && /[ \t]/.test(s[i])) i++;
  if (s[i] === '\n') { let j = i + 1; while (j < s.length && /[ \t]/.test(s[j])) j++; if (s[j] !== '\n') i = j; }
  return i;
}
function skipOptional(s, i) {
  const j = skipWs(s, i);
  if (s[j] !== '[') return i;
  const k = s.indexOf(']', j);
  return k < 0 ? i : k + 1;
}
function skipAllArgs(s, i) {
  for (;;) {
    const j = skipOptional(s, i);
    if (j !== i) { i = j; continue; }
    const k = skipWs(s, i);
    if (s[k] === '{') { const e = groupEnd(s, k); if (e < 0) return i; i = e; continue; }
    return i;
  }
}

const countWords = (text) => (text.replace(/\\[%&$#_{}]/g, ' ').match(WORD) || []).length;

// Count one cleaned chunk (comments, math and excluded environments already removed) into acc.
function scan(s, acc) {
  let buf = '';
  const flush = () => { acc.words += countWords(buf); buf = ''; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{' || c === '}') { i++; continue; } // grouping is transparent
    if (c === '~') { buf += ' '; i++; continue; }
    if (c !== '\\') { buf += c; i++; continue; }
    const m = /^\\([A-Za-z]+)\*?/.exec(s.slice(i, i + 40));
    if (!m) {
      const am = /^\\['`^"~=.]\s*\{?([A-Za-z])\}?/.exec(s.slice(i, i + 12)); // accent: keep the letter
      if (am) { buf += am[1]; i += am[0].length; continue; }
      buf += ' '; i += 2; continue; // \\ \, \; \% \& etc.
    }
    const name = m[1];
    i += m[0].length;
    if (name === 'begin' || name === 'end') {
      buf += ' ';
      if (s[i] === '{') {
        const e = groupEnd(s, i);
        const env = e < 0 ? '' : s.slice(i + 1, e - 1);
        if (e > 0) i = e;
        if (name === 'begin') { i = skipOptional(s, i); if (env === 'minipage' || env === 'multicols') i = skipAllArgs(s, i); }
      }
      continue;
    }
    if (name === 'verb') { const e = s.indexOf(s[i], i + 1); i = e < 0 ? s.length : e + 1; buf += ' '; continue; }
    if (CAPTION.has(name) || FOOTNOTE.has(name)) {
      flush();
      if (name === 'captionof') { const j = skipWs(s, i); if (s[j] === '{') { const e = groupEnd(s, j); if (e > 0) i = e; } }
      i = skipOptional(s, i);
      const j = skipWs(s, i);
      if (s[j] === '{') {
        const e = groupEnd(s, j);
        if (e > 0) {
          const inner = { words: 0, captions: 0, footnotes: 0 };
          scan(s.slice(j + 1, e - 1), inner);
          acc[CAPTION.has(name) ? 'captions' : 'footnotes'] += inner.words + inner.captions + inner.footnotes;
          i = e;
        }
      }
      buf += ' ';
      continue;
    }
    if (SKIP_FIRST.has(name)) {
      buf += ' ';
      i = skipOptional(s, i);
      const j = skipWs(s, i);
      if (s[j] === '{') { const e = groupEnd(s, j); if (e > 0) i = e; }
      continue;
    }
    if (SKIP_ARGS.has(name) || /^(cite|parencite|textcite|autocite)[a-z]*$/.test(name)) { buf += ' '; i = skipAllArgs(s, i); continue; }
    if (SECTIONING.has(name)) { buf += ' '; i = skipOptional(s, i); continue; }
    buf += ' '; // other commands: drop the name, keep the argument text
  }
  flush();
}

// Expand \input/\include from `file`. `read(rel)` returns the text or throws. Each included
// file is wrapped in \u0001+path\u0001 ... \u0001-\u0001 so sections can report their file.
function expand(file, read, stack, seen, missing) {
  let text;
  try { text = read(file); } catch { missing.push(file); return ''; }
  seen.add(file);
  return stripComments(text).replace(/\\(?:input|include)\s*\{([^}]*)\}/g, (_, raw) => {
    const rel = raw.trim().replace(/^\.\//, '');
    if (!rel) return ' ';
    const cands = /\.tex$/i.test(rel) ? [rel] : [rel + '.tex', rel];
    const found = cands.find((c) => { try { read(c); return true; } catch { return false; } });
    if (!found) { missing.push(cands[0]); return ' '; }
    if (stack.includes(found)) return ' '; // include cycle
    return ` \u0001+${found}\u0001${expand(found, read, [...stack, found], seen, missing)}\u0001-\u0001 `;
  });
}

// Count LaTeX text as typed (used for the editor selection): no \input following, no preamble handling.
export function countLatex(src) {
  const acc = { words: 0, captions: 0, footnotes: 0 };
  scan(clean(stripComments(src)), acc);
  return { ...acc, total: acc.words + acc.captions + acc.footnotes };
}

// Count the paper starting at `main`; `read(rel)` reads a project-relative file (throws if missing).
export function countProject(main, read) {
  const missing = [];
  const seen = new Set();
  let text = expand(main, read, [main], seen, missing);
  const b = text.indexOf('\\begin{document}');
  if (b >= 0) text = text.slice(b + '\\begin{document}'.length);
  const e = text.indexOf('\\end{document}');
  if (e >= 0) text = text.slice(0, e);

  let abstract = null;
  text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/, (_, body) => { abstract = body; return ' '; });

  const buckets = [];
  const open = (title, file, body = '') => { const bk = { title, file, words: 0, captions: 0, footnotes: 0, text: body }; buckets.push(bk); return bk; };
  if (abstract !== null) open('Abstract', main, abstract);
  const fileStack = [main];
  let cur = open('(front matter)', main);

  const tokens = /\u0001\+([^\u0001]*)\u0001|\u0001-\u0001|\\(?:chapter|section)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
  let last = 0, m;
  while ((m = tokens.exec(text))) {
    cur.text += text.slice(last, m.index);
    last = tokens.lastIndex;
    if (m[1] !== undefined) fileStack.push(m[1]);
    else if (m[0] === '\u0001-\u0001') fileStack.pop();
    else {
      const end = groupEnd(text, tokens.lastIndex - 1);
      const title = end < 0 ? '' : text.slice(tokens.lastIndex, end - 1);
      const plain = title.replace(/\\[A-Za-z]+\*?/g, ' ').replace(/[{}]/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
      cur = open(plain || '(untitled)', fileStack[fileStack.length - 1], title + ' '); // the title counts as words
      if (end > 0) last = tokens.lastIndex = end;
    }
  }
  cur.text += text.slice(last);

  const sections = [];
  for (const bk of buckets) {
    scan(clean(bk.text), bk);
    delete bk.text;
    if (bk.title === '(front matter)' && !bk.words && !bk.captions && !bk.footnotes) continue;
    bk.total = bk.words + bk.captions + bk.footnotes;
    sections.push(bk);
  }
  const sum = (k) => sections.reduce((n, s) => n + s[k], 0);
  const words = sum('words'), captions = sum('captions'), footnotes = sum('footnotes');
  return { main, words, captions, footnotes, total: words + captions + footnotes, sections, files: [...seen], missing: [...new Set(missing)] };
}
