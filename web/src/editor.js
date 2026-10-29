// CodeMirror 6 editor with LaTeX highlighting and inline review decorations:
// suggestions render as struck-through original + inserted replacement, comments as highlights.
import { EditorView, keymap, Decoration, WidgetType, lineNumbers, highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment, RangeSetBuilder, RangeSet } from '@codemirror/state';
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

// Compile diagnostics in the gutter: one marker per line, rebuilt wholesale by setDiagnostics and mapped through edits.
const setDiagnosticMarkers = StateEffect.define();

class DiagnosticMarker extends GutterMarker {
  constructor(items) { super(); this.items = items; this.severity = items.some((i) => i.severity === 'error') ? 'error' : 'warn'; }
  eq(other) { return other.items === this.items; }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-diag-marker ${this.severity}`;
    el.title = this.items.map((i) => (i.context ? `${i.message}\n${i.context}` : i.message)).join('\n\n');
    el.textContent = '●';
    return el;
  }
}

const diagnosticField = StateField.define({
  create() { return RangeSet.empty; },
  update(markers, tr) {
    markers = markers.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDiagnosticMarkers)) markers = e.value;
    return markers;
  },
});

function buildDiagnosticMarkers(doc, items) {
  const byLine = new Map();
  for (const it of items) {
    if (!it.line || it.line < 1 || it.line > doc.lines) continue;
    if (!byLine.has(it.line)) byLine.set(it.line, []);
    byLine.get(it.line).push(it);
  }
  const b = new RangeSetBuilder();
  for (const n of [...byLine.keys()].sort((a, c) => a - c)) b.add(doc.line(n).from, doc.line(n).from, new DiagnosticMarker(byLine.get(n)));
  return b.finish();
}

let onDiagnosticClick = null;
const diagnosticGutter = gutter({
  class: 'cm-diag-gutter',
  markers: (v) => v.state.field(diagnosticField),
  domEventHandlers: {
    mousedown(view, line) {
      let hit = null;
      view.state.field(diagnosticField).between(line.from, line.from, (from, to, m) => { hit = m; });
      if (!hit) return false;
      onDiagnosticClick?.(hit.items);
      return true;
    },
  },
});

// Colours come from CSS custom properties in web/style.css, so the light and dark themes
// (and anything else that redefines the tokens) restyle the editor without rebuilding it.
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-command)' },  // \commands
  { tag: t.tagName, color: 'var(--syn-command)' },
  { tag: t.atom, color: 'var(--syn-atom)' },
  { tag: t.bracket, color: 'var(--syn-bracket)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--syn-string)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.variableName, color: 'var(--syn-atom)' },
  { tag: t.meta, color: 'var(--syn-number)' },
  { tag: t.special(t.string), color: 'var(--syn-math)' },  // math
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0 40vh', caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-gutters': { background: 'var(--gutter)', border: 'none', color: 'var(--muted)' },
  '.cm-activeLine': { background: 'var(--active-line)' },
  '.cm-activeLineGutter': { background: 'var(--active-gutter)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--selection) !important' },
});

export function createEditor(parent, { onChange, onSelection, onReviewClick, keys = [] }) {
  const wrapping = new Compartment();
  const readOnly = new Compartment();
  // Tells CodeMirror's own base theme (search panel, tooltips, bracket matching) which variant to use.
  const darkMode = new Compartment();
  const extensions = [
    diagnosticField, diagnosticGutter, lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(),
    StreamLanguage.define(stex), syntaxHighlighting(highlight), theme, darkMode.of(EditorView.darkTheme.of(false)),
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
    // items: [{ line, message, context, severity: 'error' | 'warn' }]; onClick receives the items on the clicked line.
    setDiagnostics(items, onClick) {
      onDiagnosticClick = onClick || null;
      view.dispatch({ effects: setDiagnosticMarkers.of(buildDiagnosticMarkers(view.state.doc, items)) });
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
    setDark(dark) { view.dispatch({ effects: darkMode.reconfigure(EditorView.darkTheme.of(dark)) }); },
    // The colours and font size live in CSS variables; after changing them CodeMirror must re-measure line heights.
    remeasure() { view.requestMeasure(); },
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
