import fs from 'node:fs';
import path from 'node:path';
import { test, expect, readDisk } from './fixtures.mjs';

// window.marginBeforeClose(): the Mac app calls it before closing a paper window or quitting. It
// saves what is unsaved and returns '' when nothing is at risk, or a sentence saying what is
// (then the app asks instead of closing over the author's edits).
test.describe.configure({ mode: 'serial' });

const content = (page) => page.locator('#editor .cm-content');
const beforeClose = (page) => page.evaluate(() => window.marginBeforeClose());

async function openMethods(page) {
  await page.locator('#tree').getByText('methods.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

async function typeAtEnd(page, text) {
  await content(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

test('nothing unsaved: empty answer', async ({ page }) => {
  await openMethods(page);
  expect(await beforeClose(page)).toBe('');
});

test('fresh typing is saved on the spot, not 0.7 s later', async ({ page, margin }) => {
  await openMethods(page);
  await typeAtEnd(page, '\n% typed-right-before-closing');
  expect(await beforeClose(page)).toBe('');
  expect(readDisk(margin, 'sections/methods.tex')).toContain('% typed-right-before-closing');
});

test('an unresolved conflict is reported, and nothing is overwritten', async ({ page, margin }) => {
  await openMethods(page);
  const file = 'sections/methods.tex';
  const theirs = readDisk(margin, file) + '\n% written-by-claude';
  const route = /\/api\/file\?path=sections%2Fmethods\.tex$/;
  await page.route(route, async (r) => {
    if (r.request().method() === 'PUT') fs.writeFileSync(path.join(margin.paper, file), theirs);
    await r.continue();
  });
  await typeAtEnd(page, '\n% typed-by-author');
  await expect(page.locator('#banner')).toBeVisible();
  await page.unroute(route);
  const answer = await beforeClose(page);
  expect(answer).toContain(file);
  expect(answer).toMatch(/conflict/);
  expect(readDisk(margin, file)).toBe(theirs);
});
