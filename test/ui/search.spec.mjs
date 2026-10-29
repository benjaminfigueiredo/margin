import { test, expect, rest, readDisk } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });

const hits = (page) => page.locator('#search-results .search-hit');
const groups = (page) => page.locator('#search-results .search-file');
const openSearch = async (page) => { if (await page.locator('#search').isHidden()) await page.locator('#btn-search').click(); };
const find = async (page, q) => { await openSearch(page); await page.locator('#search-q').fill(q); };

test('results are grouped by file with counts, and a click jumps to the match', async ({ page, margin }) => {
  const methods = readDisk(margin, 'sections/methods.tex');
  const intro = readDisk(margin, 'sections/intro.tex');
  const n = (t) => (t.match(/heatwave/gi) || []).length;
  await find(page, 'heatwave');
  await expect(groups(page).filter({ hasText: 'sections/methods.tex' })).toHaveCount(1);
  await expect(groups(page).filter({ hasText: 'sections/intro.tex' }).locator('.sf-count')).toHaveText(String(n(intro)));
  await expect(groups(page).filter({ hasText: 'sections/methods.tex' }).locator('.sf-count')).toHaveText(String(n(methods)));
  await expect(page.locator('#search-count')).toContainText(/\d+ matches? in \d+ files?/);
  // the first hit under methods.tex: jump, and the editor opens that file at that line with the match selected
  const line = methods.split('\n').findIndex((l) => /heatwave/i.test(l)) + 1;
  const hit = page.locator('#search-results .search-file[data-path="sections/methods.tex"] ~ .search-hit').first();
  await expect(hit.locator('.hit-line')).toHaveText(String(line));
  await expect(hit.locator('mark')).toHaveText(/heatwave/i);
  await hit.click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await expect(page.locator('#editor .cm-lineNumbers .cm-activeLineGutter')).toHaveText(String(line));
  await expect(page.locator('#editor .cm-selectionBackground').first()).toBeVisible();
});

test('invalid regex shows the message instead of results', async ({ page }) => {
  await find(page, 'x');
  await page.locator('[data-opt="regex"]').click();
  await page.locator('#search-q').fill('(unclosed');
  await expect(page.locator('#search-note')).toContainText(/Invalid regular expression/);
  await expect(hits(page)).toHaveCount(0);
  await page.locator('[data-opt="regex"]').click();
});

test('replace in one file changes only that file, and keeps unsaved edits in it', async ({ page, margin }) => {
  const introBefore = readDisk(margin, 'sections/intro.tex');
  const mainBefore = readDisk(margin, 'main.tex');
  const methodsBefore = readDisk(margin, 'sections/methods.tex');
  // open methods.tex and type without waiting for the autosave
  await page.locator('#tree').getByText('methods.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nTYPED-JUST-NOW');
  await find(page, 'heatwave');
  await page.locator('#search-r').fill('thermal event');
  await groups(page).filter({ hasText: 'sections/methods.tex' }).getByRole('button', { name: 'Replace in file' }).click();
  await expect.poll(() => readDisk(margin, 'sections/methods.tex')).toContain('thermal event');
  const after = readDisk(margin, 'sections/methods.tex');
  expect(after).toContain('TYPED-JUST-NOW');
  expect(after).not.toMatch(/heatwave/i);
  expect(after).toBe(methodsBefore.replace(/heatwave/gi, 'thermal event') + '\nTYPED-JUST-NOW');
  expect(readDisk(margin, 'sections/intro.tex')).toBe(introBefore);
  expect(readDisk(margin, 'main.tex')).toBe(mainBefore);
  await expect(page.locator('#editor .cm-content')).toContainText('thermal event');
  await expect(page.locator('#editor .cm-content')).toContainText('TYPED-JUST-NOW');
  await expect(groups(page).filter({ hasText: 'sections/methods.tex' })).toHaveCount(0);
});

test('replace one match, then replace all asks first and names the files and matches', async ({ page, margin }) => {
  const intro = readDisk(margin, 'sections/intro.tex');
  const total = (intro.match(/heatwave/gi) || []).length;
  await find(page, 'heatwave');
  await page.locator('#search-r').fill('HW');
  await expect(hits(page).first()).toBeVisible();
  await hits(page).first().hover();
  await hits(page).first().getByRole('button', { name: 'Replace' }).click();
  await expect.poll(() => (readDisk(margin, 'main.tex') + readDisk(margin, 'sections/intro.tex')).split('HW').length - 1).toBe(1);

  // replace all: a confirmation names the numbers; cancelling writes nothing
  const mainBefore = readDisk(margin, 'main.tex');
  const introBefore = readDisk(margin, 'sections/intro.tex');
  await expect(page.locator('#search-all')).toBeEnabled();
  await page.locator('#search-all').click();
  const confirm = page.locator('#search-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/Replace \d+ matches? in \d+ files? with .HW./);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(readDisk(margin, 'main.tex')).toBe(mainBefore);
  expect(readDisk(margin, 'sections/intro.tex')).toBe(introBefore);

  await page.locator('#search-all').click();
  await confirm.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect.poll(() => /heatwave/i.test(readDisk(margin, 'main.tex') + readDisk(margin, 'sections/intro.tex'))).toBe(false);
  expect(total).toBeGreaterThan(0);
});

test('replacing text a suggestion quotes warns first, then the card is flagged', async ({ page, margin }) => {
  const sug = await rest(margin, '/review/suggest', { method: 'POST', body: { file: 'sections/intro.tex', original: 'Ocean warming', replacement: 'Sea warming' } });
  expect(sug.id).toBeTruthy();
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await find(page, 'Ocean warming');
  await page.locator('#search-r').fill('Marine warming');
  await expect(hits(page)).toHaveCount(1);
  await hits(page).first().hover();
  await hits(page).first().getByRole('button', { name: 'Replace' }).click();
  const confirm = page.locator('#search-confirm');
  await expect(confirm).toContainText('1 open review item quotes text this would change');
  expect(readDisk(margin, 'sections/intro.tex')).toContain('Ocean warming');
  await confirm.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect.poll(() => readDisk(margin, 'sections/intro.tex')).toContain('Marine warming');
  await page.locator('#review .seg button[data-scope="all"]').click();
  await expect(page.locator('#cards .card.orphaned')).toHaveCount(1);
  await expect(page.locator('#cards .card.orphaned .status.orphan')).toHaveText('text changed');
});

test('the panel follows the theme (no stray colours) and closes with Escape', async ({ page }) => {
  await find(page, 'warming');
  await expect(hits(page).first()).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const bg = await page.locator('#search').evaluate((el) => getComputedStyle(el).backgroundColor);
    const body = await page.evaluate(() => getComputedStyle(document.body).color);
    expect(bg).not.toBe(body);
  }
  await page.locator('#search-q').press('Escape');
  await expect(page.locator('#search')).toBeHidden();
});
