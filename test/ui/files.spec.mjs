import fs from 'node:fs';
import path from 'node:path';
import { test, expect, readDisk, rest } from './fixtures.mjs';

// File management: the specs share one paper and build on each other.
test.describe.configure({ mode: 'serial' });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

const row = (page, name) => page.locator('#tree .tree-item').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const exists = (margin, rel) => fs.existsSync(path.join(margin.paper, rel));

// A DataTransfer holding one file, as a drop from the desktop would carry it.
const fileDrop = (page, name, bytes, type = 'image/png') => page.evaluateHandle(([n, b64, t]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n, { type: t }));
  return dt;
}, [name, bytes.toString('base64'), type]);

test('create a file from the tree, type in it, rename it, delete it', async ({ page, margin }) => {
  // + > New file: the name field opens in the tree
  await page.locator('#btn-new').click();
  await page.getByRole('menuitem', { name: 'New file…' }).click();
  await page.locator('#tree .tree-input').fill('scratch.tex');
  await page.keyboard.press('Enter');

  // it opens, empty, and the tree lists it (nothing refreshed it by hand: the watcher did)
  await expect(page.locator('#current-file')).toHaveText('scratch.tex');
  await expect(row(page, 'scratch.tex')).toBeVisible();
  expect(readDisk(margin, 'scratch.tex')).toBe('');

  await page.locator('#editor .cm-content').click();
  await page.keyboard.type('Hello margin');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect.poll(() => readDisk(margin, 'scratch.tex')).toBe('Hello margin');

  // right-click > Rename: header and tree follow, the editor keeps its text, the file keeps working
  await row(page, 'scratch.tex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const input = page.locator('#tree .tree-input');
  await expect(input).toHaveValue('scratch.tex');
  await input.fill('renamed.tex');
  await page.keyboard.press('Enter');
  await expect(page.locator('#current-file')).toHaveText('renamed.tex');
  await expect(row(page, 'renamed.tex')).toBeVisible();
  await expect(row(page, 'scratch.tex')).toHaveCount(0);
  await expect(row(page, 'renamed.tex')).toHaveClass(/active/);
  await expect(page.locator('#editor .cm-content')).toContainText('Hello margin');
  expect(exists(margin, 'scratch.tex')).toBe(false);
  expect(readDisk(margin, 'renamed.tex')).toBe('Hello margin');

  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' again');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect.poll(() => readDisk(margin, 'renamed.tex')).toBe('Hello margin again');
  expect(exists(margin, 'scratch.tex'), 'saving after a rename must not bring the old file back').toBe(false);

  // the hover button opens the same menu; Delete asks first, naming the file
  await row(page, 'renamed.tex').hover();
  await row(page, 'renamed.tex').locator('.row-menu').click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.locator('dialog.dialog');
  await expect(dialog).toContainText('Delete “renamed.tex”?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(exists(margin, 'renamed.tex')).toBe(true);

  await row(page, 'renamed.tex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'renamed.tex')).toHaveCount(0);
  expect(exists(margin, 'renamed.tex')).toBe(false);
  // the editor fell back to the main document, and nothing recreates the deleted file
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await page.waitForTimeout(1500);
  expect(exists(margin, 'renamed.tex')).toBe(false);
});

test('the tree follows files created and removed outside the UI (the watcher, no manual refresh)', async ({ page, margin }) => {
  fs.writeFileSync(path.join(margin.paper, 'from-claude.tex'), 'x');
  await expect(row(page, 'from-claude.tex')).toBeVisible();
  fs.unlinkSync(path.join(margin.paper, 'from-claude.tex'));
  await expect(row(page, 'from-claude.tex')).toHaveCount(0);
});

test('new folder, then a file inside it from the folder menu; refusals are explained', async ({ page, margin }) => {
  await page.locator('#btn-new').click();
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  await page.locator('#tree .tree-input').fill('chapters');
  await page.keyboard.press('Enter');
  await expect(row(page, 'chapters')).toBeVisible();
  expect(fs.statSync(path.join(margin.paper, 'chapters')).isDirectory()).toBe(true);

  await row(page, 'chapters').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file here…' }).click();
  await page.locator('#tree .tree-input').fill('one.tex');
  await page.keyboard.press('Enter');
  await expect(page.locator('#current-file')).toHaveText('chapters/one.tex');
  await expect(row(page, 'one.tex')).toBeVisible();

  // a name that is taken is refused and nothing is emptied
  await page.locator('#btn-new').click();
  await page.getByRole('menuitem', { name: 'New file…' }).click();
  await page.locator('#tree .tree-input').fill('main.tex');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toasts')).toContainText('main.tex already exists');
  expect(readDisk(margin, 'main.tex').length).toBeGreaterThan(100);
  await page.keyboard.press('Escape');

  // the main document cannot be deleted from here, and the way out is named
  await row(page, 'main.tex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.locator('#toasts')).toContainText('Change the main document first');
  await expect(page.locator('dialog.dialog')).toHaveCount(0);
  expect(exists(margin, 'main.tex')).toBe(true);
});

test('deleting a file keeps its review items: the dialog says so, the panel marks them', async ({ page, margin }) => {
  await rest(margin, '/file?path=chapters/two.tex', { method: 'PUT', body: { content: 'A claim that needs a source.' } });
  await expect(row(page, 'two.tex')).toBeVisible();
  await rest(margin, '/review/comment', { method: 'POST', body: { file: 'chapters/two.tex', quote: 'A claim that needs a source.', comment: 'Which source?' } });

  await row(page, 'two.tex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.locator('dialog.dialog');
  await expect(dialog).toContainText('1 open review item on it will be kept, not deleted');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'two.tex')).toHaveCount(0);

  await page.locator('#review [data-scope="all"]').click();
  const card = page.locator('#cards .card').filter({ hasText: 'Which source?' });
  await expect(card).toBeVisible();
  await expect(card.locator('.status.orphan')).toHaveText('file missing');
  expect((await rest(margin, '/review')).filter((i) => i.file === 'chapters/two.tex')).toHaveLength(1);
});

test('renaming a file carries its comments along', async ({ page, margin }) => {
  await rest(margin, '/file?path=chapters/three.tex', { method: 'PUT', body: { content: 'Another claim here.' } });
  await expect(row(page, 'three.tex')).toBeVisible();
  await rest(margin, '/review/comment', { method: 'POST', body: { file: 'chapters/three.tex', quote: 'Another claim', comment: 'Check this.' } });
  await row(page, 'three.tex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.locator('#tree .tree-input').fill('four.tex');
  await page.keyboard.press('Enter');
  await expect(row(page, 'four.tex')).toBeVisible();
  const items = (await rest(margin, '/review')).filter((i) => i.file === 'chapters/four.tex');
  expect(items).toHaveLength(1);
  expect(items[0].orphaned).toBe(false);
  await page.locator('#review [data-scope="all"]').click();
  const card = page.locator('#cards .card').filter({ hasText: 'Check this.' });
  await expect(card).toBeVisible();
  await expect(card.locator('.status.orphan')).toHaveCount(0);
});

test('dropping an image on the editor uploads it to figures/ and inserts a figure block at the cursor', async ({ page, margin }) => {
  await row(page, 'main.tex').click();
  await expect(page.locator('#current-file')).toHaveText('main.tex');
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n% figures go below\n');

  const dt = await fileDrop(page, 'SST anomaly (1).png', PNG);
  await page.dispatchEvent('#editor', 'drop', { dataTransfer: dt });

  // the file lands in figures/ (created on the way) under a name that is safe in LaTeX
  await expect.poll(() => exists(margin, 'figures/SST-anomaly-1.png')).toBe(true);
  expect(fs.readFileSync(path.join(margin.paper, 'figures/SST-anomaly-1.png'))).toEqual(PNG);

  // and the skeleton is in the text, with the caption left to fill in; the file's bytes are not
  const content = page.locator('#editor .cm-content');
  await expect(content).toContainText('\\includegraphics[width=0.8\\linewidth]{figures/SST-anomaly-1.png}');
  await expect(content).toContainText('\\caption{}');
  await expect(content).toContainText('\\label{fig:sst-anomaly-1}');
  await expect(content).toContainText('\\begin{figure}[htbp]');
  await expect(content).not.toContainText('IHDR');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const src = readDisk(margin, 'main.tex');
  expect(src.indexOf('% figures go below')).toBeLessThan(src.indexOf('\\begin{figure}[htbp]'));
  expect(src).toContain('\\caption{}\n  \\label{fig:sst-anomaly-1}\n\\end{figure}');

  // the cursor is inside the caption braces: typing fills it in
  await page.keyboard.type('Sea surface temperature anomaly.');
  await expect(content).toContainText('\\caption{Sea surface temperature anomaly.}');

  // the same name again must not replace the first file: it becomes -2, with its own label
  const dt2 = await fileDrop(page, 'SST anomaly (1).png', Buffer.concat([PNG, Buffer.from('second')]));
  await page.dispatchEvent('#editor', 'drop', { dataTransfer: dt2 });
  await expect.poll(() => exists(margin, 'figures/SST-anomaly-1-2.png')).toBe(true);
  expect(fs.readFileSync(path.join(margin.paper, 'figures/SST-anomaly-1.png'))).toEqual(PNG);
  await expect(content).toContainText('{figures/SST-anomaly-1-2.png}');
  await expect(content).toContainText('\\label{fig:sst-anomaly-1-2}');
  await expect(page.locator('#toasts')).toContainText('was already in figures/');

  // the figure shows up in the tree and in the outline
  await expect(row(page, 'figures')).toBeVisible();
  await expect(row(page, 'SST-anomaly-1.png')).toBeVisible();
});

test('a figure dropped in the middle of a line goes after that line, never inside a sentence', async ({ page, margin }) => {
  const content = page.locator('#editor .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nOne line of prose that must stay in one piece.\nNext line.\n');
  const box = await page.locator('#editor .cm-line', { hasText: 'One line of prose' }).boundingBox();
  const dt = await fileDrop(page, 'mid.png', PNG);
  await page.dispatchEvent('#editor', 'drop', { dataTransfer: dt, clientX: box.x + box.width / 3, clientY: box.y + box.height / 2 });
  await expect(content).toContainText('{figures/mid.png}');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect.poll(() => readDisk(margin, 'main.tex')).toContain('One line of prose that must stay in one piece.\n\n\\begin{figure}[htbp]');
  expect(readDisk(margin, 'main.tex')).toMatch(/\\end\{figure\}\n\nNext line\./);
});

test('a drop that is not a figure does not go into the text', async ({ page, margin }) => {
  const before = await page.locator('#editor .cm-content').innerText();
  const dt = await fileDrop(page, 'data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
  await page.dispatchEvent('#editor', 'drop', { dataTransfer: dt });
  await expect(page.locator('#toasts')).toContainText('only png, jpg, pdf, eps and svg');
  expect(await page.locator('#editor .cm-content').innerText()).toBe(before);
  expect(exists(margin, 'data.csv') || exists(margin, 'figures/data.csv')).toBe(false);
});

test('dropping files on a folder in the tree uploads them there and inserts nothing', async ({ page, margin }) => {
  await row(page, 'main.tex').click();
  const before = await page.locator('#editor .cm-content').innerText();
  const dt = await fileDrop(page, 'notes.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
  await page.dispatchEvent('#tree .tree-item.dir >> text=chapters', 'drop', { dataTransfer: dt });
  await expect.poll(() => exists(margin, 'chapters/notes.csv')).toBe(true);
  expect(readDisk(margin, 'chapters/notes.csv')).toBe('a,b\n1,2\n');
  await expect(row(page, 'notes.csv')).toBeVisible();
  expect(await page.locator('#editor .cm-content').innerText()).toBe(before);

  // onto the empty part of the tree: the top level
  const dt2 = await fileDrop(page, 'top.png', PNG);
  await page.dispatchEvent('#tree', 'drop', { dataTransfer: dt2 });
  await expect.poll(() => exists(margin, 'top.png')).toBe(true);

  // an existing name is not replaced until you say so
  const dt3 = await fileDrop(page, 'notes.csv', Buffer.from('x,y\n'), 'text/csv');
  await page.dispatchEvent('#tree .tree-item.dir >> text=chapters', 'drop', { dataTransfer: dt3 });
  const dialog = page.locator('dialog.dialog');
  await expect(dialog).toContainText('Replace “chapters/notes.csv”?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(readDisk(margin, 'chapters/notes.csv')).toBe('a,b\n1,2\n');
  const dt4 = await fileDrop(page, 'notes.csv', Buffer.from('x,y\n'), 'text/csv');
  await page.dispatchEvent('#tree .tree-item.dir >> text=chapters', 'drop', { dataTransfer: dt4 });
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await expect.poll(() => readDisk(margin, 'chapters/notes.csv')).toBe('x,y\n');
});
