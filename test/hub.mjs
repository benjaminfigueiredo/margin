// End-to-end test of the hub (server/hub.js, `margin hub`): papers as child processes on stable
// ports, .mcp.json kept in step, shared appearance settings, the localhost guards, the macOS
// helpers (with a stub: osascript never runs here), and that no child outlives the hub.
// Run by `npm run test:api` after test/run.mjs. Uses a temporary config folder throughout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub, isPortFree, paperId, READY_PREFIX } from '../server/hub.js';
import { startServer } from '../server/app.js';
import { init } from '../server/init.js';
import { claudeTerminalCommand, folderPickerCommand } from '../server/macos.js';
import { resolveConfigDir } from '../server/config.js';
import { freePort } from './free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'margin.js');
const step = (name) => console.log(`\n── hub: ${name}`);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-hub-')));
const cfg = path.join(tmp, 'config');
const hubPort = await freePort();
const firstPaperPort = hubPort + 1;

function makePaper(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(here, '..', 'examples', 'sample-paper'), dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'init');
  return dir;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// A zombie (exited, not yet reaped by an init that does not reap) counts as gone.
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/s.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
async function waitGone(pid, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(100); }
  return false;
}
// Raw request, so Host, Origin and Sec-Fetch-Site can be anything a browser (or attacker) sends.
function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, json, text: data }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const hubApi = (port) => async (p, { method = 'GET', body, headers } = {}) => {
  const r = await raw(port, { method, path: `/api${p}`, body, headers });
  return { status: r.status, body: r.json };
};

const paperA = makePaper('paper-a');
const paperB = makePaper('paper-b');
const notPaper = path.join(tmp, 'notes'); fs.mkdirSync(notPaper); fs.writeFileSync(path.join(notPaper, 'todo.txt'), 'x');
// A was set up with an old `margin init` (port 4242, the hub's own port) and has another MCP server too.
init(paperA, { port: 4242, log: () => {} });
{
  const m = readJson(path.join(paperA, '.mcp.json'));
  m.mcpServers.other = { type: 'stdio', command: 'other-server', args: ['--flag'] };
  fs.writeFileSync(path.join(paperA, '.mcp.json'), JSON.stringify(m, null, 2));
}
// B was never inited, but has an .mcp.json for something else.
fs.writeFileSync(path.join(paperB, '.mcp.json'), JSON.stringify({ mcpServers: { zotero: { type: 'http', url: 'http://127.0.0.1:9999/mcp' } } }, null, 2));

const osa = [];
let pickAnswer = null;
const stubRun = async (cmd, args) => {
  osa.push([cmd, args]);
  if (args.some((a) => a.includes('choose folder'))) {
    if (pickAnswer === 'cancel') throw Object.assign(new Error('Command failed'), { stderr: '0:42: execution error: User canceled. (-128)' });
    return { stdout: `${pickAnswer}\n`, stderr: '' };
  }
  return { stdout: '', stderr: '' };
};

step('config folder location');
assert.equal(resolveConfigDir({ env: {}, platform: 'darwin', home: '/Users/x' }), '/Users/x/Library/Application Support/margin');
assert.equal(resolveConfigDir({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', home: '/home/x' }), '/xdg/margin');
assert.equal(resolveConfigDir({ env: {}, platform: 'linux', home: '/home/x' }), '/home/x/.config/margin');
assert.equal(resolveConfigDir({ env: { MARGIN_CONFIG_DIR: '/tmp/m', XDG_CONFIG_HOME: '/xdg' }, platform: 'darwin', home: '/Users/x' }), '/tmp/m');

let hub = await startHub({ port: hubPort, configDir: cfg, firstPaperPort, platform: 'linux', run: stubRun });
let api = hubApi(hubPort);
const hubOrigin = `http://127.0.0.1:${hubPort}`;
console.log(`hub on ${hub.url}, config ${cfg}`);

step('a bad folder is refused');
for (const [bad, why] of [
  ['', 'empty'], ['relative/paper', 'relative'], [path.join(tmp, 'nope'), 'missing'], [path.join(paperA, 'main.tex'), 'a file'],
  ['/', 'the disk root'], [os.homedir(), 'the home folder'], ['~', 'the home folder, as ~'], [cfg, 'the config folder'], [path.join(cfg, 'logs'), 'inside the config folder'],
  [tmp, 'a folder holding the config folder'], [notPaper, 'no .tex file'], [`${paperA}\u0007x`, "a control character"],
]) {
  const r = await api('/papers', { method: 'POST', body: { path: bad } });
  assert.equal(r.status, 400, `${why} refused`); assert.ok(r.body.error, why);
}
assert.equal((await api('/papers', { method: 'POST', body: {} })).status, 400, 'no path');
assert.equal((await api('/papers')).body.papers.length, 0);
console.log('relative, missing, file, /, ~, config folder (and inside/above it), no .tex: all refused');

step('two papers get distinct ports; adding one again changes nothing');
// Added at the same moment: still two different ports.
const [a, b] = (await Promise.all([api('/papers', { method: 'POST', body: { path: paperA } }), api('/papers', { method: 'POST', body: { path: paperB + '/' } })])).map((r) => r.body);
assert.ok(a.port >= firstPaperPort && b.port >= firstPaperPort && a.port !== b.port && a.port !== hubPort && b.port !== hubPort);
assert.equal(a.id, paperId(paperA)); assert.equal(b.path, paperB);
assert.equal(a.state, 'stopped'); assert.equal(a.claude.setup, true); assert.equal(b.claude.setup, false);
const again = (await api('/papers', { method: 'POST', body: { path: path.join(paperA, '..', 'paper-a') } })).body;
assert.equal(again.id, a.id); assert.equal(again.port, a.port);
assert.equal((await api('/papers')).body.papers.length, 2);
const reg = readJson(path.join(cfg, 'projects.json'));
assert.equal(reg.version, 1); assert.deepEqual(reg.projects.map((p) => p.port).sort(), [a.port, b.port].sort());
assert.ok(!fs.readdirSync(cfg).some((f) => f.endsWith('.tmp')), 'atomic write leaves no temp file');
console.log(`A on ${a.port}, B on ${b.port}`);

step('starting: both answer, and the same paper is never started twice');
const [s1, s2, s3] = await Promise.all([api(`/papers/${a.id}/start`, { method: 'POST' }), api(`/papers/${a.id}/start`, { method: 'POST' }), api(`/papers/${b.id}/start`, { method: 'POST' })]);
for (const s of [s1, s2, s3]) { assert.equal(s.status, 200); assert.equal(s.body.state, 'running', s.body.error); }
assert.equal(s1.body.pid, s2.body.pid, 'one process for A');
assert.notEqual(s1.body.pid, s3.body.pid);
const again2 = await api(`/papers/${a.id}/start`, { method: 'POST' });
assert.equal(again2.body.pid, s1.body.pid, 'starting a running paper is a no-op');
const pidA = s1.body.pid, pidB = s3.body.pid;
for (const [p, dir] of [[a, paperA], [b, paperB]]) {
  const proj = await (await fetch(`http://127.0.0.1:${p.port}/api/project`)).json();
  assert.equal(fs.realpathSync(proj.root), dir);
  assert.equal(proj.hub, hub.url, 'the paper knows its hub (for the link back)');
}
assert.ok(readJson(path.join(cfg, 'projects.json')).projects.find((p) => p.id === a.id).lastOpened, 'last opened recorded');
assert.match(fs.readFileSync(path.join(cfg, 'logs', `${a.id}.log`), 'utf8'), /Margin is editing paper-a/, 'child output goes to its log');
console.log(`A pid ${pidA}, B pid ${pidB}`);

step('.mcp.json follows the port: updated for an inited paper, other entries kept');
{
  const m = readJson(path.join(paperA, '.mcp.json'));
  assert.equal(m.mcpServers.margin.url, `http://127.0.0.1:${a.port}/mcp`);
  assert.equal(m.mcpServers.margin.type, 'http');
  assert.deepEqual(m.mcpServers.other, { type: 'stdio', command: 'other-server', args: ['--flag'] });
  const view = (await api('/papers')).body.papers.find((p) => p.id === a.id);
  assert.match(view.notice, /restart it/, 'the author is told to restart Claude Code');
  assert.match(view.notice, /4242/);
  const mb = readJson(path.join(paperB, '.mcp.json'));
  assert.deepEqual(mb, { mcpServers: { zotero: { type: 'http', url: 'http://127.0.0.1:9999/mcp' } } }, 'a paper not set up is left alone');
  assert.equal((await api(`/papers/${a.id}/dismiss`, { method: 'POST' })).body.notice, null);
  // Nothing reaches git: the hub wrote nothing into the paper but .mcp.json, which is excluded.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: paperA }).toString().trim(), '');
}
console.log('A now points at its own port; "other" untouched; B untouched');

step('"Set up for Claude" runs margin init with the paper\'s port and keeps the other server');
{
  const r = await api(`/papers/${b.id}/setup-claude`, { method: 'POST' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.claude.setup, true);
  assert.match(r.body.output, /Margin set up in/);
  const mb = readJson(path.join(paperB, '.mcp.json'));
  assert.equal(mb.mcpServers.margin.url, `http://127.0.0.1:${b.port}/mcp`);
  assert.deepEqual(mb.mcpServers.zotero, { type: 'http', url: 'http://127.0.0.1:9999/mcp' });
  assert.ok(readJson(path.join(paperB, '.claude', 'settings.local.json')).enabledMcpjsonServers.includes('margin'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: paperB }).toString().trim(), '', 'all of it stays out of git');
  // And Claude Code's MCP client reaches B through that URL.
  const res = await fetch(mb.mcpServers.margin.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
  assert.equal(res.status, 200);
}
console.log('B set up for Claude at its own port');

step('the hub refuses cross-site requests and other hosts, including from a paper page');
{
  const paperOrigin = `http://127.0.0.1:${a.port}`;
  const post = (headers) => raw(hubPort, { method: 'POST', path: '/api/papers', body: { path: paperB }, headers });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await post({ Origin: paperOrigin })).status, 403, "a paper's page (another port, another origin)");
  assert.equal((await post({ Origin: 'null' })).status, 403, 'opaque Origin');
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'Sec-Fetch-Site cross-site');
  assert.equal((await post({ 'Sec-Fetch-Site': 'same-site' })).status, 403, 'Sec-Fetch-Site same-site (a paper page)');
  assert.equal((await raw(hubPort, { path: '/api/papers', headers: { Origin: paperOrigin } })).status, 403, 'reads too');
  assert.equal((await raw(hubPort, { path: '/api/papers', headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403, 'a no-cors read from a paper page');
  assert.equal((await raw(hubPort, { path: `/open/${a.id}`, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 403, 'a link from another site cannot start a paper');
  assert.equal((await raw(hubPort, { path: `/open/${a.id}`, headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 403, 'nor a link in a paper');
  assert.equal((await raw(hubPort, { method: 'POST', path: `/api/papers/${a.id}/stop`, headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: 'x' })).status, 403);
  assert.equal((await raw(hubPort, { path: '/api/papers', headers: { Host: `evil.example:${hubPort}` } })).status, 403, 'DNS rebinding: wrong Host');
  assert.equal((await raw(hubPort, { path: '/', headers: { Host: 'evil.example' } })).status, 403);
  // The page itself may be reached by a link (from a paper's "Papers" link, say), but not framed.
  const page = await raw(hubPort, { path: '/', headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(page.status, 200); assert.match(page.text, /hub\.js/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await raw(hubPort, { path: '/api/papers', headers: { Origin: hubOrigin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200, "the hub's own page");
  assert.equal((await raw(hubPort, { path: `/open/${a.id}`, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await raw(hubPort, { path: '/api/hub', headers: { Host: `localhost:${hubPort}` } })).status, 200);
  assert.equal((await raw(hubPort, { path: '/index.html' })).status, 404, "the hub does not serve a paper's UI");
  // A Claude Code session still pointed at the hub's port gets an explanation, not a paper.
  const mcp = await raw(hubPort, { method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
  assert.equal(mcp.status, 404); assert.match(mcp.json.error.message, /hub, not a paper/);
  // The paper's own guard (same shared code) still refuses the hub's origin.
  assert.equal((await raw(a.port, { method: 'POST', path: '/api/compile', headers: { Origin: hubOrigin, 'Content-Type': 'text/plain' }, body: 'x' })).status, 403, 'a paper refuses the hub page too');
  assert.equal(hub.list().length, 2, 'nothing was added or changed by the refused requests');
}
console.log('foreign origins, papers\' origins, cross-site and same-site, wrong Host: refused');

step('appearance settings are shared by every paper (and the hub)');
{
  const getA = async () => (await fetch(`http://127.0.0.1:${a.port}/api/appearance`)).json();
  assert.equal((await getA()).saved, false);
  const put = (port, body) => fetch(`http://127.0.0.1:${port}/api/appearance`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(a.port, { theme: 'dark', fontSize: 16 })).status, 200);
  const fromB = await (await fetch(`http://127.0.0.1:${b.port}/api/appearance`)).json();
  assert.deepEqual(fromB, { settings: { theme: 'dark', fontSize: 16 }, saved: true });
  assert.equal((await put(b.port, { layout: 'split' })).status, 200);
  assert.deepEqual((await getA()).settings, { theme: 'dark', fontSize: 16, layout: 'split' }, 'a partial update keeps the rest');
  assert.equal((await api('/appearance')).body.settings.theme, 'dark');
  assert.equal((await put(a.port, { theme: 'purple', fontSize: 99 })).status, 400, 'bad values refused');
  assert.equal((await raw(a.port, { method: 'PUT', path: '/api/appearance', headers: { Origin: `http://127.0.0.1:${b.port}` }, body: { theme: 'light' } })).status, 403, 'another paper\'s page cannot write them');
  // Two papers writing at once: atomic, last write wins, the file is always whole.
  await Promise.all(Array.from({ length: 20 }, (_, i) => put(i % 2 ? a.port : b.port, { fontSize: [12, 13, 14, 15, 16, 18, 20][i % 7] })));
  const file = readJson(path.join(cfg, 'settings.json'));
  assert.equal(file.version, 1); assert.ok([12, 13, 14, 15, 16, 18, 20].includes(file.fontSize));
  assert.ok(!fs.readdirSync(cfg).some((f) => f.endsWith('.tmp')));
  await put(a.port, { theme: 'system', fontSize: 14, layout: 'auto' });
}
console.log('one settings.json in the config folder, read and written by both papers');

step('Stop');
{
  const r = await api(`/papers/${a.id}/stop`, { method: 'POST' });
  assert.equal(r.body.state, 'stopped'); assert.equal(r.body.pid, null);
  assert.ok(await waitGone(pidA), 'A\'s process is gone');
  assert.ok(await isPortFree(a.port));
  assert.equal((await api('/papers')).body.papers.find((p) => p.id === b.id).state, 'running', 'B keeps running');
}

step('a port taken by something else is reported, not fought over');
{
  const squatter = http.createServer((req, res) => res.end('hi'));
  await new Promise((ok) => squatter.listen(a.port, '127.0.0.1', ok));
  let r = await api(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'error'); assert.match(r.body.error, /taken by another program/);
  await new Promise((ok) => squatter.close(ok));
  // A standalone `margin` on the same folder and port.
  const standalone = await startServer({ root: paperA, port: a.port });
  r = await api(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'error'); assert.match(r.body.error, /already running for this paper outside the hub/);
  await standalone.close();
  await sleep(100);
  r = await api(`/papers/${a.id}/start`, { method: 'POST' }); // Restart from the error state
  assert.equal(r.body.state, 'running', r.body.error); assert.equal(r.body.error, null);
}
console.log('busy port: a clear error, then Restart works once it is free');

step('a paper that dies is shown as an error, with Restart');
{
  const pid = (await api('/papers')).body.papers.find((p) => p.id === a.id).pid;
  process.kill(pid, 'SIGKILL');
  let v;
  for (let i = 0; i < 50; i++) { v = (await api('/papers')).body.papers.find((p) => p.id === a.id); if (v.state === 'error') break; await sleep(100); }
  assert.equal(v.state, 'error'); assert.match(v.error, /stopped unexpectedly \(signal SIGKILL\)/); assert.match(v.error, /Full log:/);
  assert.equal((await api('/papers')).body.papers.find((p) => p.id === b.id).state, 'running', 'the other paper is unaffected');
  const r = await api(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'running');
}

step('a paper whose folder has gone says so');
{
  const broken = makePaper('paper-broken');
  const p = (await api('/papers', { method: 'POST', body: { path: broken } })).body;
  fs.rmSync(broken, { recursive: true });
  let r = await api(`/papers/${p.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'error'); assert.match(r.body.error, /Folder not found/); assert.equal(r.body.missing, true);
  assert.equal((await api(`/papers/${p.id}`, { method: 'DELETE' })).status, 200);
}

step('Remove from list stops the paper and never touches its files');
{
  const before = fs.readdirSync(paperB).sort();
  const r = await api(`/papers/${b.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(await waitGone(pidB));
  assert.deepEqual(fs.readdirSync(paperB).sort(), before);
  assert.ok(fs.existsSync(path.join(paperB, 'main.tex')));
  assert.deepEqual((await api('/papers')).body.papers.map((p) => p.id), [a.id]);
  assert.equal((await api(`/papers/${b.id}/start`, { method: 'POST' })).status, 404);
}

step('macOS actions are refused elsewhere');
assert.equal((await api('/pick-folder', { method: 'POST' })).status, 400);
assert.equal((await api(`/papers/${a.id}/terminal`, { method: 'POST' })).status, 400);
assert.equal(osa.length, 0);

step('close() stops every child');
{
  const pids = hub.pids();
  assert.equal(pids.length, 1);
  await hub.close();
  for (const pid of pids) assert.ok(await waitGone(pid), `child ${pid} gone after close()`);
  assert.ok(await isPortFree(a.port)); assert.ok(await isPortFree(hubPort));
}

step('ports survive a hub restart (and the macOS helpers, with a stub)');
hub = await startHub({ port: hubPort, configDir: cfg, firstPaperPort, platform: 'darwin', run: stubRun });
api = hubApi(hubPort);
{
  const list = (await api('/papers')).body.papers;
  assert.deepEqual(list.map((p) => [p.id, p.port, p.state]), [[a.id, a.port, 'stopped']]);
  const r = await api(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'running'); assert.equal(r.body.port, a.port); assert.equal(r.body.notice, null, '.mcp.json already right: no notice');
  // B, added again after its removal, gets a port of its own.
  const b2 = (await api('/papers', { method: 'POST', body: { path: paperB } })).body;
  assert.ok(b2.port !== a.port);
  // Folder picker: a constant script, the answer is validated like a typed path.
  pickAnswer = paperB + '/';
  assert.deepEqual((await api('/pick-folder', { method: 'POST' })).body, { path: paperB + '/' });
  pickAnswer = 'cancel';
  assert.deepEqual((await api('/pick-folder', { method: 'POST' })).body, { cancelled: true });
  const [cmd, args] = osa[0];
  assert.equal(cmd, 'osascript'); assert.deepEqual([cmd, args], folderPickerCommand());
  assert.ok(args.every((x, i) => (i % 2 === 0 ? x === '-e' : true)), 'only -e statements');
  // Claude terminal: the folder is an argument to the script, never part of its text.
  const nasty = path.join(tmp, 'it\'s "odd" $(touch pwned) & `x`');
  fs.cpSync(paperB, nasty, { recursive: true });
  const n = (await api('/papers', { method: 'POST', body: { path: nasty } })).body;
  osa.length = 0;
  assert.equal((await api(`/papers/${n.id}/terminal`, { method: 'POST' })).status, 200);
  const [tcmd, targs] = osa[0];
  assert.equal(tcmd, 'osascript');
  assert.equal(targs.at(-1), nasty, 'the folder is the last argument, verbatim');
  assert.ok(targs.slice(0, -1).every((x) => !x.includes(tmp)), 'and appears nowhere in the script');
  assert.ok(targs.slice(0, -1).some((x) => x.includes('quoted form of (item 1 of argv)')), 'shell-quoted by AppleScript');
  assert.deepEqual(targs, claudeTerminalCommand(nasty)[1]);
  assert.throws(() => claudeTerminalCommand('relative/path'));
  await api(`/papers/${n.id}`, { method: 'DELETE' });
  await hub.close();
}
console.log('same ports after restart; picker and terminal commands built safely (stub, osascript not run)');

step('margin hub (CLI): ready line, and SIGKILL of the hub takes its papers with it');
{
  const cfg2 = path.join(tmp, 'config-cli');
  const port2 = await freePort();
  const paperPort = port2 + 1;
  // A hand-written registry (what the hub would have written) with A on a known port.
  fs.mkdirSync(cfg2, { recursive: true });
  fs.writeFileSync(path.join(cfg2, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: a.id, path: paperA, name: 'paper-a', port: paperPort, addedAt: new Date().toISOString(), lastOpened: null }] }));
  const proc = spawn(process.execPath, [BIN, 'hub', '--port', String(port2), '--no-open'], { env: { ...process.env, MARGIN_CONFIG_DIR: cfg2 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes(READY_PREFIX); i++) await sleep(100);
  assert.match(out, new RegExp(`^MARGIN_HUB_READY http://127\\.0\\.0\\.1:${port2}/$`, 'm'), `ready line printed:\n${out}`);
  const api2 = hubApi(port2);
  // A second hub on the same port says so and exits.
  const second = spawn(process.execPath, [BIN, 'hub', '--port', String(port2), '--no-open'], { env: { ...process.env, MARGIN_CONFIG_DIR: cfg2 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; second.stderr.on('data', (d) => { out2 += d; });
  const code2 = await new Promise((ok) => second.on('exit', ok));
  assert.equal(code2, 1); assert.match(out2, /hub is already running/);
  const r = await api2(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'running', r.body.error);
  assert.equal(r.body.port, paperPort);
  const child = r.body.pid;
  assert.ok(alive(child));
  proc.kill('SIGKILL');
  assert.ok(await waitGone(child), 'the paper exits when its hub is SIGKILLed');
  assert.ok(await isPortFree(paperPort));
  console.log(`hub pid ${proc.pid} SIGKILLed; paper pid ${child} exited by itself`);
}

step('SIGTERM to margin hub stops its papers; bare `margin` picks paper or hub by the folder');
{
  const cfg3 = path.join(tmp, 'config-bare');
  const port3 = await freePort();
  const paperPort = port3 + 1;
  fs.mkdirSync(cfg3, { recursive: true });
  fs.writeFileSync(path.join(cfg3, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: a.id, path: paperA, name: 'paper-a', port: paperPort, addedAt: new Date().toISOString(), lastOpened: null }] }));
  // In a folder with no .tex file, bare `margin` is the hub.
  const proc = spawn(process.execPath, [BIN, '--port', String(port3), '--no-open'], { cwd: notPaper, env: { ...process.env, MARGIN_CONFIG_DIR: cfg3 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes(READY_PREFIX); i++) await sleep(100);
  assert.match(out, /No \.tex file in .*, so starting the hub/);
  assert.match(out, new RegExp(`^MARGIN_HUB_READY http://127\\.0\\.0\\.1:${port3}/$`, 'm'));
  const r = await hubApi(port3)(`/papers/${a.id}/start`, { method: 'POST' });
  assert.equal(r.body.state, 'running', r.body.error);
  proc.kill('SIGTERM');
  const code = await new Promise((ok) => proc.on('exit', ok));
  assert.equal(code, 0);
  assert.ok(await waitGone(r.body.pid), 'SIGTERM stopped the paper before the hub exited');
  // In a paper folder, bare `margin` is the editor for it, exactly as before.
  const port4 = await freePort();
  const ed = spawn(process.execPath, [BIN, '--port', String(port4), '--no-open'], { cwd: paperB, env: { ...process.env, MARGIN_CONFIG_DIR: cfg3 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let eout = ''; ed.stdout.on('data', (d) => { eout += d; });
  for (let i = 0; i < 100 && !eout.includes('Claude MCP'); i++) await sleep(100);
  assert.match(eout, /Margin is editing paper-b/); assert.doesNotMatch(eout, /MARGIN_HUB_READY/);
  const proj = await (await fetch(`http://127.0.0.1:${port4}/api/project`)).json();
  assert.equal(proj.hub, undefined, 'a standalone paper has no hub link');
  assert.match(eout, /\.mcp\.json points Claude Code at port/, 'a standalone start warns when .mcp.json names another port');
  ed.kill('SIGTERM');
  await new Promise((ok) => ed.on('exit', ok));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll hub checks passed.');
process.exit(0);
