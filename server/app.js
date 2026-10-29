// HTTP + WebSocket server: REST API for the browser UI, /mcp for Claude Code,
// and a file watcher so edits from anywhere (Claude, git pull, another editor)
// show up live. Binds to 127.0.0.1 only.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { mountResponseRoutes } from './responses.js';
import { createClaudeLink } from './asks.js';
import { changes as projectChanges, acceptedSince } from './changes.js';
import * as latexdiff from './latexdiff.js';
import { loopbackHosts, hostGuard, crossSiteGuard, upgradeAllowed, listenLoopback } from './localhost.js';
import { mountAppearanceRoutes } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const UPLOAD_LIMIT = '20mb'; // same as the JSON limit for saving a file

// configDir: the author's Margin config folder (server/config.js). When given, appearance settings
// (theme, font size, layout) are shared with every other paper through it; tests leave it out.
// hubUrl: set when the hub started this server, for the link back to it in the top bar.
export async function startServer({ root, port = 4242, main, engine, configDir, hubUrl }) {
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
  const state = { editor: null, lastCompile: null, compiling: null, diffing: null };

  const app = express();
  const wss = new WebSocketServer({ noServer: true });

  // Host check and cross-site refusal (server/localhost.js), on HTTP and the WebSocket alike.
  const allowedHosts = loopbackHosts(port);
  app.use(hostGuard(allowedHosts));
  app.use(crossSiteGuard(allowedHosts));

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

  const claude = createClaudeLink({ review, broadcast });
  const ctx = { project, review, state, broadcast, compile: runCompile };
  review.on('change', () => broadcast({ type: 'review-changed' }));

  // ---------- MCP (stateless Streamable HTTP; one server instance per request) ----------
  app.post('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
    claude.noteMcp(req.body);
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
  // Uploads are raw bytes whatever their type (a .json upload must not be parsed as the request body).
  const jsonBody = express.json({ limit: '20mb' });
  api.use((req, res, next) => (req.path === '/upload' ? next() : jsonBody(req, res, next)));
  const handle = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
    catch (e) { res.status(e.status || 400).json({ error: e.message || String(e) }); }
  };

  const hub = typeof hubUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(hubUrl) ? hubUrl : null;
  api.get('/project', handle(async () => ({ name: project.name, root: project.root, main: project.main, settings, git: await git.status(project), lastCompile: state.lastCompile ? summarize(state.lastCompile) : null, ...(hub ? { hub } : {}) })));
  // Theme, font size and layout, shared across papers through the config folder (web/src/settings.js).
  if (configDir) mountAppearanceRoutes(api, configDir, handle);
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
    // exclusive=1: create only, never replace (the UI's "new file" uses it so it cannot clobber a file Claude just made).
    project.write(p, req.body.content, { exclusive: req.query.exclusive === '1' });
    noteSelfWrite(project.rel(project.abs(p)), req.body.content);
    if (settings.autoCompile) scheduleAutoCompile();
    return { ok: true, mtime: fs.statSync(project.abs(p)).mtimeMs };
  }));
  // ---- file management: folders, rename, delete, upload, reveal. All of it goes through Project's guard. ----
  api.post('/folder', handle(async (req) => ({ ok: true, ...project.mkdir(String(req.body?.path || '')) })));
  api.post('/file/rename', handle(async (req) => {
    const { from, to, overwrite } = req.body || {};
    const r = project.rename(String(from || ''), String(to || ''), { overwrite: overwrite === true });
    // Comments and suggestions follow the file; the store is the only writer of review.json.
    const reviewItems = review.moveFile(r.from, r.to);
    if (state.editor?.file && (state.editor.file === r.from || state.editor.file.startsWith(r.from + '/'))) state.editor = { ...state.editor, file: r.to + state.editor.file.slice(r.from.length) };
    return { ok: true, ...r, reviewItems };
  }));
  // Review items on a deleted file are kept, not deleted: they show as "file missing" and anchor again
  // if a file of that name comes back (a pull from Overleaf, a restore). review.json is not under
  // version control, so dropping them would be unrecoverable.
  api.delete('/file', handle(async (req) => {
    const r = project.remove(String(req.query.path || ''));
    const reviewItemsKept = review.itemsUnder(r.path).length;
    if (reviewItemsKept) broadcast({ type: 'review-changed' }); // their cards now read "file missing"
    return { ok: true, ...r, reviewItemsKept };
  }));
  api.post('/upload', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), handle(async (req) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return { ok: true, ...project.writeBinary(String(req.query.path || ''), buf, { overwrite: req.query.overwrite === '1' }) };
  }));
  // "Reveal in Finder/Explorer": opens the OS file manager on a path inside the paper folder.
  api.post('/reveal', handle(async (req) => {
    const rel = String(req.body?.path || '');
    const abs = project.abs(rel);
    if (!fs.existsSync(abs)) throw new Error(`Not found: ${rel}`);
    const isDir = fs.statSync(abs).isDirectory();
    const [cmd, args] = process.platform === 'darwin' ? ['open', isDir ? [abs] : ['-R', abs]]
      : process.platform === 'win32' ? ['explorer.exe', isDir ? [abs] : [`/select,${abs}`]]
      : ['xdg-open', [isDir ? abs : path.dirname(abs)]];
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `No file manager found to open (${cmd} is not installed). The folder is ${project.root}` : e.message)));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { ok: true };
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
  mountResponseRoutes(api, { review, handle, broadcast }); // response to referees

  api.post('/editor-state', handle(async (req) => { state.editor = { ...req.body, at: Date.now() }; return { ok: true }; }));

  api.get('/git/status', handle(async () => ({ ...await git.status(project), remoteCheck: gitTimer ? { ...gitFetch } : null })));
  api.post('/git/sync', handle(async (req) => { const r = await git.sync(project, { message: req.body.message || undefined }); broadcast({ type: 'tree-changed' }); return r; }));
  api.post('/git/pull', handle(async () => { const r = await git.pull(project); broadcast({ type: 'tree-changed' }); return r; }));
  // Changes view (server/changes.js): per-file hunks since the last sync or since the last commit, and the
  // suggestions accepted since a time. Read-only; nothing here moves HEAD or touches the working tree.
  api.get('/changes', handle(async (req) => projectChanges(project, { since: req.query.since || 'sync' })));
  api.get('/changes/accepted', handle(async (req) => acceptedSince(project, review, req.query.since || 'sync')));
  // Marked-up PDF of the changes (server/latexdiff.js), built under .margin-build/diff/, served at /pdf-diff.
  api.get('/latexdiff', handle(async () => ({ ...(await latexdiff.checkLatexdiff()), last: latexdiff.lastDiff(project), building: !!state.diffing })));
  api.post('/latexdiff', handle(async (req) => {
    const ref = req.body?.ref;
    if (ref != null && typeof ref !== 'string') throw new Error('ref must be a string');
    if (state.diffing) throw Object.assign(new Error('A diff PDF is already being built. Wait for it to finish.'), { status: 409 });
    state.diffing = latexdiff.makeDiffPdf(project, { ref, engine: settings.engine });
    try { return await state.diffing; } finally { state.diffing = null; }
  }));
  api.get('/wordcount', handle(async () => countProject(project.main, (rel) => project.read(rel))));
  api.get('/search', handle(async (req) => projectSearch.search(project, { q: req.query.q, regex: req.query.regex === '1', caseSensitive: req.query.case === '1', whole: req.query.whole === '1' })));
  api.post('/replace', handle(async (req) => {
    const r = projectSearch.replace(project, review, req.body || {});
    // Cards quoting replaced text re-anchor or flag themselves ("text changed"); they are not rewritten.
    if (!r.dryRun && r.replaced) broadcast({ type: 'review-changed' });
    return r;
  }));
  api.get('/citations', handle(async () => checkCitations(project)));

  claude.mount(api);
  // Errors from the body parsers (an oversized upload, malformed JSON) as JSON, like every other error here.
  api.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const tooBig = err.type === 'entity.too.large';
    res.status(tooBig ? 413 : err.status || 500).json({ error: tooBig ? `That is over the ${UPLOAD_LIMIT.toUpperCase()} limit.` : err.message });
  });
  app.use('/api', api);
  app.get('/pdf', (req, res) => {
    if (!fs.existsSync(project.pdfPath)) return res.status(404).send('No PDF yet');
    res.set('Cache-Control', 'no-store');
    res.sendFile(project.pdfPath, { dotfiles: 'allow' }); // .margin-build is a dot-folder
  });
  // The latexdiff build lives in its own folder; the real PDF above is never replaced by it.
  app.get('/pdf-diff', (req, res) => {
    if (!fs.existsSync(latexdiff.diffPdfPath(project))) return res.status(404).send('No diff PDF yet');
    res.set('Cache-Control', 'no-store');
    res.sendFile(latexdiff.diffPdfPath(project), { dotfiles: 'allow' });
  });
  app.use(express.static(PUBLIC, { index: 'index.html' }));

  // ---------- WebSocket ----------
  const onUpgrade = (req, socket, head) => {
    if (!upgradeAllowed(req, allowedHosts) || !req.url.startsWith('/ws')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
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

  // 127.0.0.1, and ::1 as well when the machine has IPv6 (macOS may resolve localhost to it first).
  const { server, server6 } = await listenLoopback(app, port, { onUpgrade });
  return { server, project, review, gitPoll, gitTimerActive: () => gitTimer !== null, close: async () => { clearInterval(gitTimer); claude.close(); gitTimer = null; await watcher.close(); wss.close(); server.close(); server6.close(); } };
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
