// Appearance settings: what is allowed, and how a stored or posted value is cleaned up.
// Pure (no Node imports): web/src/settings.js bundles this file into the browser, so the
// server and the UI cannot disagree about the values. The first-paint script in
// web/index.html repeats the theme and layout values; keep it in sync.
export const THEMES = ['system', 'light', 'dark'];
export const SIZES = [12, 13, 14, 15, 16, 18, 20];
export const DEFAULT_SIZE = 14;
export const LAYOUTS = ['auto', 'standard', 'split'];

// Keeps only known keys with allowed values. Unknown or bad values are dropped, not defaulted,
// so a partial update (just the theme) leaves the other settings as they were.
export function cleanAppearance(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (THEMES.includes(input.theme)) out.theme = input.theme;
  if (SIZES.includes(Number(input.fontSize))) out.fontSize = Number(input.fontSize);
  if (LAYOUTS.includes(input.layout)) out.layout = input.layout;
  return out;
}
