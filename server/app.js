// HTTP + WebSocket server: REST API for the browser UI, /mcp for Claude Code,
// and a file watcher so edits from anywhere (Claude, git pull, another editor)
// show up live. Binds to 127.0.0.1 only.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Project, BUILD_DIR, REVIEW_DIR } from './project.js';
import { ReviewStore } from './review.js';
import { compile, forwardSearch, inverseSearch } from './compile.js';
import * as git from './git.js';
import { checkCitations } from './bib.js';
import { buildMcpServer } from './mcp.js';
import { ensureLocalOnlyExcluded } from './init.js';
import { countProject } from './wordcount.js';
import * as projectSearch from './search.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

export async function startServer({ root, port = 4242, main, engine }) {
  const project = new Project(root, { main });
  // CLAUDE.md: nothing Margin creates may reach Overleaf. git.sync() stages with
  // `git add -A`, so the local-only paths must be excluded even when `margin init`
  // was never run on this folder.
  try {
    const added = ensureLocalOnlyExcluded(project.root);
    if (added.length) console.log(`margin: kept ${added.join(', ')} out of git (.git/info/exclude)`);
  } catch (e) {
    console.warn(`margin: could not update .git/info/exclude (${e.message}). Run "margin init" before syncing, or Margin's own files may be pushed to Overleaf.`);
  }
  const config = loadConfig(project);
  if (!main && config.main) project.main = config.main;
  const settings = { engine: engine || config.engine || 'pdflatex', autoCompile: config.autoCompile ?? false };
  const review = new ReviewStore(project);
  const state = { editor: null, lastCompile: null, compiling: null };

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  // Guard against DNS rebinding: only answer requests addressed to localhost.
  app.use((req, res, next) => (allowedHosts.has(req.headers.host) ? next() : res.status(403).send('Forbidden host')));

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const c of wss.clients) if (c.readyState === 1) { c.send(data); n++; }
    return n;
  };

  const runCompile = async (by = 'you') => {
    if (state.compiling) return state.compiling; // coalesce concurrent requests
    broadcast({ type: 'compile-start', by });
    state.compiling = compile(project, { engine: settings.engine }).then((r) => {
      state.lastCompile = { ...r, at: Date.now(), by };
      state.compiling = null;
      broadcast({ type: 'compile-done', by, ok: r.ok, pdf: r.pdf, errors: r.errors, warnings: r.warnings, durationMs: r.durationMs, at: state.lastCompile.at });
      return r;
    });
    return state.compiling;
  };

  const ctx = { project, review, state, broadcast, compile: runCompile };
  review.on('change', () => broadcast({ type: 'review-changed' }));

  // ---------- MCP (stateless Streamable HTTP; one server instance per request) ----------
  app.post('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
    const mcp = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null });
    }
  });
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method not allowed'));
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method not allowed'));

  // ---------- REST API for the UI ----------
  const api = express.Router();
  api.use(express.json({ limit: '20mb' }));
  const handle = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
    catch (e) { res.status(400).json({ error: e.message || String(e) }); }
  };

  api.get('/project', handle(async () => ({ name: project.name, root: project.root, main: project.main, settings, git: await git.status(project), lastCompile: state.lastCompile ? summarize(state.lastCompile) : null })));
  api.put('/settings', handle(async (req) => {
    if (req.body.engine && ['pdflatex', 'xelatex', 'lualatex'].includes(req.body.engine)) settings.engine = req.body.engine;
    if (typeof req.body.autoCompile === 'boolean') settings.autoCompile = req.body.autoCompile;
    if (req.body.main && project.exists(req.body.main)) project.main = req.body.main;
    saveConfig(project, { main: project.main, engine: settings.engine, autoCompile: settings.autoCompile });
    return { settings, main: project.main };
  }));
  api.get('/tree', handle(async () => project.tree()));
  api.get('/file', handle(async (req) => {
    const p = String(req.query.path || '');
    const stat = fs.statSync(project.abs(p));
    return { path: p, content: project.read(p), mtime: stat.mtimeMs };
  }));
  api.put('/file', handle(async (req) => {
    const p = String(req.query.path || '');
    if (typeof req.body.content !== 'string') throw new Error('content is required');
    project.write(p, req.body.content);
    noteSelfWrite(project.rel(project.abs(p)), req.body.content);
    if (settings.autoCompile) scheduleAutoCompile();
    return { ok: true, mtime: fs.statSync(project.abs(p)).mtimeMs };
  }));
  api.get('/raw', (req, res) => {
    try { res.sendFile(project.abs(String(req.query.path || '')), { dotfiles: 'allow' }); } catch (e) { res.status(400).send(e.message); }
  });

  api.post('/compile', handle(async () => summarize(await runCompile('you'))));
  api.get('/compile/log', handle(async () => ({ log: state.lastCompile?.log || '' })));
  api.get('/synctex/forward', handle(async (req) => forwardSearch(project, String(req.query.file), Number(req.query.line), Number(req.query.column || 0))));
  api.get('/synctex/inverse', handle(async (req) => inverseSearch(project, Number(req.query.page), Number(req.query.x), Number(req.query.y))));

  api.get('/review', handle(async (req) => review.list({ status: req.query.status || 'all', file: req.query.file })));
  api.post('/review/comment', handle(async (req) => review.addComment({ ...req.body, author: 'you' })));
  api.post('/review/suggest', handle(async (req) => review.addSuggestion({ ...req.body, author: 'you' })));
  // Accepting rewrites the file on disk; the watcher reports it as an external change so the editor reloads.
  api.post('/review/:id/accept', handle(async (req) => review.accept(req.params.id, { replacement: req.body.replacement })));
  api.post('/review/:id/unaccept', handle(async (req) => review.unaccept(req.params.id)));
  api.post('/review/:id/reject', handle(async (req) => review.reject(req.params.id, { reason: req.body.reason })));
  api.post('/review/:id/resolve', handle(async (req) => review.resolve(req.params.id)));
  api.post('/review/:id/reopen', handle(async (req) => review.reopen(req.params.id)));
  api.post('/review/:id/reply', handle(async (req) => review.reply(req.params.id, { body: req.body.body, author: 'you' })));
  api.delete('/review/:id', handle(async (req) => review.remove(req.params.id)));
  api.post('/review/clear-closed', handle(async () => ({ removed: review.clearClosed() })));

  api.post('/editor-state', handle(async (req) => { state.editor = { ...req.body, at: Date.now() }; return { ok: true }; }));

  api.get('/git/status', handle(async () => ({ ...await git.status(project), remoteCheck: gitTimer ? { ...gitFetch } : null })));
  api.post('/git/sync', handle(async (req) => { const r = await git.sync(project, { message: req.body.message || undefined }); broadcast({ type: 'tree-changed' }); return r; }));
  api.post('/git/pull', handle(async () => { const r = await git.pull(project); broadcast({ type: 'tree-changed' }); return r; }));
  api.get('/wordcount', handle(async () => countProject(project.main, (rel) => project.read(rel))));
  api.get('/search', handle(async (req) => projectSearch.search(project, { q: req.query.q, regex: req.query.regex === '1', caseSensitive: req.query.case === '1', whole: req.query.whole === '1' })));
  api.post('/replace', handle(async (req) => {
    const r = projectSearch.replace(project, review, req.body || {});
    // Cards quoting replaced text re-anchor or flag themselves ("text changed"); they are not rewritten.
    if (!r.dryRun && r.replaced) broadcast({ type: 'review-changed' });
    return r;
  }));
  api.get('/citations', handle(async () => checkCitations(project)));

  app.use('/api', api);
  app.get('/pdf', (req, res) => {
    if (!fs.existsSync(project.pdfPath)) return res.status(404).send('No PDF yet');
    res.set('Cache-Control', 'no-store');
    res.sendFile(project.pdfPath, { dotfiles: 'allow' }); // .margin-build is a dot-folder
  });
  app.use(express.static(PUBLIC, { index: 'index.html' }));

  // ---------- WebSocket ----------
  const onUpgrade = (req, socket, head) => {
    if (!allowedHosts.has(req.headers.host) || !req.url.startsWith('/ws')) { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', project: project.name })));

  // ---------- File watcher ----------
  // Files the UI just saved: rel path -> { hash of the bytes written, at }. A watcher event is our own
  // echo only if the file on disk still has exactly those bytes, so a different write that lands right
  // after an autosave is always reported as external. Entries are kept after a match (a single save can
  // produce more than one event), dropped on the first mismatch, and swept by age and count.
  const selfWrites = new Map();
  const SELF_TTL_MS = 30000, SELF_MAX = 500;
  const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  function noteSelfWrite(rel, content) {
    selfWrites.delete(rel); // re-insert so Map order is oldest-first
    selfWrites.set(rel, { hash: hashOf(Buffer.from(content, 'utf8')), at: Date.now() });
    const now = Date.now();
    for (const [k, v] of selfWrites) {
      if (selfWrites.size > SELF_MAX || now - v.at > SELF_TTL_MS) selfWrites.delete(k); else break;
    }
  }
  function isSelfWrite(rel) {
    const e = selfWrites.get(rel);
    if (!e) return false;
    let same = false;
    try { same = hashOf(fs.readFileSync(project.abs(rel))) === e.hash; } catch { /* gone or unreadable: not ours */ }
    if (!same) selfWrites.delete(rel);
    return same;
  }
  const watcher = chokidar.watch(project.root, {
    ignored: (p) => { const rel = project.rel(p); return rel !== '' && project.isIgnored(rel); },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });
  watcher.on('all', (event, p) => {
    const rel = project.rel(p);
    if (event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') broadcast({ type: 'tree-changed' });
    if (event === 'change' || event === 'add') {
      const external = !isSelfWrite(rel);
      broadcast({ type: 'file-changed', path: rel, external });
      if (external) { broadcast({ type: 'review-changed' }); if (settings.autoCompile) scheduleAutoCompile(); }
    }
  });
  let autoTimer = null;
  const scheduleAutoCompile = () => { clearTimeout(autoTimer); autoTimer = setTimeout(() => runCompile('auto'), 1200); };

  // ---------- Overleaf polling ----------
  // Fetch every few minutes so the author learns about co-authors' commits. Failures (offline, remote
  // wants a password) are silent: the next tick simply tries again. Only started for a repo with a remote.
  const GIT_POLL_MS = 180000;
  let gitTimer = null, gitLast = null, gitPolling = false;
  // A fetch that keeps failing (expired Overleaf token, offline, revoked access) must not
  // read as "up to date": status().behind would quietly go back to being stale, which is the
  // exact problem this poll exists to fix. Two consecutive failures is about six minutes, so
  // a sleeping laptop or a wifi blip stays quiet.
  const gitFetch = { checked: false, failures: 0, error: '' };
  const gitKey = (st) => `${st.behind}/${st.ahead}/${(st.incoming || []).join('\n')}/${gitFetch.failures > 1}`;
  const gitPoll = async () => {
    if (gitPolling) return;
    gitPolling = true;
    try {
      const r = await git.fetchRemote(project);
      gitFetch.checked = true;
      if (r.ok) { gitFetch.failures = 0; gitFetch.error = ''; }
      else { gitFetch.failures++; gitFetch.error = r.out; }
      const st = await git.status(project);
      if (!st.repo || st.behind == null) return;
      if (gitKey(st) !== gitLast) { gitLast = gitKey(st); broadcast({ type: 'git-changed', behind: st.behind, ahead: st.ahead, files: st.incoming || [], reachable: gitFetch.failures <= 1 }); }
    } catch { /* silent */ } finally { gitPolling = false; }
  };
  if (await git.hasRemote(project)) {
    gitLast = gitKey(await git.status(project));
    gitTimer = setInterval(gitPoll, GIT_POLL_MS);
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // On macOS "localhost" often resolves to the IPv6 address ::1 first, so answer there too.
  // Best effort: machines without IPv6 just keep the IPv4 listener.
  const server6 = http.createServer(app);
  server6.on('upgrade', onUpgrade);
  await new Promise((resolve) => { server6.once('error', () => resolve()); server6.listen(port, '::1', resolve); });
  return { server, project, review, gitPoll, gitTimerActive: () => gitTimer !== null, close: async () => { clearInterval(gitTimer); gitTimer = null; await watcher.close(); wss.close(); server.close(); server6.close(); } };
}

function summarize(r) {
  return { ok: r.ok, pdf: r.pdf, errors: r.errors, warnings: r.warnings, durationMs: r.durationMs, at: r.at };
}

function loadConfig(project) {
  try { return JSON.parse(fs.readFileSync(path.join(project.root, REVIEW_DIR, 'config.json'), 'utf8')); } catch { return {}; }
}
function saveConfig(project, cfg) {
  fs.mkdirSync(path.join(project.root, REVIEW_DIR), { recursive: true });
  fs.writeFileSync(path.join(project.root, REVIEW_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
}

export { BUILD_DIR };
