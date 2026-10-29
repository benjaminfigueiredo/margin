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

step('editor state (as posted by the UI)');
await rest('/editor-state', { method: 'POST', body: { file: 'main.tex', cursorLine: 15, selection: { text: 'measured survival, egg production', fromLine: 16, toLine: 16 } } });
r = await call('get_editor_state');
console.log(r.text); assert.match(r.text, /egg production/);

step('add_bib_entry from BibTeX, duplicate refused');
r = await call('add_bib_entry', { bibtex: '@article{smith2021heat, author={Smith, J.}, title={Repeated heat stress in copepods}, journal={J. Plankton Res.}, year={2021}, doi={10.1093/plankt/fbab000}}' });
console.log(r.text); assert.ok(!r.error);
r = await call('add_bib_entry', { bibtex: '@article{other, title={dup}, doi={10.1093/PLANKT/fbab000}}' });
console.log(r.text); assert.ok(r.error);

console.log('\nAll checks passed.');
await client.close();
if (running) { await running.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(0);
