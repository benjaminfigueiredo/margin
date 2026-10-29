// Compile with latexmk into .margin-build/ and turn the TeX log into
// structured errors/warnings with file:line, so both the UI and Claude can act on them.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIR } from './project.js';

export const ENGINE_FLAGS = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

// max_print_line stops TeX from hard-wrapping log lines at 79 chars, which breaks parsing.
// Keep it below BibTeX's buffer size (20000), or BibTeX refuses to start. Shared with the
// latexdiff build (server/latexdiff.js), which must not drift from it.
export const latexmkEnv = () => ({ ...process.env, max_print_line: '10000', error_line: '254', half_error_line: '238' });

export function compile(project, { engine = 'pdflatex', timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    mirrorDirs(project);
    const args = [
      ENGINE_FLAGS[engine] || '-pdf',
      '-synctex=1',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-f', // keep going past errors so a partial PDF still appears, like Overleaf
      `-outdir=${BUILD_DIR}`,
      project.main,
    ];
    const child = spawn('latexmk', args, { cwd: project.root, env: latexmkEnv() });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); output += '\n[margin] compile timed out\n'; }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, pdf: false, errors: [{ message: `Could not run latexmk: ${err.message}. Is a TeX distribution installed and on PATH?` }], warnings: [], durationMs: Date.now() - started, log: output });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const logPath = path.join(project.buildDir, project.main.replace(/\.tex$/, '.log'));
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : output;
      const parsed = parseLog(log, project);
      const pdf = fs.existsSync(project.pdfPath) && fs.statSync(project.pdfPath).mtimeMs >= started - 1000;
      resolve({
        // latexmk exits non-zero for undefined references too; "ok" means no TeX errors and a fresh PDF.
        ok: parsed.errors.length === 0 && fs.existsSync(project.pdfPath),
        pdf,
        exitCode: code,
        errors: parsed.errors,
        warnings: parsed.warnings,
        durationMs: Date.now() - started,
        log: log.length > 400000 ? log.slice(-400000) : log,
      });
    });
  });
}

// pdflatex -output-directory cannot create subfolders for \include{sections/intro}; pre-create them.
function mirrorDirs(project) {
  fs.mkdirSync(project.buildDir, { recursive: true });
  for (const entry of project.tree()) {
    if (entry.type === 'dir') fs.mkdirSync(path.join(project.buildDir, entry.path), { recursive: true });
  }
}

export function parseLog(log, project) {
  const errors = [];
  const warnings = [];
  const lines = log.split(/\r?\n/);
  const known = new Set(project ? project.textFiles() : []);
  const norm = (f) => {
    let r = f.replace(/^\.\//, '');
    if (project && path.isAbsolute(r)) r = project.rel(r);
    return r;
  };
  let currentFile = project ? project.main : null;
  const fileOpen = /\((\.?\.?\/?[^\s()]+?\.(?:tex|bbl|ltx))/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track the most recently opened source file (best effort; TeX logs have no reliable structure).
    for (const m of line.matchAll(fileOpen)) {
      const f = norm(m[1]);
      if (known.size === 0 || known.has(f)) currentFile = f;
    }

    // -file-line-error format: ./sections/intro.tex:42: Undefined control sequence.
    let m = line.match(/^(\.?\.?\/?[^:\s][^:]*?\.(?:tex|bbl|sty|cls|ltx)):(\d+): (.*)$/);
    if (m) {
      const context = collectContext(lines, i + 1);
      errors.push({ file: norm(m[1]), line: Number(m[2]), message: m[3].trim(), context });
      continue;
    }
    // Errors without a location, e.g. "! LaTeX Error: File `foo.sty' not found." in some engines
    m = line.match(/^! (.*)$/);
    if (m) {
      const context = collectContext(lines, i + 1);
      const lm = context.match(/^l\.(\d+)/m);
      errors.push({ file: currentFile, line: lm ? Number(lm[1]) : null, message: m[1].trim(), context });
      continue;
    }
    m = line.match(/^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/);
    if (m) {
      let msg = m[3];
      // Continuation lines are indented with "(pkg)" or spaces
      let j = i + 1;
      while (j < lines.length && /^(\(\S+\)\s+|\s{4,})\S/.test(lines[j]) && j - i < 6) { msg += ' ' + lines[j].replace(/^\(\S+\)\s+/, '').trim(); j++; }
      const lm = msg.match(/on input line (\d+)/);
      warnings.push({ file: lm ? currentFile : null, line: lm ? Number(lm[1]) : null, message: msg.replace(/\s+/g, ' ').trim(), kind: classifyWarning(msg), source: m[1] || m[2] || 'LaTeX' });
      continue;
    }
    m = line.match(/^(Overfull|Underfull) \\[hv]box (.*?)(?:in paragraph |detected )?at lines? (\d+)(?:--(\d+))?/);
    if (m) {
      warnings.push({ file: currentFile, line: Number(m[3]), message: line.trim(), kind: 'box' });
    }
  }
  return { errors: dedupe(errors), warnings: dedupe(warnings) };
}

function collectContext(lines, start) {
  const ctx = [];
  for (let j = start; j < Math.min(lines.length, start + 6); j++) {
    if (lines[j].trim() === '' && ctx.length > 0) break;
    ctx.push(lines[j]);
    if (/^l\.\d+/.test(lines[j])) { if (lines[j + 1] !== undefined) ctx.push(lines[j + 1]); break; }
  }
  return ctx.join('\n');
}

function classifyWarning(msg) {
  if (/Citation .* undefined/i.test(msg)) return 'citation';
  if (/Reference .* undefined/i.test(msg)) return 'reference';
  if (/multiply.defined/i.test(msg)) return 'duplicate-label';
  if (/Rerun/i.test(msg)) return 'rerun';
  return 'other';
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = `${it.file}|${it.line}|${it.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- SyncTeX ----------

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function parseSynctex(stdout) {
  // Output is a series of "Key:value" lines, possibly several result records.
  const records = [];
  let cur = null;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(\w+):(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if ((k === 'Output' || k === 'Input') && cur && cur[k] !== undefined) { records.push(cur); cur = null; }
    if (!cur) cur = {};
    cur[k] = v.trim();
  }
  if (cur) records.push(cur);
  return records;
}

// Source position -> PDF location (page, x, y in PDF points from top-left)
export async function forwardSearch(project, file, line, column = 0) {
  if (!fs.existsSync(project.pdfPath)) throw new Error('No PDF yet: compile first');
  const input = project.abs(file);
  const out = await run('synctex', ['view', '-i', `${line}:${column}:${input}`, '-o', project.pdfPath], project.root);
  const rec = parseSynctex(out).find((r) => r.Page);
  if (!rec) return null;
  return { page: Number(rec.Page), x: Number(rec.x), y: Number(rec.y), h: Number(rec.h), v: Number(rec.v), width: Number(rec.W), height: Number(rec.H) };
}

// PDF location -> source position
export async function inverseSearch(project, page, x, y) {
  if (!fs.existsSync(project.pdfPath)) throw new Error('No PDF yet: compile first');
  const out = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${project.pdfPath}`], project.root);
  const rec = parseSynctex(out).find((r) => r.Input);
  if (!rec) return null;
  let input = rec.Input;
  // SyncTeX records paths as TeX saw them: absolute, or relative to the project root with "./" and sometimes "/./"
  input = input.replace(/\/\.\//g, '/');
  const absInput = path.isAbsolute(input) ? input : path.resolve(project.root, input);
  // TeX may report the resolved path (macOS: /var -> /private/var), so compare real paths
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const file = path.relative(real(project.root), real(absInput)).split(path.sep).join('/');
  return { file, line: Number(rec.Line), column: Math.max(0, Number(rec.Column)) };
}
