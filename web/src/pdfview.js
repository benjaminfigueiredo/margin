// PDF viewer on pdf.js: continuous pages, lazy rendering, zoom, scroll kept across
// recompiles, double-click for SyncTeX inverse search, a marker for forward search, a selectable
// text layer per page, and search over the PDF's text (text and matching in pdftext.js).
import * as pdfjsLib from 'pdfjs-dist';
import { renderTextLayer, indexText, normalizeQuery, findInIndex, matchSegments, captureSelection, restoreSelection } from './pdftext.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export function createPdfView(scroller, pagesEl, { onInverse, onStatus }) {
  let doc = null;
  let zoom = 'fit'; // 'fit' or a number (CSS px per PDF point)
  let scale = 1;
  let pages = []; // { n, page, el, canvas, hitsEl, viewport, rendered, renderTask, textReady, textEl, textLayer, index }
  let loadToken = 0;
  let textCache = new Map(); // page number -> Promise<{ content, index }>, for the current document
  let pointerDown = null; // where the last press on a page started, to tell a drag from a double-click
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const n = Number(e.target.dataset.page);
      renderPage(n);
      if (pages[n - 1]) ensureText(pages[n - 1]);
    }
  }, { root: scroller, rootMargin: '600px 0px' });

  function computeScale(baseWidth) {
    if (zoom === 'fit') return Math.max(0.3, (scroller.clientWidth - 32) / baseWidth);
    return zoom;
  }

  async function load(url) {
    const token = ++loadToken;
    // Remember where we were, as a fraction of the document, to restore after reload.
    const anchor = currentAnchor();
    const task = pdfjsLib.getDocument({ url: `${url}?t=${Date.now()}`, isEvalSupported: false });
    let next;
    try { next = await task.promise; } catch (e) { console.warn('PDF load failed', e); return false; }
    if (token !== loadToken) { next.destroy(); return false; }
    const first = await next.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const old = doc;
    doc = next;
    textCache = new Map();
    scale = computeScale(base.width);
    await buildPages();
    restoreAnchor(anchor);
    if (old) old.destroy();
    if (findState.query) find(findState.raw, { keepCurrent: true }); // the new PDF may have other matches
    return true;
  }

  async function buildPages() {
    observer.disconnect();
    const selected = captureSelection(pagesEl, pages); // the page elements are about to be replaced
    for (const p of pages) { p.renderTask?.cancel(); p.textTask?.cancel(); }
    pagesEl.replaceChildren();
    pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(i);
      el.style.width = `${viewport.width}px`;
      el.style.height = `${viewport.height}px`;
      el.style.setProperty('--scale-factor', String(scale)); // the text layer's size and font sizes follow it
      const canvas = document.createElement('canvas');
      const hitsEl = document.createElement('div');
      hitsEl.className = 'pdf-hits';
      el.append(canvas, hitsEl);
      el.addEventListener('mousedown', (ev) => { pointerDown = { x: ev.clientX, y: ev.clientY }; });
      el.addEventListener('dblclick', (ev) => {
        // The text layer sits over the page, so a drag that selects text must not also jump:
        // a double-click whose second press moved is a selection.
        if (pointerDown && Math.hypot(ev.clientX - pointerDown.x, ev.clientY - pointerDown.y) > 4) return;
        const r = el.getBoundingClientRect();
        const x = (ev.clientX - r.left) / scale;
        const y = (ev.clientY - r.top) / scale;
        onInverse?.(i, x, y);
      });
      pagesEl.append(el);
      pages.push({ n: i, page, el, canvas, hitsEl, viewport, rendered: false });
      observer.observe(el);
    }
    updatePageLabel();
    if (selected) restoreSelectionOnceBuilt(selected);
  }

  // ---- text layer ----

  function pageText(n) {
    const cache = textCache;
    let t = cache.get(n);
    if (!t) {
      t = doc.getPage(n).then((pg) => pg.getTextContent()).then((content) => ({ content, index: indexText(content) }));
      cache.set(n, t);
      t.catch(() => cache.delete(n));
    }
    return t;
  }

  // Builds the page's text layer once (a sibling of the canvas, so re-rendering the canvas leaves
  // it alone). Resolves to whether there is a layer now.
  function ensureText(p) {
    p.textReady ??= (async () => {
      const { content, index } = await pageText(p.n);
      if (pages[p.n - 1] !== p) return false;
      const container = document.createElement('div');
      container.className = 'textLayer';
      const { layer, done } = renderTextLayer(container, content, p.viewport);
      p.textTask = layer;
      await done;
      if (pages[p.n - 1] !== p) return false;
      const end = document.createElement('div');
      end.className = 'endOfContent'; // lets a drag through the gaps between lines keep selecting
      container.append(end);
      container.addEventListener('mousedown', () => container.classList.add('selecting'));
      p.el.append(container);
      p.textEl = container;
      p.textLayer = layer;
      p.index = index;
      drawHits(p);
      return true;
    })().catch((e) => { if (e?.name !== 'AbortException') console.warn('PDF text failed', e); return false; });
    return p.textReady;
  }
  document.addEventListener('mouseup', () => {
    for (const el of pagesEl.querySelectorAll('.textLayer.selecting')) el.classList.remove('selecting');
  });

  async function restoreSelectionOnceBuilt(selected) {
    const mine = pages;
    await Promise.all([selected.a.page, selected.f.page].map((n) => (pages[n - 1] ? ensureText(pages[n - 1]) : null)));
    if (pages === mine) restoreSelection(selected, pages);
  }

  // ---- search ----

  const MAX_MATCHES = 5000;
  let findState = { raw: '', query: '', matches: [], byPage: new Map(), current: -1, capped: false, busy: false };
  let findSeq = 0;
  let findListener = null;
  const notifyFind = () => findListener?.({
    query: findState.query, count: findState.matches.length, current: findState.current + 1,
    capped: findState.capped, busy: findState.busy,
  });

  // Case-insensitive, whitespace-insensitive search of the text of every page. Page text is
  // collected once per document and only when searched; highlights are drawn per page when
  // its text layer exists. Resolves when the matches are known.
  async function find(raw, { keepCurrent = false } = {}) {
    const seq = ++findSeq;
    const query = normalizeQuery(raw || '');
    const before = findState.current;
    const st = findState = { raw: raw || '', query, matches: [], byPage: new Map(), current: -1, capped: false, busy: !!(query && doc) };
    for (const p of pages) p.hitsEl.replaceChildren();
    notifyFind();
    if (!st.busy) return;
    const d = doc;
    const texts = Array.from({ length: d.numPages }, (_, i) => pageText(i + 1)); // all at once; the worker queues them
    for (let i = 0; i < texts.length && !st.capped; i++) {
      let t;
      try { t = await texts[i]; } catch { continue; }
      if (seq !== findSeq || d !== doc) return;
      for (const m of findInIndex(t.index, query, MAX_MATCHES - st.matches.length)) {
        if (!st.byPage.has(i + 1)) st.byPage.set(i + 1, []);
        st.byPage.get(i + 1).push(st.matches.length);
        st.matches.push({ page: i + 1, ...m });
      }
      st.capped = st.matches.length >= MAX_MATCHES;
    }
    if (seq !== findSeq) return;
    st.busy = false;
    for (const p of pages) drawHits(p);
    if (!st.matches.length) return notifyFind();
    // Start from the page being read, unless this refreshes a search the reader is working through.
    const top = currentAnchor()?.page ?? 1;
    const first = st.matches.findIndex((m) => m.page >= top);
    return goTo(keepCurrent && before >= 0 ? Math.min(before, st.matches.length - 1) : Math.max(first, 0), !keepCurrent);
  }

  // Overlays on the matching spans of one page: one box per line of each match, positioned from
  // the text layer's own geometry so they follow zoom and the browser's text metrics.
  function drawHits(p) {
    p.hitsEl.replaceChildren();
    const list = findState.byPage.get(p.n);
    if (!list || !p.textLayer) return;
    const origin = p.el.getBoundingClientRect();
    const divs = p.textLayer.textDivs;
    const frag = document.createDocumentFragment();
    for (const mi of list) {
      const m = findState.matches[mi];
      for (const seg of matchSegments(p.index, m.start, m.end)) {
        const node = divs[seg.item]?.firstChild;
        if (!node) continue;
        const range = document.createRange();
        range.setStart(node, Math.min(seg.from, node.length));
        range.setEnd(node, Math.min(seg.to, node.length));
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          const box = document.createElement('div');
          box.className = mi === findState.current ? 'pdf-hit current' : 'pdf-hit';
          box.dataset.m = String(mi);
          Object.assign(box.style, { left: `${r.left - origin.left}px`, top: `${r.top - origin.top}px`, width: `${r.width}px`, height: `${r.height}px` });
          frag.append(box);
        }
      }
    }
    p.hitsEl.append(frag);
  }

  async function goTo(i, scroll = true) {
    const st = findState;
    if (i < 0 || i >= st.matches.length) return;
    st.current = i;
    notifyFind();
    const p = pages[st.matches[i].page - 1];
    if (!p) return;
    await ensureText(p);
    if (st !== findState || st.current !== i || pages[p.n - 1] !== p) return;
    for (const el of pagesEl.querySelectorAll('.pdf-hit.current')) el.classList.remove('current');
    const boxes = p.hitsEl.querySelectorAll(`[data-m="${i}"]`);
    for (const el of boxes) el.classList.add('current');
    if (scroll && boxes[0]) scrollToBox(p, boxes[0]);
  }

  // Moves the view only if the match is not comfortably on screen already.
  function scrollToBox(p, box) {
    const top = p.el.offsetTop + box.offsetTop;
    const left = p.el.offsetLeft + box.offsetLeft;
    if (top < scroller.scrollTop + 40 || top + box.offsetHeight > scroller.scrollTop + scroller.clientHeight - 60) {
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'instant' });
    }
    if (left < scroller.scrollLeft + 20 || left + box.offsetWidth > scroller.scrollLeft + scroller.clientWidth - 20) {
      scroller.scrollTo({ left: Math.max(0, left - scroller.clientWidth / 3), behavior: 'instant' });
    }
  }

  function step(dir) {
    const n = findState.matches.length;
    if (n) return goTo((findState.current + dir + n) % n);
  }

  async function renderPage(n) {
    const p = pages[n - 1];
    if (!p || p.rendered) return;
    p.rendered = true;
    const ratio = dpr();
    const vp = p.page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${p.viewport.width}px`;
    canvas.style.height = `${p.viewport.height}px`;
    p.renderTask = p.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
    try {
      await p.renderTask.promise;
      p.canvas.replaceWith(canvas); // swap only when finished, so no blank flash
      p.canvas = canvas;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(e);
      p.rendered = false;
    }
  }

  function currentAnchor() {
    if (!pages.length) return null;
    const top = scroller.scrollTop;
    for (const p of pages) {
      const off = p.el.offsetTop;
      if (off + p.el.offsetHeight > top) return { page: Number(p.el.dataset.page), frac: (top - off) / p.el.offsetHeight };
    }
    return null;
  }

  function restoreAnchor(a) {
    if (!a || !pages.length) return;
    const p = pages[Math.min(a.page, pages.length) - 1];
    scroller.scrollTop = p.el.offsetTop + a.frac * p.el.offsetHeight;
  }

  function updatePageLabel() {
    const a = currentAnchor();
    onStatus?.(doc ? `${a ? a.page : 1} / ${doc.numPages}` : '');
  }
  scroller.addEventListener('scroll', () => requestAnimationFrame(updatePageLabel), { passive: true });

  async function setZoom(z) {
    if (!doc) { zoom = z; return; }
    const anchor = currentAnchor();
    zoom = z;
    const base = pages[0].page.getViewport({ scale: 1 });
    scale = computeScale(base.width);
    await buildPages();
    restoreAnchor(anchor);
  }

  let resizeTimer;
  new ResizeObserver(() => {
    if (zoom !== 'fit' || !doc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setZoom('fit'), 150);
  }).observe(scroller);

  // Forward search result: synctex gives h (left), v (baseline), W, H in PDF points.
  function showLocation({ page, h, v, width, height, x, y }) {
    const p = pages[page - 1];
    if (!p) return;
    const left = (Number.isFinite(h) ? h : x) * scale;
    const top = ((Number.isFinite(v) ? v : y) - (height || 12)) * scale;
    const w = Math.max(40, (width || 300) * scale);
    const hh = Math.max(14, (height || 12) * scale + 4);
    scroller.scrollTo({ top: p.el.offsetTop + top - scroller.clientHeight / 3, behavior: 'smooth' });
    const marker = document.createElement('div');
    marker.className = 'synctex-marker';
    Object.assign(marker.style, { left: `${left - 4}px`, top: `${top - 2}px`, width: `${w + 8}px`, height: `${hh}px` });
    p.el.append(marker);
    setTimeout(() => marker.remove(), 1800);
  }

  return {
    load,
    setZoom,
    zoomIn() { return setZoom(Math.min(4, (zoom === 'fit' ? scale : zoom) * 1.15)); },
    zoomOut() { return setZoom(Math.max(0.3, (zoom === 'fit' ? scale : zoom) / 1.15)); },
    get zoomLabel() { return zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`; },
    showLocation,
    find,
    findNext: () => step(1),
    findPrev: () => step(-1),
    clearFind: () => find(''),
    onFind(fn) { findListener = fn; },
    get loaded() { return !!doc; },
  };
}
