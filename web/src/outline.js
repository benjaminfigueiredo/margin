// Outline panel: sections, figures and tables of the open .tex file, parsed from the editor text.
import { h } from './util.js';

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

// Blank out comments (a % not preceded by a backslash runs to end of line), keeping offsets and newlines.
function maskComments(text) {
  return text.replace(/(^|[^\\])%[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

// Text of the braced group whose "{" is at or after `i` (only whitespace may precede it); null if none.
function braced(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

// Reduce a title to plain text: drop math delimiters, commands (keeping their arguments) and braces.
function plain(t) {
  return t.replace(/\\(?:label|ref|cite\w*)\{[^}]*\}/g, '').replace(/\$/g, '').replace(/\\[a-zA-Z]+\*?/g, '').replace(/\\(.)/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export function parseOutline(text) {
  const s = maskComments(text);
  const lineStarts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const out = [];
  const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)(?![a-zA-Z])|\\begin\{(figure|table)(\*?)\}/g;
  let m;
  while ((m = re.exec(s))) {
    const line = lineOf(m.index);
    if (m[1]) {
      let i = m.index + m[0].length;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '[') { const close = s.indexOf(']', i); if (close < 0) continue; i = close + 1; }
      const arg = braced(s, i);
      if (!arg) continue;
      out.push({ kind: 'section', level: LEVELS[m[1]], line, label: plain(arg.text) || `(untitled ${m[1]})`, starred: !!m[2] });
    } else {
      const env = m[3];
      const endTag = `\\end{${env}${m[4]}}`;
      let end = s.indexOf(endTag, m.index);
      if (end < 0) end = s.length;
      const body = s.slice(m.index, end);
      let label = '';
      const cap = /\\caption(?![a-zA-Z])\s*(?:\[[^\]]*\])?/.exec(body);
      if (cap) { const arg = braced(body, cap.index + cap[0].length); if (arg) label = plain(arg.text); }
      if (!label) { const lab = /\\label\{([^}]*)\}/.exec(body); if (lab) label = lab[1].trim(); }
      if (label.length > 60) label = label.slice(0, 59) + '…';
      out.push({ kind: env, level: null, line, label: label || `(${env})` });
    }
  }
  return out;
}

export function createOutline(root, { getText, onJump }) {
  const list = root.querySelector('.outline-list');
  let entries = [];
  let cursorLine = 1;

  function currentIndex() {
    let idx = -1;
    entries.forEach((e, i) => { if (e.kind === 'section' && e.line <= cursorLine) idx = i; });
    return idx;
  }

  function highlight() {
    const cur = currentIndex();
    [...list.children].forEach((el, i) => el.classList.toggle('current', i === cur));
  }

  function render() {
    const text = getText();
    if (text == null) {
      entries = [];
      list.replaceChildren(h('div', { class: 'outline-empty' }, 'Outline is available for .tex files.'));
      return;
    }
    entries = parseOutline(text);
    if (!entries.length) { list.replaceChildren(h('div', { class: 'outline-empty' }, 'No sections, figures or tables.')); return; }
    // Indent relative to the shallowest heading present, so a paper that starts at \section is not pre-indented.
    const base = Math.min(...entries.filter((e) => e.kind === 'section').map((e) => e.level), 5);
    let depth = 0;
    list.replaceChildren(...entries.map((e) => {
      if (e.kind === 'section') depth = Math.max(0, e.level - base);
      const tag = e.kind === 'section' ? null : e.kind === 'figure' ? 'Fig' : 'Tab';
      return h('div', {
        class: `outline-item ${e.kind}`,
        style: `padding-left:${10 + (e.kind === 'section' ? depth : depth + 1) * 12}px`,
        title: `Line ${e.line}`,
        dataset: { line: e.line },
        onclick: () => onJump(e.line),
      }, tag ? h('span', { class: 'otag' }, tag) : null, h('span', { class: 'name' }, e.label));
    }));
    highlight();
  }

  return {
    render,
    update: render,
    setCursor(line) { if (line !== cursorLine) { cursorLine = line; highlight(); } },
  };
}
