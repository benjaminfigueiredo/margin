// The Changes view: what differs between the paper on disk and an earlier state of it, as
// per-file hunks the UI can show and jump into. Read-only: it only ever runs `git diff`,
// `git log` and friends, never anything that moves HEAD, the index or the working tree.
//
// Two baselines, because "what changed" has two honest meanings:
//   sync  since the last sync with Overleaf: everything committed or edited here that Overleaf
//         does not have. With no upstream (a local-only repo, or a branch that tracks nothing)
//         there is no "last sync" to compare with, so this falls back to HEAD and says so.
//   head  uncommitted edits only (the working tree against the last commit).
import { git, status } from './git.js';
import { isTextFile } from './project.js';
import fs from 'node:fs';

const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_LINES_PER_FILE = 3000; // lines kept per file; counts stay exact, the rest is "truncated"
const MAX_FILES = 300;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const RECENT_COMMITS = 30;

const trim = (r) => r.stdout.trim();

// The commit a "changes since" view compares against, plus what the UI needs to describe it.
//
// With an upstream the baseline is the merge-base of HEAD and the upstream, not the upstream
// itself. They are the same commit while you are only ahead (the normal case). They differ when
// a co-author has pushed commits you have not pulled: diffing against the upstream tip would then
// show their new work as if you had deleted it. The merge-base is the last point both sides
// agree on, which is what "since the last sync" means.
export async function baseline(project, since = 'sync') {
  const st = await status(project);
  if (!st.repo) return { repo: false };
  const out = { repo: true, branch: st.branch, tracking: st.tracking, ahead: st.ahead, behind: st.behind, overleaf: st.overleaf, remote: st.remote };
  const head = await git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok) return { ...out, noCommits: true };
  out.head = trim(head);
  let sha = out.head;
  out.kind = 'head';
  if (since === 'sync' && st.tracking) {
    const up = await git(project, ['rev-parse', '--verify', '--quiet', '@{u}^{commit}']);
    const mb = await git(project, ['merge-base', 'HEAD', '@{u}']);
    if (up.ok) { sha = mb.ok ? trim(mb) : trim(up); out.kind = 'upstream'; }
  }
  out.sha = sha;
  const when = await git(project, ['log', '-1', '--format=%cI%x1f%s', sha]);
  if (when.ok) { const [time, subject] = trim(when).split('\x1f'); out.time = time; out.subject = subject; }
  return out;
}

// Turns a user-supplied ref into a full commit sha, or throws a message fit for a toast. The ref
// goes to git as an argument, so one that looks like an option is refused before git sees it
// (`--output=...` would otherwise write a file), and everything after this uses the sha.
export async function resolveRef(project, ref) {
  const r = String(ref ?? '').trim();
  if (!r) throw new Error('Choose a commit, tag or branch to compare with.');
  if (r.startsWith('-') || /[\u0000-\u001f\u007f]/.test(r)) throw new Error(`"${r}" is not a valid git ref.`);
  const v = await git(project, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]);
  if (!v.ok) throw new Error(`Git does not know "${r}" here. Use a commit hash, a tag or a branch name.`);
  return trim(v);
}

export async function recentCommits(project, n = RECENT_COMMITS) {
  const r = await git(project, ['log', `-${n}`, '--format=%H%x1f%cI%x1f%s%x1f%D']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, time, subject, refs] = l.split('\x1f');
    const tags = (refs || '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('tag: ')).map((x) => x.slice(5));
    return { sha, short: sha.slice(0, 7), time, subject, tags };
  });
}

// GET /api/changes. `since`: 'sync' (default) or 'head'.
export async function changes(project, { since = 'sync' } = {}) {
  if (since !== 'sync' && since !== 'head') throw new Error('since must be "sync" or "head"');
  const base = await baseline(project, since);
  if (!base.repo) return { repo: false, since, files: [], totals: { files: 0, additions: 0, deletions: 0 }, commits: [] };
  const result = { ...base, since, files: [], truncated: false, commits: await recentCommits(project) };
  if (base.noCommits) return { ...result, totals: { files: 0, additions: 0, deletions: 0 } };

  const d = await git(project, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U3', '--relative', '--src-prefix=a/', '--dst-prefix=b/', base.sha, '--'], { maxBuffer: MAX_DIFF_BYTES });
  if (!d.ok) throw new Error(`git diff failed: ${(d.stderr || '').trim().split('\n')[0] || 'unknown error'}`);
  const files = parseDiff(d.stdout).filter((f) => !project.isIgnored(f.path));

  // `git diff` does not list files git has never seen. A section the author just created is a
  // change, so list those as added files (they are not in the index, so nothing to rename from).
  const un = await git(project, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (un.ok) {
    const known = new Set(files.map((f) => f.path));
    for (const rel of un.stdout.split('\0').filter(Boolean)) {
      if (known.has(rel) || project.isIgnored(rel)) continue;
      const f = untrackedFile(project, rel);
      if (f) files.push(f);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_FILES) { result.truncated = true; files.length = MAX_FILES; }
  result.files = files;
  result.totals = { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) };
  return result;
}

// "Suggestions accepted since <time>". `since` is an ISO time, or 'sync' for the time of the commit the
// Changes view compares against (the last sync, or the last commit when there is no upstream).
// Derived only from .review/review.json and its archive; Margin keeps no notion of a Claude session.
export async function acceptedSince(project, review, since) {
  let iso = String(since || '');
  let basis = 'time';
  if (iso === 'sync') {
    const b = await baseline(project, 'sync');
    if (!b.time) throw new Error(b.repo ? 'There is no commit to measure "since the last sync" from yet.' : 'Not a git repository, so there is no last sync. Pick a time instead.');
    iso = b.time;
    basis = b.kind === 'upstream' ? 'sync' : 'commit';
  }
  return { since: iso, basis, items: review.acceptedSince(iso) };
}

function untrackedFile(project, rel) {
  const f = { path: rel, oldPath: null, status: 'A', untracked: true, binary: false, additions: 0, deletions: 0, hunks: [], truncated: false };
  let text = null;
  try {
    const abs = project.abs(rel); // symlinks out of the paper folder throw here
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (isTextFile(rel) && st.size <= MAX_UNTRACKED_BYTES) text = fs.readFileSync(abs, 'utf8');
  } catch { return null; }
  if (text == null || text.includes('\u0000')) return { ...f, binary: true };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  f.additions = lines.length;
  if (lines.length) {
    const kept = lines.slice(0, MAX_LINES_PER_FILE);
    f.truncated = kept.length < lines.length;
    f.hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: kept.map((t, i) => ({ t: '+', o: null, n: i + 1, text: t })) });
  }
  return f;
}

// ---------- unified diff parser ----------

// git quotes a path with special characters in C style: "a\tb", "caf\303\251", "q\"uote".
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  const body = s.slice(1, s.lastIndexOf('"'));
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(body[i + 1] || '')) oct += body[++i]; bytes.push(parseInt(oct, 8)); }
    else bytes.push({ t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
const stripPrefix = (p) => unquote(p.replace(/\t.*$/, '')).replace(/^[ab]\//, '');

// The new path from "a/X b/X". Both halves are the same X except for renames, whose own header
// lines correct it; splitting on the middle (not on a space) keeps names with spaces whole.
function headerPath(rest) {
  if (rest.startsWith('"')) { const k = rest.indexOf('" "'); if (k > 0) return stripPrefix(rest.slice(k + 2)); }
  const L = (rest.length - 5) / 2;
  if (Number.isInteger(L) && L > 0 && rest.slice(2, 2 + L) === rest.slice(L + 5)) return rest.slice(L + 5);
  const k = rest.lastIndexOf(' b/');
  return k > 0 ? rest.slice(k + 3) : rest;
}

export function parseDiff(text) {
  const files = [];
  let f = null; let hunk = null; let o = 0; let n = 0; let kept = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      f = { path: headerPath(line.slice(11)), oldPath: null, status: 'M', untracked: false, binary: false, additions: 0, deletions: 0, hunks: [], truncated: false };
      files.push(f); hunk = null; kept = 0;
      continue;
    }
    if (!f) continue;
    if (!hunk) {
      // File header lines. Unambiguous even for names with spaces, unlike the `diff --git` line.
      if (line.startsWith('new file mode')) f.status = 'A';
      else if (line.startsWith('deleted file mode')) f.status = 'D';
      else if (line.startsWith('rename from ')) { f.status = 'R'; f.oldPath = unquote(line.slice(12)); }
      else if (line.startsWith('rename to ')) f.path = unquote(line.slice(10));
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) f.binary = true;
      else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        const oldP = line.slice(4); const newP = lines[i + 1].slice(4);
        if (newP !== '/dev/null') f.path = stripPrefix(newP); else if (oldP !== '/dev/null') f.path = stripPrefix(oldP);
        i++;
      }
    }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      hunk = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      o = hunk.oldStart; n = hunk.newStart;
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === '+' || c === '-' || c === ' ') {
      if (c === '+') f.additions++; else if (c === '-') f.deletions++;
      if (kept < MAX_LINES_PER_FILE) {
        hunk.lines.push({ t: c, o: c === '+' ? null : o, n: c === '-' ? null : n, text: line.slice(1) });
        kept++;
      } else f.truncated = true;
      if (c !== '+') o++;
      if (c !== '-') n++;
    }
    // "\ No newline at end of file" and the blank line after the last hunk are not content.
  }
  // A truncated file may end with an empty hunk; drop those.
  for (const x of files) x.hunks = x.hunks.filter((hk) => hk.lines.length);
  return files;
}
