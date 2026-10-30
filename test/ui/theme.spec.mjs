import { test, expect, rest } from './fixtures.mjs';

// Theme and font size are per-browser settings; the specs share one paper and run in order.
test.describe.configure({ mode: 'serial' });

// Relative luminance of a computed CSS colour, 0 (black) to 1 (white).
const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const style = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);

async function chooseTheme(page, choice) {
  await page.locator('#btn-settings').click();
  await page.locator(`[data-theme-choice="${choice}"]`).click();
  await page.locator('#btn-settings').click();
}

test('dark theme restyles the chrome, the review cards and the editor syntax colours', async ({ page, margin }) => {
  await rest(margin, '/review/comment', { method: 'POST', body: { file: 'main.tex', quote: 'Marine heatwaves are becoming more', comment: 'Is "more frequent" sourced?' } });
  const card = page.locator('#cards .card').first();
  await expect(card).toBeVisible();
  const body = card.locator('.body');
  const command = page.locator('#editor .cm-content').getByText('\\documentclass').first();

  const light = { bg: await style(page.locator('body'), 'backgroundColor'), card: await style(body, 'color'), command: await style(command, 'color') };
  expect(luminance(light.bg)).toBeGreaterThan(0.5);

  await chooseTheme(page, 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await style(page.locator('body'), 'backgroundColor');
  expect(luminance(bg)).toBeLessThan(0.05);

  // Card text must change colour and still be readable against the card.
  const cardInk = await style(body, 'color');
  expect(cardInk).not.toBe(light.card);
  expect(contrast(cardInk, await style(card, 'backgroundColor'))).toBeGreaterThan(7);

  // The editor's syntax colours come from CSS tokens, so they must follow the theme too.
  const commandInk = await style(command, 'color');
  expect(commandInk).not.toBe(light.command);
  expect(contrast(commandInk, await style(page.locator('.editor-pane'), 'backgroundColor'))).toBeGreaterThan(4.5);

  // The choice survives a reload; System then follows the browser's colour scheme.
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await chooseTheme(page, 'system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(luminance(await style(page.locator('body'), 'backgroundColor'))).toBeLessThan(0.05);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(luminance(await style(page.locator('body'), 'backgroundColor'))).toBeGreaterThan(0.5);
});

test('font size applies to the editor only and survives a reload', async ({ page }) => {
  const editorFont = () => style(page.locator('#editor .cm-content'), 'fontSize');
  const chromeFont = () => style(page.locator('#current-file'), 'fontSize');
  expect(await editorFont()).toBe('14px');
  const chrome = await chromeFont();

  await page.locator('#btn-settings').click();
  await page.locator('#set-font-size').selectOption('18');
  await expect.poll(editorFont).toBe('18px');
  expect(await chromeFont()).toBe(chrome);

  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect.poll(editorFont).toBe('18px');
  await expect(page.locator('#set-font-size')).toHaveValue('18');
});
