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
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(client.getServerVersion()?.version, pkg.version, 'the MCP server reports the package version');

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
