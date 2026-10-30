// get_cited_pdf: find the PDF of a cited paper on this computer so Claude can read it and judge
// whether it supports the sentence that cites it. Sources, in this order:
//   1. the author's Zotero (an attachment of the item with that citation key: stored or linked file,
//      any library, via server/zotero.js);
//   2. the paper's private context: a PDF named <key>.pdf in .review/context/ (case-insensitive),
//      for authors without Zotero.
// Nothing is fetched from the internet. The PDF found is copied to .margin-build/cited/<key>.pdf in
// the paper folder, because Claude Code reads files inside the project without a permission prompt
// and asks for ones outside it. .margin-build/ is local-only (LOCAL_ONLY in init.js, IGNORED in
// project.js), so the copies never reach git or Overleaf.
//
// The key becomes a file name, so it is validated strictly. Sources are opened, never trusted: a
// regular file, at most CITED_MAX_BYTES, starting with "%PDF-". The cache folder must be a plain
// folder (a link in its place is refused, never followed) and files are written to a temporary
// name and renamed into place. The copy gets the source's modification time, so "same size and same
// mtime" means unchanged and anything else is copied again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUILD_DIR } from './project.js';
import { citations, parseBib } from './bib.js';
import { zoteroAttachments } from './zotero.js';

export const CITED_FOLDER = `${BUILD_DIR}/cited`; // relative to the paper folder
export const CITED_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_KEYS = 10;
const MAX_KEY = 120;
const NOT_REACHABLE = /not running|did not answer|cannot query|open Zotero/i;

// What a BibTeX key may be here: letters, digits and _ : . + - (so never a path), starting with a
// letter, digit or underscore, not ending in a dot. Stricter than BibTeX itself on purpose.
const KEY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_:.+-]*$/u;

export function checkKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('A citation key is required.');
  if (key.length > MAX_KEY || !KEY_RE.test(key) || key.endsWith('.')) {
    throw new Error(`Not a usable citation key: ${JSON.stringify(key.length > 60 ? key.slice(0, 60) + '…' : key)}. Give the key as it appears in \\cite{…} and the .bib file (letters, digits and _ : . + - only).`);
  }
  return key;
}

// Something wrong with the source file itself (as opposed to Margin's own folders): the next
// attachment, or the context, may still work.
class BadSource extends Error {}

const mb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function lstat(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

// .margin-build/cited, created if need be; both folders must be plain folders, never links.
function citedDir(project) {
  let dir = project.root;
  for (const part of [BUILD_DIR, 'cited']) {
    dir = path.join(dir, part);
    let st = lstat(dir);
    if (!st) {
      try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      st = lstat(dir);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path.relative(project.root, dir)} is not a plain folder (a link or a file is in its place), so Margin will not copy PDFs there.`);
  }
  return dir;
}

// Checks an open source file and copies it to <cache>/<key>.pdf unless that copy is current.
// Returns { size, refreshed }. Throws a message that says what is wrong with the file.
function stageCopy(project, key, fd, what) {
  const st = fs.fstatSync(fd);
  if (!st.isFile()) throw new BadSource(`${what} is not a regular file.`);
  if (st.size === 0) throw new BadSource(`${what} is empty.`);
  if (st.size > CITED_MAX_BYTES) throw new BadSource(`${what} is ${mb(st.size)}, over the ${CITED_MAX_BYTES / 1024 / 1024} MB limit.`);
  const head = Buffer.alloc(5);
  if (fs.readSync(fd, head, 0, 5, 0) < 5 || head.toString('latin1') !== '%PDF-') throw new BadSource(`${what} is not a PDF (it does not start with %PDF-).`);

  const dir = citedDir(project);
  const dest = path.join(dir, `${key}.pdf`);
  const cur = lstat(dest);
  // Timestamps round-trip through utimes to within a millisecond or so (and coarser on some disks).
  if (cur?.isFile() && cur.size === st.size && Math.abs(cur.mtimeMs - st.mtimeMs) < 2) return { size: st.size, refreshed: false };

  const tmp = path.join(dir, `.${key}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const out = fs.openSync(tmp, 'wx', 0o600);
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0, n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { fs.writeSync(out, buf, 0, n); pos += n; }
    if (pos !== st.size) throw new BadSource(`${what} changed while it was being copied; try again.`);
    fs.futimesSync(out, st.atimeMs / 1000, st.mtimeMs / 1000);
    fs.closeSync(out);
    fs.renameSync(tmp, dest); // replaces an older copy, or a link that sits there, without following it
  } catch (e) {
    try { fs.closeSync(out); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* nothing left */ }
    throw e;
  }
  return { size: st.size, refreshed: !!cur };
}

// Title, authors and year from the manuscript's own .bib, for keys Zotero does not describe.
function bibMeta(project, key) {
  try {
    for (const b of citations(project).bibs) {
      const e = parseBib(project.read(b)).find((x) => x.key === key);
      if (!e) continue;
      const clean = (s) => String(s || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
      return { title: clean(e.fields.title), authors: clean(e.fields.author).replace(/\s+and\s+/g, '; '), year: clean(e.fields.year || e.fields.date).match(/\d{4}/)?.[0], fromBib: b };
    }
  } catch { /* the bibliography is optional here */ }
  return null;
}

// A PDF in the private context named <key>.pdf (any case); returns the context file's name.
function contextName(context, key) {
  if (!context) return null;
  const want = `${key}.pdf`.normalize('NFC').toLowerCase();
  return context.list().items.find((it) => it.name.normalize('NFC').toLowerCase() === want)?.name || null;
}

const HOW_TO_ADD = (key) => `Attach the PDF to the item in Zotero, or add ${key}.pdf in Margin's Context view (the file name is the citation key).`;

async function findOne({ project, context }, key, zoteroState) {
  const why = []; // what was tried and why it gave nothing
  // 1. Zotero
  if (!zoteroState.down) {
    try {
      const z = await zoteroAttachments(key);
      const bad = [];
      const good = [];
      for (const f of z.files) {
        let fd;
        try {
          // Zotero's own file, possibly a link into Dropbox: followed, but it must be a regular PDF.
          // O_NONBLOCK so that a named pipe in its place cannot hang the server.
          fd = fs.openSync(f.path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
        } catch (e) {
          bad.push(`${f.name}: ${e.code === 'ENOENT' ? 'Zotero lists it but the file is not on this computer (not synced down yet, or moved: open the item in Zotero)' : e.message}`);
          continue;
        }
        try {
          const r = stageCopy(project, key, fd, f.name);
          good.push({ name: f.name, ...r });
        } catch (e) { if (!(e instanceof BadSource)) throw Object.assign(e, { hard: true }); bad.push(e.message); } finally { fs.closeSync(fd); }
        if (good.length) break; // first usable PDF wins; the others are only named
      }
      if (good.length) {
        const [first] = good;
        const others = z.files.map((f) => f.name).filter((n) => n !== first.name);
        return { key, ok: true, source: 'zotero', via: z.via, library: z.item.library, meta: z.item, file: first.name, size: first.size, refreshed: first.refreshed, others };
      }
      if (z.files.length) why.push(`Zotero has the item (${z.item.title}) but none of its attachments is a usable PDF: ${bad.map((b) => b.replace(/\.$/, '')).join('; ')}.`);
      else why.push(`Zotero has the item (${z.item.title}) but no PDF attached${z.skipped.length ? ` (${[...new Set(z.skipped)].join('; ')})` : ''}.`);
    } catch (e) {
      if (e.hard) throw e; // Margin's own cache folder is unusable: not Zotero's fault, and the context would fail the same way
      if (NOT_REACHABLE.test(e.message)) zoteroState.down = e.message;
      why.push(e.message);
    }
  } else why.push(zoteroState.down);

  // 2. The private context
  let name = null;
  try { name = contextName(context, key); } catch (e) { why.push(`Context folder unavailable: ${e.message}`); }
  if (name) {
    try {
      const f = context.open(name); // O_NOFOLLOW, regular files only
      try {
        const r = stageCopy(project, key, f.fd, `The context file ${name}`);
        return { key, ok: true, source: 'context', meta: bibMeta(project, key), file: name, size: r.size, refreshed: r.refreshed, others: [] };
      } finally { fs.closeSync(f.fd); }
    } catch (e) {
      if (!(e instanceof BadSource) && !e.status && e.code !== 'ELOOP' && e.code !== 'ENOENT') throw e; // e.status: ContextStore refused the file
      why.push(e.message);
    }
  }

  // 3. Nothing local
  return { key, ok: false, why, hint: HOW_TO_ADD(key) };
}

// keys: citation keys. Returns one result per distinct key (keys equal but for case count once, as in
// BibTeX): { key, ok: true, source, … } or { key, ok: false, error | why, hint }.
export async function findCitedPdfs(ctx, keys) {
  const out = [];
  const seen = new Set();
  const zoteroState = { down: null };
  for (const raw of keys) {
    try {
      const key = checkKey(raw);
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      out.push(await findOne(ctx, key, zoteroState));
    } catch (e) {
      out.push({ key: String(raw), ok: false, error: e.message });
    }
  }
  return out;
}

// The tool's answer.
export function describeCitedPdfs(project, results) {
  const blocks = results.map((r) => {
    if (!r.ok) {
      if (r.error) return `${r.key}: ${r.error}`;
      return [`no local PDF for ${r.key}`, ...r.why.map((w) => `  ${w}`), `  What to do: ${r.hint}`].join('\n');
    }
    const rel = `${CITED_FOLDER}/${r.key}.pdf`;
    const m = r.meta || {};
    const lines = [`${r.key}: ${m.title || '(title unknown)'}${m.authors ? ` — ${m.authors}` : ''}${m.year ? ` (${m.year})` : ''}`];
    lines.push(`  read: ${rel}   (absolute: ${path.join(project.root, rel)})`);
    lines.push(`  source: ${r.source === 'zotero' ? `zotero (${r.via}${r.library && r.library !== 'My Library' ? `, library: ${r.library}` : ''}), attachment ${r.file}` : `context (.review/context/${r.file})${m.fromBib ? `; description from ${m.fromBib}` : ''}`}; ${mb(r.size)}; ${r.refreshed ? 'copy refreshed because the source changed' : 'copy is current'}`);
    if (r.others?.length) lines.push(`  other attachments not copied: ${r.others.join(', ')} (ask the author if the claim might rest on supplementary material)`);
    return lines.join('\n');
  });
  const found = results.filter((r) => r.ok).length;
  const tail = found ? '\nRead each PDF with your Read tool on the path above. Its page count is not known here: read the abstract and the relevant part first, and pass a pages range such as "1-5" (Read requires one for PDFs over 10 pages and reports the page count). Quote and cite page numbers only from what you actually read; never invent them. If the PDF is a scan without text, say so rather than guessing.' : '';
  return blocks.join('\n\n') + tail;
}
