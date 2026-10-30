// Text for the PDF viewer: the selectable text layer (pdf.js TextLayer), and the plain-text index
// that PDF search runs on. No DOM state of its own; pdfview.js decides when to build what.
import { TextLayer } from 'pdfjs-dist';

// Fills `container` with one transparent, absolutely positioned span per text item of the page,
// so the browser can select it over the canvas. Resolves to the TextLayer (its `textDivs` line up
// with the string items of `content`) or rejects with an AbortException if cancelled.
export function renderTextLayer(container, content, viewport) {
  const layer = new TextLayer({ textContentSource: content, container, viewport });
  return { layer, done: layer.render() };
}

// Text items in the order TextLayer makes spans for them. getTextContent() without marked
// content only returns string items, but filter anyway so the indexes cannot drift.
const stringItems = (content) => content.items.filter((it) => it.str !== undefined);

// One normalised string per page for matching, with, for every character of it, the item and the
// character range in that item it came from. Normalising is NFKC (so the ligature glyph "ﬁ"
// matches "fi"), lower case, and every run of whitespace, line ends included, becomes one space.
// A match can therefore be mapped back to the spans it covers.
export function indexText(content) {
  const items = stringItems(content);
  let text = '';
  const item = []; // per character of text: item number, or -1 for a line end
  const from = []; // per character: start offset in the item's str
  const to = [];   // per character: end offset
  const add = (ch, i, a, b) => { text += ch; item.push(i); from.push(a); to.push(b); };
  const space = (i, a, b) => { if (text && text[text.length - 1] !== ' ') add(' ', i, a, b); };
  items.forEach((it, i) => {
    let off = 0;
    for (const ch of it.str) {
      const norm = ch.normalize('NFKC').toLowerCase();
      for (const u of norm) {
        if (/\s/.test(u)) space(i, off, off + ch.length);
        else for (let k = 0; k < u.length; k++) add(u[k], i, off, off + ch.length);
      }
      off += ch.length;
    }
    if (it.hasEOL) space(-1, 0, 0);
  });
  return { text, item, from, to, count: items.length };
}

// What the search box text is compared as: same normalisation, trimmed.
export function normalizeQuery(q) {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Non-overlapping occurrences of the (already normalised) query: [{ start, end }] in index.text.
export function findInIndex(index, query, limit = Infinity) {
  const out = [];
  if (!query) return out;
  for (let at = index.text.indexOf(query); at !== -1 && out.length < limit; at = index.text.indexOf(query, at + query.length)) {
    out.push({ start: at, end: at + query.length });
  }
  return out;
}

// The pieces of a match, one per item it touches: [{ item, from, to }] (offsets in the item's str).
export function matchSegments(index, start, end) {
  const out = [];
  for (let k = start; k < end; k++) {
    const i = index.item[k];
    if (i < 0) continue;
    const last = out[out.length - 1];
    if (last && last.item === i) { last.from = Math.min(last.from, index.from[k]); last.to = Math.max(last.to, index.to[k]); }
    else out.push({ item: i, from: index.from[k], to: index.to[k] });
  }
  return out;
}

// ---- selection that survives rebuilding the pages ----
// A zoom or a recompile replaces every page element, which drops the browser's selection. These
// two keep it as positions (page, span number, character) and put it back on the new spans.

// `pages` is the viewer's page list: { textEl, textLayer } per page, once its text layer exists.
export function captureSelection(pagesEl, pages) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return null;
  if (!pagesEl.contains(sel.anchorNode) || !pagesEl.contains(sel.focusNode)) return null;
  const pos = (node, offset) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const page = Number(el?.closest('.pdf-page')?.dataset.page);
    const p = pages[page - 1];
    if (!p?.textLayer) return null;
    if (el.parentElement === p.textEl && el.tagName === 'SPAN') {
      const item = p.textLayer.textDivs.indexOf(el);
      if (item < 0) return null;
      return { page, item, offset: node.nodeType === 1 ? (offset ? el.textContent.length : 0) : offset };
    }
    // Dragged past the last line: the browser parks that end of the selection on the layer itself.
    return p.textEl.contains(el) ? { page, end: true } : null;
  };
  const a = pos(sel.anchorNode, sel.anchorOffset);
  const f = pos(sel.focusNode, sel.focusOffset);
  return a && f ? { a, f, text: sel.toString() } : null;
}

// Call once the text layers of saved.a.page and saved.f.page exist. Leaves alone a selection the
// user has made since, and one that would take the caret out of an editor field; gives up if the
// text under the saved positions is no longer the text that was selected (the PDF changed).
export function restoreSelection(saved, pages) {
  const sel = window.getSelection();
  if (!saved || !sel) return false;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable], .cm-editor')) return false;
  if (!sel.isCollapsed) return false;
  const at = ({ page, item, offset, end }) => {
    const p = pages[page - 1];
    if (!p?.textLayer) return null;
    if (end) return [p.textEl.querySelector('.endOfContent'), 0];
    const text = p.textLayer.textDivs[item]?.firstChild;
    return text ? [text, Math.min(offset, text.length)] : null;
  };
  const a = at(saved.a);
  const f = at(saved.f);
  if (!a || !f || !a[0] || !f[0]) return false;
  sel.setBaseAndExtent(a[0], a[1], f[0], f[1]);
  if (sel.toString() === saved.text) return true;
  sel.removeAllRanges();
  return false;
}
