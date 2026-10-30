// One-click "marked-up PDF of what changed", for resubmissions: runs latexdiff between a git
// ref (default: the last sync with Overleaf) and the paper on disk, then compiles the result
// into .margin-build/diff/. The normal build output (project.pdfPath) is never touched, and
// nothing is written outside .margin-build/.
//
// latexdiff --flatten, not one latexdiff per file
// ------------------------------------------------
// A multi-file paper needs either `latexdiff --flatten` (one run, with every \input/\include
// replaced by the file's text on both sides) or a latexdiff per .tex file plus a copy of the
// whole project tree to point \input at. We use --flatten:
//  + One pass over whole documents, so text moved between files (a paragraph from intro.tex to
//    methods.tex) shows as moved, and files added or deleted since the ref just appear or
//    vanish where they are included. Per-file diffs would show those as wholesale delete + add,
//    and need extra logic to pair files up (renames, new files, files only one side includes).
//  + The result is one self-contained .tex: no mirrored project tree, no rewriting of \input
//    paths. It compiles from the paper folder, so figures, .bib, .bst and .cls resolve exactly
//    as in a normal build.
//  - latexdiff only expands what its flattener understands: \input, \include, \subfile and
//    \import-style commands in the body. An \input in the preamble, or a file it cannot find,
//    stays an \input, is then read from the current paper (so it has no change marks), and is
//    reported to the author as a warning instead of being silently undiffed.
//  - latexdiff resolves \input relative to each side's main file, so each side is staged as a
//    plain tree of text sources (old: from git, new: a snapshot of the paper) with the main file
//    at the same relative path. That also keeps a stale .bbl beside the sources out of it:
//    latexdiff would otherwise inline it in place of \bibliography on one side only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git, isRepo } from './git.js';
import { baseline, resolveRef } from './changes.js';
import { ENGINE_FLAGS, latexmkEnv, parseLog } from './compile.js';
import { isTextFile } from './project.js';

export const DIFF_NAME = 'margin-diff';
const STAGE_RE = /\.(tex|ltx|tikz|pgf|txt)$/i; // what \input / \include / \subfile can pull in
const STAGE_MAX_FILE = 5 * 1024 * 1024;
const STAGE_MAX_TOTAL = 80 * 1024 * 1024;

export const diffDir = (project) => path.join(project.buildDir, 'diff');
export const diffPdfPath = (project) => path.join(diffDir(project), `${DIFF_NAME}.pdf`);

export const MISSING_MESSAGE = 'latexdiff is not installed (or is not on PATH). Margin needs the `latexdiff` command to make a marked-up PDF. '
  + 'macOS: full MacTeX includes it; with BasicTeX run `sudo tlmgr install latexdiff`. Ubuntu/Debian: `sudo apt install latexdiff`. '
  + 'It also needs Perl, which macOS and Linux have.';

function run(cmd, args, { cwd, timeout = 15000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
  });
}

// { installed, version } or { installed: false, message } like compile.js does for latexmk.
export async function checkLatexdiff(cmd = 'latexdiff') {
  const r = await run(cmd, ['--version']);
  if (r.error) return { installed: false, message: r.error.code === 'ENOENT' ? MISSING_MESSAGE : `Could not run latexdiff: ${r.error.message}. ${MISSING_MESSAGE}` };
  return { installed: true, version: (r.stdout + r.stderr).split('\n')[0].trim() };
}

// Marked-up changes need ulem and listings (latexdiff's default UNDERLINE style: strike-through
// for deletions). They live in texlive-plain-generic / latex-extra on Ubuntu and are missing from
// BasicTeX, and a missing package would fail every diff build. CFONT needs only `color`.
let styleCache = null;
export async function markupStyle() {
  if (styleCache) return styleCache;
  const have = async (f) => { const r = await run('kpsewhich', [f]); return !!r.error || (r.ok && r.stdout.trim() !== ''); }; // no kpsewhich: assume the full set
  styleCache = (await have('ulem.sty')) && (await have('listings.sty')) ? 'UNDERLINE' : 'CFONT';
  return styleCache;
}
export const resetStyleCache = () => { styleCache = null; };

// The previous diff build, if its PDF is still there (it survives a restart).
export function lastDiff(project) {
  try {
    if (!fs.existsSync(diffPdfPath(project))) return null;
    return JSON.parse(fs.readFileSync(path.join(diffDir(project), 'meta.json'), 'utf8'));
  } catch { return null; }
}

// Files of the old tree: text sources only (what latexdiff can inline), straight from git's object
// store through one `cat-file --batch`, so nothing is checked out and the working tree is never touched.
async function extractOld(project, sha, dest) {
  const ls = await git(project, ['ls-tree', '-r', '-z', sha], { maxBuffer: 256 * 1024 * 1024 });
  if (!ls.ok) throw new Error(`Could not read ${sha.slice(0, 7)}: ${(ls.stderr || '').trim().split('\n')[0]}`);
  const wanted = [];
  for (const entry of ls.stdout.split('\0').filter(Boolean)) {
    const m = entry.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/s); // symlinks (120000) and submodules are not blobs we want
    if (!m || (m[1] !== '100644' && m[1] !== '100755')) continue;
    const rel = m[3];
    if (!STAGE_RE.test(rel) || /[\u0000-\u001f]/.test(rel) || rel.split('/').some((s) => s === '..' || s === '') || project.isIgnored(rel)) continue;
    wanted.push({ oid: m[2], rel });
  }
  if (!wanted.length) return 0;
  const out = await new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: project.root, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.on('error', () => {});
    child.stdin.end(wanted.map((w) => `${w.oid}\n`).join(''));
  });
  let pos = 0; let total = 0; let written = 0;
  for (const w of wanted) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) break;
    const [, type, size] = out.toString('utf8', pos, eol).split(' ');
    const n = Number(size);
    if (type !== 'blob' || !Number.isFinite(n)) { pos = eol + 1; continue; }
    const body = out.subarray(eol + 1, eol + 1 + n);
    pos = eol + 1 + n + 1;
    total += n;
    if (n > STAGE_MAX_FILE || total > STAGE_MAX_TOTAL) continue;
    const target = path.resolve(dest, w.rel);
    if (!target.startsWith(dest + path.sep)) continue; // never write outside the staging folder
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    written++;
  }
  return written;
}

// A snapshot of the paper's current text sources (the same set, from disk).
function stageNew(project, dest) {
  let total = 0;
  for (const e of project.tree()) {
    if (e.type !== 'file' || !STAGE_RE.test(e.path) || !isTextFile(e.path) || e.size > STAGE_MAX_FILE || (total += e.size) > STAGE_MAX_TOTAL) continue;
    const target = path.join(dest, e.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(project.abs(e.path), target);
  }
}

// \subfile / \input that survived flattening: not compared, so the author is told.
function unexpanded(tex) {
  const names = new Set();
  for (const m of tex.matchAll(/^[^%\n]*?\\(?:input|include|subfile)\s*\{([^}#]+)\}/gm)) names.add(m[1].trim());
  return [...names];
}

const noise = (l) => !l.trim() || /^Bibliography file .* cannot be found/.test(l); // no .bbl is staged on purpose

export async function makeDiffPdf(project, { ref, engine = 'pdflatex', latexdiff = 'latexdiff', timeoutMs = 240000 } = {}) {
  const started = Date.now();
  const tool = await checkLatexdiff(latexdiff);
  if (!tool.installed) throw Object.assign(new Error(tool.message), { missing: 'latexdiff' });
  if (!(await isRepo(project))) throw new Error('This paper is not a git repository, so there is no earlier version to compare with. Clone your Overleaf project with git first.');

  // What to compare with: the commit the Changes view uses by default, or the ref the author chose.
  let sha; let label;
  if (ref == null || String(ref).trim() === '') {
    const b = await baseline(project, 'sync');
    if (b.noCommits) throw new Error('This repository has no commits yet, so there is nothing to compare with.');
    sha = b.sha;
    label = b.kind === 'upstream' ? `your last sync with ${b.overleaf ? 'Overleaf' : 'the remote'}` : 'your last commit';
  } else {
    sha = await resolveRef(project, ref);
    label = String(ref).trim();
  }
  const short = sha.slice(0, 7);
  if (/^[0-9a-f]{40,64}$/i.test(label)) label = label.slice(0, 7);
  const main = project.main;
  if (!STAGE_RE.test(main)) throw new Error(`The main document ${main} is not a .tex file.`);

  // Fresh folder every time: stale .aux/.bbl from an earlier diff must not leak into this one,
  // and a failed build must not leave an old PDF that looks like this one.
  const dir = diffDir(project);
  fs.rmSync(dir, { recursive: true, force: true });
  const oldDir = path.join(dir, 'old'); const newDir = path.join(dir, 'new');
  fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(newDir, { recursive: true });
  try {
    await extractOld(project, sha, oldDir);
    if (!fs.existsSync(path.join(oldDir, main))) throw new Error(`${main} does not exist in ${label} (${short}), so there is nothing to compare it with. Choose a later commit.`);
    stageNew(project, newDir);

    const style = await markupStyle();
    const texPath = path.join(dir, `${DIFF_NAME}.tex`);
    const fd = fs.openSync(texPath, 'w');
    let ld;
    try {
      ld = await new Promise((resolve) => {
        const child = spawn(latexdiff, ['--flatten', '--no-label', `--type=${style}`, path.join(oldDir, main), path.join(newDir, main)], { cwd: dir, stdio: ['ignore', fd, 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, stderr: error.message }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr }); });
      });
    } finally { fs.closeSync(fd); }
    const ldLines = ld.stderr.split('\n').filter((l) => !noise(l));
    const tex = fs.readFileSync(texPath, 'utf8');
    if (!ld.ok || !tex.includes('\\begin{document}')) {
      throw new Error(`latexdiff could not compare the two versions: ${ldLines.slice(0, 3).join(' ') || 'it produced no document'}`);
    }
    const warnings = ldLines.filter((l) => /^WARNING|^Warning|^ERROR/i.test(l)).slice(0, 5).map((l) => ({ message: `latexdiff: ${l.trim()}` }));
    const skipped = unexpanded(tex);
    if (skipped.length) warnings.push({ message: `Not compared, so shown as they are now with no change marks (included from the preamble, or not found): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}` });

    // Same latexmk setup as a normal compile (see compile.js), from the paper folder so figures,
    // .bib and .cls resolve as usual, writing only under .margin-build/diff/.
    const rel = path.relative(project.root, dir).split(path.sep).join('/');
    const args = [ENGINE_FLAGS[engine] || '-pdf', '-interaction=nonstopmode', '-file-line-error', '-f', `-outdir=${rel}`, `${rel}/${DIFF_NAME}.tex`];
    const built = await new Promise((resolve) => {
      const child = spawn('latexmk', args, { cwd: project.root, env: latexmkEnv() });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); output += '\n[margin] diff compile timed out\n'; }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); resolve({ output: `Could not run latexmk: ${err.message}. Is a TeX distribution installed and on PATH?` }); });
      child.on('close', () => { clearTimeout(timer); resolve({ output }); });
    });
    const logPath = path.join(dir, `${DIFF_NAME}.log`);
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : built.output;
    const parsed = parseLog(log, project);
    // Errors inside the generated .tex have no line the author can open; keep the message only.
    const errors = parsed.errors.slice(0, 10).map((e) => (e.file && !String(e.file).includes(DIFF_NAME) ? { message: e.message, file: e.file, line: e.line } : { message: e.message }));
    const pdf = fs.existsSync(diffPdfPath(project));
    const result = {
      ok: pdf, pdf, url: '/pdf-diff', ref: label, sha, short, style, engine,
      errors, warnings, durationMs: Date.now() - started, at: Date.now(),
      log: pdf ? undefined : log.slice(-4000),
    };
    if (!pdf && !errors.length) errors.push({ message: 'LaTeX produced no PDF. See the end of the log below.' });
    if (pdf) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ref: label, sha, short, style, engine, at: result.at, errors: errors.length, warnings: warnings.length }));
    return result;
  } finally {
    // The staged copies are scratch; the .tex, .pdf and .log stay for inspection.
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.rmSync(newDir, { recursive: true, force: true });
  }
}
