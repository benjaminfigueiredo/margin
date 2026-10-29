// PDF viewer on pdf.js: continuous pages, lazy rendering, zoom, scroll kept across
// recompiles, double-click for SyncTeX inverse search, and a marker for forward search.
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export function createPdfView(scroller, pagesEl, { onInverse, onStatus }) {
  let doc = null;
  let zoom = 'fit'; // 'fit' or a number (CSS px per PDF point)
  let scale = 1;
  let pages = []; // { el, canvas, viewport, rendered, renderTask, width, height }
  let loadToken = 0;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderPage(Number(e.target.dataset.page));
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
    scale = computeScale(base.width);
    await buildPages();
    restoreAnchor(anchor);
    if (old) old.destroy();
    return true;
  }

  async function buildPages() {
    observer.disconnect();
    for (const p of pages) p.renderTask?.cancel();
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
      const canvas = document.createElement('canvas');
      el.append(canvas);
      el.addEventListener('dblclick', (ev) => {
        const r = el.getBoundingClientRect();
        const x = (ev.clientX - r.left) / scale;
        const y = (ev.clientY - r.top) / scale;
        onInverse?.(i, x, y);
      });
      pagesEl.append(el);
      pages.push({ page, el, canvas, viewport, rendered: false });
      observer.observe(el);
    }
    updatePageLabel();
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
    get loaded() { return !!doc; },
  };
}
