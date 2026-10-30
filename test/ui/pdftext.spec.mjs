import fs from 'node:fs';
import path from 'node:path';
import { test, expect, rest } from './fixtures.mjs';

// The tests share one paper on disk and build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial' });

const pageEl = (page, n = 1) => page.locator(`#pdf-pages .pdf-page[data-page="${n}"]`);
const selectedText = (page) => page.evaluate(() => window.getSelection().toString());
const count = (page) => page.locator('.pdf-find-count');

async function recompile(page) {
  const done = page.waitForResponse((r) => r.url().endsWith('/api/compile') && r.request().method() === 'POST');
  await page.locator('#btn-compile').click();
  await done;
  await expect(page.locator('#btn-compile .label')).toHaveText('Recompile');
}

// pdfview replaces every page element on a zoom and after each compile, so measure and drag in one
// retried step. Drags across the whole line of text that contains `text`.
async function dragLine(page, text) {
  await expect(async () => {
    const line = pageEl(page).locator('.textLayer span', { hasText: text });
    const box = await line.boundingBox();
    expect(box).toBeTruthy();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, y, { steps: 6 });
    await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
    await page.mouse.up();
    expect(await selectedText(page)).toContain(text);
  }).toPass({ timeout: 20_000 });
}

// Resolves once this page element has been thrown away by a rebuild.
const replaced = async (page, n = 1) => {
  const handle = await pageEl(page, n).elementHandle();
  return () => page.waitForFunction((el) => !el.isConnected, handle);
};

test('text layer: dragging over a line selects its text', async ({ page }) => {
  await expect(pageEl(page).locator('.textLayer span').first()).toBeAttached();
  await dragLine(page, 'Survival declined by 34%');
  expect(await selectedText(page)).toContain('Survival declined by 34%');
  // The layer is a sibling of the canvas, not inside it, and does not eat the pointer for the page.
  await expect(pageEl(page).locator('> canvas')).toHaveCount(1);
  await expect(pageEl(page).locator('> .textLayer')).toHaveCount(1);
});

test('a drag, even one that starts as a double-click, selects instead of jumping to the source', async ({ page }) => {
  await page.locator('#tree').getByText('methods.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  const line = pageEl(page).locator('.textLayer span', { hasText: 'after the third event' });
  const box = await line.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 5, y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(500);
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
});

test('search: count, next and previous move through the matches and the view', async ({ page }) => {
  const q = page.locator('.pdf-find-q');
  await q.fill('heatwaves');
  await expect(count(page)).toHaveText('1 / 7');
  await expect(page.locator('.pdf-hit.current')).not.toHaveCount(0);
  const where = async () => (await page.locator('.pdf-hit.current').first().boundingBox());
  const first = await where();

  const scrollTop = () => page.locator('#pdf-scroll').evaluate((el) => el.scrollTop);
  const top = await scrollTop();
  await page.locator('.pdf-find-next').click();
  await expect(count(page)).toHaveText('2 / 7');
  await expect.poll(async () => (await where()).y).not.toBe(first.y);
  expect(await scrollTop()).toBe(top); // both matches are on screen, so the page stays where it is
  await page.locator('.pdf-find-prev').click();
  await expect(count(page)).toHaveText('1 / 7');
  await expect.poll(async () => (await where()).y).toBe(first.y);
  await page.locator('.pdf-find-prev').click(); // wraps
  await expect(count(page)).toHaveText('7 / 7');
  await q.press('Enter');
  await expect(count(page)).toHaveText('1 / 7');
  await q.press('Shift+Enter');
  await expect(count(page)).toHaveText('7 / 7');

  // Whitespace and case do not matter, and a phrase can run across the end of a line of text.
  await q.fill('IMPORTANT  to understand how small');
  await expect(count(page)).toHaveText('1 / 1');
  await q.fill('no such text in this paper');
  await expect(count(page)).toHaveText('No matches');
  await expect(page.locator('.pdf-hit')).toHaveCount(0);

  await q.fill('Copepods');
  await expect(page.locator('.pdf-hit')).not.toHaveCount(0);
  await q.press('Escape');
  await expect(q).toHaveValue('');
  await expect(count(page)).toHaveText('');
  await expect(page.locator('.pdf-hit')).toHaveCount(0);
});

test('search in a longer paper: next and previous scroll to a match on another page', async ({ page, margin }) => {
  const file = path.join(margin.paper, 'sections', 'methods.tex');
  fs.appendFileSync(file, '\n\nThe flamingo is on page one.\n\\newpage\nNothing here.\n\\newpage\nThe flamingo is on page three.\n');
  await expect(async () => { // the editor picks the change up from disk
    expect((await rest(margin, '/file?path=sections/methods.tex')).content).toContain('page three');
  }).toPass();
  await recompile(page);
  await expect(page.locator('#page-label')).toHaveText(/ \/ 3$/);

  const scroller = page.locator('#pdf-scroll');
  const q = page.locator('.pdf-find-q');
  await q.fill('flamingo');
  await expect(count(page)).toHaveText('1 / 2');
  const top0 = await scroller.evaluate((el) => el.scrollTop);
  await page.locator('.pdf-find-next').click();
  await expect(count(page)).toHaveText('2 / 2');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top0 + 500);
  // The current match is on screen, on page 3.
  await expect(pageEl(page, 3).locator('.pdf-hit.current')).toHaveCount(1);
  await expect.poll(async () => {
    const hit = await pageEl(page, 3).locator('.pdf-hit.current').boundingBox();
    const view = await scroller.boundingBox();
    return hit.y >= view.y && hit.y + hit.height <= view.y + view.height;
  }).toBe(true);
  await page.locator('.pdf-find-prev').click();
  await expect(count(page)).toHaveText('1 / 2');
  await expect.poll(async () => {
    const hit = await pageEl(page, 1).locator('.pdf-hit.current').boundingBox();
    const view = await scroller.boundingBox();
    return hit && hit.y >= view.y && hit.y + hit.height <= view.y + view.height;
  }).toBe(true);
  await q.press('Escape');
});

test('Ctrl+F in the PDF pane goes to the PDF search box', async ({ page }) => {
  await pageEl(page).locator('.textLayer span').first().click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.pdf-find-q')).toBeFocused();
  await page.keyboard.press('Escape');
});

// A recompile only reloads the PDF if latexmk wrote a new one, so touch a source file first (a
// comment changes nothing on the page).
const touchSource = (margin) => fs.appendFileSync(path.join(margin.paper, 'sections', 'methods.tex'), '\n% touched\n');

test('a selection survives a zoom change and a recompile', async ({ page, margin }) => {
  await dragLine(page, 'Survival declined by 34%');

  const gone = await replaced(page);
  await page.locator('#zoom-in').click();
  await gone();
  await expect.poll(() => selectedText(page)).toContain('Survival declined by 34%');
  await expect(page.locator('#zoom-label')).not.toHaveText('Fit');

  touchSource(margin);
  const gone2 = await replaced(page);
  await recompile(page);
  await gone2();
  await expect.poll(() => selectedText(page)).toContain('Survival declined by 34%');

  const gone3 = await replaced(page);
  await page.locator('#zoom-fit').click();
  await gone3();
  await expect.poll(() => selectedText(page)).toContain('Survival declined by 34%');
});

test('search highlights follow a zoom change and a recompile', async ({ page, margin }) => {
  const q = page.locator('.pdf-find-q');
  await q.fill('flamingo');
  await expect(count(page)).toHaveText(/ \/ 2$/);
  await expect(page.locator('.pdf-hit')).not.toHaveCount(0);
  const gone = await replaced(page);
  await page.locator('#zoom-in').click();
  await gone();
  await expect(page.locator('.pdf-hit.current')).toHaveCount(1);
  touchSource(margin);
  const gone2 = await replaced(page);
  await recompile(page);
  await gone2();
  await expect(count(page)).toHaveText(/ \/ 2$/);
  await expect(page.locator('.pdf-hit.current')).toHaveCount(1);
  await q.press('Escape');
  await page.locator('#zoom-fit').click();
});
