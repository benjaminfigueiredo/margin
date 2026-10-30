// The search box in the PDF pane head: wires the input, the match count and the previous/next
// buttons to pdfview's find API. Enter / Shift+Enter step through the matches, Escape clears.
import { $, debounce } from './util.js';

export function initPdfFind(root, pdf, { reveal } = {}) {
  const input = $('.pdf-find-q', root);
  const count = $('.pdf-find-count', root);
  const prev = $('.pdf-find-prev', root);
  const next = $('.pdf-find-next', root);

  pdf.onFind(({ query, count: n, current, capped, busy }) => {
    count.textContent = !query ? '' : busy ? '…' : !n ? 'No matches' : `${current} / ${n}${capped ? '+' : ''}`;
    count.classList.toggle('none', !!query && !busy && !n);
    prev.disabled = next.disabled = !n;
  });

  const run = debounce(() => pdf.find(input.value), 120);
  input.addEventListener('input', run);
  // The Logs and project Find panels cover the PDF pages; searching the PDF means looking at it.
  input.addEventListener('focus', () => reveal?.());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (input.value) (e.shiftKey ? pdf.findPrev() : pdf.findNext()); }
    else if (e.key === 'Escape') { input.value = ''; pdf.clearFind(); input.blur(); }
  });
  prev.addEventListener('click', () => pdf.findPrev());
  next.addEventListener('click', () => pdf.findNext());

  // Ctrl/Cmd+F while reading the PDF (focus is in the pane) searches the PDF; anywhere else it
  // stays the editor's own find.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
    if (!(e.target instanceof Element) || !e.target.closest('#pdf-pane') || e.target.closest('#logs, #search')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}
