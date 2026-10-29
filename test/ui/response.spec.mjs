import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, readDisk, rest } from './fixtures.mjs';

// The Response view: the author pastes a report, Claude (here: the MCP tools) drafts the
// points, the author confirms stances, accepts or rejects the linked suggestions and
// downloads the letter. The report is invented for the test.
test.describe.configure({ mode: 'serial' });

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

const point = (page, label) => page.locator('.resp-point').filter({ has: page.locator('.resp-num', { hasText: label }) });

test('paste a report, confirm stances, follow the linked suggestions, export the letter', async ({ page, margin }) => {
  const call = await claude(margin);
  await page.locator('[data-rail="response"]').click();
  await expect(page.locator('#cards')).toBeHidden();
  await expect(page.locator('.resp-add')).toBeVisible(); // nothing yet: the paste box is open

  await page.locator('.resp-reviewer').fill('Reviewer 1');
  await page.locator('.resp-add textarea').fill('Invented report for the UI test.\n1. Shorten the introduction.\n2. Justify the 72 h exposure.');
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.locator('.resp-group-head strong')).toHaveText('Reviewer 1');
  await expect(page.locator('.resp-wait')).toBeVisible();

  // Claude drafts the points; they appear live, pending the author's confirmation.
  await call('update_response', { points: [
    { referee_text: 'Shorten the introduction.', stance: 'agree', reply: 'We shortened the Introduction.' },
    { referee_text: 'Justify the 72 h exposure.', stance: 'agree', reply: 'We now justify it.' },
  ] });
  await expect(page.locator('.resp-point')).toHaveCount(2);
  await expect(point(page, 'R1.1').locator('.resp-chip')).toHaveText('Pending');
  await expect(point(page, 'R1.1').locator('.resp-stance-row')).toContainText('Claude proposes');

  // The author confirms R1.1 and changes R1.2 to Clarify (which confirms it).
  await point(page, 'R1.1').getByRole('button', { name: 'Confirm' }).click();
  await expect(point(page, 'R1.1').locator('.resp-confirmed')).toBeVisible();
  await point(page, 'R1.2').locator('.resp-stance').selectOption('clarify');
  await expect(point(page, 'R1.2').locator('.resp-chip')).toHaveText('Done');

  // Claude implements R1.1; the author accepts it from the Response view.
  const file = 'sections/intro.tex';
  await call('suggest_edit', { file, original: 'it is not well known how', replacement: 'little is known about how', rationale: 'Shorter.', responds_to: 'R1.1' });
  const link = point(page, 'R1.1').locator('.resp-link');
  await expect(link).toHaveCount(1);
  await expect(link.locator('.status')).toHaveText('open');
  await link.getByRole('button', { name: '✓' }).click();
  await expect(point(page, 'R1.1').locator('.resp-chip')).toHaveText('Done');
  expect(readDisk(margin, file)).toContain('little is known about how');

  // Undo the accept, then reject: the point is flagged, prominently.
  const [item] = (await rest(margin, '/review?status=all')).filter((it) => it.file === file);
  await rest(margin, `/review/${item.id}/unaccept`, { method: 'POST', body: {} });
  await expect(point(page, 'R1.1').locator('.resp-chip')).toHaveText('Pending');
  await link.getByRole('button', { name: '✕' }).click();
  await expect(point(page, 'R1.1').locator('.resp-chip')).toHaveText('Mismatch');
  await expect(point(page, 'R1.1').locator('.resp-reason.mismatch')).toContainText('was rejected');
  await expect(page.locator('.resp-alert')).toContainText('R1.1');
  await expect(page.locator('#response-badge')).toHaveText('1');

  // Clicking a linked suggestion shows it in the editor.
  await page.locator('#tree').getByText('main.tex', { exact: true }).click();
  await link.locator('.diff').click();
  await expect(page.locator('#current-file')).toHaveText(file);

  // The author edits a reply; it is saved when the box loses focus.
  const reply = point(page, 'R1.2').locator('.resp-reply');
  await reply.fill('Seventy-two hours matches the median event duration.');
  await page.locator('.resp-bar').click();
  await expect(point(page, 'R1.2').locator('.resp-reply-head')).toContainText('edited by you');
  const saved = (await rest(margin, '/responses')).points.find((p) => p.label === 'R1.2');
  expect(saved.reply).toBe('Seventy-two hours matches the median event duration.');

  // Export: a download (after a warning about the mismatch), numbered and quoted.
  page.once('dialog', (d) => { expect(d.message()).toContain('mismatch'); d.accept(); });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '.md' }).click()]);
  expect(download.suggestedFilename()).toBe('response-to-reviewers.md');
  const md = fs.readFileSync(await download.path(), 'utf8');
  expect(md).toContain('### Comment 1.1\n\n> Shorten the introduction.\n\n**Response.** We shortened the Introduction.');
  expect(md).toContain('### Comment 1.2\n\n> Justify the 72 h exposure.\n\n**Response.** Seventy-two hours');

  // The view is remembered; the Review view comes back with its cards.
  await page.reload();
  await expect(page.locator('.resp-point')).toHaveCount(2);
  await page.locator('[data-rail="review"]').click();
  await expect(page.locator('#cards')).toBeVisible();
  await expect(page.locator('#response')).toBeHidden();
});
