import { test, expect, readDisk, rest } from './fixtures.mjs';

const tree = (page, name) => page.locator('#tree').getByText(name, { exact: true });

test('accept then Undo accept: card reopens, inline diff returns, file restored', async ({ page, margin }) => {
  const file = 'sections/intro.tex';
  const original = 'it is not well known how';
  const replacement = 'little is known about how';
  const pristine = readDisk(margin, file);
  await rest(margin, '/review/suggest', { method: 'POST', body: { file, original, replacement, rationale: 'More direct.' } });
  await tree(page, 'intro.tex').click();
  await expect(page.locator('#current-file')).toHaveText(file);
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveText(replacement);

  await page.locator('#cards .card.suggestion').getByRole('button', { name: /Accept/ }).click();
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveCount(0);
  expect(readDisk(margin, file)).toContain(replacement);

  await page.locator('#show-closed').check();
  const card = page.locator('#cards .card.suggestion');
  await expect(card.locator('.status')).toHaveText('accepted');
  await expect(card.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Undo accept' }).click();

  await expect(card.locator('.status')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Accept/ }).first()).toBeVisible();
  await expect(page.locator('#editor .cm-sugg-del')).toHaveText(original);
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveText(replacement);
  expect(readDisk(margin, file)).toBe(pristine);
});
