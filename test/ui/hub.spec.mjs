// The hub page: the paper list with states, Open (which starts a stopped paper in the new
// window), adding a folder by path, and appearance settings shared between papers.
// Its own hub on a temporary config folder; not the shared paper fixture.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub } from '../../server/hub.js';
import { freePort } from '../free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
test.describe.configure({ mode: 'serial' });

let hub, tmp, a, b, cPath;
function makePaper(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(here, '..', '..', 'examples', 'sample-paper'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'init');
  return dir;
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-hub-ui-')));
  const port = await freePort(); // papers get the next free ports above it
  hub = await startHub({ port, configDir: path.join(tmp, 'config'), firstPaperPort: port + 1, platform: 'linux' });
  a = await hub.addPaper(makePaper('alpha-paper'));
  b = await hub.addPaper(makePaper('beta-paper'));
  cPath = makePaper('gamma-paper');
  const started = await hub.startPaper(a.id);
  expect(started.state).toBe('running');
});

test.afterAll(async () => {
  await hub?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const row = (page, entry) => page.locator(`.paper[data-id="${entry.id}"]`);
async function waitBooted(p) {
  await expect(p.locator('#current-file')).not.toHaveText('');
  await expect(p.locator('#conn')).toHaveClass(/\bon\b/);
}

test('lists papers with their state, and Open starts a stopped one and leads to it', async ({ page }) => {
  await page.goto(hub.url);
  await expect(page.locator('.paper')).toHaveCount(2);
  await expect(row(page, a).locator('.paper-name')).toHaveText('alpha-paper');
  await expect(row(page, a).locator('.pill')).toHaveText('Running');
  await expect(row(page, b).locator('.pill')).toHaveText('Stopped');
  await expect(row(page, a).locator('.paper-path')).toHaveText(path.join(tmp, 'alpha-paper'));
  await expect(row(page, a).locator('a.open')).toHaveAttribute('href', `http://127.0.0.1:${a.port}/`);
  await expect(row(page, a).locator('a.open')).toHaveAttribute('target', '_blank');
  await expect(row(page, b).locator('.last-opened')).toHaveText('never opened');

  // A stopped paper: the new window starts it, then becomes the paper.
  const [popup] = await Promise.all([page.waitForEvent('popup'), row(page, b).locator('a.open').click()]);
  await expect(popup).toHaveURL(`http://127.0.0.1:${b.port}/`, { timeout: 30000 });
  await waitBooted(popup);
  await expect(popup.locator('#project-name')).toHaveText('beta-paper');
  await expect(popup.locator('#hub-link')).toBeVisible();
  await expect(popup.locator('#hub-link')).toHaveAttribute('href', hub.url);
  await expect(row(page, b).locator('.pill')).toHaveText('Running');
  await expect(row(page, b).locator('.last-opened')).toHaveText('opened just now');
  await popup.close();

  // A running paper opens directly.
  const [direct] = await Promise.all([page.waitForEvent('popup'), row(page, a).locator('a.open').click()]);
  await expect(direct).toHaveURL(`http://127.0.0.1:${a.port}/`);
  await waitBooted(direct);
  // The link back is a plain navigation to the hub.
  await direct.locator('#hub-link').click();
  await expect(direct).toHaveURL(hub.url);
  await expect(direct.locator('.paper')).toHaveCount(2);
  await direct.close();

  // Stop.
  await row(page, b).locator('button.stop').click();
  await expect(row(page, b).locator('.pill')).toHaveText('Stopped');
});

test('Open folder… adds a folder by path, refusing one that is not a paper', async ({ page }) => {
  await page.goto(hub.url);
  await page.locator('#btn-add').click();
  await page.locator('#add-path').fill(path.join(tmp, 'config'));
  await page.locator('#add-form button[type=submit]').click();
  await expect(page.locator('#add-error')).toContainText("Margin's own settings folder");
  await page.locator('#add-path').fill(cPath);
  await page.locator('#add-form button[type=submit]').click();
  await expect(page.locator('#add-form')).toBeHidden();
  const c = page.locator('.paper', { hasText: 'gamma-paper' });
  await expect(c.locator('.pill')).toHaveText('Running', { timeout: 30000 });
  await expect(c.locator('.setup-claude')).toBeVisible(); // never inited
  await c.locator('.setup-claude').click();
  await expect(c.locator('.setup-claude')).toHaveCount(0);
  await expect(c.locator('.paper-msg.notice')).toContainText('Set up for Claude');
  expect(JSON.parse(fs.readFileSync(path.join(cPath, '.mcp.json'), 'utf8')).mcpServers.margin.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
});

test('appearance settings changed in one paper show up in another, and on the hub', async ({ page, context }) => {
  await page.goto(`http://127.0.0.1:${a.port}/`);
  await waitBooted(page);
  await expect(page.locator('#settings-where')).toHaveText('Shared by all your papers on this computer.');
  await page.locator('#btn-settings').click();
  await page.locator('[data-theme-choice="dark"]').click();
  await page.locator('#set-font-size').selectOption('18');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'settings.json'), 'utf8')).fontSize).toBe(18);

  // Paper B is another origin (its own localStorage): it can only know through the shared file.
  await hub.startPaper(b.id);
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${b.port}/`);
  await waitBooted(other);
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => other.locator('#editor .cm-content').evaluate((el) => getComputedStyle(el).fontSize)).toBe('18px');
  await expect(other.locator('#set-font-size')).toHaveValue('18');

  const hubPage = await context.newPage();
  await hubPage.goto(hub.url);
  await expect(hubPage.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Back to the defaults, from B this time; A picks it up when its tab comes back to the front.
  await other.locator('#btn-settings').click();
  await other.locator('[data-theme-choice="system"]').click();
  await other.locator('#set-font-size').selectOption('14');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'settings.json'), 'utf8')).theme).toBe('system');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('#set-font-size')).toHaveValue('14');
});
