// Project: a LaTeX repo on disk. All paths handed to/from clients are
// repo-relative with forward slashes; this module is the only place that
// turns them into absolute paths, and it refuses anything outside the repo.
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_DIR = '.margin-build';
export const REVIEW_DIR = '.review';
const IGNORED = new Set(['.git', BUILD_DIR, REVIEW_DIR, 'node_modules', '.DS_Store', '.claude', '.mcp.json']);
const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.cfg', '.def', '.bbx', '.cbx', '.latexmkrc', '.json', '.yaml', '.yml', '.csv', '.tikz', '.pgf', '.ltx', '.dtx', '.ins', '.clo', '.lco']);
// Build artefacts LaTeX leaves next to sources when compiled elsewhere (e.g. Overleaf zips, old local builds).
const ARTEFACT_EXT = new Set(['.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.synctex.gz', '.bbl', '.blg', '.bcf', '.run.xml', '.nav', '.snm', '.vrb']);

export class Project {
  constructor(root, { main } = {}) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new Error(`Not a directory: ${this.root}`);
    }
    // Resolved once: the paper itself may sit behind a symlink (/tmp, /var on macOS).
    // Containment is checked against this, never against the lexical root.
    this.realRoot = fs.realpathSync(this.root);
    this.name = path.basename(this.root);
    this.main = main || detectMain(this.root);
  }

  abs(rel) {
    if (typeof rel !== 'string' || rel.length === 0) throw new Error('path is required');
    const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const p = path.resolve(this.root, cleaned);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error(`Path escapes project: ${rel}`);
    this.#checkReal(p, rel);
    return p;
  }

  // Symlinks must not lead out of the paper folder. The target may not exist yet
  // (write() creates files and folders), so resolve the longest existing ancestor
  // and re-append the rest. Applies to reads as well as writes: reading through
  // an escaping link would leak files via /api/raw and read_file.
  #checkReal(p, rel) {
    const real = this.#resolve(p, rel, 0);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
      throw new Error(`Path escapes project (symlink points outside the paper folder): ${rel}`);
    }
  }

  #resolve(p, rel, depth) {
    if (depth > 40) throw new Error(`Path escapes project (too many symlinks): ${rel}`);
    try {
      return fs.realpathSync(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Cannot verify path stays inside the paper folder (${e.code}): ${rel}`);
    }
    // ENOENT: either p is missing, or p is a dangling symlink (whose target a write would create).
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`Cannot verify path stays inside the paper folder (${e.code}): ${rel}`); }
    if (st && st.isSymbolicLink()) {
      return this.#resolve(path.resolve(this.#resolve(path.dirname(p), rel, depth + 1), fs.readlinkSync(p)), rel, depth + 1);
    }
    const parent = path.dirname(p);
    if (parent === p) throw new Error(`Cannot verify path stays inside the paper folder: ${rel}`);
    return path.join(this.#resolve(parent, rel, depth + 1), path.basename(p));
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  isIgnored(rel) {
    return rel.split('/').some((seg) => IGNORED.has(seg));
  }

  tree() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const e of entries) {
        if (IGNORED.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = this.rel(abs);
        if (e.isDirectory()) { out.push({ path: rel, type: 'dir' }); walk(abs); }
        else if (e.isFile()) {
          if (isArtefact(e.name)) continue;
          out.push({ path: rel, type: 'file', text: isTextFile(e.name), size: fs.statSync(abs).size });
        }
      }
    };
    walk(this.root);
    return out;
  }

  textFiles(ext) {
    return this.tree().filter((f) => f.type === 'file' && f.text && (!ext || f.path.endsWith(ext))).map((f) => f.path);
  }

  read(rel) {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }

  write(rel, content) {
    const p = this.abs(rel);
    if (this.isIgnored(rel)) throw new Error(`Refusing to write into an ignored folder: ${rel}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }

  exists(rel) {
    try { return fs.existsSync(this.abs(rel)); } catch { return false; }
  }

  get buildDir() { return path.join(this.root, BUILD_DIR); }
  get reviewDir() { return path.join(this.root, REVIEW_DIR); }
  get pdfPath() { return path.join(this.buildDir, this.main.replace(/\.tex$/, '.pdf')); }
}

export function isTextFile(name) {
  const lower = name.toLowerCase();
  if (lower === 'latexmkrc' || lower === '.latexmkrc') return true;
  return TEXT_EXT.has(path.extname(lower));
}

function isArtefact(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.synctex.gz') || lower.endsWith('.run.xml')) return true;
  return ARTEFACT_EXT.has(path.extname(lower));
}

// Overleaf's default is main.tex; otherwise pick the root-level .tex that has \documentclass.
export function detectMain(root) {
  const rootTex = fs.readdirSync(root).filter((f) => f.endsWith('.tex'));
  if (rootTex.includes('main.tex')) return 'main.tex';
  const withClass = rootTex.filter((f) => /^[^%\n]*\\documentclass/m.test(fs.readFileSync(path.join(root, f), 'utf8')));
  if (withClass.length > 0) return withClass[0];
  return rootTex[0] || 'main.tex';
}
