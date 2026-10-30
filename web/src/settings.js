// Appearance settings in the top bar: theme (System / Light / Dark), editor font size and
// layout (Standard, or Split screen for a short window above a Claude terminal).
// These are personal, not project settings, so they are not in .review/config.json. They are
// shared by all the author's papers through the server (/api/appearance, stored in Margin's
// config folder, see server/config.js), and kept in this browser's localStorage too: that copy
// paints the first frame instantly and is the fallback when the server has no shared settings.
// Each paper runs on its own port, which is its own localStorage, hence the server copy.
// The theme is also applied before first paint by a one-line script in web/index.html, and
// so is the layout; keep keys, values and the height threshold in sync with it.
import { $ } from './util.js';
import { THEMES, SIZES, DEFAULT_SIZE, LAYOUTS } from '../../server/appearance.js';

const THEME_KEY = 'margin:theme';
const SIZE_KEY = 'margin:font-size';
const LAYOUT_KEY = 'margin:layout';
// Auto switches to split screen at or below this window height: the standard chrome (44px top
// bar, 34px pane heads, uncollapsed outline) leaves too little editor below it.
export const SPLIT_MAX_HEIGHT = 660;

// A blocked localStorage (private mode, strict cookie settings) must not stop the app booting.
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* lasts for this page only */ } };

export function initSettings(editor) {
  const root = document.documentElement;
  const btn = $('#btn-settings'), menu = $('#settings-menu'), sizeSel = $('#set-font-size');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = THEMES.includes(read(THEME_KEY)) ? read(THEME_KEY) : 'system';
  let size = SIZES.includes(Number(read(SIZE_KEY))) ? Number(read(SIZE_KEY)) : DEFAULT_SIZE;
  let layout = LAYOUTS.includes(read(LAYOUT_KEY)) ? read(LAYOUT_KEY) : 'auto';
  let autoCollapsed = false;

  sizeSel.replaceChildren(...SIZES.map((n) => new Option(`${n} px`, String(n))));

  function apply() {
    if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
    root.style.setProperty('--editor-font-size', `${size}px`);
    editor.setDark(theme === 'dark' || (theme === 'system' && media.matches));
    editor.remeasure();
    for (const b of menu.querySelectorAll('[data-theme-choice]')) b.classList.toggle('on', b.dataset.themeChoice === theme);
    sizeSel.value = String(size);
    applyLayout();
  }

  function applyLayout() {
    const split = layout === 'split' || (layout === 'auto' && window.innerHeight <= SPLIT_MAX_HEIGHT);
    const was = root.dataset.layout === 'split';
    root.dataset.layout = split ? 'split' : 'standard';
    for (const b of menu.querySelectorAll('[data-layout-choice]')) b.classList.toggle('on', b.dataset.layoutChoice === layout);
    // The outline is the first thing to give up its height; put it back as it was on leaving.
    const outline = $('#outline'), toggle = $('#outline .outline-toggle');
    const setOutline = (closed) => { outline.classList.toggle('collapsed', closed); toggle.setAttribute('aria-expanded', String(!closed)); toggle.textContent = closed ? '▸' : '▾'; };
    if (split && (!was || !autoCollapsed) && !outline.classList.contains('collapsed') && !outline.dataset.userOpened) { setOutline(true); autoCollapsed = true; }
    if (!split && was && autoCollapsed) { setOutline(false); autoCollapsed = false; }
    if (split !== was) editor.remeasure();
  }

  // ---- shared copy on the server. Never blocks booting: every failure leaves the local copy. ----
  let shared = false, pulled = false, editedBeforePull = false;
  const push = () => {
    if (!shared) { if (!pulled) editedBeforePull = true; return; }
    fetch('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme, fontSize: size, layout }) }).catch(() => {});
  };
  async function pull() {
    let r;
    try {
      const res = await fetch('/api/appearance', { cache: 'no-store' });
      if (!res.ok) return; // this server keeps no shared settings: localStorage only
      r = await res.json();
    } catch { return; } finally { pulled = true; }
    shared = true;
    $('#settings-where').textContent = 'Shared by all your papers on this computer.';
    // First time anywhere, or a change made while the request was out: this browser's choice wins.
    if (!r.saved || editedBeforePull) { editedBeforePull = false; push(); return; }
    const s = r.settings || {};
    let changed = false;
    if (THEMES.includes(s.theme) && s.theme !== theme) { theme = s.theme; write(THEME_KEY, theme); changed = true; }
    if (SIZES.includes(s.fontSize) && s.fontSize !== size) { size = s.fontSize; write(SIZE_KEY, String(size)); changed = true; }
    if (LAYOUTS.includes(s.layout) && s.layout !== layout) { layout = s.layout; write(LAYOUT_KEY, layout); changed = true; }
    if (changed) apply();
  }
  // Coming back to this tab after changing a setting in another paper picks the change up.
  window.addEventListener('focus', () => pull());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });

  for (const b of menu.querySelectorAll('[data-theme-choice]')) {
    b.addEventListener('click', () => { theme = b.dataset.themeChoice; write(THEME_KEY, theme); apply(); push(); });
  }
  sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); write(SIZE_KEY, String(size)); apply(); push(); });
  for (const b of menu.querySelectorAll('[data-layout-choice]')) {
    b.addEventListener('click', () => { layout = b.dataset.layoutChoice; write(LAYOUT_KEY, layout); applyLayout(); push(); });
  }
  window.addEventListener('resize', () => { if (layout === 'auto') applyLayout(); });
  // Opening the outline by hand in split screen is a choice: don't fold it again on the next resize.
  // (main.js toggles the class in its own listener, so look once both have run.)
  $('#outline .outline-toggle').addEventListener('click', () => setTimeout(() => {
    if (root.dataset.layout === 'split' && !$('#outline').classList.contains('collapsed')) $('#outline').dataset.userOpened = '1';
    autoCollapsed = false;
  }));
  media.addEventListener('change', () => { if (theme === 'system') apply(); });

  const open = (on) => { menu.classList.toggle('hidden', !on); btn.setAttribute('aria-expanded', String(on)); };
  // No stopPropagation: the click must still reach the document so the compile menu closes.
  btn.addEventListener('click', () => open(menu.classList.contains('hidden')));
  document.addEventListener('click', (e) => { if (!e.target.closest('.settings-group')) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });

  apply();
  pull();
}
