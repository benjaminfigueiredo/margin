import { test, expect, readDisk, rest } from './fixtures.mjs';

// Accepting a suggestion rewrites the source file on disk. If the editor has unsaved
// edits at that moment, the server applies the change to the version on disk — which
// lacks those edits — and the "changed on disk" banner's "Keep mine" then writes the
// stale buffer back over the accepted text, losing it with nothing to show that the
// review store and the file disagree. Every review action now flushes pending edits
// first, the same way openFile, compile, comment and sync always have.
//
// Timing: the editor autosaves 700 ms after the last keystroke, so this test types and
// clicks Accept back to back to stay inside that window. If the autosave wins the race
// the end state is still correct, so this cannot fail spuriously — it just stops
// exercising the hazard on an unusually slow run.

const MARKER = '% unsaved-edit-marker';
const ORIGINAL = 'Marine heatwaves are becoming more frequent';
const REPLACEMENT = 'Marine heatwaves are becoming markedly more frequent';

test('accepting with unsaved edits keeps both the edit and the accepted text', async ({ page, margin }) => {
  await expect(page.locator('#current-file')).toHaveText('main.tex');

  const sugg = await rest(margin, '/review/suggest', {
    method: 'POST',
    body: { file: 'main.tex', original: ORIGINAL, replacement: REPLACEMENT, rationale: 'tighter' },
  });
  expect(sugg.id, JSON.stringify(sugg)).toBeTruthy();
  const card = page.locator(`#cards .card[data-id="${sugg.id}"]`);
  await expect(card).toBeVisible();

  // Dirty the buffer, then accept straight away.
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n${MARKER}`);
  await card.locator('button.accept').click();

  // Both survive on disk: the accepted replacement and the unsaved edit.
  await expect.poll(() => readDisk(margin, 'main.tex')).toContain(REPLACEMENT);
  expect(readDisk(margin, 'main.tex')).toContain(MARKER);
  expect(readDisk(margin, 'main.tex')).not.toContain(ORIGINAL + ' and');

  // The editor ends up agreeing with disk rather than diverging from it.
  await expect(page.locator('#editor .cm-content')).toContainText(REPLACEMENT);
  await expect(page.locator('#editor .cm-content')).toContainText(MARKER);
  await expect(page.locator('#banner')).toBeHidden();
});
