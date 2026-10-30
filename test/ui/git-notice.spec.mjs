// Overleaf-commits notice. Uses its own server on a clone of a bare "Overleaf" repo, and calls the
// server's gitPoll() directly instead of waiting for the 3-minute timer, so nothing here depends on time.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/app.js';
import { freePort } from '../free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...a], { cwd, stdio: 'pipe' }).toString();

const test = base.extend({
  remote: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-ui-gitnotice-'));
    const bare = path.join(tmp, 'remote.git');
    const mine = path.join(tmp, 'mine'), theirs = path.join(tmp, 'theirs');
    sh(tmp, 'init', '-q', '--bare', '-b', 'master', bare);
    sh(tmp, 'clone', '-q', bare, mine);
    fs.cpSync(path.join(here, '..', '..', 'examples', 'sample-paper'), mine, { recursive: true });
    sh(mine, 'add', '-A'); sh(mine, 'commit', '-qm', 'init'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:master');
    sh(tmp, 'clone', '-q', bare, theirs);
    const port = await freePort();
    const running = await startServer({ root: mine, port });
    await use({ baseURL: `http://127.0.0.1:${port}`, running, mine, theirs });
    await running.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },
});

test('banner names the open file when a co-author changed it; Pull brings it into the editor', async ({ page, remote }) => {
  await page.goto(remote.baseURL + '/');
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);

  const f = path.join(remote.theirs, 'main.tex');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n% added by a co-author\n');
  sh(remote.theirs, 'commit', '-qam', 'co-author edit'); sh(remote.theirs, 'push', '-q');

  await remote.running.gitPoll();
  const banner = page.locator('#banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('main.tex was changed on Overleaf');
  await expect(page.locator('#git-status')).toContainText('1 to pull');

  await banner.getByRole('button', { name: 'Pull from Overleaf' }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator('#editor .cm-content')).toContainText('added by a co-author');
  await expect(page.locator('#git-status')).not.toContainText('to pull');
});

// The pull rewrites the open file while the author types: the typing must not put the pre-pull text
// back over the co-author's change (which the next Sync would then push as a revert).
test('typing while a pull runs keeps both the pulled change and the typing', async ({ page, remote }) => {
  await page.goto(remote.baseURL + '/');
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  const f = path.join(remote.theirs, 'main.tex');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('\\date{}', '\\date{2026}'));
  sh(remote.theirs, 'commit', '-qam', 'co-author date'); sh(remote.theirs, 'push', '-q');
  await remote.running.gitPoll();
  const banner = page.locator('#banner');
  await expect(banner).toContainText('main.tex was changed on Overleaf');

  // Typed as the pull starts; the pull rewrites the file; the autosave delay passes; then the page
  // hears back from the pull.
  await page.route('**/api/git/pull', async (route) => {
    await page.locator('#editor .cm-content').focus();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n% typed-during-pull');
    const response = await route.fetch();
    await page.waitForTimeout(1000);
    await route.fulfill({ response });
  });
  await banner.getByRole('button', { name: 'Pull from Overleaf' }).click();
  const disk = () => fs.readFileSync(path.join(remote.mine, 'main.tex'), 'utf8');
  await expect.poll(disk).toContain('% typed-during-pull');
  await expect.poll(disk).toContain('\\date{2026}');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#editor .cm-content')).toContainText('\\date{2026}');
  await expect(page.locator('#banner')).toBeHidden();
});

test('a commit to a different file gets the generic notice, which can be dismissed', async ({ page, remote }) => {
  await page.goto(remote.baseURL + '/');
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);

  fs.appendFileSync(path.join(remote.theirs, 'refs.bib'), '\n% touched\n');
  sh(remote.theirs, 'commit', '-qam', 'bib edit'); sh(remote.theirs, 'push', '-q');
  await remote.running.gitPoll();
  const banner = page.locator('#banner');
  await expect(banner).toContainText("Overleaf has 1 new commit you haven't pulled");
  await expect(banner).not.toContainText('main.tex');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
});

test('a branch that tracks nothing on Overleaf says so instead of looking up to date', async ({ page, remote }) => {
  sh(remote.mine, 'checkout', '-qb', 'my-edits');
  await page.goto(remote.baseURL + '/');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  const st = page.locator('#git-status');
  await expect(st).toContainText('my-edits');
  await expect(st).toContainText('not tracking Overleaf');
  await expect(st).toHaveAttribute('title', /master/);
});
