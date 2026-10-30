// keepalive: the request outlives the page (browsers allow 64 KB of such bodies in flight per page).
// A failed request throws an Error that carries the HTTP status and the JSON body of the answer.
export async function api(path, { method = 'GET', body, keepalive } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    keepalive: keepalive || undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

// localStorage holds only per-browser conveniences (last file, pane widths). A browser that blocks
// site storage throws on every access; that must never stop a paper from opening.
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* lasts for this page only */ } },
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(msg, kind = 'info', ms = 3500) {
  const host = $('#toasts');
  const el = h('div', { class: `toast ${kind}` }, msg);
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// Word-level diff for showing a suggestion as deletions/insertions.
export function wordDiff(a, b) {
  const ta = a.split(/(\s+)/).filter((x) => x !== '');
  const tb = b.split(/(\s+)/).filter((x) => x !== '');
  if (ta.length * tb.length > 250000) return [{ op: 'del', text: a }, { op: 'ins', text: b }];
  const n = ta.length; const m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (op, text) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push('eq', ta[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', ta[i++]);
    else push('ins', tb[j++]);
  }
  while (i < n) push('del', ta[i++]);
  while (j < m) push('ins', tb[j++]);
  // Whitespace-only "equal" runs between changes read better folded into the change
  return out;
}
