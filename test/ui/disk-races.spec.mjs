import fs from 'node:fs';
import path from 'node:path';
import { test, expect, readDisk, rest } from './fixtures.mjs';

// Editor <-> disk consistency. Something other than the editor rewrites the open file (an accepted
// suggestion, find-and-replace, Claude, git) while the author is typing. Whatever the timing, an
// edit the author made is never silently dropped, and a change written to disk is never silently
// overwritten by a stale buffer: the two are merged when they touch different parts of the file,
// and otherwise the author is told and chooses.
//
// Each race is made deterministic with page.route: the server has already done its write when the
// handler types into the editor, and only then is the response handed to the page.

test.describe.configure({ mode: 'serial' });

const tree = (page, name) => page.locator('#tree').getByText(name, { exact: true });
const content = (page) => page.locator('#editor .cm-content');
const banner = (page) => page.locator('#banner');
// The whole buffer (CodeMirror renders only the lines in view).
const editorDoc = (page) => page.evaluate(() => document.querySelector('#editor .cm-content').cmTile.root.view.state.doc.toString());
const writeDisk = (margin, rel, text) => fs.writeFileSync(path.join(margin.paper, rel), text);

async function open(page, file) {
  await tree(page, file.split('/').pop()).click();
  await expect(page.locator('#current-file')).toHaveText(file);
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

// Types at the end of the open file, as the author would (keyboard into the focused editor).
async function typeAtEnd(page, text) {
  await content(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

// The server handles the request; the author types; only then does the page see the response.
function typeBeforeResponse(page, text, { when = () => true } = {}) {
  return async (route) => {
    if (!when(route.request())) return route.continue();
    const response = await route.fetch();
    await typeAtEnd(page, text);
    await route.fulfill({ response });
  };
}

async function settled(page, margin, file) {
  await expect(page.locator('#save-state')).toHaveText('Saved');
  // the editor shows exactly what is on disk
  await expect.poll(async () => (await editorDoc(page)) === readDisk(margin, file)).toBe(true);
}

test('typing just after a replace is written keeps both the replace and the typing', async ({ page, margin }) => {
  const file = 'sections/intro.tex';
  await open(page, file);
  await page.locator('#btn-search').click();
  await page.locator('#search-q').fill('Ocean warming');
  await page.locator('#search-r').fill('Sea warming');
  const hit = page.locator('#search-results .search-hit').first();
  await expect(hit).toBeVisible();
  await page.route('**/api/replace', typeBeforeResponse(page, '\n% typed-after-replace', { when: (r) => !r.postDataJSON().dryRun }));
  await hit.hover();
  await hit.locator('.hit-replace').click();

  await expect.poll(() => readDisk(margin, file)).toContain('% typed-after-replace');
  await expect.poll(() => readDisk(margin, file)).toContain('Sea warming');
  await settled(page, margin, file);
  expect(readDisk(margin, file)).not.toContain('Ocean warming');
  await expect(banner(page)).toBeHidden();
  await page.unroute('**/api/replace');
  await page.locator('#search .close').click();
});

test('typing just after Accept is written keeps both the accepted text and the typing', async ({ page, margin }) => {
  const file = 'sections/intro.tex';
  await open(page, file);
  const sugg = await rest(margin, '/review/suggest', { method: 'POST', body: { file, original: 'the most pervasive stressors', replacement: 'the most widespread stressors' } });
  const card = page.locator(`#cards .card[data-id="${sugg.id}"]`);
  await expect(card).toBeVisible();
  await page.route('**/api/review/*/accept', typeBeforeResponse(page, '\n% typed-after-accept'));
  await card.locator('button.accept').click();

  await expect.poll(() => readDisk(margin, file)).toContain('% typed-after-accept');
  await expect.poll(() => readDisk(margin, file)).toContain('the most widespread stressors');
  await settled(page, margin, file);
  await expect(banner(page)).toBeHidden();
  await page.unroute('**/api/review/*/accept');

  // Undo accept has the same window.
  await page.locator('#show-closed').check();
  await page.route('**/api/review/*/unaccept', typeBeforeResponse(page, '\n% typed-after-undo'));
  await card.getByRole('button', { name: 'Undo accept' }).click();
  await expect.poll(() => readDisk(margin, file)).toContain('% typed-after-undo');
  await expect.poll(() => readDisk(margin, file)).toContain('the most pervasive stressors');
  await settled(page, margin, file);
  expect(readDisk(margin, file)).toContain('% typed-after-accept');
  await expect(banner(page)).toBeHidden();
  await page.unroute('**/api/review/*/unaccept');
  await page.locator('#show-closed').uncheck();
});

test('typing while the editor reloads a file Claude changed is not lost', async ({ page, margin }) => {
  const file = 'sections/methods.tex';
  await open(page, file);
  const before = readDisk(margin, file);
  await page.route(/\/api\/file\?path=sections%2Fmethods\.tex$/, typeBeforeResponse(page, '\n% typed-during-reload', { when: (r) => r.method() === 'GET' }));
  // Claude (or any other editor) rewrites the top of the file on disk.
  writeDisk(margin, file, before.replace('Adult \\textit{Acartia tonsa}', 'Adult female \\textit{Acartia tonsa}'));

  await expect.poll(() => readDisk(margin, file)).toContain('% typed-during-reload');
  expect(readDisk(margin, file)).toContain('Adult female');
  await settled(page, margin, file);
  await expect(banner(page)).toBeHidden();
  await page.unroute(/\/api\/file\?path=sections%2Fmethods\.tex$/);
});

test('a save that would overwrite a newer disk version is refused; the author chooses', async ({ page, margin }) => {
  const file = 'sections/methods.tex';
  await open(page, file);
  const before = readDisk(margin, file);
  const theirs = before + '\n% written-by-claude';
  // The author's autosave reaches the server just after Claude appended to the same spot.
  await page.route(/\/api\/file\?path=sections%2Fmethods\.tex$/, async (route) => {
    if (route.request().method() === 'PUT') writeDisk(margin, file, theirs);
    await route.continue();
  });
  await typeAtEnd(page, '\n% typed-by-author');

  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(file);
  await page.unroute(/\/api\/file\?path=sections%2Fmethods\.tex$/);
  // Nothing was overwritten, and nothing the author typed is gone.
  expect(readDisk(margin, file)).toBe(theirs);
  await expect(content(page)).toContainText('% typed-by-author');
  // Typing on while the banner is up still saves nothing over Claude's version.
  await typeAtEnd(page, ' more');
  await page.waitForTimeout(1200);
  expect(readDisk(margin, file)).toBe(theirs);
  await expect(page.locator('#save-state')).toHaveText(/not saved/i);

  await banner(page).getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(() => readDisk(margin, file)).toContain('% typed-by-author more');
  expect(readDisk(margin, file)).not.toContain('% written-by-claude');
  await settled(page, margin, file);
  await expect(banner(page)).toBeHidden();

  // The other choice: the disk version replaces the buffer.
  const theirs2 = readDisk(margin, file) + '\n% claude-again';
  await page.route(/\/api\/file\?path=sections%2Fmethods\.tex$/, async (route) => {
    if (route.request().method() === 'PUT') writeDisk(margin, file, theirs2);
    await route.continue();
  });
  await typeAtEnd(page, '\n% author-again');
  await expect(banner(page)).toBeVisible();
  await page.unroute(/\/api\/file\?path=sections%2Fmethods\.tex$/);
  await banner(page).getByRole('button', { name: 'Load disk version' }).click();
  await settled(page, margin, file);
  expect(readDisk(margin, file)).toBe(theirs2);
  await expect(banner(page)).toBeHidden();
  writeDisk(margin, file, before);
  await expect(content(page)).not.toContainText('claude-again');
});

test('typing while Sync runs is kept and saved', async ({ page, margin }) => {
  const file = 'sections/methods.tex';
  await open(page, file);
  page.once('dialog', (d) => d.accept('test sync'));
  await page.route('**/api/git/sync', typeBeforeResponse(page, '\n% typed-during-sync'));
  await page.locator('#btn-sync').click();
  await expect.poll(() => readDisk(margin, file)).toContain('% typed-during-sync');
  await settled(page, margin, file);
  await page.unroute('**/api/git/sync');
});

test('a file deleted on disk is not silently recreated by the autosave', async ({ page, margin }) => {
  const file = 'sections/scratch.tex';
  writeDisk(margin, file, 'scratch line\n');
  await expect(tree(page, 'scratch.tex')).toBeVisible();
  await open(page, file);
  fs.unlinkSync(path.join(margin.paper, file));
  await expect(tree(page, 'scratch.tex')).toHaveCount(0);
  await typeAtEnd(page, 'kept text');
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(/no longer on disk/i);
  expect(fs.existsSync(path.join(margin.paper, file))).toBe(false);
  await expect(content(page)).toContainText('kept text');
  await banner(page).getByRole('button', { name: /Save it again/ }).click();
  await expect.poll(() => fs.existsSync(path.join(margin.paper, file)) && readDisk(margin, file)).toBe('scratch line\nkept text');
  await expect(banner(page)).toBeHidden();
  fs.unlinkSync(path.join(margin.paper, file));
});

test('edits typed just before the page goes away are saved without beforeunload', async ({ page, context, margin }) => {
  const file = 'sections/intro.tex';
  await open(page, file);
  await typeAtEnd(page, '\n% typed-before-close');
  await page.close(); // no beforeunload (Playwright's default), as when a web view is torn down
  await expect.poll(() => readDisk(margin, file)).toContain('% typed-before-close');

  // A file far over the 64 KB keepalive limit: what is sent is the edit, not the whole file.
  const big = 'big.tex';
  writeDisk(margin, big, Array.from({ length: 2500 }, (_, i) => `Line ${i} of a long chapter, with enough words to add up.`).join('\n') + '\n');
  expect(fs.statSync(path.join(margin.paper, big)).size).toBeGreaterThan(100_000);
  const p2 = await context.newPage();
  await p2.goto(margin.baseURL + '/');
  await expect(p2.locator('#conn')).toHaveClass(/\bon\b/);
  await open(p2, big);
  await typeAtEnd(p2, '% typed-at-the-end-of-a-big-file');
  await p2.close();
  await expect.poll(() => readDisk(margin, big)).toContain('% typed-at-the-end-of-a-big-file');
  expect(readDisk(margin, big).startsWith('Line 0 of a long chapter')).toBe(true);
  fs.unlinkSync(path.join(margin.paper, big));
});

test('typing while another file loads goes into neither file', async ({ page, margin }) => {
  await open(page, 'sections/intro.tex');
  const methods = readDisk(margin, 'sections/methods.tex');
  const intro = readDisk(margin, 'sections/intro.tex');
  const url = /\/api\/file\?path=sections%2Fmethods\.tex$/;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await typeAtEnd(page, '\n% typed-while-loading');
    await page.waitForTimeout(1200); // past the autosave delay
    await route.fulfill({ response });
  });
  await tree(page, 'methods.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await settled(page, margin, 'sections/methods.tex');
  await page.unroute(url);
  expect(readDisk(margin, 'sections/methods.tex')).toBe(methods);
  expect(readDisk(margin, 'sections/intro.tex')).toBe(intro);
});

test('a file whose edits could not be saved is not closed by opening another', async ({ page, margin }) => {
  const file = 'sections/intro.tex';
  await open(page, file);
  const before = readDisk(margin, file);
  const url = /\/api\/file\?path=sections%2Fintro\.tex$/;
  await page.route(url, (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
  await typeAtEnd(page, '\n% typed-while-offline');
  await expect(page.locator('#save-state')).toHaveText('Save failed');
  await tree(page, 'methods.tex').click();
  await expect(page.locator('#toasts')).toContainText('not saved yet');
  await expect(page.locator('#current-file')).toHaveText(file);
  await expect(content(page)).toContainText('% typed-while-offline');
  await page.unroute(url);
  await tree(page, 'methods.tex').click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  expect(readDisk(margin, file)).toBe(`${before}\n% typed-while-offline`);
  writeDisk(margin, file, before);
});

// pagehide while a save is still on its way: the last request carries the edit against both the
// last saved text and the save in flight, and whichever reaches the server first, both end up on disk.
for (const order of ['last save first', 'earlier save first']) {
  test(`a save still on its way when the page goes away (${order})`, async ({ page, margin }) => {
    const file = 'sections/methods.tex';
    await open(page, file);
    const before = readDisk(margin, file);
    const held = [];
    const url = /\/api\/file\?path=sections%2Fmethods\.tex$/;
    await page.route(url, (route) => (route.request().method() === 'PUT' ? held.push(route) : route.continue()));
    await typeAtEnd(page, '\n% first-part');
    await expect.poll(() => held.length).toBe(1); // the autosave, held on its way
    await typeAtEnd(page, ' second-part');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await expect.poll(() => held.length).toBe(2);
    const last = held[1].request().postDataJSON();
    expect(last.after?.id).toBe(held[0].request().postDataJSON().id);
    const go = order === 'last save first' ? [held[1], held[0]] : [held[0], held[1]];
    await go[0].continue();
    await expect.poll(() => readDisk(margin, file)).not.toBe(before);
    await go[1].continue();
    await expect.poll(() => readDisk(margin, file)).toBe(`${before}\n% first-part second-part`);
    await page.unroute(url);
    await settled(page, margin, file);
    await expect(banner(page)).toBeHidden();
    writeDisk(margin, file, before);
    await expect(content(page)).not.toContainText('first-part');
  });
}
