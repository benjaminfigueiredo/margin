// End-to-end test: Claude's MCP tools, the review store, compile, SyncTeX, bibliography.
//   npm test                         starts a throwaway server on a copy of examples/sample-paper
//   node test/run.mjs <server-url>   runs against a server you started yourself (on a fresh sample paper)
// Needs a TeX installation with latexmk, bibtex and synctex.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/app.js';
import { Project } from '../server/project.js';

let base = process.argv[2];
let running = null;
let tmp = null;
if (!base) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-test-'));
  const paper = path.join(tmp, 'paper');
  fs.cpSync(path.join(here, '..', 'examples', 'sample-paper'), paper, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: paper, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'init');
  const port = 43000 + Math.floor(Math.random() * 2000);
  running = await startServer({ root: paper, port });
  base = `http://127.0.0.1:${port}`;
  console.log(`Test server on ${base} for ${paper}`);
}

const client = new Client({ name: 'margin-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  return { error: !!r.isError, text };
};
const rest = async (path, opts = {}) => {
  const res = await fetch(`${base}/api${path}`, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return res.json();
};
const step = (name) => console.log(`\n── ${name}`);

step('tools/list');
const { tools } = await client.listTools();
console.log(tools.map((t) => t.name).join(', '));
assert.ok(tools.length >= 14);

step('compile');
let r = await call('compile');
console.log(r.text);
assert.match(r.text, /missingref2020/);
assert.match(r.text, /sec:result/);

step('check_citations');
r = await call('check_citations');
console.log(r.text);
assert.match(r.text, /missingref2020/);
assert.match(r.text, /unused2019/);

step('suggest_edit (quote typed on one line, source wraps differently)');
r = await call('suggest_edit', {
  file: 'sections/intro.tex',
  original: 'Copepods are the most abundant metazoans in the ocean and they play a key role in the transfer of energy',
  replacement: 'Copepods, the most abundant metazoans in the ocean, play a key role in transferring energy',
  rationale: 'Tighter; removes the comma splice.',
});
console.log(r.text); assert.ok(!r.error);
const suggId = r.text.match(/Suggestion (\w+)/)[1];

step('suggest_edit with ambiguous quote → helpful error');
r = await call('suggest_edit', { file: 'sections/intro.tex', original: 'heatwaves', replacement: 'heat waves', rationale: 'x' });
console.log(r.text); assert.ok(r.error);

step('overlapping suggestion → refused');
r = await call('suggest_edit', { file: 'sections/intro.tex', original: 'they play a key role', replacement: 'play a central role', rationale: 'x' });
console.log(r.text); assert.ok(r.error);

step('suggest_edits batch');
r = await call('suggest_edits', { edits: [
  { file: 'main.tex', original: 'Marine heatwaves are becoming more frequent and it is very important to understand how small organisms respond to them.', replacement: 'Marine heatwaves are becoming more frequent, yet how small organisms respond to them remains poorly understood.', rationale: 'Avoids "it is very important"; states the gap.' },
  { file: 'sections/intro.tex', original: 'it is not well known how', replacement: 'little is known about how', rationale: 'More direct.' },
  { file: 'sections/intro.tex', original: 'does not exist anywhere', replacement: 'x', rationale: 'should fail' },
] });
console.log(r.text); assert.match(r.text, /3\. FAILED/);

step('add_comment');
r = await call('add_comment', { file: 'sections/intro.tex', quote: '\\citep{missingref2020}', comment: 'This key is not in refs.bib. Which paper did you mean — one of the single-heatwave studies on Acartia?' });
console.log(r.text); assert.ok(!r.error);

step('author leaves a comment for Claude (REST, as the UI does)');
await rest('/review/comment', { method: 'POST', body: { file: 'sections/methods.tex', quote: 'held for 72 hours', comment: 'Claude: should we justify why 72 h?' } });
r = await call('list_review', { author: 'you' });
console.log(r.text); assert.match(r.text, /72 h/);

step('accept a suggestion (REST) → source file changes');
const items = await rest('/review');
const target = items.find((i) => i.id.startsWith(suggId));
const before = (await rest('/file?path=sections/intro.tex')).content;
await rest(`/review/${target.id}/accept`, { method: 'POST', body: {} });
const after = (await rest('/file?path=sections/intro.tex')).content;
assert.ok(!before.includes('Copepods,') && after.includes('Copepods, the most abundant metazoans'));
console.log('accepted; intro.tex now contains the new sentence');

step('other suggestions in the same file still anchored after the edit');
r = await call('list_review', { file: 'sections/intro.tex' });
console.log(r.text); assert.ok(!/no longer found/.test(r.text));

step('reply + resolve');
const comment = (await rest('/review')).find((i) => i.author === 'you');
r = await call('reply', { id: comment.id.slice(0, 8), text: '72 h matches the median duration of recent events in the region; I can add a citation.' });
console.log(r.text);
r = await call('resolve', { id: comment.id.slice(0, 8) });
console.log(r.text);

step('SyncTeX forward + inverse');
await call('compile');
const fwd = await rest('/synctex/forward?file=sections/methods.tex&line=5');
console.log('forward', fwd); assert.ok(fwd.page >= 1);
const inv = await rest(`/synctex/inverse?page=${fwd.page}&x=${fwd.h + 5}&y=${fwd.v - 2}`);
console.log('inverse', inv); assert.equal(inv.file, 'sections/methods.tex');

step('path safety: symlinks (Project.abs)');
{
  const { Project } = await import('../server/project.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-symlink-'));
  try {
    const outside = path.join(dir, 'outside');
    const paper = path.join(dir, 'paper');
    fs.mkdirSync(outside); fs.mkdirSync(path.join(paper, 'real'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'ORIGINAL');
    fs.writeFileSync(path.join(paper, 'real', 'in.tex'), 'inside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(paper, 'link.txt'));
    fs.symlinkSync(outside, path.join(paper, 'linkdir'));
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(paper, 'dangling.txt'));
    fs.symlinkSync(path.join(paper, 'real'), path.join(paper, 'okdir'));
    fs.symlinkSync(path.join(paper, 'real', 'in.tex'), path.join(paper, 'ok.tex'));
    const proj = new Project(paper);

    // file symlink pointing outside: write refused, target unchanged, read refused too
    assert.throws(() => proj.write('link.txt', 'PWNED'), /Path escapes project.*link\.txt/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'ORIGINAL');
    assert.throws(() => proj.read('link.txt'), /Path escapes project/);
    // directory symlink pointing outside: existing and new files under it refused
    assert.throws(() => proj.write('linkdir/secret.txt', 'PWNED'), /Path escapes project/);
    assert.throws(() => proj.write('linkdir/new/deep.txt', 'PWNED'), /Path escapes project/);
    assert.ok(!fs.existsSync(path.join(outside, 'new')));
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'ORIGINAL');
    // dangling symlink: a write would create the outside target
    assert.throws(() => proj.write('dangling.txt', 'PWNED'), /Path escapes project/);
    assert.ok(!fs.existsSync(path.join(outside, 'not-yet.txt')));
    // symlinks that stay inside keep working; new files and folders still can be created
    proj.write('okdir/via-link.tex', 'x');
    assert.equal(fs.readFileSync(path.join(paper, 'real', 'via-link.tex'), 'utf8'), 'x');
    assert.equal(proj.read('ok.tex'), 'inside');
    proj.write('sub/dir/new.tex', 'n');
    assert.equal(proj.read('sub/dir/new.tex'), 'n');
    // lexical escapes still refused
    assert.throws(() => proj.abs('../outside/secret.txt'), /Path escapes project/);

    // paper root itself behind a symlink (macOS /var, /tmp): ordinary paths must work (cf. 3471077)
    const viaLink = path.join(dir, 'root-link');
    fs.symlinkSync(paper, viaLink);
    const p2 = new Project(viaLink);
    p2.write('chapters/a.tex', 'hello');
    assert.equal(p2.read('chapters/a.tex'), 'hello');
    assert.equal(p2.read('ok.tex'), 'inside');
    assert.throws(() => p2.write('link.txt', 'PWNED'), /Path escapes project/);
    console.log('symlink checks ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

step('editor state (as posted by the UI)');
await rest('/editor-state', { method: 'POST', body: { file: 'main.tex', cursorLine: 15, selection: { text: 'measured survival, egg production', fromLine: 16, toLine: 16 } } });
r = await call('get_editor_state');
console.log(r.text); assert.match(r.text, /egg production/);

step('add_bib_entry from BibTeX, duplicate refused');
r = await call('add_bib_entry', { bibtex: '@article{smith2021heat, author={Smith, J.}, title={Repeated heat stress in copepods}, journal={J. Plankton Res.}, year={2021}, doi={10.1093/plankt/fbab000}}' });
console.log(r.text); assert.ok(!r.error);
r = await call('add_bib_entry', { bibtex: '@article{other, title={dup}, doi={10.1093/PLANKT/fbab000}}' });
console.log(r.text); assert.ok(r.error);

// Zotero tools against a fake Zotero (Better BibTeX JSON-RPC, then the local API
// fallback). Only when the test server runs in-process, so it sees the env var.
if (running) {
  const zot = await fakeZotero();
  process.env.MARGIN_ZOTERO_URL = zot.url;

  step('search_zotero via Better BibTeX (words in any order)');
  r = await call('search_zotero', { query: 'copepod heatwave' });
  console.log(r.text);
  assert.match(r.text, /leeHeatwaveCopepod2022/);
  assert.match(r.text, /library: Lab group/);

  step('cite_from_zotero: group library found, local fields dropped, duplicate refused');
  r = await call('cite_from_zotero', { key: 'leeHeatwaveCopepod2022' });
  console.log(r.text); assert.ok(!r.error);
  const bib = fs.readFileSync(path.join(tmp, 'paper', 'refs.bib'), 'utf8');
  assert.match(bib, /@article\{leeHeatwaveCopepod2022,/);
  assert.match(bib, /^  month\s*= jul,?$/m);
  assert.doesNotMatch(bib, /Zotero\/storage|abstract/);
  r = await call('search_zotero', { query: 'heatwave' });
  assert.match(r.text, /already in refs\.bib/);
  r = await call('cite_from_zotero', { key: 'leeHeatwaveCopepod2022' });
  console.log(r.text); assert.ok(r.error);
  r = await call('cite_from_zotero', { key: 'nosuchkey' });
  console.log(r.text); assert.ok(r.error); assert.match(r.text, /search_zotero/);

  step('Zotero local API fallback (no Better BibTeX)');
  zot.mode = 'local';
  r = await call('search_zotero', { query: 'grazing' });
  console.log(r.text); assert.match(r.text, /kimGrazing2020/);
  r = await call('cite_from_zotero', { key: 'kimGrazing2020' });
  console.log(r.text); assert.ok(!r.error); assert.match(r.text, /\\cite\{kimGrazing2020\}/);

  step('Zotero not running');
  await zot.close();
  r = await call('search_zotero', { query: 'anything' });
  console.log(r.text); assert.ok(r.error); assert.match(r.text, /Zotero is not running/);
}

// Path safety: Project.abs() is the only gate between client paths and the disk,
// and Project.write() adds the ignored-folder check. Uses its own temp folders so
// it runs the same whether the server is in-process or external.
step('Project.abs: traversal rejected, normal paths normalised');
const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-pathsafe-'));
const proj = new Project(safeDir);
for (const bad of ['../outside.tex', 'sections/../../outside.tex', '', null, 'a/../../..', `../${path.basename(safeDir)}-sibling/x.tex`]) {
  assert.throws(() => proj.abs(bad), /path is required|escapes project/, `should reject ${JSON.stringify(bad)}`);
}
assert.equal(proj.abs('main.tex'), path.join(safeDir, 'main.tex'));
assert.equal(proj.abs('./main.tex'), path.join(safeDir, 'main.tex'));
assert.equal(proj.abs('sections/intro.tex'), path.join(safeDir, 'sections', 'intro.tex'));
assert.equal(proj.abs('sections\\intro.tex'), path.join(safeDir, 'sections', 'intro.tex'));
assert.equal(proj.abs('/main.tex'), path.join(safeDir, 'main.tex'));
// Leading slash is stripped, so '/etc/passwd' is NOT rejected: it maps to <root>/etc/passwd.
// Confined to the paper folder, which is what matters here.
assert.equal(proj.abs('/etc/passwd'), path.join(safeDir, 'etc', 'passwd'));

step('HTTP API refuses traversal paths and writes nothing');
const paperRoot = (await rest('/project')).root;
const probe = path.join(path.dirname(paperRoot), 'margin-escape-probe.tex');
const q = (p) => `?path=${encodeURIComponent(p)}`;
let res = await fetch(`${base}/api/file${q('../package.json')}`);
assert.equal(res.status, 400); assert.match((await res.json()).error, /escapes project/);
res = await fetch(`${base}/api/file${q('../margin-escape-probe.tex')}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'PWNED' }) });
assert.equal(res.status, 400); assert.match((await res.json()).error, /escapes project/);
res = await fetch(`${base}/api/file${q('sections/../../margin-escape-probe.tex')}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'PWNED' }) });
assert.equal(res.status, 400);
assert.equal(fs.existsSync(probe), false, 'PUT through traversal must not create a file outside the paper');
res = await fetch(`${base}/api/raw${q('../package.json')}`);
assert.equal(res.status, 400); assert.match(await res.text(), /escapes project/);

step('Project.write refuses ignored folders');
for (const bad of ['.review/x', '.git/config', '.claude/settings.local.json']) {
  assert.throws(() => proj.write(bad, 'x'), /ignored folder/, `should refuse ${bad}`);
}
assert.equal(fs.existsSync(path.join(safeDir, '.review')), false);
assert.equal(fs.existsSync(path.join(safeDir, '.git')), false);

// Escaping symlinks have their own step ("path safety: symlinks") further up.
fs.rmSync(safeDir, { recursive: true, force: true });

step('review store: versioning, backups, corruption');
{
  const { ReviewStore, CURRENT_VERSION } = await import('../server/review.js');
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'margin-rs-'));
  const storeIn = (dir) => new ReviewStore({ reviewDir: path.join(dir, '.review'), read: () => '' });
  const item = (id, status = 'open') => ({ id, kind: 'comment', file: 'main.tex', quote: 'q', body: 'b', author: 'x', status, replies: [] });
  const put = (dir, obj) => { fs.mkdirSync(path.join(dir, '.review'), { recursive: true }); fs.writeFileSync(path.join(dir, '.review', 'review.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const rj = (dir) => path.join(dir, '.review', 'review.json');

  // version 0 (and unversioned) files migrate, keeping items; the original is backed up
  let d = mk(); put(d, { version: 0, items: [item('aaaa1111')] });
  let s = storeIn(d);
  assert.equal(s.data.version, CURRENT_VERSION); assert.equal(s.data.items.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(rj(d), 'utf8')).version, CURRENT_VERSION);
  assert.equal(JSON.parse(fs.readFileSync(rj(d) + '.bak', 'utf8')).version, 0);
  d = mk(); put(d, { items: [item('bbbb2222')] });
  assert.equal(storeIn(d).data.items.length, 1);

  // too-new version: refuses with a readable error and leaves the file untouched
  d = mk(); const future = JSON.stringify({ version: 99, items: [item('cccc3333')], extra: true });
  put(d, future);
  assert.throws(() => storeIn(d), (e) => e.message.includes(rj(d)) && /newer version of Margin/.test(e.message) && /Update Margin/.test(e.message));
  assert.equal(fs.readFileSync(rj(d), 'utf8'), future);

  // truncated file: moved aside, not overwritten
  d = mk(); const broken = '{"version":1,"items":[{"id":"dddd'; put(d, broken);
  const warn = console.warn; console.warn = () => {};
  try { s = storeIn(d); } finally { console.warn = warn; }
  assert.equal(s.data.items.length, 0);
  assert.ok(!fs.existsSync(rj(d)));
  const aside = fs.readdirSync(path.join(d, '.review')).filter((f) => f.startsWith('review.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(d, '.review', aside[0]), 'utf8'), broken);
  s.data.items.push(item('eeee5555')); s.save();
  assert.equal(fs.readFileSync(path.join(d, '.review', aside[0]), 'utf8'), broken);

  // backup after a save holds the previous state; rotation is capped
  s.data.items.push(item('ffff6666')); s.save();
  assert.equal(JSON.parse(fs.readFileSync(rj(d) + '.bak', 'utf8')).items.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(rj(d), 'utf8')).items.length, 2);
  for (let i = 0; i < 6; i++) { s.data.items.push(item('gggg000' + i)); s.save(); }
  assert.ok(!fs.existsSync(rj(d) + '.bak4'));
  assert.ok(!fs.existsSync(rj(d) + '.tmp'));

  // clearClosed archives what it removes
  d = mk(); put(d, { version: 1, items: [item('h1', 'open'), item('h2', 'accepted'), item('h3', 'rejected')] });
  s = storeIn(d);
  assert.equal(s.clearClosed(), 2);
  assert.deepEqual(s.data.items.map((i) => i.id), ['h1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, '.review', 'archive.json'), 'utf8')).items.map((i) => i.id), ['h2', 'h3']);
}

console.log('\nAll checks passed.');
await client.close();
if (running) { await running.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(0);

// Minimal stand-in for Zotero on 23119: Better BibTeX's item.search/item.export
// (mode 'bbt'), or only Zotero's local API with BBT absent (mode 'local').
async function fakeZotero() {
  const http = await import('node:http');
  const items = [
    { id: 'http://zotero.org/groups/1/items/AAAA1111', library: 'Lab group', citekey: 'leeHeatwaveCopepod2022', title: 'Marine heatwave effects on copepod fecundity', author: [{ family: 'Lee', given: 'A.' }], issued: { 'date-parts': [[2022]] }, 'container-title': 'Limnol. Oceanogr.', DOI: '10.1002/lno.99999',
      bib: '@article{leeHeatwaveCopepod2022,\n  title = {Marine Heatwave Effects on Copepod Fecundity},\n  author = {Lee, A.},\n  year = 2022,\n  month = jul,\n  journal = {Limnol. Oceanogr.},\n  doi = {10.1002/lno.99999},\n  abstract = {Long text.},\n  file = {/Users/someone/Zotero/storage/X/Lee.pdf}\n}\n' },
  ];
  const localItem = { key: 'BBBB2222', data: { key: 'BBBB2222', itemType: 'journalArticle', title: 'Grazing by copepods', creators: [{ creatorType: 'author', firstName: 'B.', lastName: 'Kim' }], date: '2020', extra: 'Citation Key: kimGrazing2020' } };
  const state = { mode: 'bbt' };
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/better-bibtex/json-rpc') {
      if (state.mode !== 'bbt') return send(404, 'No endpoint found', 'text/plain');
      const { method, params } = JSON.parse(body);
      if (method === 'item.search') {
        const q = params[0].toLowerCase(); // phrase match, like BBT
        return send(200, { jsonrpc: '2.0', id: 1, result: items.filter((i) => `${i.title} ${i.citekey}`.toLowerCase().includes(q)).map(({ bib, ...csl }) => csl) });
      }
      const it = items.find((i) => i.citekey === params[0][0] && i.library === (params[2] || 'My Library'));
      return send(200, it ? { jsonrpc: '2.0', id: 1, result: it.bib } : { jsonrpc: '2.0', id: null, error: { code: -32602, message: `not found: ${params[0][0]}` } });
    }
    if (url.pathname.startsWith('/api/users/0/items')) {
      if (url.pathname.endsWith('/BBBB2222')) {
        if (url.searchParams.get('format') === 'bibtex') return send(200, '@article{kim_grazing_2020,\n\ttitle = {Grazing by copepods},\n\tauthor = {Kim, B.},\n\tyear = {2020}\n}\n', 'text/plain');
        return send(200, localItem);
      }
      return send(200, url.searchParams.get('q')?.match(/grazing|kimGrazing2020/i) ? [localItem] : []);
    }
    send(404, 'No endpoint found', 'text/plain');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return Object.assign(state, { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => srv.close(ok)) });
}
