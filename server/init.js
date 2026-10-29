// `margin init`: prepare a manuscript repo for Margin + Claude Code.
// Everything it adds is listed in .git/info/exclude (a local-only ignore file),
// so none of it is pushed to Overleaf or shows up for co-authors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(here, '..', 'templates');
const LOCAL_ONLY = ['.review/', '.margin-build/', '.claude/', '.mcp.json'];

export function init(dir, { port = 4242, log = console.log } = {}) {
  if (!fs.existsSync(dir)) throw new Error(`No such folder: ${dir}`);
  const done = [];
  const skipped = [];

  // 1. Keep Margin's and Claude's files out of git (and therefore out of Overleaf).
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(gitDir)) {
    const added = ensureLocalOnlyExcluded(dir);
    if (added.length) done.push(`git: kept ${added.join(', ')} out of commits (.git/info/exclude)`);
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir }).toString().trim();
      if (!/overleaf\.com/.test(remote)) skipped.push(`origin is ${remote.replace(/\/\/[^@/]+@/, '//')} (not Overleaf) — Sync will push there`);
    } catch { skipped.push('no "origin" remote — Sync will only commit locally'); }
  } else {
    skipped.push('not a git repository — clone your Overleaf project with git for syncing (see README)');
  }

  // 2. Claude Code: MCP server, auto-approval, instructions, slash commands.
  writeIfAbsent(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { margin: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }, null, 2) + '\n', done, skipped, dir);

  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = readJson(settingsPath);
  settings.enabledMcpjsonServers = [...new Set([...(settings.enabledMcpjsonServers || []), 'margin'])];
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = [...new Set([...(settings.permissions.allow || []), 'mcp__margin__*'])];
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  done.push('.claude/settings.local.json: approved the margin MCP server and its tools');

  writeIfAbsent(path.join(dir, '.claude', 'CLAUDE.md'), fs.readFileSync(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8'), done, skipped, dir);
  for (const f of fs.readdirSync(path.join(TEMPLATES, 'commands'))) {
    writeIfAbsent(path.join(dir, '.claude', 'commands', f), fs.readFileSync(path.join(TEMPLATES, 'commands', f), 'utf8'), done, skipped, dir);
  }

  log(`\nMargin set up in ${dir}\n`);
  for (const d of done) log(`  ✓ ${d}`);
  for (const s of skipped) log(`  · ${s}`);
  log(`\nNext:\n  margin "${dir}"          # start the editor\n  cd "${dir}" && claude    # in another terminal\n\nEdit .claude/CLAUDE.md to describe your journal, style and terminology.\n`);
  return { done, skipped };
}

function writeIfAbsent(file, content, done, skipped, dir) {
  const rel = path.relative(dir, file);
  if (fs.existsSync(file)) { skipped.push(`${rel} already exists — left unchanged`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  done.push(`created ${rel}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// The promise that nothing Margin creates reaches Overleaf rests entirely on these
// entries in .git/info/exclude, because git.sync() stages everything with `git add -A`.
// `margin init` writes them, but `margin <dir>` runs happily on a repo that was never
// inited, so the server calls this on startup too. Returns the entries it added.
export function ensureLocalOnlyExcluded(dir) {
  const gitDir = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(gitDir); } catch { return []; }
  if (!st.isDirectory()) return []; // linked worktree or submodule: .git is a file, not a dir
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const missing = LOCAL_ONLY.filter((p) => !current.split('\n').includes(p));
  if (!missing.length) return [];
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, `${current.endsWith('\n') || current === '' ? '' : '\n'}# Margin (local only, never pushed to Overleaf)\n${missing.join('\n')}\n`);
  return missing;
}
