// Changes panel: what changed since the last sync / since the last commit, clicking a line to jump to
// it, suggestions accepted since a time, and the diff PDF bar. Uses its own server on a clone of a bare
// "Overleaf" repo, with one commit that is not pushed, one edit that is not committed and one new file.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...a], { cwd, stdio: 'pipe' }).toString();

const test = base.extend({
  remote: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-ui-changes-'));
    const bare = path.join(tmp, 'remote.git');
    const mine = path.join(tmp, 'mine');
    sh(tmp, 'init', '-q', '--bare', '-b', 'master', bare);
    sh(tmp, 'clone', '-q', bare, mine);
    fs.cpSync(path.join(here, '..', '..', 'examples', 'sample-paper'), mine, { recursive: true });
    sh(mine, 'add', '-A'); sh(mine, 'commit', '-qm', 'init'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:master');
    const edit = (rel, from, to) => { const f = path.join(mine, rel); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to)); };
    edit('main.tex', 'very important', 'crucial');
    sh(mine, 'commit', '-qam', 'committed here, not pushed');
    edit('sections/intro.tex', 'the ocean', 'the sea');
    fs.writeFileSync(path.join(mine, 'sections', 'extra.tex'), 'A brand new section.\nWith two lines.\n');
    const port = 47000 + Math.floor(Math.random() * 2000);
    const running = await startServer({ root: mine, port });
    await use({ baseURL: `http://127.0.0.1:${port}`, running, mine, tmp });
    await running.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },
});

async function boot(page, remote) {
  await page.goto(remote.baseURL + '/');
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
}
const post = (remote, p, body) => fetch(`${remote.baseURL}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

test('lists what changed since the last sync, with counts, and a click lands on the line', async ({ page, remote }) => {
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const panel = page.locator('#changes');
  await expect(panel).toBeVisible();
  await expect(page.locator('#changes-note')).toContainText('as of your last sync');
  const files = panel.locator('.ch-file');
  await expect(files).toHaveCount(3);
  await expect(panel.locator('#changes-count')).toContainText('3 files');
  const main = panel.locator('.ch-file[data-path="main.tex"]');
  await expect(main.locator('.ch-add')).toHaveText('+1');
  await expect(main.locator('.ch-del')).toHaveText('−1');
  await expect(main.locator('.ch-line.del')).toContainText('very important');
  await expect(main.locator('.ch-line.add')).toContainText('crucial');
  await expect(main.locator('.w-ins')).toHaveText(/crucial/); // the words that changed are marked
  await expect(panel.locator('.ch-file[data-path="sections/extra.tex"] .ch-status')).toHaveText('new');

  // a line in the open file: the editor goes to it
  await main.locator('.ch-line.add').click();
  await expect(page.locator('#editor .cm-activeLine')).toContainText('crucial');
  // a line in another file: it is opened and the editor goes to the line
  await panel.locator('.ch-file[data-path="sections/intro.tex"] .ch-line.add').click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
  await expect(page.locator('#editor .cm-activeLine')).toContainText('the sea');
  // the file name opens it at its first change
  await panel.locator('.ch-file[data-path="main.tex"] .ch-path').click();
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(page.locator('#editor .cm-activeLine')).toContainText('crucial');

  // folding a file hides its lines and survives a refresh
  await main.locator('.ch-toggle').click();
  await expect(main.locator('.ch-line').first()).toBeHidden();
  await panel.locator('#changes-refresh').click();
  await expect(main.locator('.ch-line').first()).toBeHidden();
  await panel.getByRole('button', { name: 'Expand all' }).click();
  await expect(main.locator('.ch-line').first()).toBeVisible();

  // Uncommitted: main.tex was committed, so it is gone; the other two remain
  await panel.getByRole('button', { name: 'Uncommitted' }).click();
  await expect(files).toHaveCount(2);
  await expect(panel.locator('.ch-file[data-path="main.tex"]')).toHaveCount(0);
  await expect(page.locator('#changes-note')).toContainText('not yet committed');
});

test('an edit made in the editor shows up on refresh; a clean paper says so', async ({ page, remote }) => {
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.locator('#changes .ch-file')).toHaveCount(3);
  // the author undoes everything outside the editor (Claude or git would do the same): the panel follows
  sh(remote.mine, 'checkout', '--', 'sections/intro.tex'); fs.rmSync(path.join(remote.mine, 'sections', 'extra.tex'));
  await expect(page.locator('#changes .ch-file')).toHaveCount(1); // refreshed by itself
  sh(remote.mine, 'push', '-q');
  await page.locator('#changes-refresh').click();
  await expect(page.locator('#changes .empty')).toContainText('No changes since your last sync');
});

test('opening Changes closes Logs and Find, and the other way round', async ({ page, remote }) => {
  await boot(page, remote);
  const changes = page.locator('#changes'), logs = page.locator('#logs'), search = page.locator('#search');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(changes).toBeVisible();
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(search).toBeVisible(); await expect(changes).toBeHidden();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(changes).toBeVisible(); await expect(search).toBeHidden();
  await page.locator('#btn-logs').click();
  await expect(logs).toBeVisible(); await expect(changes).toBeHidden();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(changes).toBeVisible(); await expect(logs).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(changes).toBeHidden();
});

test('a branch that tracks nothing says there is no "last sync" and compares with the last commit', async ({ page, remote }) => {
  sh(remote.mine, 'checkout', '-q', '-b', 'my-edits');
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const note = page.locator('#changes-note');
  await expect(note).toContainText('not tracking anything on Overleaf');
  await expect(note).toContainText('no “last sync”');
  await expect(note).toContainText('since your last commit');
  // main.tex was committed on the old branch, so it is not an uncommitted edit here
  await expect(page.locator('#changes .ch-file')).toHaveCount(2);
  await expect(page.locator('#diff-ref option').first()).toContainText('your last commit');
});

test('accepted suggestions since a time, and what "since" means', async ({ page, remote }) => {
  const s = await post(remote, '/review/suggest', { file: 'sections/methods.tex', original: 'Each heatwave consisted of a ramp', replacement: 'Each heatwave consisted of a linear ramp', rationale: 'Say what shape.' });
  await post(remote, `/review/${s.id}/accept`);
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Accepted suggestions' }).click();
  const note = page.locator('#changes-note');
  await expect(note).toContainText('does not track Claude sessions');
  await expect(note).toContainText('when each suggestion was accepted');
  const card = page.locator('#changes .ch-acc');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('sections/methods.tex');
  await expect(card.locator('.w-ins')).toHaveText(/linear/);
  await expect(card).toContainText('Say what shape.');
  // a later start time empties the list (an hour ago contains it; pick "a time I choose" in the future)
  await page.locator('#changes-since-sel').selectOption('custom');
  const future = new Date(Date.now() + 2 * 3600000); future.setMinutes(future.getMinutes() - future.getTimezoneOffset());
  await page.locator('#changes-since-time').fill(future.toISOString().slice(0, 16));
  await expect(page.locator('#changes .empty')).toContainText('No suggestions were accepted');
  await page.locator('#changes-since-sel').selectOption('24h');
  await expect(card).toHaveCount(1);
  await card.locator('.ch-path').click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await expect(page.locator('#editor .cm-activeLine')).toContainText('linear ramp');
});

test('usable in a short split-screen window: list scrolls, nothing falls below the fold', async ({ page, remote }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await boot(page, remote);
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'split');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const panel = page.locator('#changes');
  await expect(panel.locator('.ch-file')).toHaveCount(3);
  const box = async (sel) => (await page.locator(sel).boundingBox());
  const foot = await box('#diff-make');
  expect(foot.y + foot.height).toBeLessThanOrEqual(480 - 20); // above the status bar
  const list = await box('#changes-list');
  expect(list.height).toBeGreaterThan(120); // room left for the list itself
  // the list is the thing that scrolls: panel itself does not overflow
  const overflow = await panel.evaluate((el) => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight }));
  expect(overflow.x).toBeLessThanOrEqual(1); expect(overflow.y).toBeLessThanOrEqual(1);
  await page.locator('#changes-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(panel.locator('.ch-file[data-path="sections/intro.tex"] .ch-line').last()).toBeInViewport();
  await panel.locator('.ch-file[data-path="sections/intro.tex"] .ch-line.add').first().click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
});

test('the diff PDF is shown with an obvious DIFF bar, survives a recompile, and Back restores the normal PDF', async ({ page, remote }) => {
  const tool = await (await fetch(`${remote.baseURL}/api/latexdiff`)).json();
  test.skip(!tool.installed, `latexdiff is not on PATH here (${tool.message})`);
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.locator('#changes .ch-file')).toHaveCount(3);
  await page.getByRole('button', { name: 'Make diff PDF' }).click();
  const bar = page.locator('#diff-bar');
  await expect(bar).toBeVisible({ timeout: 90000 });
  await expect(bar.locator('.diff-tag')).toHaveText('DIFF');
  await expect(bar).toContainText('Changes since your last sync');
  await expect(page.locator('#changes')).toBeHidden();
  await expect(page.locator('#pdf-pane')).toHaveClass(/diff-mode/);
  await expect(page.locator('.pdf-head a[download]')).toHaveAttribute('href', '/pdf-diff');
  await expect(page.locator('#pdf-pages .pdf-page').first()).toBeVisible();

  // a normal recompile that changes the PDF finishes while the diff is on screen: it must not swap the diff out
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  fs.appendFileSync(path.join(remote.mine, 'main.tex'), '\n% touched\n');
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/compile')), page.locator('#btn-compile').click()]);
  await expect(page.locator('#compile-status')).toContainText('Compiled');
  await page.waitForTimeout(1500);
  expect(asked.filter((u) => /\/pdf\?/.test(u)), 'the normal PDF was not reloaded over the diff').toEqual([]);
  await expect(bar).toBeVisible();
  await expect(page.locator('.pdf-head a[download]')).toHaveAttribute('href', '/pdf-diff');

  // Rebuild repeats the build and keeps the diff on screen
  await bar.getByRole('button', { name: 'Rebuild' }).click();
  await expect(page.locator('#diff-rebuild')).toHaveText('Rebuild', { timeout: 90000 });
  await expect(bar).toBeVisible();
  await expect(page.locator('#pdf-pages .pdf-page').first()).toBeVisible();

  // double-clicking the diff PDF must not run a SyncTeX jump with the wrong PDF
  await page.locator('#pdf-pages .pdf-page').first().dblclick({ position: { x: 100, y: 100 } });
  await expect(page.locator('.toast', { hasText: 'diff PDF' })).toBeVisible();

  await bar.getByRole('button', { name: 'Back to normal PDF' }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('#pdf-pane')).not.toHaveClass(/diff-mode/);
  await expect(page.locator('.pdf-head a[download]')).toHaveAttribute('href', '/pdf');
  await expect(page.locator('#pdf-pages .pdf-page').first()).toBeVisible();
  expect(asked.some((u) => /\/pdf\?/.test(u)), 'Back loaded the normal PDF').toBe(true);
});

test('without latexdiff the panel says what to install instead of failing on click', async ({ page, remote }) => {
  await page.route('**/api/latexdiff', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { installed: false, message: 'latexdiff is not installed (or is not on PATH). Margin needs the `latexdiff` command to make a marked-up PDF. macOS: full MacTeX includes it.', last: null, building: false } })
    : route.continue());
  await boot(page, remote);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.locator('#diff-status')).toContainText('latexdiff is not installed');
  await expect(page.locator('#diff-status')).toHaveClass(/error/);
  await expect(page.locator('#diff-make')).toBeDisabled();
});
