// The hub: one page listing the author's papers, and a process manager that runs each paper's
// ordinary Margin server (bin/margin.js <dir> --no-open --port P) as a child process. Reusing the
// CLI keeps the well-tested paper code path unchanged, and a paper that crashes cannot take the
// others (or the hub) down.
//
// - Each paper gets a port once (4243 and up, skipping ports in use) and keeps it: the registry
//   (projects.json in the config folder) remembers it, and the paper's .mcp.json is kept pointing
//   at it, so Claude Code in that folder always talks to that paper.
// - Children exit when the hub goes away, however it goes (bin/margin.js exits when the IPC
//   channel to the hub disconnects, which also happens when the hub is SIGKILLed).
// - The hub has the same localhost guards as a paper server (server/localhost.js), stricter on
//   GET: only the page at / may be reached by a link from another site or another paper.
import express from 'express';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loopbackHosts, hostGuard, crossSiteGuard, listenLoopback } from './localhost.js';
import { resolveConfigDir, readJson, writeJsonAtomic, mountAppearanceRoutes } from './config.js';
import { init, hooksInstalled } from './init.js';
import { pickFolder, openClaudeTerminal, runCommand } from './macos.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const MARGIN_BIN = path.join(here, '..', 'bin', 'margin.js');
const { version } = createRequire(import.meta.url)('../package.json');

export const DEFAULT_HUB_PORT = 4242;
export const FIRST_PAPER_PORT = 4243;
export const READY_PREFIX = 'MARGIN_HUB_READY';
const REGISTRY_FILE = 'projects.json';
const REGISTRY_VERSION = 1;
const STOP_GRACE_MS = 5000;

// ---------- registry: projects.json ----------
export class Registry {
  constructor(dir) {
    this.file = path.join(dir, REGISTRY_FILE);
    this.projects = [];
    if (!fs.existsSync(this.file)) return;
    const data = readJson(this.file);
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      // Unreadable: keep it aside (never silently overwrite the author's list) and start empty.
      const aside = `${this.file}.unreadable-${Date.now()}`;
      try { fs.renameSync(this.file, aside); } catch { /* read-only: the next save reports it */ }
      this.warning = `${REGISTRY_FILE} could not be read; it was moved to ${aside} and the list starts empty.`;
      return;
    }
    if (Number(data.version) > REGISTRY_VERSION) throw new Error(`${this.file} was written by a newer Margin (format ${data.version}). Update Margin, or point MARGIN_CONFIG_DIR elsewhere.`);
    this.projects = data.projects.filter((p) => p && typeof p.path === 'string' && Number.isInteger(p.port) && typeof p.id === 'string');
  }
  save() { writeJsonAtomic(this.file, { version: REGISTRY_VERSION, projects: this.projects }); }
  get(id) { return this.projects.find((p) => p.id === id); }
  byPath(p) { return this.projects.find((x) => x.path === p); }
}

export const paperId = (realPath) => crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 12);

// ---------- which folders may become papers ----------
// An existing folder (resolved with realpath) that holds a .tex file, and not one of the folders
// that would make no sense and could be large to watch: /, the home folder itself, the config
// folder, anything inside it or above it.
export function validatePaperPath(raw, { configDir, home = os.homedir() } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Give the folder that holds your paper');
  let p = raw.trim();
  if (/[\u0000-\u001f]/.test(p)) throw new Error('That path contains control characters');
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  if (!path.isAbsolute(p)) throw new Error(`Give the full path of the folder (starting with / or ~/): ${raw}`);
  let real;
  try { real = fs.realpathSync(p); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `No such folder: ${p}` : `Cannot open ${p} (${e.code || e.message})`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${real}`);
  const realOrSelf = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  if (real === path.parse(real).root) throw new Error('That is the root of the disk, not a paper folder');
  if (real === realOrSelf(home)) throw new Error('That is your home folder, not a paper folder. Choose the folder that holds the paper');
  if (configDir) {
    const cfg = realOrSelf(configDir);
    if (inside(real, cfg)) throw new Error("That is Margin's own settings folder, not a paper");
    if (inside(cfg, real)) throw new Error(`${real} contains Margin's settings folder; choose the folder that holds the paper`);
  }
  let names;
  try { names = fs.readdirSync(real); } catch (e) { throw new Error(`Cannot read ${real} (${e.code || e.message})`); }
  if (!names.some((n) => n.toLowerCase().endsWith('.tex'))) throw new Error(`No .tex file in ${real}. Choose the folder that holds the paper's main .tex file`);
  return real;
}

// ---------- ports ----------
export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function getJson(url, ms = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---------- .mcp.json: Claude Code's connection to the paper ----------
const mcpUrl = (port) => `http://127.0.0.1:${port}/mcp`;
const mcpPath = (dir) => path.join(dir, '.mcp.json');

// Never write through a symlink: it could lead out of the paper folder.
function writeMcp(dir, data) {
  const file = mcpPath(dir);
  let st = null;
  try { st = fs.lstatSync(file); } catch { /* absent */ }
  if (st && !st.isFile()) throw new Error('.mcp.json is not a plain file (a symlink?); Margin leaves it alone');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// What the paper's .mcp.json says about Margin: { setup, url?, problem? }.
export function readMcp(dir) {
  const file = mcpPath(dir);
  if (!fs.existsSync(file)) return { setup: false };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { setup: false, problem: `.mcp.json could not be read (${e.message}), so Claude Code may not connect to Margin. Fix or delete it, then press Set up for Claude.` };
  }
  const m = data?.mcpServers?.margin;
  if (!m || typeof m !== 'object') return { setup: false, data };
  return { setup: true, url: m.url, data };
}

// For a paper set up with `margin init`: point the margin entry at the paper's port. Only that
// entry's url changes; other servers and fields are kept. Returns a notice when it changed.
export function syncMcp(dir, port) {
  const r = readMcp(dir);
  if (!r.setup || r.url === mcpUrl(port)) return null;
  r.data.mcpServers.margin.url = mcpUrl(port);
  writeMcp(dir, r.data);
  return `.mcp.json now points Claude Code at port ${port}${r.url ? ` (it said ${r.url})` : ''}. If Claude Code is open in this folder, restart it (/exit, then claude) so it talks to this paper.`;
}

// "Set up for Claude": the existing `margin init` with the paper's port, then make sure the margin
// entry is in .mcp.json even if the file already existed with other servers (init leaves an
// existing .mcp.json alone).
export function setupClaude(dir, port) {
  const lines = [];
  const r0 = readMcp(dir);
  if (r0.problem) throw new Error(r0.problem);
  init(dir, { port, log: (l) => lines.push(l) });
  const r = readMcp(dir);
  if (!r.setup || r.url !== mcpUrl(port)) {
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    data.mcpServers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
    data.mcpServers.margin = { ...(data.mcpServers.margin || {}), type: 'http', url: mcpUrl(port) };
    writeMcp(dir, data);
  }
  return lines.join('\n').trim();
}

// ---------- the hub ----------
export async function startHub({
  port = DEFAULT_HUB_PORT,
  configDir = resolveConfigDir(),
  firstPaperPort = FIRST_PAPER_PORT,
  platform = process.platform,
  run = runCommand, // osascript runner, replaced by a stub in tests
  startTimeoutMs = 60000,
  log = () => {},
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const logsDir = path.join(configDir, 'logs');
  const registry = new Registry(configDir);
  if (registry.warning) log(`margin hub: ${registry.warning}`);
  const hubUrl = `http://127.0.0.1:${port}/`;
  const runtime = new Map(); // id -> { state, error, child, pid, exited, starting, stopping, notice }
  const rt = (id) => { if (!runtime.has(id)) runtime.set(id, { state: 'stopped' }); return runtime.get(id); };
  let closing = false;

  const logFile = (id) => path.join(logsDir, `${id}.log`);
  const logTail = (id, n = 6) => {
    try {
      const lines = fs.readFileSync(logFile(id), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--- '));
      return lines.slice(-n).join('\n').slice(-600);
    } catch { return ''; }
  };

  async function allocatePort() {
    const taken = new Set(registry.projects.map((p) => p.port));
    for (let p = firstPaperPort; p < firstPaperPort + 2000 && p <= 65535; p++) {
      if (p === port || taken.has(p)) continue;
      if (await isPortFree(p)) return p;
    }
    throw new Error('No free port found for this paper');
  }

  // One add at a time, so two papers added at once cannot be given the same port.
  let adding = Promise.resolve();
  function addPaper(raw) {
    const next = adding.then(async () => {
      const real = validatePaperPath(raw, { configDir });
      const existing = registry.byPath(real);
      if (existing) return existing;
      const entry = { id: paperId(real), path: real, name: path.basename(real), port: await allocatePort(), addedAt: new Date().toISOString(), lastOpened: null };
      registry.projects.push(entry);
      registry.save();
      return entry;
    });
    adding = next.catch(() => {});
    return next;
  }

  const need = (id) => {
    const e = registry.get(String(id));
    if (!e) throw Object.assign(new Error('No such paper in the list'), { status: 404 });
    return e;
  };

  function touch(entry) { entry.lastOpened = new Date().toISOString(); registry.save(); }

  // Who is on a paper's port when it is not ours: another Margin on this folder, or something else.
  async function portOccupant(entry) {
    const info = await getJson(`http://127.0.0.1:${entry.port}/api/project`, 1500);
    let same = false;
    try { same = !!info?.root && fs.realpathSync(info.root) === entry.path; } catch { /* gone */ }
    if (same) return `Margin is already running for this paper outside the hub (port ${entry.port}, probably a terminal running "margin"). Stop it there, then press Restart.`;
    return `Port ${entry.port}, which this paper uses, is taken by another program. Quit that program and press Restart, or remove the paper from the list and add it again to give it a new port.`;
  }

  async function startPaper(id) {
    const entry = need(id);
    const r = rt(entry.id);
    if (r.state === 'running') { touch(entry); return view(entry); }
    if (r.starting) return r.starting;
    r.starting = (async () => {
      r.state = 'starting'; r.error = null;
      try {
        if (closing) throw new Error('The hub is shutting down');
        if (!fs.existsSync(entry.path)) throw new Error(`Folder not found: ${entry.path}. Was it moved or deleted? Remove it from the list and add it again from its new place.`);
        touch(entry);
        try { const n = syncMcp(entry.path, entry.port); if (n) r.notice = n; } catch (e) { r.notice = `Could not update .mcp.json: ${e.message}`; }
        if (!(await isPortFree(entry.port))) throw new Error(await portOccupant(entry));
        await spawnPaper(entry, r);
        r.state = 'running';
      } catch (e) {
        r.state = 'error'; r.error = e.message;
        if (r.child && r.child.exitCode === null && r.child.signalCode === null) await stopChild(r);
      } finally {
        r.starting = null;
      }
      return view(entry);
    })();
    return r.starting;
  }

  async function spawnPaper(entry, r) {
    fs.mkdirSync(logsDir, { recursive: true });
    const fd = fs.openSync(logFile(entry.id), 'w');
    fs.writeSync(fd, `--- ${new Date().toISOString()} margin ${entry.path} --port ${entry.port} (started by the hub) ---\n`);
    let child;
    try {
      child = fork(MARGIN_BIN, [entry.path, '--no-open', '--port', String(entry.port)], {
        cwd: entry.path,
        env: { ...process.env, MARGIN_HUB_URL: hubUrl, MARGIN_CONFIG_DIR: configDir },
        execArgv: [],
        stdio: ['ignore', fd, fd, 'ipc'],
      });
    } finally {
      fs.closeSync(fd); // the child has its own copy
    }
    r.child = child; r.pid = child.pid; r.stopping = false;
    r.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.on('error', () => { /* reported through exit */ });
    r.exited.then(({ code, signal }) => {
      if (r.child !== child) return;
      r.child = null; r.pid = null;
      if (r.stopping || closing) { if (r.state !== 'error') r.state = 'stopped'; return; }
      if (r.state === 'running') {
        r.state = 'error';
        const tail = logTail(entry.id);
        r.error = `Margin stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`}).${tail ? `\n${tail}` : ''}\nFull log: ${logFile(entry.id)}`;
      }
    });

    // Running = its server answers, for this folder.
    const deadline = Date.now() + startTimeoutMs;
    let exitedEarly = null;
    r.exited.then((x) => { exitedEarly = x; });
    while (Date.now() < deadline) {
      if (closing) throw new Error('The hub is shutting down');
      if (exitedEarly) {
        const tail = logTail(entry.id);
        throw new Error(`Margin could not start this paper (${exitedEarly.signal ? `signal ${exitedEarly.signal}` : `exit code ${exitedEarly.code}`}).${tail ? `\n${tail}` : ''}\nFull log: ${logFile(entry.id)}`);
      }
      const info = await getJson(`http://127.0.0.1:${entry.port}/api/project`, 1500);
      let ours = false;
      try { ours = !!info?.root && fs.realpathSync(info.root) === entry.path; } catch { /* not yet */ }
      if (ours && !exitedEarly) return;
      await new Promise((ok) => setTimeout(ok, 150));
    }
    throw new Error(`Margin did not answer within ${Math.round(startTimeoutMs / 1000)} s. Full log: ${logFile(entry.id)}`);
  }

  async function stopChild(r) {
    const child = r.child;
    if (!child) return;
    r.stopping = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const done = await Promise.race([r.exited, new Promise((ok) => setTimeout(() => ok(null), STOP_GRACE_MS))]);
    if (!done) { try { child.kill('SIGKILL'); } catch { /* gone */ } await r.exited; }
  }

  async function stopPaper(id) {
    const entry = need(id);
    const r = rt(entry.id);
    if (r.starting) await r.starting;
    await stopChild(r);
    r.state = 'stopped'; r.error = null;
    return view(entry);
  }

  async function removePaper(id) {
    const entry = need(id);
    await stopPaper(entry.id);
    registry.projects = registry.projects.filter((p) => p.id !== entry.id);
    registry.save();
    runtime.delete(entry.id);
    return { ok: true, removed: entry.id };
  }

  function view(entry) {
    const r = rt(entry.id);
    const claude = readMcp(entry.path);
    return {
      id: entry.id, name: entry.name, path: entry.path, port: entry.port, url: `http://127.0.0.1:${entry.port}/`,
      addedAt: entry.addedAt, lastOpened: entry.lastOpened,
      state: r.state, error: r.error || null, pid: r.pid || null, notice: r.notice || null,
      missing: !fs.existsSync(entry.path),
      // outdated: set up by an older Margin, without the notification hooks (init adds them).
      claude: { setup: claude.setup, problem: claude.problem || null, outdated: claude.setup && !hooksInstalled(entry.path) },
    };
  }
  const list = () => [...registry.projects]
    .sort((a, b) => String(b.lastOpened || b.addedAt).localeCompare(String(a.lastOpened || a.addedAt)))
    .map(view);

  // ---------- HTTP ----------
  const app = express();
  const allowedHosts = loopbackHosts(port);
  app.use(hostGuard(allowedHosts));
  // Stricter than a paper server: every route but the page at / must come from the hub's own page
  // (or from no page at all: the address bar, a bookmark, the native app, curl), so a link on
  // another site or in a paper cannot start anything, even through /open/<id>.
  app.use(crossSiteGuard(allowedHosts, { guardReads: (req) => req.path !== '/' }));
  app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const handle = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
    catch (e) { res.status(e.status || 400).json({ error: e.message || String(e) }); }
  };
  api.get('/hub', handle(async () => ({ hub: true, version, platform, url: hubUrl, configDir })));
  api.get('/papers', handle(async () => ({ papers: list(), warning: registry.warning || null })));
  api.post('/papers', handle(async (req) => view(await addPaper(req.body?.path))));
  api.post('/papers/:id/start', handle(async (req) => startPaper(req.params.id)));
  api.post('/papers/:id/stop', handle(async (req) => stopPaper(req.params.id)));
  api.post('/papers/:id/opened', handle(async (req) => { const e = need(req.params.id); touch(e); return view(e); }));
  api.post('/papers/:id/setup-claude', handle(async (req) => {
    const e = need(req.params.id);
    const output = setupClaude(e.path, e.port);
    const r = rt(e.id);
    r.notice = `Set up for Claude. Run claude in ${e.path}${r.state === 'running' ? '' : ' after opening the paper'} (restart it if it is already open).`;
    return { ...view(e), output };
  }));
  api.post('/papers/:id/dismiss', handle(async (req) => { const e = need(req.params.id); rt(e.id).notice = null; return view(e); }));
  api.delete('/papers/:id', handle(async (req) => removePaper(req.params.id)));
  api.post('/pick-folder', handle(async () => {
    if (platform !== 'darwin') throw new Error('The folder picker is only available on macOS. Type the folder path instead.');
    const picked = await pickFolder({ run });
    return picked ? { path: picked } : { cancelled: true };
  }));
  api.post('/papers/:id/terminal', handle(async (req) => {
    const e = need(req.params.id);
    if (platform !== 'darwin') throw new Error('Opening a Claude terminal is only available on macOS.');
    await openClaudeTerminal(e.path, { run });
    return { ok: true };
  }));
  mountAppearanceRoutes(api, configDir, handle);
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  api.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(err.status || 500).json({ error: err.message }); });
  app.use('/api', api);

  // A Claude Code session still configured for the hub's port (an old `margin init` used 4242).
  app.all('/mcp', (req, res) => res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'This is the Margin hub, not a paper. Open the paper from the hub (it updates .mcp.json), then restart Claude Code in the paper folder.' } }));

  // root: Margin itself may live under a dot-folder, which sendFile refuses in an absolute path.
  const page = (req, res) => res.sendFile('hub.html', { root: PUBLIC });
  app.get('/', page);
  app.get('/open/:id', page);
  for (const f of ['hub.js', 'hub.css', 'style.css']) app.get(`/${f}`, (req, res) => res.sendFile(f, { root: PUBLIC }));
  app.use((req, res) => res.status(404).send('Not found'));

  const { server, server6 } = await listenLoopback(app, port);

  // Last resort if the hub process exits without close(): don't leave children behind (they also
  // exit by themselves when the IPC channel goes, see bin/margin.js).
  const onExit = () => { for (const r of runtime.values()) { try { r.child?.kill('SIGTERM'); } catch { /* gone */ } } };
  process.on('exit', onExit);

  async function close() {
    if (closing) return;
    closing = true;
    process.off('exit', onExit);
    await Promise.all([...runtime.values()].map(async (r) => { if (r.starting) await r.starting.catch(() => {}); await stopChild(r); }));
    await Promise.all([server, server6].map((s) => new Promise((ok) => {
      if (!s.listening) return ok();
      s.close(() => ok());
      s.closeAllConnections(); // a hub page's open keep-alive connection must not hold the port
    })));
  }

  return { url: hubUrl, port, configDir, registry, close, list, addPaper, startPaper, stopPaper, pids: () => [...runtime.values()].map((r) => r.pid).filter(Boolean) };
}
