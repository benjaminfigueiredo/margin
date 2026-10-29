import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

// Reloading the PDF after a compile must finish cleanly every time, not just the first. pdf.load()
// used to call destroy() on the previous document, which pdfjs-dist 6 does not have, so every reload
// after the first threw once the new PDF was on screen (and leaked the old document's worker).
// loadPdf() updates the zoom label only after load() returns, so a sentinel there shows whether it did.
test('the PDF reloads cleanly after every compile', async ({ page, margin }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('#pdf-pages .pdf-page canvas').first()).toBeVisible();
  for (let i = 1; i <= 3; i++) {
    // A recompile only writes a new PDF (and only then reloads it) when a source changed.
    fs.appendFileSync(path.join(margin.paper, 'sections', 'methods.tex'), `\n% touched ${i}\n`);
    await page.evaluate(() => { document.querySelector('#zoom-label').textContent = 'reloading'; });
    const done = page.waitForResponse((r) => r.url().endsWith('/api/compile') && r.request().method() === 'POST');
    await page.locator('#btn-compile').click();
    await done;
    await expect(page.locator('#zoom-label'), `reload ${i} finished`).not.toHaveText('reloading');
  }
  expect(errors).toEqual([]);
});
