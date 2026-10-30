// Text helpers for keeping the editor and the file on disk in step (web/src/main.js). Pure: no DOM.

// CodeMirror keeps "\n" line breaks whatever the file uses, so a CRLF file reads back from the
// editor with LF only. Compare texts through this; edits sent to the server are always made
// against the exact text it sent.
export const sameText = (a, b) => a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');

// The one span where b differs from a, in a's positions: a.slice(0, from) + text + a.slice(to) === b.
export function region(a, b) {
  const n = Math.min(a.length, b.length);
  let from = 0;
  while (from < n && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  let ea = a.length, eb = b.length;
  while (ea > from && eb > from && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  return { from, to: ea, text: b.slice(from, eb) };
}

// base: the text both sides started from; mine: the editor now; theirs: the file on disk now.
// When the two sides changed separate parts of base (at least one untouched character between
// them), returns theirs' change as a change to mine ({ from, to, insert }, in mine's positions):
// applying it gives base with both changes. Otherwise null: the author has to choose.
export function merge3(base, mine, theirs) {
  const b = base.replace(/\r\n?/g, '\n');
  const t = theirs.replace(/\r\n?/g, '\n');
  const m = region(b, mine);
  const o = region(b, t);
  if (m.from === m.to && m.text === '') return { from: o.from, to: o.to, insert: o.text }; // mine is base
  if (o.from === o.to && o.text === '') return { from: 0, to: 0, insert: '' }; // theirs is base
  if (o.to < m.from) return { from: o.from, to: o.to, insert: o.text };
  if (o.from > m.to) { const d = mine.length - b.length; return { from: o.from + d, to: o.to + d, insert: o.text }; }
  return null;
}
