import { test, expect, rest } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });

const SRC = [
  '\\section{Introduction}',
  'Text.',
  '% \\section{Dead}',
  '\\subsection{The $\\alpha$ {\\em effect}}',
  'More.',
  '\\section*{Appendix}',
  '\\begin{figure}',
  '\\caption{Rate of $x^2$ growth}',
  '\\end{figure}',
  'End.',
  '',
].join('\n');

const names = (page) => page.locator('#outline .outline-item .name');

test('outline lists headings in order, skips comments, jumps on click', async ({ page, margin }) => {
  await rest(margin, '/file?path=sections/intro.tex', { method: 'PUT', body: { content: SRC } });
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await page.locator('#tree').getByText('intro.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
  await expect(names(page)).toHaveText(['Introduction', 'The effect', 'Appendix', 'Rate of x^2 growth']);
  await expect(page.locator('#outline')).not.toContainText('Dead');
  await names(page).nth(1).click();
  await expect(page.locator('#editor .cm-lineNumbers .cm-activeLineGutter')).toHaveText('4');
  await expect(page.locator('#outline .outline-item.current .name')).toHaveText('The effect');
});

test('outline picks up a new \\section without saving', async ({ page }) => {
  await page.locator('#tree').getByText('intro.tex', { exact: true }).click();
  await expect(names(page).first()).toHaveText('Introduction');
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\\section');
  await page.keyboard.type('{Brand New}');
  await expect(names(page).filter({ hasText: 'Brand New' })).toHaveCount(1);
});
