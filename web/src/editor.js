// CodeMirror 6 editor with LaTeX highlighting and inline review decorations:
// suggestions render as struck-through original + inserted replacement, comments as highlights.
import { EditorView, keymap, Decoration, WidgetType, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags as t } from '@lezer/highlight';

const setItems = StateEffect.define();
const setActive = StateEffect.define();

class InsertWidget extends WidgetType {
  constructor(text, id, active) { super(); this.text = text; this.id = id; this.active = active; }
  eq(o) { return o.text === this.text && o.id === this.id && o.active === this.active; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-sugg-ins' + (this.active ? ' active' : '');
    el.dataset.reviewId = this.id;
    el.textContent = this.text === '' ? '⌫' : this.text;
    if (this.text === '') el.classList.add('deletion-only');
    el.title = 'Suggested text';
    return el;
  }
  ignoreEvent() { return false; }
}

function buildDecorations(items, activeId, docLength) {
  const ranges = [];
  for (const it of items) {
    if (it.from == null || it.status !== 'open' || it.to > docLength) continue;
    const active = it.id === activeId;
    if (it.kind === 'suggestion') {
      if (it.to > it.from) ranges.push({ from: it.from, to: it.to, deco: Decoration.mark({ class: `cm-sugg-del${active ? ' active' : ''}`, attributes: { 'data-review-id': it.id } }) });
      ranges.push({ from: it.to, to: it.to, deco: Decoration.widget({ widget: new InsertWidget(it.replacement, it.id, active), side: 1 }) });
    } else {
      ranges.push({ from: it.from, to: Math.max(it.to, it.from + 1), deco: Decoration.mark({ class: `cm-comment${it.author === 'you' ? ' mine' : ''}${active ? ' active' : ''}`, attributes: { 'data-review-id': it.id } }) });
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

const reviewField = StateField.define({
  create() { return { items: [], active: null, deco: Decoration.none }; },
  update(value, tr) {
    let { items, active, deco } = value;
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(setItems)) { items = e.value; rebuild = true; }
      if (e.is(setActive)) { active = e.value; rebuild = true; }
    }
    if (rebuild) deco = buildDecorations(items, active, tr.state.doc.length);
    else if (tr.docChanged) deco = deco.map(tr.changes);
    return { items, active, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7a3e9d' },           // \commands
  { tag: t.tagName, color: '#7a3e9d' },
  { tag: t.atom, color: '#1f6f8b' },
  { tag: t.bracket, color: '#5b6770' },
  { tag: t.comment, color: '#8a9399', fontStyle: 'italic' },
  { tag: t.string, color: '#2f7d4f' },
  { tag: t.number, color: '#b0560f' },
  { tag: t.variableName, color: '#1f6f8b' },
  { tag: t.meta, color: '#b0560f' },
  { tag: t.special(t.string), color: '#c0392b' },  // math
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0 40vh' },
  '.cm-gutters': { background: 'var(--gutter)', border: 'none', color: 'var(--muted)' },
  '.cm-activeLine': { background: 'rgba(60, 120, 90, 0.05)' },
  '.cm-activeLineGutter': { background: 'rgba(60, 120, 90, 0.10)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(61, 139, 95, 0.22) !important' },
});

export function createEditor(parent, { onChange, onSelection, onReviewClick, keys = [] }) {
  const wrapping = new Compartment();
  const readOnly = new Compartment();
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(),
    StreamLanguage.define(stex), syntaxHighlighting(highlight), theme,
    wrapping.of(EditorView.lineWrapping), readOnly.of(EditorState.readOnly.of(false)),
    reviewField,
    keymap.of([...keys, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) onChange?.(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) onSelection?.(u.state);
    }),
    EditorView.domEventHandlers({
      mousedown(e) {
        const target = e.target.closest?.('[data-review-id]');
        if (target) { onReviewClick?.(target.dataset.reviewId); }
        return false;
      },
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });

  return {
    view,
    setDoc(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: external.of(true), selection: { anchor: 0 }, scrollIntoView: true });
      view.scrollDOM.scrollTop = 0;
    },
    // Apply an external change (e.g. accepted suggestion) as a minimal diff so the cursor and scroll stay put.
    replaceDocPreserving(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let start = 0;
      while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
      let endA = cur.length; let endB = text.length;
      while (endA > start && endB > start && cur[endA - 1] === text[endB - 1]) { endA--; endB--; }
      view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) }, annotations: external.of(true) });
    },
    getDoc() { return view.state.doc.toString(); },
    setReview(items, active) {
      view.dispatch({ effects: [setItems.of(items), setActive.of(active ?? view.state.field(reviewField).active)] });
    },
    setActive(id) { view.dispatch({ effects: setActive.of(id) }); },
    gotoLine(line, { select = false, flash = true } = {}) {
      const n = Math.min(Math.max(1, line), view.state.doc.lines);
      const l = view.state.doc.line(n);
      view.dispatch({ selection: select ? { anchor: l.from, head: l.to } : { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
      if (flash) flashLine(view, l.from);
    },
    gotoRange(from, to) {
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    },
    setReadOnly(ro) { view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(ro)) }); },
    focus() { view.focus(); },
  };
}

import { Annotation } from '@codemirror/state';
const external = Annotation.define();

function flashLine(view, pos) {
  requestAnimationFrame(() => {
    const { node } = view.domAtPos(pos);
    const lineEl = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cm-line');
    if (!lineEl) return;
    lineEl.classList.remove('flash');
    void lineEl.offsetWidth;
    lineEl.classList.add('flash');
    setTimeout(() => lineEl.classList.remove('flash'), 1600);
  });
}

export function selectionInfo(state) {
  const sel = state.selection.main;
  const doc = state.doc;
  const cursorLine = doc.lineAt(sel.head).number;
  if (sel.empty) return { cursorLine, selection: null };
  return {
    cursorLine,
    selection: { text: doc.sliceString(sel.from, sel.to), from: sel.from, to: sel.to, fromLine: doc.lineAt(sel.from).number, toLine: doc.lineAt(sel.to).number },
  };
}
