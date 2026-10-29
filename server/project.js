// Project: a LaTeX repo on disk. All paths handed to/from clients are
// repo-relative with forward slashes; this module is the only place that
// turns them into absolute paths, and it refuses anything outside the repo.
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_DIR = '.margin-build';
export const REVIEW_DIR = '.review';
const IGNORED = new Set(['.git', BUILD_DIR, REVIEW_DIR, 'node_modules', '.DS_Store', '.claude', '.mcp.json']);
// Compared in lower case: on macOS and Windows `.GIT` is the same folder as `.git`.
const IGNORED_LC = new Set([...IGNORED].map((n) => n.toLowerCase()));
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
    return rel.split(/[\\/]/).some((seg) => IGNORED_LC.has(seg.toLowerCase()));
  }

  // Every change on disk (write, mkdir, rename, remove, upload) resolves its path here, so they
  // all share one guard: abs() for containment and symlinks, then the ignored-folder check on the
  // *normalised* path (so `.git\hooks`, `.GIT/x` and `a/../.git/x` are all caught), and no absolute
  // paths. abs() itself stays lenient for reads: it maps `/x` to `<root>/x`.
  #target(rel) {
    if (typeof rel === 'string' && /^[\\/]/.test(rel)) throw new Error(`Absolute paths are not allowed: ${rel}`);
    const abs = this.abs(rel);
    const norm = this.rel(abs);
    if (!norm) throw new Error('That is the paper folder itself');
    if (this.isIgnored(norm)) throw new Error(`Refusing to touch an ignored folder (.git, .review, .claude, .margin-build, node_modules): ${rel}`);
    if (/[\u0000-\u001f]/.test(norm)) throw new Error(`File names cannot contain control characters: ${JSON.stringify(rel)}`);
    return { abs, rel: norm };
  }

  // mkdir -p, but say what is wrong when a file sits where a folder is needed.
  #mkdirp(dirAbs, rel) {
    try { fs.mkdirSync(dirAbs, { recursive: true }); } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOTDIR') throw conflict(`Part of the path is a file, not a folder: ${rel}`);
      throw e;
    }
  }

  #lstat(abs) {
    try { return fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  }

  // The main document cannot be renamed or deleted from under the compiler (or a folder holding it).
  #refuseMain(rel, verb) {
    if (this.main === rel || this.main.startsWith(rel + '/')) {
      const what = rel === this.main ? `${rel} is the main document` : `${rel} contains the main document (${this.main})`;
      throw new Error(`${what}. Change the main document first (Recompile ▾ → Main document), then ${verb} it.`);
    }
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

  // Creates the file (and any missing folders) or replaces it. `exclusive` makes it create-only:
  // it fails rather than replace a file that is already there.
  write(rel, content, { exclusive = false } = {}) {
    const t = this.#target(rel);
    this.#mkdirp(path.dirname(t.abs), t.rel);
    try { fs.writeFileSync(t.abs, content, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' }); } catch (e) {
      if (e.code === 'EEXIST') throw conflict(`Already exists: ${t.rel}`);
      if (e.code === 'EISDIR') throw conflict(`${t.rel} is a folder`);
      throw e;
    }
  }

  // Binary write for uploads. Never replaces an existing file unless `overwrite` is set.
  writeBinary(rel, buf, { overwrite = false } = {}) {
    const t = this.#target(rel);
    const st = this.#lstat(t.abs);
    if (st?.isDirectory()) throw conflict(`${t.rel} is a folder`);
    if (st && !overwrite) throw conflict(`Already exists: ${t.rel}`);
    this.#mkdirp(path.dirname(t.abs), t.rel);
    try { fs.writeFileSync(t.abs, buf, { flag: overwrite ? 'w' : 'wx' }); } catch (e) {
      if (e.code === 'EEXIST') throw conflict(`Already exists: ${t.rel}`);
      throw e;
    }
    return { path: t.rel, size: buf.length };
  }

  mkdir(rel) {
    const t = this.#target(rel);
    if (this.#lstat(t.abs)) throw conflict(`Already exists: ${t.rel}`);
    this.#mkdirp(t.abs, t.rel);
    return { path: t.rel };
  }

  // Moves a file or folder. Both ends go through the same guard as write(). Replacing a file needs
  // `overwrite`; a folder is never replaced.
  rename(from, to, { overwrite = false } = {}) {
    const a = this.#target(from);
    const b = this.#target(to);
    const st = this.#lstat(a.abs);
    if (!st) throw new Error(`Not found: ${a.rel}`);
    if (a.rel === b.rel) throw new Error('The new name is the same as the old one');
    if (b.rel.startsWith(a.rel + '/')) throw new Error(`Cannot move ${a.rel} into itself`);
    this.#refuseMain(a.rel, 'rename');
    const dst = this.#lstat(b.abs);
    // A case-only rename on a case-insensitive disk (Fig.png -> fig.png) "exists" as the same file.
    const sameFile = dst && dst.ino === st.ino && dst.dev === st.dev && a.rel.toLowerCase() === b.rel.toLowerCase();
    if (dst && !sameFile) {
      if (!overwrite) throw conflict(`Already exists: ${b.rel}`);
      if (st.isDirectory() || dst.isDirectory()) throw conflict(`Will not replace a folder: ${b.rel}`);
    }
    this.#mkdirp(path.dirname(b.abs), b.rel);
    fs.renameSync(a.abs, b.abs);
    return { from: a.rel, to: b.rel, type: st.isDirectory() ? 'dir' : 'file' };
  }

  // Deletes a file, or a folder with everything in it. A folder holding something Margin keeps
  // out of sight (.git, node_modules, ...) is refused, since the author cannot see what would go.
  remove(rel) {
    const t = this.#target(rel);
    const st = this.#lstat(t.abs);
    if (!st) throw new Error(`Not found: ${t.rel}`);
    this.#refuseMain(t.rel, 'delete');
    if (!st.isDirectory()) { fs.unlinkSync(t.abs); return { path: t.rel, type: 'file', files: 1 }; }
    let files = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name !== '.DS_Store' && IGNORED_LC.has(e.name.toLowerCase())) {
          throw new Error(`Cannot delete ${t.rel}: it contains ${this.rel(path.join(dir, e.name))}, which Margin keeps out of sight. Remove it in your file manager first.`);
        }
        if (e.name === '.DS_Store') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name)); else files++;
      }
    };
    walk(t.abs);
    fs.rmSync(t.abs, { recursive: true }); // symlinks inside are unlinked, never followed
    return { path: t.rel, type: 'dir', files };
  }

  exists(rel) {
    try { return fs.existsSync(this.abs(rel)); } catch { return false; }
  }

  get buildDir() { return path.join(this.root, BUILD_DIR); }
  get reviewDir() { return path.join(this.root, REVIEW_DIR); }
  get pdfPath() { return path.join(this.buildDir, this.main.replace(/\.tex$/, '.pdf')); }
}

// An error the API reports as 409 (something is in the way) instead of 400.
function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }

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
