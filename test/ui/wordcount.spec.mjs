import { test, expect } from './fixtures.mjs';

// Sample paper: abstract 49, Introduction 105, Methods 42 words (the API test in test/run.mjs checks the same numbers).
test('word count: status bar total, per-section breakdown, live selection count', async ({ page }) => {
  const btn = page.locator('#wc-btn');
  await expect(btn).toHaveText('196 words');

  await btn.click();
  const panel = page.locator('#wc-panel');
  await expect(panel).toBeVisible();
  const rowOf = (name) => panel.locator('tbody tr', { has: page.locator('th', { hasText: name }) });
  await expect(rowOf('Abstract').locator('td').first()).toHaveText('49');
  await expect(rowOf('Introduction').locator('td').first()).toHaveText('105');
  await expect(rowOf('Methods').locator('td').first()).toHaveText('42');
  await expect(panel.locator('tfoot td').last()).toHaveText('196');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Type a line into the editor and select it: the selection count tracks the selection live.
  const sel = page.locator('#wc-sel');
  await expect(sel).toBeHidden();
  await page.locator('#tree').getByText('intro.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nalpha beta gamma delta % not this');
  await page.keyboard.press('Shift+Home');
  await expect(sel).toHaveText('4 selected');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(sel).toBeHidden();

  // The saved edit shows up in the status bar total (4 new words).
  await expect(btn).toHaveText('200 words');
});
