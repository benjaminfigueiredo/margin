import { test, expect, readDisk, rest } from './fixtures.mjs';

// The tests share one paper on disk and build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial' });

// The sample paper compiles with no errors and 4 warnings (missing citation, undefined reference, ...).
const EXPECTED_WARNINGS = '4';

const editorText = (page) => page.locator('#editor .cm-content');
const tree = (page, name) => page.locator('#tree').getByText(name, { exact: true });

async function recompile(page) {
  const done = page.waitForResponse((r) => r.url().endsWith('/api/compile') && r.request().method() === 'POST');
  await page.locator('#btn-compile').click();
  await done;
  await expect(page.locator('#btn-compile .label')).toHaveText('Recompile');
}

test('boot: tree, editor, connection dot, first PDF page', async ({ page }) => {
  await expect(tree(page, 'main.tex')).toBeVisible();
  await expect(tree(page, 'refs.bib')).toBeVisible();
  await expect(tree(page, 'sections')).toBeVisible();
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await expect(editorText(page)).toContainText('Thermal Tolerance of Coastal Copepods');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  const canvas = page.locator('#pdf-pages .pdf-page[data-page="1"] canvas');
  await expect(canvas).toBeVisible();
  // The PDF pane replaces every page element after each compile (pdfview buildPages),
  // so read width and height in one poll instead of two separate measurements.
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return Math.min(box?.width ?? 0, box?.height ?? 0);
  }).toBeGreaterThan(0);
});

test('edit and save: Unsaved then Saved, content reaches disk', async ({ page, margin }) => {
  const marker = '% ui-test-marker';
  await editorText(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n${marker}`);
  await expect(page.locator('#save-state')).toHaveText('Unsaved');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect((await rest(margin, '/file?path=main.tex')).content).toContain(marker);
  expect(readDisk(margin, 'main.tex')).toContain(marker);
});

test('compile: log badge shows the sample paper counts, a row opens file:line', async ({ page }) => {
  await recompile(page);
  const badge = page.locator('#log-badge');
  await expect(badge).toHaveText(EXPECTED_WARNINGS);
  await expect(badge).toHaveClass(/warn/);
  await page.locator('#btn-logs').click();
  await expect(page.locator('#log-list h4', { hasText: `Warnings (${EXPECTED_WARNINGS})` })).toBeVisible();
  const row = page.locator('#log-list .log-item.warn', { has: page.locator('.log-loc') }).first();
  const loc = (await row.locator('.log-loc').textContent()).trim();
  const [file, line] = loc.split(':');
  await row.click();
  await expect(page.locator('#current-file')).toHaveText(file);
  await expect(page.locator('#editor .cm-lineNumbers .cm-activeLineGutter')).toHaveText(line);
});

test('accept a suggestion: inline diff and card, then disk changes', async ({ page, margin }) => {
  const original = 'it is not well known how';
  const replacement = 'little is known about how';
  await rest(margin, '/review/suggest', { method: 'POST', body: { file: 'sections/intro.tex', original, replacement, rationale: 'More direct.' } });
  await tree(page, 'intro.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/intro.tex');
  await expect(page.locator('#editor .cm-sugg-del')).toHaveText(original);
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveText(replacement);
  await expect(page.locator('#editor .cm-sugg-del')).toHaveCSS('text-decoration-line', /line-through/);
  const card = page.locator('#cards .card.suggestion');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.diff ins').first()).toHaveText('little');
  await card.getByRole('button', { name: /Accept/ }).click();
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveCount(0);
  await expect(page.locator('#cards .card.suggestion')).toHaveCount(0);
  expect(readDisk(margin, 'sections/intro.tex')).toContain(replacement);
  expect(readDisk(margin, 'sections/intro.tex')).not.toContain(original);
  await page.locator('#show-closed').check();
  await expect(page.locator('#cards .card.suggestion .status')).toHaveText('accepted');
});

test('reject a suggestion: card closes, file unchanged', async ({ page, margin }) => {
  const original = 'which may underestimate cumulative effects';
  await rest(margin, '/review/suggest', { method: 'POST', body: { file: 'sections/intro.tex', original, replacement: 'which may understate cumulative effects', rationale: 'x' } });
  await tree(page, 'intro.tex').click();
  const before = readDisk(margin, 'sections/intro.tex');
  const card = page.locator('#cards .card.suggestion');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: /Reject/ }).click();
  await expect(page.locator('#cards .card.suggestion')).toHaveCount(0);
  await expect(page.locator('#editor .cm-sugg-ins')).toHaveCount(0);
  expect(readDisk(margin, 'sections/intro.tex')).toBe(before);
  const items = await rest(margin, '/review');
  expect(items.find((i) => i.quote.includes('underestimate')).status).toBe('rejected');
});

test('comment on a selection', async ({ page }) => {
  await tree(page, 'methods.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  const quote = 'held for 72 hours';
  await expect(editorText(page)).toContainText(quote);
  // Select the phrase with the mouse: find where it is drawn, then drag across it.
  const rect = await page.evaluate((q) => {
    const walker = document.createTreeWalker(document.querySelector('#editor .cm-content'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(q);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + q.length);
      const b = r.getBoundingClientRect();
      return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 };
    }
    return null;
  }, quote);
  expect(rect).not.toBeNull();
  await page.mouse.move(rect.x0, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.x1, rect.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#btn-comment')).toBeEnabled();
  await page.locator('#btn-comment').click();
  await expect(page.locator('#new-comment')).toBeVisible();
  await expect(page.locator('#new-comment .quote')).toHaveText(quote);
  await page.locator('#new-comment textarea').fill('Claude: why 72 h?');
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/review/comment'));
  await page.locator('#new-comment .submit').click();
  await posted;
  const card = page.locator('#cards .card.comment');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.quote')).toHaveText(quote);
  await expect(card.locator('.body')).toHaveText('Claude: why 72 h?');
});

test('PDF to source: double-click on page 1 jumps to the source line', async ({ page, margin }) => {
  await recompile(page);
  const fwd = await rest(margin, '/synctex/forward?file=sections/methods.tex&line=5');
  expect(fwd.page).toBe(1);
  await tree(page, 'main.tex').click();
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  const pageEl = page.locator('#pdf-pages .pdf-page[data-page="1"]');
  await expect(pageEl.locator('canvas')).toBeVisible();
  // A compile makes pdfview's buildPages() call replaceChildren(), so this node can
  // detach between being measured and being clicked. Measure, click and check the jump
  // as one retried step. Page width in CSS px over the paper width in pt (US letter,
  // the pdfLaTeX default) gives the scale.
  await expect(async () => {
    const scale = (await pageEl.boundingBox()).width / 612;
    await pageEl.dblclick({ position: { x: (fwd.h + 5) * scale, y: (fwd.v - 2) * scale } });
    await expect(page.locator('#current-file')).toHaveText('sections/methods.tex', { timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.locator('#editor .cm-lineNumbers .cm-activeLineGutter')).toHaveText('5');
});

test('review panel toggle persists across reload', async ({ page }) => {
  const panel = page.locator('#review');
  await expect(panel).not.toHaveClass(/collapsed/);
  await page.locator('#btn-review').click();
  await expect(panel).toHaveClass(/collapsed/);
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect(panel).toHaveClass(/collapsed/);
  await page.locator('#btn-review').click();
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect(panel).not.toHaveClass(/collapsed/);
});
