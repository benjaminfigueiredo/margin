// The author's Margin config folder: the hub's paper list (projects.json), the appearance
// settings every paper shares (settings.json) and the hub's logs. It is never inside a paper
// folder, so nothing here can reach Overleaf.
//   macOS:     ~/Library/Application Support/margin
//   elsewhere: $XDG_CONFIG_HOME/margin, or ~/.config/margin
//   override:  MARGIN_CONFIG_DIR (tests always set it)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanAppearance } from './appearance.js';

export function resolveConfigDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.MARGIN_CONFIG_DIR) return path.resolve(env.MARGIN_CONFIG_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'margin');
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, 'margin');
  return path.join(home, '.config', 'margin');
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Write to a temporary file next to the target, then rename it over the target: a reader (or
// another Margin process writing at the same moment) sees the old file or the new one, never half
// of one. Two writers: the last rename wins.
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

// ---------- appearance settings (theme, editor font size, layout) ----------
const SETTINGS_FILE = 'settings.json';
const SETTINGS_VERSION = 1;

export function readAppearance(dir) {
  const data = readJson(path.join(dir, SETTINGS_FILE));
  return { settings: cleanAppearance(data), saved: !!data };
}

export function writeAppearance(dir, patch) {
  const update = cleanAppearance(patch);
  if (!Object.keys(update).length) throw new Error('Nothing to save: expected theme, fontSize or layout with an allowed value');
  const settings = { ...readAppearance(dir).settings, ...update };
  writeJsonAtomic(path.join(dir, SETTINGS_FILE), { version: SETTINGS_VERSION, ...settings, updatedAt: new Date().toISOString() });
  return { settings, saved: true };
}

// GET/PUT /appearance on a router whose requests already passed the localhost guards. `handle`
// is the server's usual wrapper that turns a thrown error into a JSON 400.
export function mountAppearanceRoutes(router, dir, handle) {
  router.get('/appearance', handle(async () => readAppearance(dir)));
  router.put('/appearance', handle(async (req) => writeAppearance(dir, req.body)));
}
