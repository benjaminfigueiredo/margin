// Thin git wrapper for the Overleaf round-trip. Overleaf allows one linear
// branch (master), so we commit locally and pull with --rebase before pushing.
// Credentials come from your own git credential helper (Overleaf git token).
import { execFile } from 'node:child_process';
import fs from 'node:fs';

function git(project, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: project.root, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export async function isRepo(project) {
  const r = await git(project, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export async function status(project) {
  if (!(await isRepo(project))) return { repo: false };
  const [branch, porcelain, remote, upstream] = await Promise.all([
    git(project, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(project, ['status', '--porcelain']),
    git(project, ['remote', 'get-url', 'origin']),
    git(project, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
  ]);
  const rawStatus = porcelain.stdout.split('\n').filter(Boolean);
  const changed = rawStatus.map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  // Unmerged porcelain codes. behind/ahead are both 0 while a conflict is unresolved,
  // so this is the only thing that distinguishes a conflicted tree from a clean one.
  const conflicted = rawStatus.filter((l) => UNMERGED.has(l.slice(0, 2))).map((l) => l.slice(3));
  let behind = null; let ahead = null;
  let incoming = [];
  if (upstream.ok) [behind, ahead] = upstream.stdout.trim().split(/\s+/).map(Number);
  if (behind > 0) {
    // Files the remote changed since we diverged (three-dot: only their side).
    const d = await git(project, ['diff', '--name-only', 'HEAD...@{u}']);
    if (d.ok) incoming = d.stdout.split('\n').filter(Boolean);
  }
  return {
    repo: true,
    branch: branch.stdout.trim(),
    remote: remote.ok ? redact(remote.stdout.trim()) : null,
    overleaf: remote.ok && /overleaf\.com|sharelatex/i.test(remote.stdout),
    changed,
    ahead,
    behind,
    incoming,
    conflicted,
  };
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function redact(url) { return url.replace(/\/\/[^@/]+@/, '//'); }

// Commit local changes, rebase onto Overleaf, push. Returns a step log.
export async function sync(project, { message = 'Edits via Margin', push = true } = {}) {
  const steps = [];
  const step = async (label, args) => { const r = await git(project, args); steps.push({ label, ok: r.ok, out: (r.stdout + r.stderr).trim() }); return r; };
  if (!(await isRepo(project))) return { ok: false, steps: [{ label: 'check', ok: false, out: 'Not a git repository. Clone your Overleaf project with git first.' }] };

  // `git add -A` would stage the conflict markers themselves and push them into the
  // shared manuscript. But refusing on the index flag alone would be a dead end: editing
  // the markers out in Margin does not clear it, and Margin has no `git add`. So judge by
  // the file's contents — markers still there means unresolved, markers gone means the
  // author (or Claude) has resolved it and only the index is still flagged.
  const unresolved = await conflictedPaths(project);
  if (unresolved.length) {
    const stillMarked = unresolved.filter((f) => {
      try { return /^<<<<<<< /m.test(fs.readFileSync(project.abs(f), 'utf8')); } catch { return true; }
    });
    if (stillMarked.length) {
      const where = stillMarked.join(', ');
      return {
        ok: false,
        conflict: stillMarked,
        hint: `${where} still has unresolved conflict markers from an earlier pull. Edit them out (or ask Claude to), then Sync — syncing now would push <<<<<<< markers to your co-authors.`,
        steps: [{ label: 'check', ok: false, out: `unresolved conflict in ${where}` }],
      };
    }
    await step('mark resolved', ['add', '--', ...unresolved]);
  }

  const st = await git(project, ['status', '--porcelain']);
  if (st.stdout.trim()) {
    await step('stage', ['add', '-A']);
    const c = await step('commit', ['commit', '-m', message]);
    if (!c.ok) return { ok: false, steps };
  }
  const hasRemote = (await git(project, ['remote'])).stdout.trim().length > 0;
  if (!hasRemote) { steps.push({ label: 'remote', ok: true, out: 'No remote configured; committed locally only.' }); return { ok: true, steps }; }

  const pull = await step('pull', ['pull', '--rebase', '--autostash']);
  if (!pull.ok) {
    // Overleaf supports one branch, so a branch with no upstream is a dead end. Say that
    // instead of passing git's "There is no tracking information" through to a toast.
    if (/no tracking information|no upstream/i.test(pull.stdout + pull.stderr)) {
      const b = (await git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      return { ok: false, steps, hint: `The branch "${b}" is not tracking anything on Overleaf, which only supports one branch (master). Your commit is safe on "${b}"; switch back with "git checkout master" and sync from there.` };
    }
    const conflicted = (await git(project, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
    if (conflicted) {
      await step('abort rebase', ['rebase', '--abort']);
      return { ok: false, conflict: conflicted.split('\n'), steps, hint: 'Overleaf has changes that conflict with yours in these files. Your commit is safe locally; resolve with git (or ask Claude to) and sync again.' };
    }
    return { ok: false, steps };
  }
  if (push) {
    const p = await step('push', ['push']);
    if (!p.ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}

export async function pull(project) {
  const r = await git(project, ['pull', '--rebase', '--autostash']);
  // --autostash can fast-forward successfully and then fail to reapply the stash, which
  // leaves both versions in the file with conflict markers while git still exits 0. That
  // must not read as success: the next Sync would commit the markers and push them.
  const unresolved = await conflictedPaths(project);
  if (unresolved.length) {
    return {
      ok: false,
      conflict: unresolved,
      out: (r.stdout + r.stderr).trim(),
      hint: `Overleaf's changes and your own edits both touch ${unresolved.join(', ')}. Both versions are in the file now, marked with <<<<<<< and >>>>>>>. Edit it to keep what you want (or ask Claude to), then Sync. Your version is also kept in "git stash".`,
    };
  }
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}

async function conflictedPaths(project) {
  const r = await git(project, ['diff', '--name-only', '--diff-filter=U']);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

// Update remote-tracking refs so status().behind reflects what co-authors pushed. Without this
// `behind` only reflects the last manual fetch. Never throws and never prompts: offline, or a
// remote that needs a password (GIT_TERMINAL_PROMPT=0), just returns { ok: false }.
export async function fetchRemote(project, { timeout = 20000 } = {}) {
  const r = await git(project, ['fetch', '--quiet'], { timeout });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}

export async function hasRemote(project) {
  if (!(await isRepo(project))) return false;
  return (await git(project, ['remote'])).stdout.trim().length > 0;
}

export async function diff(project, file) {
  const r = await git(project, ['diff', '--', ...(file ? [file] : [])]);
  return r.stdout;
}
