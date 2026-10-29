// Thin git wrapper for the Overleaf round-trip. Overleaf allows one linear
// branch (master), so we commit locally and pull with --rebase before pushing.
// Credentials come from your own git credential helper (Overleaf git token).
import { execFile } from 'node:child_process';

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
  const changed = porcelain.stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
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
  };
}

function redact(url) { return url.replace(/\/\/[^@/]+@/, '//'); }

// Commit local changes, rebase onto Overleaf, push. Returns a step log.
export async function sync(project, { message = 'Edits via Margin', push = true } = {}) {
  const steps = [];
  const step = async (label, args) => { const r = await git(project, args); steps.push({ label, ok: r.ok, out: (r.stdout + r.stderr).trim() }); return r; };
  if (!(await isRepo(project))) return { ok: false, steps: [{ label: 'check', ok: false, out: 'Not a git repository. Clone your Overleaf project with git first.' }] };

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
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}

// Update remote-tracking refs so status().behind reflects what co-authors pushed. Without this
// `behind` only reflects the last manual fetch. Never throws and never prompts: offline, or a
// remote that needs a password (GIT_TERMINAL_PROMPT=0), just returns { ok: false }.
export async function fetch(project, { timeout = 20000 } = {}) {
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
