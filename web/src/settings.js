// Appearance settings in the top bar: theme (System / Light / Dark) and editor font size.
// These are personal, not project settings, so they live in this browser's localStorage
// rather than in .review/config.json. The theme is also applied before first paint by a
// one-line script in web/index.html; keep the key and values in sync with it.
import { $ } from './util.js';

const THEME_KEY = 'margin:theme';
const SIZE_KEY = 'margin:font-size';
const THEMES = ['system', 'light', 'dark'];
const SIZES = [12, 13, 14, 15, 16, 18, 20];
const DEFAULT_SIZE = 14;

// A blocked localStorage (private mode, strict cookie settings) must not stop the app booting.
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* lasts for this page only */ } };

export function initSettings(editor) {
  const root = document.documentElement;
  const btn = $('#btn-settings'), menu = $('#settings-menu'), sizeSel = $('#set-font-size');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = THEMES.includes(read(THEME_KEY)) ? read(THEME_KEY) : 'system';
  let size = SIZES.includes(Number(read(SIZE_KEY))) ? Number(read(SIZE_KEY)) : DEFAULT_SIZE;

  sizeSel.replaceChildren(...SIZES.map((n) => new Option(`${n} px`, String(n))));

  function apply() {
    if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
    root.style.setProperty('--editor-font-size', `${size}px`);
    editor.setDark(theme === 'dark' || (theme === 'system' && media.matches));
    editor.remeasure();
    for (const b of menu.querySelectorAll('[data-theme-choice]')) b.classList.toggle('on', b.dataset.themeChoice === theme);
    sizeSel.value = String(size);
  }

  for (const b of menu.querySelectorAll('[data-theme-choice]')) {
    b.addEventListener('click', () => { theme = b.dataset.themeChoice; write(THEME_KEY, theme); apply(); });
  }
  sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); write(SIZE_KEY, String(size)); apply(); });
  media.addEventListener('change', () => { if (theme === 'system') apply(); });

  const open = (on) => { menu.classList.toggle('hidden', !on); btn.setAttribute('aria-expanded', String(on)); };
  // No stopPropagation: the click must still reach the document so the compile menu closes.
  btn.addEventListener('click', () => open(menu.classList.contains('hidden')));
  document.addEventListener('click', (e) => { if (!e.target.closest('.settings-group')) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });

  apply();
}
