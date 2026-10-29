import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });

const marker = (page, kind) => page.locator(`#editor .cm-diag-marker${kind ? '.' + kind : ''}`);
const tree = (page, name) => page.locator('#tree').getByText(name, { exact: true });

async function recompile(page) {
  const done = page.waitForResponse((r) => r.url().endsWith('/api/compile') && r.request().method() === 'POST');
  await page.locator('#btn-compile').click();
  await done;
  await expect(page.locator('#btn-compile .label')).toHaveText('Recompile');
}

// Line number of the row each marker sits on, matched by vertical position against the line-number gutter.
const markedLines = (page) => marker(page).evaluateAll((els) => els.map((el) => {
  const top = el.getBoundingClientRect().top;
  const nums = [...document.querySelectorAll('#editor .cm-lineNumbers .cm-gutterElement')].filter((n) => n.textContent.trim());
  return Number(nums.find((n) => Math.abs(n.getBoundingClientRect().top - top) < 3)?.textContent);
}));

test('warning markers sit on the lines of the sample paper warnings, per open file', async ({ page }) => {
  // The sample paper's warnings: undefined citation at sections/intro.tex:9, undefined reference at sections/methods.tex:11.
  await expect(marker(page)).toHaveCount(0); // main.tex has none (and nothing is compiled-in yet for it)
  await tree(page, 'intro.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
  await expect(marker(page, 'warn')).toHaveCount(1);
  await expect.poll(() => markedLines(page)).toEqual([9]);
  await expect(marker(page, 'error')).toHaveCount(0);
  await expect(marker(page)).toHaveAttribute('title', /missingref2020/);
  await tree(page, 'methods.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await expect(marker(page, 'warn')).toHaveCount(1);
  await expect.poll(() => markedLines(page)).toEqual([11]);
  await expect(marker(page)).toHaveAttribute('title', /sec:result/);
  await tree(page, 'main.tex').click();
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(marker(page)).toHaveCount(0);
});

test('a deliberate error gets a red marker on its line; fixing it clears it', async ({ page, margin }) => {
  const file = path.join(margin.paper, 'main.tex');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.indexOf('\\maketitle'); // 0-based; the bad macro goes on the next line
  lines.splice(at + 1, 0, '\\thisMacroDoesNotExist');
  const errLine = at + 2; // 1-based line of the inserted macro
  fs.writeFileSync(file, lines.join('\n'));
  await expect(page.locator('#editor .cm-content')).toContainText('thisMacroDoesNotExist');
  await recompile(page);
  await expect(marker(page, 'error')).toHaveCount(1);
  expect(await markedLines(page)).toContain(errLine);
  const err = marker(page, 'error').first();
  await expect(err).toHaveAttribute('title', /thisMacroDoesNotExist|Undefined control sequence/);

  // Clicking opens the Logs panel on the matching entry (close it first so the click must reopen it).
  if (!(await page.locator('#logs').evaluate((el) => el.classList.contains('hidden')))) await page.locator('#logs .close').click();
  await expect(page.locator('#logs')).toHaveClass(/hidden/);
  await err.click();
  await expect(page.locator('#logs')).not.toHaveClass(/hidden/);
  await expect(page.locator('#log-list .log-item.error.flash')).toContainText(`main.tex:${errLine}`);

  // Markers follow edits above them.
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('% shift\n');
  await expect.poll(async () => (await markedLines(page)).includes(errLine + 1)).toBe(true);
  await expect(page.locator('#save-state')).toHaveText('Saved');

  // Remove the error line by rewriting the file on disk right after the UI save (an external write the
  // editor must pick up), then recompile: the red marker is gone, warnings remain.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('thisMacroDoesNotExist')).join('\n'));
  await expect(page.locator('#editor .cm-content')).not.toContainText('thisMacroDoesNotExist');
  await recompile(page);
  await expect(marker(page, 'error')).toHaveCount(0);
  // Back to the sample paper's warnings only (none in main.tex).
  await expect(marker(page)).toHaveCount(0);
});
