import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, rest } from './fixtures.mjs';

// The Context view: the author's private notes for Claude, kept in .review/context/ (never in git).
// Files are added with "Add files…", by a drop on the panel and by "+ Note"; descriptions are edited
// in place; items open in a new window and are deleted with a confirmation. Contents are invented.
test.describe.configure({ mode: 'serial' });

const PDF = Buffer.from('%PDF-1.4\n% invented for the Margin UI test\n%%EOF\n');
const ctxFile = (margin, name) => path.join(margin.paper, '.review', 'context', name);
const item = (page, name) => page.locator(`.cx-item[data-name="${name}"]`);
const fileDrop = (page, name, text, type) => page.evaluateHandle(([n, t, ty]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([t], n, { type: ty }));
  return dt;
}, [name, text, type]);

async function claude(margin) {
  const c = new Client({ name: 'ui-test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${margin.baseURL}/mcp`)));
  return async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content.map((x) => x.text).join('\n');
    if (r.isError) throw new Error(text);
    return text;
  };
}

test('add files, drop one, write a note, describe, open, delete; Claude and the Finder add too; nothing for git', async ({ page, margin }) => {
  await page.locator('[data-rail="context"]').click();
  const panel = page.locator('#context');
  await expect(panel).toBeVisible();
  await expect(page.locator('#cards')).toBeHidden();
  await expect(panel.locator('.cx-empty')).toContainText('No private context yet');

  // "Add files…": two at once (the file input; the Mac app answers it with its own open panel)
  await panel.locator('input[type=file]').setInputFiles([
    { name: 'lab-meeting.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'old abstract.txt', mimeType: 'text/plain', buffer: Buffer.from('An older draft of the abstract (invented).\n') },
  ]);
  await expect(panel.locator('.cx-item')).toHaveCount(2);
  await expect(item(page, 'lab-meeting.pdf').locator('.cx-type')).toHaveText('PDF');
  await expect(item(page, 'old abstract.txt').locator('.cx-type')).toHaveText('TXT');
  await expect(page.locator('#context-count')).toHaveText('2');
  expect(fs.readFileSync(ctxFile(margin, 'lab-meeting.pdf'))).toEqual(PDF);

  // a type that cannot be used is refused with a message
  await panel.locator('input[type=file]').setInputFiles([{ name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
  await expect(page.locator('#toasts')).toContainText('only .md, .txt or .pdf');
  await expect(panel.locator('.cx-item')).toHaveCount(2);

  // a drop on the panel; one file: its description field opens at once
  const dt = await fileDrop(page, 'Call with Anna.md', '# Call with Anna (invented)\n\nKeep the 72 h exposure.\n', 'text/markdown');
  await page.dispatchEvent('#context', 'dragenter', { dataTransfer: dt });
  await expect(panel).toHaveClass(/drop-over/);
  await page.dispatchEvent('#context', 'drop', { dataTransfer: dt });
  await expect(panel).not.toHaveClass(/drop-over/);
  const call = item(page, 'Call with Anna.md');
  await expect(call).toBeVisible();
  await expect(call.locator('.cx-desc-edit')).toBeFocused();
  await page.keyboard.type('What we decided about the exposure time');
  await page.keyboard.press('Enter');
  await expect(call.locator('.cx-desc')).toHaveText('What we decided about the exposure time');

  // a note typed or pasted
  await panel.getByRole('button', { name: '+ Note' }).click();
  await panel.locator('.cx-note-title').fill('Reviewer worries');
  await panel.locator('.cx-note textarea').fill('Pasted from an email (invented):\n\n- the sample size\n- Fig. 2 colours');
  await panel.getByRole('button', { name: 'Save note' }).click();
  await expect(panel.locator('.cx-note')).toBeHidden();
  await expect(item(page, 'Reviewer worries.md')).toBeVisible();
  expect(fs.readFileSync(ctxFile(margin, 'Reviewer worries.md'), 'utf8')).toBe('# Reviewer worries\n\nPasted from an email (invented):\n\n- the sample size\n- Fig. 2 colours\n');

  // edit a description in place (Escape cancels, Enter saves)
  const pdf = item(page, 'lab-meeting.pdf');
  await pdf.locator('.cx-desc').click();
  await pdf.locator('.cx-desc-edit').fill('not this');
  await page.keyboard.press('Escape');
  await expect(pdf.locator('.cx-desc')).toHaveText('Add a description…');
  await pdf.locator('.cx-desc').click();
  await pdf.locator('.cx-desc-edit').fill('Slides from the lab meeting');
  await page.keyboard.press('Enter');
  await expect(pdf.locator('.cx-desc')).toHaveText('Slides from the lab meeting');
  expect((await rest(margin, '/context')).items.find((i) => i.name === 'lab-meeting.pdf').description).toBe('Slides from the lab meeting');

  // open: a new window on Margin's own page for the item
  const [popup] = await Promise.all([page.waitForEvent('popup'), call.locator('.cx-name').click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${margin.baseURL}/context/file?name=${encodeURIComponent('Call with Anna.md')}`);
  await expect(popup.locator('body')).toContainText('Keep the 72 h exposure.');
  await popup.close();

  // Claude keeps something the author pasted in the terminal: it appears live, marked as Claude's
  const claudeCall = await claude(margin);
  await claudeCall('save_context_note', { title: 'Units decision', body: 'SI units throughout (invented).', description: 'From the terminal' });
  await expect(item(page, 'Units decision.md').locator('.cx-by-claude')).toHaveText('added by Claude');
  await expect(item(page, 'Units decision.md').locator('.cx-desc')).toHaveText('From the terminal');
  expect(await claudeCall('get_editor_state', {})).toMatch(/Context: 5 items/);

  // put in the folder with the Finder: listed when Margin comes back to the front
  fs.writeFileSync(ctxFile(margin, 'by hand.txt'), 'Put here in the Finder (invented).\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(item(page, 'by hand.txt')).toBeVisible();
  await expect(item(page, 'by hand.txt').locator('.cx-meta')).toContainText('in the folder since');

  // delete, after a confirmation that says there is no trash
  await item(page, 'old abstract.txt').getByRole('button', { name: 'Delete' }).click();
  const dlg = page.locator('dialog.dialog');
  await expect(dlg).toContainText('no trash');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(ctxFile(margin, 'old abstract.txt'))).toBe(true);
  await item(page, 'old abstract.txt').getByRole('button', { name: 'Delete' }).click();
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(item(page, 'old abstract.txt')).toHaveCount(0);
  expect(fs.existsSync(ctxFile(margin, 'old abstract.txt'))).toBe(false);
  await expect(page.locator('#context-count')).toHaveText('5');

  // the view is remembered across a reload
  await page.reload();
  await expect(page.locator('#context .cx-item')).toHaveCount(5);
  await expect(page.locator('[data-rail="context"]')).toHaveClass(/\bon\b/);

  // none of it is in the file tree or in git
  await expect(page.locator('#tree')).not.toContainText('.review');
  expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: margin.paper }).toString()).toBe('');
});

test('the editor still turns a dropped image into a figure while the Context view is open', async ({ page, margin }) => {
  await page.locator('[data-rail="context"]').click(); // each test has a fresh browser page
  await expect(page.locator('#context')).toBeVisible();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const dt = await page.evaluateHandle((b64) => {
    const d = new DataTransfer();
    d.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'ctx-fig.png', { type: 'image/png' }));
    return d;
  }, png.toString('base64'));
  await page.locator('#editor .cm-content').click();
  await page.dispatchEvent('#editor', 'drop', { dataTransfer: dt });
  await expect.poll(() => fs.existsSync(path.join(margin.paper, 'figures', 'ctx-fig.png'))).toBe(true);
  await expect(page.locator('#editor .cm-content')).toContainText('{figures/ctx-fig.png}');
  expect(fs.existsSync(ctxFile(margin, 'ctx-fig.png'))).toBe(false);

  // a file dragged over a place that takes no drops (the PDF, the top bar) is held there, so the
  // browser cannot replace Margin with it; the Context view still takes it
  const over = (sel) => page.evaluate((s) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.md', { type: 'text/markdown' }));
    const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector(s).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, sel);
  expect(await over('#pdf-scroll')).toBe(true);
  expect(await over('.topbar')).toBe(true);
  await expect(page.locator('#context')).not.toHaveClass(/drop-over/);
  expect(await over('#context .cx-list')).toBe(true);
  await expect(page.locator('#context')).toHaveClass(/drop-over/);
});

test('dark mode and a 1280×480 split screen: the rail switch and the cards fit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'split');
  await page.emulateMedia({ colorScheme: 'dark' });
  const rail = page.locator('#review');
  const railBox = await rail.boundingBox();
  // all three views can be reached, inside the rail, in either view
  for (const view of ['review', 'context']) {
    await page.locator(`[data-rail="${view}"]`).click();
    for (const b of ['review', 'response', 'context']) {
      const box = await page.locator(`[data-rail="${b}"]`).boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(railBox.x + railBox.width);
    }
  }
  await expect(page.locator('#review [data-scope="all"]')).toBeHidden();
  const first = page.locator('.cx-item').first();
  const del = await first.getByRole('button', { name: 'Delete' }).boundingBox();
  expect(del.x + del.width).toBeLessThanOrEqual(railBox.x + railBox.width);
  const overflow = await page.locator('.cx-list').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // dark tokens apply: the cards are not the light theme's white
  expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'light' });
});
