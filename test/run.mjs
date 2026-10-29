// End-to-end test: Claude's MCP tools, the review store, compile, SyncTeX, bibliography.
//   npm test                         starts a throwaway server on a copy of examples/sample-paper
//   node test/run.mjs <server-url>   runs against a server you started yourself (on a fresh sample paper)
// Needs a TeX installation with latexmk, bibtex and synctex.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/app.js';
import { Project } from '../server/project.js';

// Commits made by the server under test (Sync, pull --autostash) need a git identity. CI machines
// have none configured, so give the test run its own instead of relying on the developer's.
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Margin test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Margin test', GIT_COMMITTER_EMAIL: 'test@example.org' })) process.env[k] ??= v;

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
assert.ok(tools.length >= 19);
for (const t of ['get_response', 'update_response']) assert.ok(tools.some((x) => x.name === t), `${t} is listed`);
for (const t of ['suggest_edit', 'suggest_edits']) assert.ok(tools.find((x) => x.name === t).inputSchema.properties.responds_to, `${t} takes responds_to`);
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(client.getServerVersion()?.version, pkg.version, 'the MCP server reports the package version');

step('cross-site requests are refused (CSRF)');
{
  // A page on any other site can make the browser send a "simple" POST (no preflight) to
  // 127.0.0.1. The Host check does not stop that, so the server must refuse foreign origins.
  const post = (headers) => fetch(`${base}/api/review/clear-closed`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: 'x' });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await post({ Origin: 'null' })).status, 403, 'opaque Origin (sandboxed frame, file://)');
  assert.equal((await post({ Origin: 'http://localhost:3000' })).status, 403, 'another local dev server');
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'no Origin, but the browser says cross-site');
  assert.equal((await post({ Origin: base })).status, 200, "Margin's own page");
  assert.equal((await post({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await fetch(`${base}/api/project`, { headers: { Origin: 'https://evil.example' } })).status, 403, 'reads too');
  // Claude Code's MCP client and the prompt hook send no Origin: still allowed (the MCP client above already connected).
  console.log('foreign origins refused; own page, MCP client and non-browser clients allowed');
}

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

    // paper root itself behind a symlink (macOS /var, /tmp): ordinary paths must work (cf. 00726da)
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

// File management (roadmap 2.1): create, rename, delete, upload. Every one of them shares Project's guard.
step('file management: create, folder, upload');
const fileApi = async (method, url, { json, raw, type } = {}) => {
  const headers = json !== undefined ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': type || 'application/octet-stream' } : {};
  const res = await fetch(`${base}/api${url}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const onDisk = (rel) => path.join(paperRoot, rel);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from('v2')]);
{
  // new file: create-only PUT, parents created, never replaces when exclusive
  let r = await fileApi('PUT', `/file${q('notes/draft.tex')}&exclusive=1`, { json: { content: 'hello world' } });
  assert.equal(r.status, 200); assert.equal(fs.readFileSync(onDisk('notes/draft.tex'), 'utf8'), 'hello world');
  r = await fileApi('PUT', `/file${q('notes/draft.tex')}&exclusive=1`, { json: { content: 'CLOBBER' } });
  assert.equal(r.status, 409); assert.match(r.body.error, /Already exists/);
  assert.equal(fs.readFileSync(onDisk('notes/draft.tex'), 'utf8'), 'hello world', 'exclusive create leaves the existing file alone');
  r = await fileApi('PUT', `/file${q('notes/draft.tex')}`, { json: { content: 'hello again' } });
  assert.equal(r.status, 200, 'a plain PUT still replaces (that is how saving works)');
  r = await fileApi('PUT', `/file${q('main.tex/inside.tex')}`, { json: { content: 'x' } });
  assert.equal(r.status, 400, 'a file where a folder is needed is refused, not a crash');
  assert.ok(fs.statSync(onDisk('main.tex')).isFile());

  // new folder
  r = await fileApi('POST', '/folder', { json: { path: 'figures/raw' } });
  assert.equal(r.status, 200); assert.ok(fs.statSync(onDisk('figures/raw')).isDirectory());
  assert.ok((await rest('/tree')).some((e) => e.path === 'figures/raw' && e.type === 'dir'), 'an empty folder shows in the tree');
  r = await fileApi('POST', '/folder', { json: { path: 'figures/raw' } });
  assert.equal(r.status, 409);

  // upload: binary-exact, refuses to replace without the flag, replaces with it
  r = await fileApi('POST', `/upload${q('figures/dot.png')}`, { raw: PNG, type: 'image/png' });
  assert.equal(r.status, 200); assert.deepEqual(fs.readFileSync(onDisk('figures/dot.png')), PNG);
  r = await fileApi('POST', `/upload${q('figures/dot.png')}`, { raw: PNG2, type: 'image/png' });
  assert.equal(r.status, 409); assert.match(r.body.error, /Already exists/);
  assert.deepEqual(fs.readFileSync(onDisk('figures/dot.png')), PNG, 'upload over an existing file is refused and changes nothing');
  r = await fileApi('POST', `/upload${q('figures/dot.png')}&overwrite=1`, { raw: PNG2, type: 'image/png' });
  assert.equal(r.status, 200); assert.deepEqual(fs.readFileSync(onDisk('figures/dot.png')), PNG2);
  r = await fileApi('POST', `/upload${q('figures/raw')}&overwrite=1`, { raw: PNG });
  assert.equal(r.status, 409, 'not even overwrite replaces a folder');
  // The body is raw bytes whatever the content type: a .json upload must not be parsed.
  r = await fileApi('POST', `/upload${q('data/in.json')}`, { raw: Buffer.from('{ "a": 1 }'), type: 'application/json' });
  assert.equal(r.status, 200); assert.equal(fs.readFileSync(onDisk('data/in.json'), 'utf8'), '{ "a": 1 }');
  console.log('create-only PUT, folder, upload (binary-exact, no silent replace) ok');
}

step('file management: oversized upload is rejected');
{
  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  const r = await fileApi('POST', `/upload${q('figures/huge.png')}`, { raw: big, type: 'image/png' });
  assert.equal(r.status, 413); assert.match(r.body.error, /20MB/);
  assert.equal(fs.existsSync(onDisk('figures/huge.png')), false, 'nothing is written for an oversized upload');
  console.log('413, nothing written');
}

step('file management: rename and delete round trip; review items follow a rename');
{
  const note = await rest('/review/comment', { method: 'POST', body: { file: 'notes/draft.tex', quote: 'hello again', comment: 'Claude: expand this.' } });
  assert.equal(note.file, 'notes/draft.tex');
  const itemsFor = async (file) => (await rest('/review')).filter((i) => i.file === file);

  let r = await fileApi('POST', '/file/rename', { json: { from: 'notes/draft.tex', to: 'notes/final.tex' } });
  assert.equal(r.status, 200); assert.equal(r.body.type, 'file'); assert.equal(r.body.reviewItems, 1);
  assert.equal(fs.existsSync(onDisk('notes/draft.tex')), false);
  assert.equal(fs.readFileSync(onDisk('notes/final.tex'), 'utf8'), 'hello again');
  let moved = await itemsFor('notes/final.tex');
  assert.equal(moved.length, 1, 'the comment moved with the file');
  assert.equal(moved[0].orphaned, false, 'and is still anchored to its text');
  assert.equal((await itemsFor('notes/draft.tex')).length, 0);

  // a folder: everything in it moves, and so do the items under it
  r = await fileApi('POST', '/file/rename', { json: { from: 'notes', to: 'writing' } });
  assert.equal(r.status, 200); assert.equal(r.body.type, 'dir');
  assert.equal(fs.readFileSync(onDisk('writing/final.tex'), 'utf8'), 'hello again');
  assert.equal((await itemsFor('writing/final.tex')).length, 1);
  const tree = (await rest('/tree')).map((e) => e.path);
  assert.ok(tree.includes('writing/final.tex') && !tree.includes('notes/final.tex'));

  // refusals, each leaving everything where it was
  fs.writeFileSync(onDisk('writing/other.tex'), 'other');
  r = await fileApi('POST', '/file/rename', { json: { from: 'writing/other.tex', to: 'writing/final.tex' } });
  assert.equal(r.status, 409); assert.match(r.body.error, /Already exists/);
  assert.equal(fs.readFileSync(onDisk('writing/final.tex'), 'utf8'), 'hello again');
  assert.equal(fs.readFileSync(onDisk('writing/other.tex'), 'utf8'), 'other');
  r = await fileApi('POST', '/file/rename', { json: { from: 'writing', to: 'writing/inner' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /into itself/);
  r = await fileApi('POST', '/file/rename', { json: { from: 'main.tex', to: 'paper.tex' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /main document/);
  assert.ok(fs.existsSync(onDisk('main.tex')) && !fs.existsSync(onDisk('paper.tex')));
  r = await fileApi('POST', '/file/rename', { json: { from: 'nope.tex', to: 'x.tex' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Not found/);
  // an explicit overwrite flag replaces a file, but never a folder
  r = await fileApi('POST', '/file/rename', { json: { from: 'writing/other.tex', to: 'writing/final.tex', overwrite: true } });
  assert.equal(r.status, 200); assert.equal(fs.readFileSync(onDisk('writing/final.tex'), 'utf8'), 'other');
  r = await fileApi('POST', '/file/rename', { json: { from: 'writing/final.tex', to: 'figures', overwrite: true } });
  assert.equal(r.status, 409); assert.match(r.body.error, /folder/);
  assert.ok(fs.existsSync(onDisk('writing/final.tex')));

  // delete: the main document is refused, with the way out
  r = await fileApi('DELETE', `/file${q('main.tex')}`);
  assert.equal(r.status, 400); assert.match(r.body.error, /main document/); assert.match(r.body.error, /Change the main document first/);
  assert.ok(fs.existsSync(onDisk('main.tex')));
  r = await fileApi('DELETE', `/file${q('nope.tex')}`);
  assert.equal(r.status, 400); assert.match(r.body.error, /Not found/);

  // delete: a file with review items. The items are kept, flagged as orphaned because the file is gone.
  r = await fileApi('DELETE', `/file${q('writing/final.tex')}`);
  assert.equal(r.status, 200); assert.equal(r.body.type, 'file'); assert.equal(r.body.reviewItemsKept, 1);
  assert.equal(fs.existsSync(onDisk('writing/final.tex')), false);
  const kept = await itemsFor('writing/final.tex');
  assert.equal(kept.length, 1, 'review items survive the deletion of their file');
  assert.equal(kept[0].orphaned, true); assert.equal(kept[0].fileMissing, true);
  // ... and anchor again when a file of that name comes back
  fs.writeFileSync(onDisk('writing/final.tex'), 'hello again');
  assert.equal((await itemsFor('writing/final.tex'))[0].orphaned, false, 'restoring the file re-anchors the comment');
  await rest(`/review/${kept[0].id}`, { method: 'DELETE' });

  // delete a folder with everything in it; a .DS_Store inside goes too
  fs.writeFileSync(onDisk('writing/.DS_Store'), 'x');
  r = await fileApi('DELETE', `/file${q('writing')}`);
  assert.equal(r.status, 200); assert.equal(r.body.type, 'dir'); assert.equal(r.body.files, 1);
  assert.equal(fs.existsSync(onDisk('writing')), false);
  // a folder holding something Margin hides (node_modules, .git, ...) is refused whole
  fs.mkdirSync(onDisk('vendor/node_modules'), { recursive: true });
  fs.writeFileSync(onDisk('vendor/a.tex'), 'a');
  r = await fileApi('DELETE', `/file${q('vendor')}`);
  assert.equal(r.status, 400); assert.match(r.body.error, /node_modules/);
  assert.ok(fs.existsSync(onDisk('vendor/a.tex')) && fs.existsSync(onDisk('vendor/node_modules')), 'nothing was removed');
  fs.rmSync(onDisk('vendor'), { recursive: true });
  for (const rel of ['figures', 'data']) assert.equal((await fileApi('DELETE', `/file${q(rel)}`)).status, 200);
  console.log('rename (files, folders, review items follow), refusals, delete (items kept as orphans, re-anchor on restore) ok');
}

step('file management: no spelling of a bad path gets through any endpoint');
{
  const BAD = ['../x', 'sections/../../x', '/etc/x', '..\\x', 'a/../../x', '.git/x', '.git\\hooks\\x', '.GIT/x', 'a/../.git/x', '.review/x', '.REVIEW/x', '.claude/x', '.margin-build/x', 'node_modules/x', 'sections/node_modules/x', '.mcp.json', '.DS_Store', ''];
  const listing = () => fs.readdirSync(paperRoot, { recursive: true }).filter((f) => !/^(\.git|\.review|\.margin-build)(\/|$)/.test(String(f)) && !/\.(aux|log|bbl|blg|out|synctex\.gz|fls|fdb_latexmk)$/.test(String(f))).sort();
  const before = listing();
  const outside = path.join(path.dirname(paperRoot), 'x');
  const noProbe = () => {
    assert.equal(fs.existsSync(outside), false, 'nothing escapes the paper folder');
    for (const p of ['x', 'etc/x', '.git/x', '.git/hooks/x', '.review/x', '.claude/x', '.margin-build/x', 'node_modules/x', 'sections/node_modules/x']) {
      assert.equal(fs.existsSync(onDisk(p)), false, `${p} must not exist`);
    }
    assert.equal(fs.existsSync(path.join(paperRoot, '.GIT')) || fs.existsSync(path.join(paperRoot, '.REVIEW')), false);
    assert.deepEqual(listing(), before, 'the paper folder is exactly as it was');
  };
  for (const bad of BAD) {
    const results = {
      'PUT /file': await fileApi('PUT', `/file${q(bad)}`, { json: { content: 'PWNED' } }),
      'PUT /file exclusive': await fileApi('PUT', `/file${q(bad)}&exclusive=1`, { json: { content: 'PWNED' } }),
      'POST /upload': await fileApi('POST', `/upload${q(bad)}&overwrite=1`, { raw: PNG }),
      'POST /folder': await fileApi('POST', '/folder', { json: { path: bad } }),
      'POST /file/rename (to)': await fileApi('POST', '/file/rename', { json: { from: 'sections/intro.tex', to: bad, overwrite: true } }),
      'POST /file/rename (from)': await fileApi('POST', '/file/rename', { json: { from: bad, to: 'taken-from-bad.tex', overwrite: true } }),
      'DELETE /file': await fileApi('DELETE', `/file${q(bad)}`),
      'POST /reveal': await fileApi('POST', '/reveal', { json: { path: bad.startsWith('/') || bad.includes('..') ? bad : '../x' } }),
    };
    for (const [what, r] of Object.entries(results)) assert.equal(r.status, 400, `${what} ${JSON.stringify(bad)} must be refused with 400, got ${r.status}`);
    noProbe();
  }
  assert.ok(fs.existsSync(onDisk('sections/intro.tex')) && !fs.existsSync(onDisk('taken-from-bad.tex')));
  console.log(`${BAD.length} bad paths x 8 operations: all 400, nothing touched`);
}

step('file management: Project-level guards (symlinks, main inside a folder, .git spellings)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-fm-'));
  try {
    const outside = path.join(dir, 'outside'); const paper = path.join(dir, 'paper');
    fs.mkdirSync(outside); fs.mkdirSync(path.join(paper, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'ORIGINAL');
    fs.writeFileSync(path.join(paper, 'sub', 'main.tex'), '\\documentclass{article}');
    fs.writeFileSync(path.join(paper, 'a.txt'), 'a');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(paper, 'link.txt'));
    fs.symlinkSync(outside, path.join(paper, 'linkdir'));
    const p = new Project(paper, { main: 'sub/main.tex' });

    // the guard is shared by every writer: backslashes, case, and ../ detours cannot reach an ignored folder
    for (const bad of ['.git\\hooks\\pre-commit', '.GIT/x', 'a/../.git/x', '.review\\x']) {
      assert.throws(() => p.write(bad, 'x'), /ignored folder/, `write ${bad}`);
      assert.throws(() => p.writeBinary(bad, Buffer.from('x')), /ignored folder/, `writeBinary ${bad}`);
      assert.throws(() => p.mkdir(bad), /ignored folder/, `mkdir ${bad}`);
      assert.throws(() => p.rename('a.txt', bad), /ignored folder/, `rename to ${bad}`);
      assert.throws(() => p.remove(bad), /ignored folder|Not found/, `remove ${bad}`);
    }
    assert.throws(() => p.write('/abs.tex', 'x'), /Absolute paths/);
    assert.throws(() => p.rename('a.txt', '.'), /paper folder itself|Absolute/);
    assert.throws(() => p.remove('sub/..'), /paper folder itself/);
    assert.equal(fs.existsSync(path.join(paper, '.git')) || fs.existsSync(path.join(paper, '.GIT')), false);

    // symlinks that leave the paper: neither end of a rename, nor delete, nor upload may follow them
    assert.throws(() => p.rename('a.txt', 'linkdir/a.txt'), /escapes project/);
    assert.throws(() => p.rename('link.txt', 'b.txt'), /escapes project/);
    assert.throws(() => p.remove('link.txt'), /escapes project/);
    assert.throws(() => p.remove('linkdir/secret.txt'), /escapes project/);
    assert.throws(() => p.writeBinary('linkdir/new.bin', Buffer.from('x')), /escapes project/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'ORIGINAL');
    assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
    // a folder that merely contains an escaping link is deleted without following it
    fs.mkdirSync(path.join(paper, 'holder')); fs.symlinkSync(outside, path.join(paper, 'holder', 'out'));
    p.remove('holder');
    assert.equal(fs.existsSync(path.join(paper, 'holder')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'ORIGINAL', 'the link was removed, its target was not touched');

    // the main document, or a folder holding it, cannot be renamed or deleted
    assert.throws(() => p.remove('sub'), /contains the main document \(sub\/main\.tex\)/);
    assert.throws(() => p.rename('sub', 'sub2'), /main document/);
    assert.throws(() => p.remove('sub/main.tex'), /Change the main document first/);
    assert.ok(fs.existsSync(path.join(paper, 'sub', 'main.tex')));
    // ... and once main is elsewhere it can go
    p.main = 'a.tex';
    p.rename('sub', 'sub2');
    assert.ok(fs.existsSync(path.join(paper, 'sub2', 'main.tex')));
    console.log('guards ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

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

step('undo accept (unaccept): deletion, reverse order, edit elsewhere, duplicate text');
{
  const F = 'undo-scratch.tex';
  const readF = () => (rest(`/file?path=${F}`)).then((x) => x.content);
  const writeF = (content) => rest(`/file?path=${F}`, { method: 'PUT', body: { content } });
  const suggest = async (original, replacement, extra = {}) => {
    const x = await rest('/review/suggest', { method: 'POST', body: { file: F, original, replacement, ...extra } });
    assert.ok(x.id, JSON.stringify(x));
    return x.id;
  };
  const accept = (id) => rest(`/review/${id}/accept`, { method: 'POST', body: {} });
  const unaccept = (id) => rest(`/review/${id}/unaccept`, { method: 'POST', body: {} });
  const item = async (id) => (await rest('/review')).find((i) => i.id === id);

  // 1. deletion, restored byte-for-byte; location comes back through the normal path
  const t1 = 'The first sentence is here. This clause is very unnecessary, and so it goes. The last one follows.\n';
  await writeF(t1);
  let a = await suggest('very unnecessary, and so it goes', '');
  await accept(a);
  assert.ok(!(await readF()).includes('unnecessary'));
  assert.equal((await item(a)).from, null, 'accepted items report no location');
  let u = await unaccept(a);
  assert.equal(u.error, undefined);
  assert.equal(await readF(), t1, 'deletion undo restores the file byte-for-byte');
  u = await item(a);
  assert.equal(u.status, 'open'); assert.equal(u.orphaned, false);
  assert.equal(u.from, t1.indexOf('very unnecessary'), 'from/to/line re-anchor after undo');
  assert.equal(u.line, 1);
  assert.equal(u.appliedReplacement, undefined); assert.equal(u.decidedBy, undefined); assert.equal(u.decidedAt, undefined);
  assert.match((await unaccept(a)).error, /Only accepted suggestions/);
  await rest(`/review/${a}`, { method: 'DELETE' });

  // 2. two accepted in the same paragraph, undone in the other order
  const t2 = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.\n';
  await writeF(t2);
  const s1 = await suggest('beta gamma', 'BETA GAMMA LONGER REPLACEMENT');
  const s2 = await suggest('zeta eta', 'Z');
  await accept(s1); await accept(s2);
  const both = await readF();
  assert.ok(both.includes('BETA GAMMA LONGER REPLACEMENT') && both.includes('Epsilon Z theta'));
  assert.equal((await unaccept(s1)).error, undefined);   // first accepted, undone first
  assert.equal(await readF(), t2.replace('zeta eta', 'Z'));
  assert.equal((await unaccept(s2)).error, undefined);
  assert.equal(await readF(), t2, 'both undone, original text restored');
  await rest(`/review/${s1}`, { method: 'DELETE' }); await rest(`/review/${s2}`, { method: 'DELETE' });

  // 3. file edited elsewhere between accept and undo; byte-for-byte except for that edit
  const t3 = 'Intro paragraph one is long enough.\n\nSecond paragraph says quick results are obvious.\n';
  await writeF(t3);
  const e1 = await suggest('quick results are obvious', 'results are clear');
  await accept(e1);
  const accepted3 = await readF();
  await writeF('A brand new first paragraph, added later, which shifts offsets.\n\n' + accepted3);
  assert.equal((await unaccept(e1)).error, undefined);
  assert.equal(await readF(), 'A brand new first paragraph, added later, which shifts offsets.\n\n' + t3);
  await rest(`/review/${e1}`, { method: 'DELETE' });
  // ...and refusal when the applied text itself was edited
  await writeF(t3);
  const e2 = await suggest('quick results are obvious', 'results are clear');
  await accept(e2);
  const edited = (await readF()).replace('results are clear', 'results are rather clear');
  await writeF(edited);
  const refused = await unaccept(e2);
  assert.match(refused.error, /edited since; undo would not restore the original/);
  assert.equal(await readF(), edited, 'refused undo leaves the file untouched');
  assert.equal((await item(e2)).status, 'accepted');
  await rest(`/review/${e2}`, { method: 'DELETE' });

  // 4. applied text appears twice: hintOffset picks the right one
  const t4 = 'We sampled in May. Water was warm in May. Then we left.\n\nWe sampled in June. Water was warm in June. Then we left.\n';
  await writeF(t4);
  const d1 = await suggest('Water was warm in June.', 'Water was warm in May.');
  // the replacement text now exists earlier in the file too
  await accept(d1);
  const after4 = await readF();
  assert.equal(after4.split('Water was warm in May.').length - 1, 2);
  assert.equal((await unaccept(d1)).error, undefined);
  assert.equal(await readF(), t4, 'the second occurrence was the one restored');
  await rest(`/review/${d1}`, { method: 'DELETE' });
  await rest(`/file?path=${F}`, { method: 'DELETE' }).catch(() => {});
}

step('word count: totals, per section, comments/math ignored, \\input followed');
{
  const ex = (p) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'sample-paper', p), 'utf8');
  const put = (p, content) => rest(`/file?path=${encodeURIComponent(p)}`, { method: 'PUT', body: { content } });
  // Earlier checks edited the paper: start from the pristine sample.
  for (const p of ['main.tex', 'sections/intro.tex', 'sections/methods.tex']) await put(p, ex(p));
  const wc = await rest('/wordcount');
  assert.equal(wc.total, 196);
  assert.deepEqual(wc.sections.map((s) => [s.title, s.words]), [['Abstract', 49], ['Introduction', 105], ['Methods', 42]]);
  assert.equal(wc.sections[1].file, 'sections/intro.tex');
  assert.deepEqual(wc.missing, []);
  // a comment and display math change nothing; an escaped \% does not start a comment
  const methods = ex('sections/methods.tex');
  await put('sections/methods.tex', methods + '% a long commented out sentence that must not count\n\\begin{align*} a &= b \\\\ c &= d \\end{align*}\n\\[ x^2 \\]\n');
  const wcMath = await rest('/wordcount');
  assert.equal(wcMath.total, 196);
  assert.equal(wcMath.sections[2].words, 42);
  await put('sections/methods.tex', methods + 'An aside \\% with escaped percent.\n');
  assert.equal((await rest('/wordcount')).total, 201);
  // captions and footnotes are subtotals, reported separately from words
  await put('sections/methods.tex', methods + '\\begin{figure}\\includegraphics{x.png}\\caption{Three words here.}\\end{figure}\nText\\footnote{Two words.}\n');
  const wcCap = await rest('/wordcount');
  assert.deepEqual([wcCap.words, wcCap.captions, wcCap.footnotes, wcCap.total], [197, 3, 2, 202]);
  // \input of a new section file with 10 words (extension optional); an include cycle is harmless
  await put('sections/methods.tex', methods);
  await put('sections/new.tex', 'one two three four five six seven eight nine ten \\input{main}\n');
  await put('main.tex', ex('main.tex').replace('\\input{sections/methods}', '\\input{sections/methods}\n\\input{sections/new}'));
  const wcInput = await rest('/wordcount');
  assert.equal(wcInput.total, 206);
  assert.ok(wcInput.files.includes('sections/new.tex'));
  await put('main.tex', ex('main.tex'));
}

step('project search and replace: literal, regex, case, whole word, 400s, cap, listed files only');
{
  const q = (o) => rest(`/search?${new URLSearchParams(o)}`);
  const put = (p, content) => rest(`/file?path=${encodeURIComponent(p)}`, { method: 'PUT', body: { content } });
  const readP = (p) => fs.readFileSync(path.join(tmp, 'paper', p), 'utf8');
  const post = (body) => rest('/replace', { method: 'POST', body });
  const count = (text, re) => (text.match(re) || []).length;

  // literal search on the sample paper, counted independently from the files on disk
  const textPaths = (await rest('/tree')).filter((e) => e.type === 'file' && e.text).map((e) => e.path);
  const expected = textPaths.map((p) => [p, count(readP(p), /heatwave/gi)]).filter(([, n]) => n);
  let s = await q({ q: 'heatwave' });
  assert.equal(s.total, expected.reduce((n, [, c]) => n + c, 0));
  assert.deepEqual(s.files.map((f) => [f.path, f.count]).sort(), expected.sort());
  assert.equal(s.truncated, false);
  const first = s.files.find((f) => f.path === 'sections/intro.tex').matches[0];
  const introText = readP('sections/intro.tex');
  assert.equal(introText.slice(first.from, first.to).toLowerCase(), 'heatwave');
  assert.equal(introText.split('\n')[first.line - 1].slice(first.column - 1, first.column - 1 + first.length).toLowerCase(), 'heatwave');
  assert.equal(first.text, introText.split('\n')[first.line - 1]);

  // case sensitivity, whole words, regex metacharacters taken literally
  assert.equal((await q({ q: 'HEATWAVE' })).total, s.total, 'case-insensitive by default');
  assert.equal((await q({ q: 'HEATWAVE', case: '1' })).total, 0);
  assert.equal((await q({ q: 'Marine', case: '1' })).total, textPaths.reduce((n, p) => n + count(readP(p), /Marine/g), 0));
  assert.equal((await q({ q: 'heatwave', whole: '1' })).total, expected.reduce((n, [p]) => n + count(readP(p), /(?<!\w)heatwave(?!\w)/gi), 0));
  assert.equal((await q({ q: '\\citep{' })).total, count(readP('sections/intro.tex'), /\\citep\{/g), 'literal mode escapes regex syntax');
  assert.equal((await q({ q: '\\\\cite[pt]\\{', regex: '1' })).total, count(readP('sections/intro.tex'), /\\cite[pt]\{/g));

  // invalid regex and empty query are 400s carrying the message, not 500s
  for (const params of [{ q: '(unclosed', regex: '1' }, { q: '' }, {}]) {
    const res = await fetch(`${base}/api/search?${new URLSearchParams(params)}`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  }
  assert.match((await q({ q: '[a-', regex: '1' })).error, /Invalid regular expression/);

  // replace needs an explicit target, an in-project text file, and a valid regex
  assert.match((await post({ q: 'heatwave', replacement: 'X' })).error, /files or matches/);
  assert.match((await post({ q: 'heatwave', replacement: 'X', files: ['../outside.tex'] })).error, /escapes project/);
  assert.match((await post({ q: '(', regex: true, replacement: 'X', files: ['main.tex'] })).error, /Invalid regular expression/);
  assert.match((await post({ q: 'a', files: ['main.tex'] })).error, /replacement is required/);

  // scratch files: replace changes only the listed files, only the named matches
  await put('scratch-a.tex', 'zebra one. Zebra two. zebras three. zebra four.\n');
  await put('scratch-b.tex', 'zebra in the other file.\n');
  const dry = await post({ q: 'zebra', replacement: 'okapi', files: ['scratch-a.tex'], dryRun: true });
  assert.equal(dry.replaced, 4); assert.equal(readP('scratch-a.tex').includes('okapi'), false, 'dry run writes nothing');
  let r = await post({ q: 'zebra', replacement: 'okapi', files: ['scratch-a.tex'] });
  assert.deepEqual(r.files, [{ path: 'scratch-a.tex', replaced: 4 }]);
  assert.equal(readP('scratch-a.tex'), 'okapi one. okapi two. okapis three. okapi four.\n');
  assert.equal(readP('scratch-b.tex'), 'zebra in the other file.\n', 'unlisted file untouched');
  assert.equal(readP('sections/intro.tex'), introText);

  // single match by offset; a stale offset replaces nothing
  const one = (await q({ q: 'okapi', case: '1', whole: '1' })).files.find((f) => f.path === 'scratch-a.tex').matches;
  assert.equal(one.length, 3);
  r = await post({ q: 'okapi', whole: true, replacement: 'gnu', matches: [{ file: 'scratch-a.tex', from: one[1].from, to: one[1].to }] });
  assert.equal(r.replaced, 1);
  assert.equal(readP('scratch-a.tex'), 'okapi one. gnu two. okapis three. okapi four.\n');
  r = await post({ q: 'okapi', replacement: 'gnu', matches: [{ file: 'scratch-a.tex', from: one[1].from, to: one[1].to }] });
  assert.equal(r.replaced, 0, 'text no longer matches at that offset');

  // regex mode expands $1; literal mode keeps "$1" as typed
  await put('scratch-a.tex', 'fig 3 and fig 12\n');
  await post({ q: 'fig (\\d+)', regex: true, replacement: 'Fig.~$1', files: ['scratch-a.tex'] });
  assert.equal(readP('scratch-a.tex'), 'Fig.~3 and Fig.~12\n');
  await post({ q: 'Fig.~3', replacement: '$1', files: ['scratch-a.tex'] });
  assert.equal(readP('scratch-a.tex'), '$1 and Fig.~12\n');

  // the match cap is reported, and counts stay exact beyond it
  await put('scratch-b.tex', 'x '.repeat(2500) + '\n');
  s = await q({ q: 'x', whole: '1' });
  const b = s.files.find((f) => f.path === 'scratch-b.tex');
  assert.equal(s.truncated, true); assert.equal(s.shown, 2000); assert.equal(s.limit, 2000);
  assert.equal(b.count, 2500); assert.ok(s.total >= 2500);
  assert.ok(s.files.reduce((n, f) => n + f.matches.length, 0) <= 2000);

  // replacing text quoted by an open suggestion / comment: warned about, then orphaned, store intact
  await put('scratch-a.tex', 'The quick brown fox jumps over the lazy dog. A second sentence stays put.\n');
  const sug = await rest('/review/suggest', { method: 'POST', body: { file: 'scratch-a.tex', original: 'quick brown fox', replacement: 'swift fox' } });
  const com = await rest('/review/comment', { method: 'POST', body: { file: 'scratch-a.tex', quote: 'second sentence', comment: 'fine' } });
  assert.ok(sug.id && com.id);
  const warn = await post({ q: 'brown', replacement: 'red', files: ['scratch-a.tex'], dryRun: true });
  assert.equal(warn.reviewAffected, 1); assert.equal(warn.reviewItems[0].id, sug.id);
  assert.equal((await post({ q: 'dog', replacement: 'cat', files: ['scratch-a.tex'], dryRun: true })).reviewAffected, 0);
  r = await post({ q: 'brown', replacement: 'red', files: ['scratch-a.tex'] });
  assert.equal(r.reviewAffected, 1);
  const list = await rest('/review?status=open');
  assert.ok(Array.isArray(list), 'the review store is still readable');
  assert.equal(list.find((i) => i.id === sug.id).orphaned, true, 'the suggestion that quoted replaced text is orphaned');
  assert.equal(list.find((i) => i.id === com.id).orphaned, false, 'an untouched comment stays anchored');
  assert.match((await rest(`/review/${sug.id}/accept`, { method: 'POST', body: {} })).error, /no longer in the file/);
  for (const id of [sug.id, com.id]) await rest(`/review/${id}`, { method: 'DELETE' });

  for (const f of ['scratch-a.tex', 'scratch-b.tex']) fs.rmSync(path.join(tmp, 'paper', f), { force: true });
}

step('watcher: self-write suppression compares content, not time');
if (running) {
  const { default: WebSocket } = await import('ws');
  const events = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (m) => { const e = JSON.parse(m); if (e.type === 'file-changed') events.push(e); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (events.some(pred)) return true; await sleep(50); } return false; };
  const putF = (p, content) => rest(`/file?path=${encodeURIComponent(p)}`, { method: 'PUT', body: { content } });
  const abs = (p) => path.join(running.project.root, p);
  const f = 'sections/watch-test.tex';

  // a UI save alone is never reported as external
  events.length = 0;
  await putF(f, 'first\n');
  assert.ok(await waitFor((e) => e.path === f), 'watcher reported the UI save');
  await sleep(500);
  assert.ok(events.filter((e) => e.path === f).every((e) => !e.external), 'UI save echoed as external');

  // two saves in a row: still no external
  events.length = 0;
  await putF(f, 'second\n');
  await putF(f, 'third\n');
  assert.ok(await waitFor((e) => e.path === f), 'watcher reported the rapid saves');
  await sleep(600);
  assert.ok(events.filter((e) => e.path === f).every((e) => !e.external), 'rapid UI saves echoed as external');

  // a different write right after a save is external, even within the old 1.5 s window
  events.length = 0;
  await putF(f, 'fourth\n');
  fs.writeFileSync(abs(f), 'written by someone else\n');
  assert.ok(await waitFor((e) => e.path === f && e.external), 'external write right after a UI save was swallowed');

  // and a later UI save is again recognised as ours
  events.length = 0;
  await putF(f, 'fifth\n');
  assert.ok(await waitFor((e) => e.path === f), 'watcher reported the later save');
  await sleep(500);
  assert.ok(events.filter((e) => e.path === f).every((e) => !e.external), 'later UI save echoed as external');

  ws.close();
  fs.rmSync(abs(f), { force: true });
}

// CLAUDE.md's hardest promise: nothing Margin creates may reach Overleaf. git.sync()
// stages with `git add -A`, so this holds only if the local-only paths are in
// .git/info/exclude. This harness never runs `margin init`, so a pass here proves the
// server itself writes them.
if (running) {
  step('local-only paths stay out of git (nothing Margin creates reaches Overleaf)');
  const paper = path.join(tmp, 'paper');
  const exclude = fs.readFileSync(path.join(paper, '.git', 'info', 'exclude'), 'utf8').split('\n');
  for (const e of ['.review/', '.margin-build/', '.claude/', '.mcp.json']) {
    assert.ok(exclude.includes(e), `${e} is missing from .git/info/exclude`);
  }
  // Both folders really exist by now: earlier steps added review items and compiled.
  assert.ok(fs.existsSync(path.join(paper, '.review')), '.review should exist by now');
  assert.ok(fs.existsSync(path.join(paper, '.margin-build')), '.margin-build should exist by now');
  const git = (...a) => execFileSync('git', a, { cwd: paper }).toString();
  for (const probe of [git('status', '--porcelain'), git('add', '-A', '--dry-run')]) {
    for (const e of ['.review', '.margin-build', '.mcp.json']) {
      assert.ok(!probe.includes(e), `git would pick up ${e} and push it to Overleaf:\n${probe}`);
    }
  }
  console.log('excluded; `git add -A` would not stage any of them');
}

// Response to referees (server/responses.js). Its own server on a fresh git copy of the
// sample paper, so `git status` can be checked before anything is accepted. The report
// below is invented for the test.
step('response to referees: points, stances, linked suggestions, derived status, export, privacy');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-resp-'));
  const paper = path.join(dir, 'paper');
  fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'sample-paper'), paper, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...a], { cwd: paper, stdio: 'pipe' }).toString();
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  const rport = 45000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ root: paper, port: rport });
  const rbase = `http://127.0.0.1:${rport}`;
  const rc = new Client({ name: 'margin-test-resp', version: '0' });
  await rc.connect(new StreamableHTTPClientTransport(new URL(`${rbase}/mcp`)));
  const rcall = async (name, args = {}) => { const x = await rc.callTool({ name, arguments: args }); return { error: !!x.isError, text: x.content.map((c) => c.text).join('\n') }; };
  const rrest = async (p, opts = {}) => (await fetch(`${rbase}/api${p}`, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined })).json();
  const pt = async (label) => (await rrest('/responses')).points.find((p) => p.label === label);
  const paperFiles = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['.git', '.review', '.margin-build'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(paper, p)); } };
    walk(paper);
    return out.sort().join('\n');
  };
  const filesBefore = paperFiles();

  const REPORT = [
    'This invented report exists only for the Margin test suite.',
    '',
    '1. The introduction is too long; please shorten the second paragraph.',
    '2. Why was each heatwave held for 72 hours? This choice needs a justification (50% of events are shorter).',
    '3. The survival model should be stated in words as well as in Eq. 1.',
  ].join('\n');

  let x = await rcall('get_response');
  assert.ok(!x.error && /No referee report yet/.test(x.text), x.text);

  // The author pastes the report in the Response view.
  const report = await rrest('/responses/reports', { method: 'POST', body: { reviewer: 'Reviewer 1', text: REPORT } });
  assert.equal(report.round, 1);
  x = await rcall('get_response');
  assert.match(x.text, /invented report exists only/, 'get_response returns the report text');

  // Claude splits it into points with proposed stances. It cannot confirm them.
  x = await rcall('update_response', { points: [
    { referee_text: 'The introduction is too long; please shorten the second paragraph.', stance: 'agree', reply: 'We shortened the second paragraph of the Introduction.' },
    { referee_text: 'Why was each heatwave held for 72 hours? This choice needs a justification (50% of events are shorter).', stance: 'clarify', reply: 'Seventy-two hours is the median duration of recent events in the region; we now say so in the Methods.', confirmed: true },
    { referee_text: 'The survival model should be stated in words as well as in Eq. 1.', stance: 'partly_agree', reply: 'We now describe the model in words.' },
  ] });
  assert.ok(!x.error, x.text);
  assert.match(x.text, /created R1\.1/); assert.match(x.text, /created R1\.3/);
  let v = await rrest('/responses');
  assert.deepEqual(v.points.map((p) => p.label), ['R1.1', 'R1.2', 'R1.3']);
  assert.ok(v.points.every((p) => !p.confirmed), 'Claude cannot confirm a stance');
  assert.ok(v.points.every((p) => p.status === 'pending' && p.reasons.includes('stance not confirmed by the author')));
  x = await rcall('get_response', { report_text: false });
  assert.match(x.text, /Waiting for the author to confirm the stance on: R1\.1, R1\.2, R1\.3/);

  // No edits for a point whose stance the author has not confirmed.
  x = await rcall('suggest_edit', { file: 'sections/intro.tex', original: 'it is not well known how', replacement: 'little is known about how', rationale: 'Shorter.', responds_to: 'R1.1' });
  assert.ok(x.error && /not confirmed/.test(x.text), x.text);
  assert.equal((await rrest('/review')).length, 0, 'and no suggestion was created');

  // The author confirms R1.1 and R1.2 and changes R1.3 to agree (which confirms it).
  await rrest(`/responses/points/${(await pt('R1.1')).id}`, { method: 'POST', body: { confirmed: true } });
  await rrest(`/responses/points/${(await pt('R1.2')).id}`, { method: 'POST', body: { confirmed: true } });
  await rrest(`/responses/points/${(await pt('R1.3')).id}`, { method: 'POST', body: { stance: 'agree' } });
  assert.equal((await pt('R1.3')).confirmed, true);
  assert.equal((await pt('R1.2')).status, 'done', 'a confirmed clarify point with a reply needs no linked change');
  assert.deepEqual((await pt('R1.1')).reasons, ['no suggestion linked yet']);

  // Claude implements R1.1 with two suggestions and R1.3 with one.
  x = await rcall('suggest_edit', { file: 'sections/intro.tex', original: 'it is not well known how', replacement: 'little is known about how', rationale: 'Shorter.', responds_to: 'R1.1' });
  assert.ok(!x.error && /linked to R1\.1/.test(x.text), x.text);
  x = await rcall('suggest_edits', { responds_to: 'R1.1', edits: [
    { file: 'sections/intro.tex', original: 'which may underestimate cumulative effects', replacement: 'which may miss cumulative effects', rationale: 'Shorter.' },
    { file: 'sections/methods.tex', original: 'Survival was modelled as', replacement: 'Survival was modelled as a logistic mixed model,', rationale: 'States the model in words.', responds_to: (await pt('R1.3')).id.slice(0, 8) },
  ] });
  assert.ok(!x.error && !/FAILED/.test(x.text), x.text);
  const items = await rrest('/review');
  const sA = items.find((i) => i.quote === 'it is not well known how').id;
  const sB = items.find((i) => i.quote.startsWith('which may')).id;
  const sC = items.find((i) => i.file === 'sections/methods.tex').id;
  assert.deepEqual((await pt('R1.1')).itemIds, [sA, sB]);
  assert.deepEqual((await pt('R1.3')).itemIds, [sC]);
  assert.deepEqual((await pt('R1.1')).reasons, ['2 linked suggestions still open']);

  // Privacy: everything so far (report, points, links, both exports) left the paper's git status clean.
  const md = await (await fetch(`${rbase}/api/responses/export?format=md`)).text();
  const texRes = await fetch(`${rbase}/api/responses/export?format=tex`);
  assert.match(texRes.headers.get('content-disposition') || '', /attachment; filename="response-to-reviewers\.tex"/);
  const tex = await texRes.text();
  assert.equal(git('status', '--porcelain'), '', 'the response feature must leave nothing for git to pick up');
  assert.equal(paperFiles(), filesBefore, 'export is a download only: no new file in the paper folder');
  assert.ok(fs.existsSync(path.join(paper, '.review', 'responses.json')), 'stored in .review/responses.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(paper, '.review', 'responses.json'), 'utf8')).version, 1);

  // Export: numbered, the referee quoted, the reply under it, in order.
  assert.match(md, /^# Response to the reviewers\n\n## Reviewer 1\n\n### Comment 1\.1\n\n> The introduction is too long; please shorten the second paragraph\.\n\n\*\*Response\.\*\* We shortened the second paragraph/);
  assert.ok(md.indexOf('Comment 1.1') < md.indexOf('Comment 1.2') && md.indexOf('Comment 1.2') < md.indexOf('Comment 1.3'));
  assert.match(md, /### Comment 1\.2\n\n> Why was each heatwave held for 72 hours\? This choice needs a justification \(50% of events are shorter\)\.\n\n\*\*Response\.\*\* Seventy-two hours/);
  assert.match(tex, /\\paragraph\{Comment 1\.2\}\n\\begin\{referee\}\nWhy was each heatwave held for 72 hours\? This choice needs a justification \(50\\% of events are shorter\)\.\n\\end\{referee\}\n\\textbf\{Response\.\} Seventy-two hours/);
  // And the LaTeX letter compiles on its own (outside the paper folder).
  const texDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-letter-'));
  fs.writeFileSync(path.join(texDir, 'letter.tex'), tex);
  execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'letter.tex'], { cwd: texDir, stdio: 'pipe' });
  assert.ok(fs.existsSync(path.join(texDir, 'letter.pdf')));
  fs.rmSync(texDir, { recursive: true, force: true });

  // Derived status follows the suggestions: accept one -> still pending; both -> done.
  await rrest(`/review/${sA}/accept`, { method: 'POST', body: {} });
  assert.deepEqual((await pt('R1.1')).reasons, ['1 linked suggestion still open']);
  await rrest(`/review/${sB}/accept`, { method: 'POST', body: {} });
  assert.equal((await pt('R1.1')).status, 'done');
  // Undoing an accept puts it back to pending.
  await rrest(`/review/${sB}/unaccept`, { method: 'POST', body: {} });
  assert.equal((await pt('R1.1')).status, 'pending');
  await rrest(`/review/${sB}/accept`, { method: 'POST', body: {} });
  assert.equal((await pt('R1.1')).status, 'done');
  // Editing the accepted text away later is a mismatch: the reply claims a change that is gone.
  const intro = (await rrest('/file?path=sections/intro.tex')).content;
  await rrest('/file?path=sections/intro.tex', { method: 'PUT', body: { content: intro.replace('which may miss cumulative effects', 'which may underestimate cumulative effects') } });
  const p1 = await pt('R1.1');
  assert.equal(p1.status, 'mismatch');
  assert.match(p1.reasons[0], /accepted, but its text is no longer in sections\/intro\.tex/);
  await rrest('/file?path=sections/intro.tex', { method: 'PUT', body: { content: intro } });
  assert.equal((await pt('R1.1')).status, 'done');

  // Rejecting a linked suggestion is a mismatch, and get_response says so plainly.
  await rrest(`/review/${sC}/reject`, { method: 'POST', body: {} });
  let p3 = await pt('R1.3');
  assert.equal(p3.status, 'mismatch');
  assert.match(p3.reasons[0], /was rejected/);
  x = await rcall('get_response', { report_text: false });
  assert.match(x.text, /R1\.3 \[\w+\] — Agree \(confirmed by the author\) — MISMATCH: suggestion \w+ was rejected/);
  assert.match(x.text, /1 mismatch/);
  assert.equal((await rrest('/responses')).mismatchAll, 1);
  // Reopened and then orphaned (its text edited away): still a mismatch.
  await rrest(`/review/${sC}/reopen`, { method: 'POST', body: {} });
  assert.equal((await pt('R1.3')).status, 'pending');
  const methods = (await rrest('/file?path=sections/methods.tex')).content;
  await rrest('/file?path=sections/methods.tex', { method: 'PUT', body: { content: methods.replace('Survival was modelled as', 'Survival was fitted as') } });
  p3 = await pt('R1.3');
  assert.equal(p3.status, 'mismatch'); assert.match(p3.reasons[0], /edited since/);
  // Deleted outright: a mismatch too. Unlinking clears it.
  await rrest(`/review/${sC}`, { method: 'DELETE' });
  p3 = await pt('R1.3');
  assert.equal(p3.status, 'mismatch'); assert.match(p3.reasons[0], /was deleted/);
  x = await rcall('update_response', { points: [{ point: 'R1.3', unlink: [sC.slice(0, 8)] }] });
  assert.ok(!x.error && /revised R1\.3/.test(x.text), x.text);
  assert.deepEqual((await pt('R1.3')).reasons, ['no suggestion linked yet']);

  // Archived accepted suggestions (Clear closed) still count as accepted.
  await rrest('/review/clear-closed', { method: 'POST' });
  assert.equal((await pt('R1.1')).status, 'done');
  assert.ok((await pt('R1.1')).links.every((l) => l.archived && l.status === 'accepted'));

  // Claude changing a confirmed stance clears the confirmation; revising the reply does not.
  await rcall('update_response', { points: [{ point: 'R1.2', reply: 'Seventy-two hours matches the median event duration.' }] });
  assert.equal((await pt('R1.2')).confirmed, true);
  x = await rcall('update_response', { points: [{ point: 'R1.2', stance: 'disagree' }] });
  assert.match(x.text, /awaiting the author's confirmation/);
  assert.equal((await pt('R1.2')).confirmed, false);
  assert.equal((await pt('R1.2')).status, 'pending');

  // Claude can save a report pasted in the terminal and number its points.
  x = await rcall('update_response', { report: { reviewer: 'Reviewer 2', text: 'Invented second report.\n1. Figure 2 needs units.' }, points: [{ referee_text: 'Figure 2 needs units.', stance: 'agree', reply: 'Added.' }] });
  assert.ok(!x.error && /created R2\.1/.test(x.text), x.text);
  x = await rcall('update_response', { points: [{ referee_text: 'No report given and two exist' }] });
  assert.match(x.text, /FAILED: There are several reports/);
  x = await rcall('update_response', { points: [{ point: 'R2.1', delete: true }] });
  assert.match(x.text, /deleted R2\.1/);

  await rc.close();
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('statuses follow the suggestions (accept, undo, reject, edit, delete, archive); export numbered and quoted; git status clean');
}

step('response store: versioning, corruption, backups');
{
  const { ReviewStore } = await import('../server/review.js');
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'margin-rsp-'));
  const rp = (d) => path.join(d, '.review', 'responses.json');
  const storeIn = (d) => new ReviewStore({ reviewDir: path.join(d, '.review'), read: () => '' });
  const put = (d, s) => { fs.mkdirSync(path.join(d, '.review'), { recursive: true }); fs.writeFileSync(rp(d), s); };
  // too new: refused, untouched
  let d = mk(); const future = JSON.stringify({ version: 99, reports: [], points: [] });
  put(d, future);
  assert.throws(() => storeIn(d), (e) => e.message.includes(rp(d)) && /newer version of Margin/.test(e.message) && /response format 99/.test(e.message));
  assert.equal(fs.readFileSync(rp(d), 'utf8'), future);
  // unreadable: moved aside, not overwritten
  d = mk(); put(d, '{"version":1,"reports":[');
  const warn = console.warn; console.warn = () => {};
  let s; try { s = storeIn(d); } finally { console.warn = warn; }
  assert.equal(s.responses.data.points.length, 0);
  assert.ok(!fs.existsSync(rp(d)));
  assert.equal(fs.readdirSync(path.join(d, '.review')).filter((f) => f.startsWith('responses.json.corrupt-')).length, 1);
  // saves keep backups, like review.json, and do not touch review.json
  s.responses.addReport({ reviewer: 'Reviewer 1', text: 'Invented.' });
  s.responses.addReport({ reviewer: 'Reviewer 2', text: 'Invented too.' });
  assert.equal(JSON.parse(fs.readFileSync(rp(d) + '.bak', 'utf8')).reports.length, 1);
  assert.ok(!fs.existsSync(path.join(d, '.review', 'review.json')));
}

step('git: fetch makes status().behind real; timer only with a remote, cleared by close()');
{
  const { fetchRemote } = await import('../server/git.js');
  const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...a], { cwd, stdio: 'pipe' }).toString();
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-gitpoll-'));
  const bare = path.join(g, 'remote.git');
  sh(g, 'init', '-q', '--bare', '-b', 'master', bare);
  const mine = path.join(g, 'mine'), theirs = path.join(g, 'theirs');
  sh(g, 'clone', '-q', bare, mine);
  fs.writeFileSync(path.join(mine, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}\n');
  fs.writeFileSync(path.join(mine, 'other.tex'), 'other\n');
  sh(mine, 'add', '-A'); sh(mine, 'commit', '-qm', 'init'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:master');
  sh(g, 'clone', '-q', bare, theirs);
  const gport = 45000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ root: mine, port: gport });
  const gbase = `http://127.0.0.1:${gport}`;
  const gstatus = async () => (await (await fetch(`${gbase}/api/git/status`)).json());
  assert.equal(srv.gitTimerActive(), true, 'a project with a remote starts the poll timer');
  assert.equal((await gstatus()).behind, 0);
  fs.writeFileSync(path.join(theirs, 'other.tex'), 'other, edited by a co-author\n');
  sh(theirs, 'commit', '-qam', 'co-author edit'); sh(theirs, 'push', '-q');
  assert.equal((await gstatus()).behind, 0, 'stale before any fetch (this is the old bug)');
  const f = await fetchRemote(new Project(mine));
  assert.equal(f.ok, true);
  const st = await gstatus();
  assert.equal(st.behind, 1, 'behind reflects the remote after fetch');
  assert.deepEqual(st.incoming, ['other.tex']);
  // A fetch that cannot reach the remote is silent: no throw, ok false.
  sh(mine, 'remote', 'set-url', 'origin', path.join(g, 'does-not-exist.git'));
  const bad = await fetchRemote(new Project(mine));
  assert.equal(bad.ok, false);
  // A fetch that keeps failing must not read as "up to date": the status surfaces it,
  // otherwise `behind` silently goes stale again and the status bar lies as it did before.
  const fresh = await gstatus();
  assert.ok(fresh.remoteCheck, 'git status must report whether the fetch is actually working');
  assert.equal(fresh.remoteCheck.failures, 0, 'no failures recorded yet');
  await srv.gitPoll(); await srv.gitPoll();
  const sick = await gstatus();
  assert.equal(sick.remoteCheck.failures, 2, 'consecutive fetch failures are counted');
  assert.ok(sick.remoteCheck.error, 'the git error is kept for the tooltip');
  assert.equal(sick.remoteCheck.checked, true);
  await srv.close();
  assert.equal(srv.gitTimerActive(), false, 'close() clears the poll timer');

  // No remote: no timer.
  const lone = path.join(g, 'lone');
  fs.mkdirSync(lone); sh(lone, 'init', '-q'); fs.writeFileSync(path.join(lone, 'main.tex'), 'x\n'); sh(lone, 'add', '-A'); sh(lone, 'commit', '-qm', 'i');
  const srv2 = await startServer({ root: lone, port: gport + 1 });
  assert.equal(srv2.gitTimerActive(), false, 'no remote: no timer');
  await srv2.close();
  // Not a git repo: no timer either.
  const plain = path.join(g, 'plain');
  fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, 'main.tex'), 'x\n');
  const srv3 = await startServer({ root: plain, port: gport + 2 });
  assert.equal(srv3.gitTimerActive(), false, 'not a repo: no timer');
  await srv3.close();
  fs.rmSync(g, { recursive: true, force: true });
  console.log('fetch updates behind; failing fetch is silent; timer absent without remote and cleared on close');
}

step('git: a conflicted pull is reported, and Sync refuses to commit conflict markers');
{
  const { pull: gPull, sync: gSync, status: gStatus } = await import('../server/git.js');
  const { ensureLocalOnlyExcluded } = await import('../server/init.js');
  const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { cwd, stdio: 'pipe' }).toString();
  const mk = () => {
    const g = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-conflict-'));
    const bare = path.join(g, 'remote.git');
    sh(g, 'init', '-q', '--bare', '-b', 'master', bare);
    const mine = path.join(g, 'mine'), theirs = path.join(g, 'theirs');
    sh(g, 'clone', '-q', bare, mine);
    fs.writeFileSync(path.join(mine, 'main.tex'), 'line one\nline two\nline three\n');
    sh(mine, 'add', '-A'); sh(mine, 'commit', '-qm', 'init'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:master');
    sh(g, 'clone', '-q', bare, theirs);
    return { g, mine, theirs };
  };

  // A co-author edits a line; the author has an uncommitted edit to the same line.
  // `pull --rebase --autostash` fast-forwards, then the stash pop conflicts, leaving
  // conflict markers in the manuscript. git exits 0, so this used to report success.
  const c = mk();
  fs.writeFileSync(path.join(c.theirs, 'main.tex'), 'line one\nTHEIR line two\nline three\n');
  sh(c.theirs, 'commit', '-qam', 'co-author'); sh(c.theirs, 'push', '-q');
  fs.writeFileSync(path.join(c.mine, 'main.tex'), 'line one\nMY line two\nline three\n');

  const pr = await gPull(new Project(c.mine));
  assert.equal(pr.ok, false, 'a pull that leaves conflict markers must not report success');
  assert.deepEqual(pr.conflict, ['main.tex'], 'the conflicted file is named');
  assert.match(pr.hint || '', /<<<<<<</, 'the hint tells the author what is now in the file');
  const merged = fs.readFileSync(path.join(c.mine, 'main.tex'), 'utf8');
  assert.match(merged, /MY line two/, "the author's own text is still recoverable");
  assert.match(merged, /THEIR line two/);

  // status() must surface the unresolved state: behind/ahead are both 0 here, so
  // without this the UI cannot tell a conflicted tree from a healthy one.
  const st = await gStatus(new Project(c.mine));
  assert.deepEqual(st.conflicted, ['main.tex'], 'status reports unresolved paths');

  // Sync must refuse while the tree is conflicted. Otherwise `git add -A` commits the
  // conflict markers and pushes them into the shared manuscript.
  const before = sh(c.mine, 'rev-parse', 'origin/master').trim();
  const sr = await gSync(new Project(c.mine), { message: 'oops' });
  assert.equal(sr.ok, false, 'Sync must refuse a conflicted tree');
  assert.match(JSON.stringify(sr), /conflict/i, 'and say why');
  assert.equal(sh(c.mine, 'rev-parse', 'origin/master').trim(), before, 'nothing was pushed');
  assert.doesNotMatch(sh(c.mine, 'log', '-1', '--format=%H'), new RegExp('^$'));
  const pushed = sh(c.mine, 'show', 'origin/master:main.tex');
  assert.doesNotMatch(pushed, /<<<<<<</, 'no conflict markers reached the remote');

  // Editing the markers out does not clear git's unmerged index entry, and Margin has no
  // `git add`, so refusing on the index flag alone would strand the author for good.
  fs.writeFileSync(path.join(c.mine, 'main.tex'), 'line one\nMERGED line two\nline three\n');
  const sr2 = await gSync(new Project(c.mine), { message: 'resolved the conflict' });
  assert.equal(sr2.ok, true, `Sync must go through once the markers are gone: ${JSON.stringify(sr2)}`);
  assert.match(sh(c.mine, 'show', 'origin/master:main.tex'), /MERGED line two/, 'the resolved text reached the remote');
  assert.equal(sh(c.mine, 'status', '--porcelain').trim(), '', 'and the tree is clean afterwards');
  fs.rmSync(c.g, { recursive: true, force: true });

  // Sync must not carry OS junk to co-authors either.
  const j = mk();
  ensureLocalOnlyExcluded(j.mine);
  fs.writeFileSync(path.join(j.mine, '.DS_Store'), 'macos junk');
  fs.writeFileSync(path.join(j.mine, 'main.tex'), 'line one edited\nline two\nline three\n');
  const jr = await gSync(new Project(j.mine), { message: 'edits' });
  assert.equal(jr.ok, true, JSON.stringify(jr));
  const onRemote = sh(j.mine, 'ls-tree', '-r', '--name-only', 'origin/master').trim().split('\n');
  assert.ok(onRemote.includes('main.tex'));
  assert.ok(!onRemote.includes('.DS_Store'), `.DS_Store was pushed to Overleaf: ${onRemote.join(', ')}`);
  fs.rmSync(j.g, { recursive: true, force: true });
  // A branch with no upstream is a dead end on Overleaf: explain it rather than
  // passing git's "There is no tracking information" through to a toast.
  const u = mk();
  sh(u.mine, 'checkout', '-qb', 'my-edits');
  fs.writeFileSync(path.join(u.mine, 'main.tex'), 'line one changed\nline two\nline three\n');
  const ur = await gSync(new Project(u.mine), { message: 'on a side branch' });
  assert.equal(ur.ok, false);
  assert.match(ur.hint || '', /my-edits/, 'the hint names the branch');
  assert.match(ur.hint || '', /master/, 'and points back to the branch Overleaf supports');
  assert.match(sh(u.mine, 'log', '-1', '--format=%s'), /on a side branch/, 'the commit is kept locally');
  // status() must tell "no upstream" apart from "up to date": behind/ahead are null then, and
  // the status bar showed nothing, exactly as for a branch with nothing to pull.
  assert.equal((await gStatus(new Project(u.mine))).tracking, false, 'a branch with no upstream is reported as such');
  sh(u.mine, 'checkout', '-q', 'master');
  assert.equal((await gStatus(new Project(u.mine))).tracking, true);
  fs.rmSync(u.g, { recursive: true, force: true });

  // A pull that git refuses because of local files: a co-author added a file at a path where
  // the author has an untracked file of their own. --autostash does not cover untracked files,
  // so git aborts. The pull must fail with git's message (the UI toasts it), and the author's
  // file must be untouched.
  const l = mk();
  fs.writeFileSync(path.join(l.theirs, 'notes.tex'), 'theirs\n');
  sh(l.theirs, 'add', '-A'); sh(l.theirs, 'commit', '-qm', 'co-author adds notes'); sh(l.theirs, 'push', '-q');
  fs.writeFileSync(path.join(l.mine, 'notes.tex'), 'my own notes\n');
  const lr = await gPull(new Project(l.mine));
  assert.equal(lr.ok, false, 'a refused pull must not report success');
  assert.ok(!lr.conflict, 'and is not reported as a conflict');
  assert.match(lr.out, /notes\.tex/, "git's message, naming the file, is passed through");
  assert.match(lr.out, /overwritten/);
  assert.equal(fs.readFileSync(path.join(l.mine, 'notes.tex'), 'utf8'), 'my own notes\n', "the author's file is untouched");
  fs.rmSync(l.g, { recursive: true, force: true });

  console.log('conflicted pull reported, Sync refuses it, junk stays local, no-upstream explained, refused pull passes git\'s reason');
}

step('Ask Claude: waiting → picked up (prompt hook / get_asks) → answered, with linked suggestions');
{
  const { CURRENT_VERSION } = await import('../server/review.js');
  const byId = async (id) => (await rest('/review')).find((i) => i.id === id);
  const deliver = () => rest('/asks/deliver', { method: 'POST', body: {} });
  // The UI posts an ask as a comment with ask: true.
  const ask = await rest('/review/comment', { method: 'POST', body: { file: 'sections/intro.tex', quote: 'several heatwaves one after another', comment: 'Can this be more specific about the timing?', line: 8, ask: true } });
  assert.equal(ask.ask, true, JSON.stringify(ask));
  assert.equal((await byId(ask.id)).askState, 'waiting');
  // An ordinary comment is not an ask, and Claude cannot create asks.
  const plain = await rest('/review/comment', { method: 'POST', body: { file: 'main.tex', quote: 'Marine heatwaves', comment: 'note to self' } });
  assert.equal(plain.ask, undefined); assert.equal((await byId(plain.id)).askState, undefined);
  // The prompt hook's endpoint hands it over once, then has nothing more to say.
  let d = await deliver();
  assert.equal(d.count, 1);
  assert.match(d.text, /^Margin: the author used "Ask Claude"/);
  assert.match(d.text, new RegExp(`\\[${ask.id.slice(0, 8)}\\] sections/intro\\.tex:\\d+`));
  assert.match(d.text, /request: Can this be more specific/);
  assert.match(d.text, /sections\/intro\.tex:8/);
  assert.match(d.text, /selected: "several heatwaves one after another"/);
  assert.equal((await byId(ask.id)).askState, 'picked-up');
  assert.equal((await byId(ask.id)).pickedUpVia, 'prompt');
  assert.deepEqual(await deliver(), { count: 0, text: '' }, 'an ask is handed to Claude once');
  // The deliver endpoint takes JSON only (a plain cross-site form post cannot reach it).
  const form = await fetch(`${base}/api/asks/deliver`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(form.status, 415);
  // get_asks still lists it (picked up, not answered) for /margin.
  r = await call('get_asks');
  assert.ok(!r.error); assert.match(r.text, /Can this be more specific/); assert.match(r.text, /pass `ask: "<id>"`/);
  r = await call('list_review', { author: 'you' });
  assert.match(r.text, new RegExp(`\\[${ask.id.slice(0, 8)}\\] ask for Claude \\(picked-up\\)`));
  // Claude answers with a suggestion linked to the ask: answered, and linked both ways.
  r = await call('suggest_edit', { file: 'sections/intro.tex', original: 'several heatwaves one after another', replacement: 'two or more heatwaves within a single season', rationale: 'More specific, as asked.', ask: ask.id.slice(0, 8) });
  assert.ok(!r.error, r.text);
  const sugg = (await rest('/review')).find((i) => i.kind === 'suggestion' && i.askId === ask.id);
  assert.ok(sugg, 'the suggestion records the ask it answers');
  let a = await byId(ask.id);
  assert.equal(a.askState, 'answered'); assert.deepEqual(a.linked, [sugg.id]);
  r = await call('list_review', { file: 'sections/intro.tex' });
  assert.match(r.text, new RegExp(`for ask ${ask.id.slice(0, 8)}`));
  r = await call('get_asks');
  assert.match(r.text, /No requests from the author are waiting/);
  // A follow-up from the author puts it back to waiting, and the hook hands it over again with the thread.
  await rest(`/review/${ask.id}/reply`, { method: 'POST', body: { body: 'Also mention the temperature range.' } });
  assert.equal((await byId(ask.id)).askState, 'waiting');
  d = await deliver();
  assert.equal(d.count, 1); assert.match(d.text, /author: Also mention the temperature range\./);
  r = await call('reply', { id: ask.id.slice(0, 8), text: 'Added the range in a second suggestion.' });
  assert.equal((await byId(ask.id)).askState, 'answered');
  await rest(`/review/${ask.id}/resolve`, { method: 'POST', body: {} });
  assert.equal((await byId(ask.id)).askState, 'done');
  // Only asks can be linked to.
  r = await call('add_comment', { file: 'main.tex', quote: 'Marine heatwaves', comment: 'x', ask: plain.id });
  assert.ok(r.error); assert.match(r.text, /not one of the author's asks/);
  // The status bar's "Claude last active": MCP calls are noted.
  const seen = await rest('/claude');
  assert.ok(Date.now() - seen.at < 60000, JSON.stringify(seen)); assert.match(seen.what, /^tool:/);
  // New fields only: the review file keeps its version, so older builds still open it.
  if (running) assert.equal(JSON.parse(fs.readFileSync(path.join(running.project.root, '.review', 'review.json'), 'utf8')).version, CURRENT_VERSION);
  assert.equal(CURRENT_VERSION, 1);
  for (const id of [ask.id, plain.id, sugg.id]) await rest(`/review/${id}`, { method: 'DELETE' });
}

step('Ask Claude prompt hook: with Margin running, with no server, with no .mcp.json');
{
  const { spawn } = await import('node:child_process');
  const script = fileURLToPath(new URL('../templates/hooks/margin-asks.mjs', import.meta.url));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-hook-'));
  const mcpAt = (url) => fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { margin: { type: 'http', url } } }));
  // Run it exactly as Claude Code does: the command from settings.local.json through sh, JSON on stdin.
  const { ASK_HOOK_COMMAND } = await import('../server/init.js');
  const hookDir = path.join(proj, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true }); fs.copyFileSync(script, path.join(hookDir, 'margin-asks.mjs'));
  // Async: the test server runs in this process, so a blocking spawn would starve it.
  const spawnHook = (cmd, args, input) => new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err, ms: Date.now() - t0 }); });
    p.stdin.end(input);
  });
  const runHook = (prompt) => spawnHook('sh', ['-c', ASK_HOOK_COMMAND], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: proj }));
  mcpAt(`${base}/mcp`);
  const ask = await rest('/review/comment', { method: 'POST', body: { file: 'main.tex', quote: 'Marine heatwaves', comment: 'Hook test: shorten the title?', line: 1, ask: true } });
  let h = await runHook('/margin');
  assert.equal(h.code, 0); assert.equal(h.out, '', '/margin fetches asks itself; the hook stays quiet');
  assert.equal((await rest('/review')).find((i) => i.id === ask.id).askState, 'waiting');
  h = await runHook('go');
  assert.equal(h.code, 0, h.err); assert.match(h.out, /Hook test: shorten the title\?/); assert.equal(h.err, '');
  console.log(`running server: exit 0 in ${h.ms} ms, printed ${h.out.length} chars`);
  assert.equal((await rest('/review')).find((i) => i.id === ask.id).askState, 'picked-up');
  h = await runHook('go');
  assert.equal(h.code, 0); assert.equal(h.out, '', 'nothing printed when nothing is waiting');
  // No server on the port: silent, exit 0, fast.
  const net = await import('node:net');
  const free = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  mcpAt(`http://127.0.0.1:${free}/mcp`);
  h = await runHook('hello');
  assert.equal(h.code, 0); assert.equal(h.out, ''); assert.equal(h.err, '');
  assert.ok(h.ms < 2000, `took ${h.ms} ms with no server`);
  console.log(`no server: exit 0 in ${h.ms} ms, silent`);
  // A port that accepts but never answers: gives up on its own, still exit 0.
  const hang = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((ok) => hang.once('listening', ok));
  mcpAt(`http://127.0.0.1:${hang.address().port}/mcp`);
  h = await runHook('hello');
  assert.equal(h.code, 0); assert.equal(h.out, ''); assert.ok(h.ms < 3500, `took ${h.ms} ms against a hanging port`);
  console.log(`hanging port: exit 0 in ${h.ms} ms, silent`);
  hang.close();
  // No .mcp.json, and garbage on stdin: still silent.
  fs.rmSync(path.join(proj, '.mcp.json'));
  h = await runHook('hello');
  assert.equal(h.code, 0); assert.equal(h.out, '');
  const g = await spawnHook('node', [script], 'not json');
  assert.equal(g.code, 0); assert.equal(g.out, '');
  await rest(`/review/${ask.id}`, { method: 'DELETE' });
  fs.rmSync(proj, { recursive: true, force: true });
}

step('margin init: MCP config, prompt hook, /margin command; idempotent, keeps the author\'s hooks');
{
  const { init } = await import('../server/init.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-init-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.overleaf.com/0000'], { cwd: dir });
  const settingsFile = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const mine = { type: 'command', command: 'echo my own hook' };
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [mine] }], Stop: [{ hooks: [mine] }] } }));
  init(dir, { port: 4321, log: () => {} });
  init(dir, { port: 4321, log: () => {} });
  const st = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(st.enabledMcpjsonServers, ['margin']);
  assert.ok(st.permissions.allow.includes('mcp__margin__*'));
  const ups = st.hooks.UserPromptSubmit;
  assert.equal(ups.length, 2, 'the author\'s hook is kept and ours is added once');
  assert.deepEqual(ups[0].hooks[0], mine);
  assert.deepEqual(ups[1].hooks, [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/margin-asks.mjs"', timeout: 5 }]);
  assert.deepEqual(st.hooks.Stop, [{ hooks: [mine] }]);
  const tpl = (p) => fs.readFileSync(fileURLToPath(new URL(`../templates/${p}`, import.meta.url)), 'utf8');
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'hooks', 'margin-asks.mjs'), 'utf8'), tpl('hooks/margin-asks.mjs'));
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'commands', 'margin.md'), 'utf8'), tpl('commands/margin.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.margin.url, 'http://127.0.0.1:4321/mcp');
  // A stale copy of the hook script is refreshed; the author's CLAUDE.md is not.
  fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'margin-asks.mjs'), '// old');
  fs.writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'my notes');
  const { done } = init(dir, { port: 4321, log: () => {} });
  assert.ok(done.some((x) => /updated .claude.hooks.margin-asks\.mjs/.test(x)), done.join('\n'));
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'hooks', 'margin-asks.mjs'), 'utf8'), tpl('hooks/margin-asks.mjs'));
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'utf8'), 'my notes');
  // Everything init wrote stays out of git, and the editor does not list it.
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir }).toString();
  assert.equal(status.trim(), '', `init left files git would push:\n${status}`);
  assert.ok(new Project(dir).isIgnored('.claude/hooks/margin-asks.mjs'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Changes view (server/changes.js) and latexdiff PDF (server/latexdiff.js): a clone of a bare "Overleaf"
// repo with a commit, a local commit ahead of it, an uncommitted edit and a brand-new file.
step('changes: since the last sync, uncommitted, a diverged upstream, no upstream, not a repo');
const chg = {};
{
  const { parseDiff, resolveRef } = await import('../server/changes.js');
  const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...a], { cwd, stdio: 'pipe' }).toString();
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-changes-'));
  const bare = path.join(g, 'remote.git');
  sh(g, 'init', '-q', '--bare', '-b', 'master', bare);
  const mine = path.join(g, 'mine'), theirs = path.join(g, 'theirs');
  sh(g, 'clone', '-q', bare, mine);
  fs.cpSync(new URL('../examples/sample-paper', import.meta.url), mine, { recursive: true });
  sh(mine, 'add', '-A'); sh(mine, 'commit', '-qm', 'init'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:master');
  sh(g, 'clone', '-q', bare, theirs);
  const cport = 46000 + Math.floor(Math.random() * 1500);
  const csrv = await startServer({ root: mine, port: cport });
  const cbase = `http://127.0.0.1:${cport}`;
  const get = async (p) => { const r = await fetch(`${cbase}/api${p}`); return { status: r.status, body: await r.json() }; };
  const post = async (p, body) => { const r = await fetch(`${cbase}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  Object.assign(chg, { g, mine, theirs, cbase, csrv, sh, get, post, firstSha: sh(mine, 'rev-parse', 'HEAD').trim() });

  let c = (await get('/changes')).body;
  assert.equal(c.repo, true); assert.equal(c.tracking, true);
  assert.deepEqual(c.files, [], 'nothing changed yet: an empty list, not an error');

  // ahead by one commit + an uncommitted edit + a new file git has never seen
  const edit = (rel, from, to) => { const f = path.join(mine, rel); const t = fs.readFileSync(f, 'utf8'); assert.ok(t.includes(from), `${rel} has ${from}`); fs.writeFileSync(f, t.replace(from, to)); };
  edit('main.tex', 'very important', 'crucial');
  sh(mine, 'commit', '-qam', 'committed here, not pushed');
  edit('sections/intro.tex', 'the ocean', 'the sea');
  fs.writeFileSync(path.join(mine, 'sections', 'extra notes.tex'), 'A brand new section.\nWith two lines.\n');
  fs.writeFileSync(path.join(mine, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

  c = (await get('/changes?since=sync')).body;
  assert.equal(c.kind, 'upstream'); assert.equal(c.ahead, 1);
  const byPath = (x) => Object.fromEntries(x.files.map((f) => [f.path, f]));
  let f = byPath(c);
  assert.deepEqual(Object.keys(f).sort(), ['figure.png', 'main.tex', 'sections/extra notes.tex', 'sections/intro.tex'], 'committed-ahead, uncommitted and untracked files are all "since the last sync"');
  assert.equal(f['main.tex'].status, 'M'); assert.equal(f['main.tex'].additions, 1); assert.equal(f['main.tex'].deletions, 1);
  const hunkLines = f['main.tex'].hunks.flatMap((h) => h.lines);
  const added = hunkLines.find((l) => l.t === '+'), removed = hunkLines.find((l) => l.t === '-');
  assert.match(added.text, /it is crucial to understand/); assert.match(removed.text, /very important/);
  const mainSrc = fs.readFileSync(path.join(mine, 'main.tex'), 'utf8').split('\n');
  assert.equal(mainSrc[added.n - 1], added.text, 'a hunk line carries its line number in the file on disk, so a click can jump to it');
  assert.equal(removed.n, null); assert.ok(removed.o > 0);
  assert.equal(f['sections/extra notes.tex'].status, 'A'); assert.equal(f['sections/extra notes.tex'].untracked, true);
  assert.equal(f['sections/extra notes.tex'].additions, 2); assert.equal(f['sections/extra notes.tex'].hunks[0].lines[1].n, 2);
  assert.equal(f['figure.png'].binary, true, 'an untracked image is listed, without hunks');
  assert.equal(c.totals.files, 4);

  c = (await get('/changes?since=head')).body;
  assert.deepEqual(Object.keys(byPath(c)).sort(), ['figure.png', 'sections/extra notes.tex', 'sections/intro.tex'], 'uncommitted: main.tex was committed, so it is not listed');
  assert.equal(c.kind, 'head');
  assert.equal((await get('/changes?since=bogus')).status, 400);

  // Margin's own files never show up as changes (they are local-only)
  assert.ok(!Object.keys(byPath((await get('/changes')).body)).some((p) => /^\.(review|margin-build|claude)|\.mcp\.json/.test(p)));

  // A co-author pushes while we are ahead. Diffing against the upstream tip would show their work as
  // our deletion; the baseline is the merge-base, so it must not appear.
  fs.appendFileSync(path.join(theirs, 'refs.bib'), '\n% a co-author note\n');
  sh(theirs, 'commit', '-qam', 'co-author edit'); sh(theirs, 'push', '-q');
  await csrv.gitPoll();
  c = (await get('/changes?since=sync')).body;
  assert.equal(c.behind, 1, 'the response says how many Overleaf commits are not pulled');
  assert.ok(!byPath(c)['refs.bib'], "a co-author's unpulled change is not shown as if it were ours");
  assert.deepEqual(Object.keys(byPath(c)).sort(), ['figure.png', 'main.tex', 'sections/extra notes.tex', 'sections/intro.tex']);

  // Names with spaces and non-ASCII characters, renames, quoted paths, and what each line number means
  const parsed = parseDiff(['diff --git a/my notes é.tex b/my notes é.tex', 'index 111..222 100644', '--- a/my notes é.tex', '+++ b/my notes é.tex', '@@ -3,2 +3,3 @@ ctx', ' keep', '-gone', '+new', '+newer', '\\ No newline at end of file',
    'diff --git "a/q\\"uote \\303\\251.tex" "b/q\\"uote \\303\\251.tex"', 'new file mode 100644', 'index 0000000..333', '--- /dev/null', '+++ "b/q\\"uote \\303\\251.tex"', '@@ -0,0 +1 @@', '+x',
    'diff --git a/old name.tex b/new name.tex', 'similarity index 100%', 'rename from old name.tex', 'rename to new name.tex',
    'diff --git a/img 1.png b/img 1.png', 'index 1..2 100644', 'Binary files a/img 1.png and b/img 1.png differ', ''].join('\n'));
  assert.deepEqual(parsed.map((p) => [p.path, p.status]), [['my notes é.tex', 'M'], ['q"uote é.tex', 'A'], ['new name.tex', 'R'], ['img 1.png', 'M']]);
  assert.equal(parsed[2].oldPath, 'old name.tex'); assert.equal(parsed[3].binary, true);
  assert.deepEqual(parsed[0].hunks[0].lines.map((l) => [l.t, l.o, l.n]), [[' ', 3, 3], ['-', 4, null], ['+', null, 4], ['+', null, 5]]);

  // The ref that reaches git is checked first: nothing that looks like an option, and only what git can resolve.
  await assert.rejects(resolveRef(new Project(mine), '--output=/tmp/margin-pwned'), /not a valid git ref/);
  await assert.rejects(resolveRef(new Project(mine), '-x'), /not a valid git ref/);
  await assert.rejects(resolveRef(new Project(mine), 'no-such-branch'), /does not know/);
  assert.equal(await resolveRef(new Project(mine), 'HEAD'), sh(mine, 'rev-parse', 'HEAD').trim());
  assert.equal(await resolveRef(new Project(mine), chg.firstSha.slice(0, 8)), chg.firstSha);

  // No upstream: "since the last sync" has no meaning, so it falls back to the last commit and says so.
  const lone = path.join(g, 'lone');
  fs.cpSync(new URL('../examples/sample-paper', import.meta.url), lone, { recursive: true });
  sh(lone, 'init', '-q'); sh(lone, 'add', '-A'); sh(lone, 'commit', '-qm', 'one');
  fs.appendFileSync(path.join(lone, 'main.tex'), '\n% local only\n');
  const lport = cport + 1;
  const lsrv = await startServer({ root: lone, port: lport });
  const lc = await (await fetch(`http://127.0.0.1:${lport}/api/changes?since=sync`)).json();
  assert.equal(lc.tracking, false); assert.equal(lc.kind, 'head', 'no upstream: compared with HEAD');
  assert.deepEqual(lc.files.map((x) => x.path), ['main.tex']);
  sh(lone, 'checkout', '-q', '-b', 'side'); // a repo with commits but a branch that tracks nothing
  assert.equal((await (await fetch(`http://127.0.0.1:${lport}/api/changes`)).json()).tracking, false);
  await lsrv.close();

  // Not a repo, and a repo without commits: a message, never a crash
  const plain = path.join(g, 'plain');
  fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, 'main.tex'), 'x\n');
  const psrv = await startServer({ root: plain, port: cport + 2 });
  const pc = await (await fetch(`http://127.0.0.1:${cport + 2}/api/changes`)).json();
  assert.equal(pc.repo, false); assert.deepEqual(pc.files, []);
  await psrv.close();
  const empty = path.join(g, 'empty');
  fs.mkdirSync(empty); fs.writeFileSync(path.join(empty, 'main.tex'), 'x\n'); sh(empty, 'init', '-q');
  const esrv = await startServer({ root: empty, port: cport + 3 });
  const ec = await (await fetch(`http://127.0.0.1:${cport + 3}/api/changes`)).json();
  assert.equal(ec.noCommits, true); assert.deepEqual(ec.files, []);
  await esrv.close();
  console.log('hunks with line numbers; ahead + uncommitted + untracked; diverged upstream shows only our side; no-upstream falls back to HEAD; non-repo and no-commit repos answer cleanly');
}

step('changes: suggestions accepted since a time (live and archived), and what "since" means');
{
  const { get, post, mine } = chg;
  const sug = async (file, original, replacement) => { const r = await post('/review/suggest', { file, original, replacement, rationale: 'because' }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const before = new Date(Date.now() - 60000).toISOString();
  const a = await sug('sections/methods.tex', 'Each heatwave consisted of a ramp', 'Each heatwave consisted of a linear ramp');
  const b = await sug('sections/intro.tex', 'which may underestimate cumulative effects', 'which may underestimate their cumulative effects');
  const rej = await sug('sections/intro.tex', 'leads to acclimation', 'causes acclimation');
  assert.equal((await get(`/changes/accepted?since=${encodeURIComponent(before)}`)).body.items.length, 0, 'open suggestions are not accepted ones');
  { const ar = await post(`/review/${a.id}/accept`); assert.equal(ar.status, 200, JSON.stringify(ar.body)); }
  assert.equal((await post(`/review/${b.id}/accept`)).status, 200);
  assert.equal((await post(`/review/${rej.id}/reject`)).status, 200);
  let acc = (await get(`/changes/accepted?since=${encodeURIComponent(before)}`)).body;
  assert.deepEqual(acc.items.map((i) => i.id).sort(), [a.id, b.id].sort(), 'accepted ones only, not the rejected one');
  assert.ok(acc.items[0].decidedAt >= acc.items[1].decidedAt, 'newest first');
  const it = acc.items.find((i) => i.id === a.id);
  assert.equal(it.replacement, 'Each heatwave consisted of a linear ramp'); assert.equal(it.archived, false);
  const methods = fs.readFileSync(path.join(mine, 'sections/methods.tex'), 'utf8').split('\n');
  assert.ok(methods[it.line - 1].includes('Each heatwave consisted of a linear ramp'), 'line points at the applied text in the file');
  // A later start time excludes them; garbage is refused
  assert.equal((await get(`/changes/accepted?since=${encodeURIComponent(new Date(Date.now() + 3600000).toISOString())}`)).body.items.length, 0);
  assert.equal((await get('/changes/accepted?since=yesterday-ish')).status, 400);
  // Clearing closed items archives them; they must still count (the store forgot them, the archive did not)
  assert.ok((await post('/review/clear-closed')).body.removed >= 3);
  assert.equal((await get('/review?status=accepted')).body.length, 0, 'gone from the live store');
  acc = (await get(`/changes/accepted?since=${encodeURIComponent(before)}`)).body;
  assert.deepEqual(acc.items.map((i) => i.id).sort(), [a.id, b.id].sort(), 'archived accepted suggestions are counted too');
  assert.ok(acc.items.every((i) => i.archived === true));
  // 'sync' is the time of the commit the Changes view compares with (here: the first commit, a moment ago)
  const sync = (await get('/changes/accepted?since=sync')).body;
  assert.equal(sync.basis, 'sync'); assert.equal(sync.items.length, 2);
  // Undoing an accept removes it from the list (it is open again)
  const c2 = await sug('sections/intro.tex', 'Previous work has mostly', 'Earlier work has mostly');
  await post(`/review/${c2.id}/accept`);
  assert.equal((await get(`/changes/accepted?since=${encodeURIComponent(before)}`)).body.items.length, 3);
  await post(`/review/${c2.id}/unaccept`);
  assert.equal((await get(`/changes/accepted?since=${encodeURIComponent(before)}`)).body.items.length, 2);
  // Read-only: asking never touched the store
  assert.equal((await get('/review?status=open')).body.length, 1, 'only the unaccepted suggestion is open');
  console.log('accepted-since lists live + archived accepted suggestions, newest first, with the line of the applied text');
}

step('latexdiff: clear message when missing; marked-up PDF built beside, never over, the normal PDF');
{
  const { checkLatexdiff, MISSING_MESSAGE } = await import('../server/latexdiff.js');
  const { get, post, mine, sh, cbase, firstSha } = chg;
  const nowhere = await checkLatexdiff('definitely-not-a-latexdiff-binary');
  assert.equal(nowhere.installed, false);
  assert.match(nowhere.message, /latexdiff/); assert.match(nowhere.message, /tlmgr/); assert.match(nowhere.message, /apt install latexdiff/);
  assert.equal(nowhere.message, MISSING_MESSAGE);
  // the build itself refuses with that message, names the command, and has touched nothing
  const { makeDiffPdf } = await import('../server/latexdiff.js');
  await assert.rejects(makeDiffPdf(new Project(mine), { latexdiff: 'definitely-not-a-latexdiff-binary' }), (e) => e.missing === 'latexdiff' && /latexdiff is not installed/.test(e.message));
  assert.equal(fs.existsSync(path.join(mine, '.margin-build', 'diff')), false, 'a missing tool must not create the diff folder');
  const tool = (await get('/latexdiff')).body;
  assert.equal(typeof tool.installed, 'boolean');
  if (!tool.installed) {
    const r = await post('/latexdiff', {});
    assert.ok(r.status >= 400); assert.match(r.body.error, /latexdiff is not installed/);
    console.log('SKIPPED the build part: latexdiff is not on PATH here. Without it the API answers:', r.body.error);
  } else {
    console.log(`using ${tool.version}`);
    const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const normalPdf = path.join(mine, '.margin-build', 'main.pdf');
    assert.equal((await post('/compile')).body.ok, true);
    const normal = { hash: sha256(normalPdf), mtime: fs.statSync(normalPdf).mtimeMs };

    const r = await post('/latexdiff', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true); assert.equal(r.body.url, '/pdf-diff');
    assert.match(r.body.ref, /last sync/);
    const diffDir = path.join(mine, '.margin-build', 'diff');
    const tex = fs.readFileSync(path.join(diffDir, 'margin-diff.tex'), 'utf8');
    // --flatten: the \input'd sections are inside the one document, with their own changes marked
    assert.ok(!/\\input\{sections\/intro\}/.test(tex), 'sections/intro.tex was inlined');
    assert.match(tex, /\\DIFadd\{sea\s*\}/, 'a change inside an \\input file is marked');
    assert.match(tex, /\\DIFadd\{crucial\s*\}/, 'a change in the main file, committed locally, is marked');
    const pdfRes = await fetch(`${cbase}/pdf-diff`);
    assert.equal(pdfRes.status, 200); assert.match(pdfRes.headers.get('content-type'), /pdf/);
    assert.equal(Buffer.from(await pdfRes.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    // the real PDF is untouched, and still what /pdf serves
    assert.equal(sha256(normalPdf), normal.hash); assert.equal(fs.statSync(normalPdf).mtimeMs, normal.mtime);
    const realRes = Buffer.from(await (await fetch(`${cbase}/pdf`)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(realRes).digest('hex'), normal.hash, '/pdf still serves the normal build');
    // scratch trees are gone; nothing leaked into the paper or into git
    assert.deepEqual(fs.readdirSync(diffDir).filter((n) => n === 'old' || n === 'new'), []);
    const porcelain = sh(mine, 'status', '--porcelain');
    assert.ok(!/margin-build|\.margin|margin-diff/.test(porcelain), `latexdiff must leave nothing for git:\n${porcelain}`);
    assert.ok(!fs.existsSync(path.join(mine, 'margin-diff.tex')) && !fs.existsSync(path.join(mine, 'margin-diff.pdf')));
    assert.equal((await get('/latexdiff')).body.last.sha, r.body.sha, 'the last build is reported (and survives a restart via meta.json)');

    // against an explicit commit: the first one, so the local commit is in the diff too
    const r2 = await post('/latexdiff', { ref: firstSha });
    assert.equal(r2.body.ok, true); assert.equal(r2.body.sha, firstSha); assert.equal(r2.body.ref, firstSha.slice(0, 7));
    // refs git cannot use, and refs that look like options, are refused before anything runs
    for (const bad of ['--output=/tmp/margin-pwned', '-h', 'nope/nope', '$(touch /tmp/margin-pwned)']) {
      const e = await post('/latexdiff', { ref: bad });
      assert.ok(e.status >= 400, `${bad} refused`); assert.ok(e.body.error);
    }
    assert.ok(!fs.existsSync('/tmp/margin-pwned'));
    assert.equal((await post('/latexdiff', { ref: 5 })).status, 400);
    // one build at a time: a second request while one runs is refused, not queued
    const [x, y] = await Promise.all([post('/latexdiff', {}), post('/latexdiff', {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(sha256(normalPdf), normal.hash, 'still untouched after several builds');
    console.log(`diff PDF built (${r.body.style} style, ${r.body.durationMs} ms); normal PDF byte-identical; scratch trees removed; nothing for git`);
  }
  await chg.csrv.close();
  fs.rmSync(chg.g, { recursive: true, force: true });
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
