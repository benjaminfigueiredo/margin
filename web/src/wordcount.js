// Word count in the status bar: whole paper (server, follows \input), per-section breakdown
// in a popover, and the editor selection (counted in the browser with the same counter).
import { api, $, h, debounce } from './util.js';
import { selectionInfo } from './editor.js';
import { countLatex } from '../../server/wordcount.js';

export function initWordCount(editor) {
  const btn = $('#wc-btn'), panel = $('#wc-panel'), sel = $('#wc-sel');
  let data = null;

  const fmt = (n) => n.toLocaleString('en-US');
  const sub = (d) => [d.captions && `${fmt(d.captions)} in captions`, d.footnotes && `${fmt(d.footnotes)} in footnotes`].filter(Boolean).join(', ');

  function renderButton() {
    btn.textContent = data ? `${fmt(data.total)} words` : '– words';
  }

  function renderPanel() {
    if (!data) return;
    const row = (cells, cls) => h('tr', { class: cls }, cells.map((c, i) => h(i ? 'td' : 'th', { class: i ? 'num' : '' }, c)));
    const body = data.sections.map((s) => row([s.title, fmt(s.words), fmt(s.captions), fmt(s.footnotes), fmt(s.total)]));
    panel.replaceChildren(
      h('div', { class: 'wc-head' }, h('strong', {}, `${fmt(data.total)} words`), h('button', { class: 'btn sm ghost', 'aria-label': 'Close', onclick: () => toggle(false) }, '✕')),
      h('div', { class: 'wc-sub' }, data.captions || data.footnotes
        ? `${fmt(data.words)} in body text, plus ${sub(data)}.` : 'Body text only; no captions or footnotes.'),
      h('table', {}, h('thead', {}, row(['Section', 'Text', 'Captions', 'Footnotes', 'Total'])), h('tbody', {}, body), h('tfoot', {}, row(['Paper', fmt(data.words), fmt(data.captions), fmt(data.footnotes), fmt(data.total)]))),
      h('div', { class: 'wc-note' }, 'Excludes comments, math, tables, the preamble and bibliography. Follows \\input and \\include.'
        + (data.missing.length ? ` Not found: ${data.missing.join(', ')}.` : '')),
    );
  }

  async function refresh() {
    try { data = await api('/wordcount'); } catch { return; }
    renderButton();
    if (!panel.classList.contains('hidden')) renderPanel();
  }
  const refreshSoon = debounce(refresh, 400);

  function toggle(open = panel.classList.contains('hidden')) {
    panel.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { renderPanel(); refresh(); }
  }
  btn.addEventListener('click', () => toggle());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) toggle(false); });
  document.addEventListener('mousedown', (e) => { if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !btn.contains(e.target)) toggle(false); });

  function updateSelection() {
    const info = editor.view && selectionInfo(editor.view.state);
    if (!info?.selection) { sel.classList.add('hidden'); return; }
    const c = countLatex(info.selection.text);
    sel.textContent = `${fmt(c.total)} selected`;
    sel.classList.remove('hidden');
  }
  document.addEventListener('selectionchange', debounce(updateSelection, 100));

  // A save changes the paper on disk: refresh the totals once it lands.
  new MutationObserver(() => { if ($('#save-state').textContent === 'Saved') refreshSoon(); }).observe($('#save-state'), { childList: true, characterData: true, subtree: true });
  refresh();
}
