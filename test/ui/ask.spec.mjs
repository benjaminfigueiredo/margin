import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, rest } from './fixtures.mjs';

// "Ask Claude" on a selection and the split-screen layout. The specs share one paper and run in order.
test.describe.configure({ mode: 'serial' });

const editorText = (page) => page.locator('#editor .cm-content');

// Drag across a phrase in the editor, as the author would.
async function select(page, phrase) {
  await expect(editorText(page)).toContainText(phrase);
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
  }, phrase);
  expect(rect).not.toBeNull();
  await page.mouse.move(rect.x0, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.x1, rect.y, { steps: 5 });
  await page.mouse.up();
}

// Claude's side, through the same MCP endpoint a Claude Code session uses.
async function claude(margin) {
  const client = new Client({ name: 'claude-code', version: 'test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${margin.baseURL}/mcp`)));
  return { call: (name, args = {}) => client.callTool({ name, arguments: args }), close: () => client.close() };
}

// Fully inside the window and not covered by anything else.
async function expectUsable(page, selector) {
  const loc = page.locator(selector).first();
  await expect(loc, selector).toBeVisible();
  const ok = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) return `outside the window: ${JSON.stringify(r)}`;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? true : `covered by ${hit?.outerHTML.slice(0, 80)}`;
  });
  expect(ok, selector).toBe(true);
}

test('Ask Claude on a selection: waiting, picked up by Claude, answered with a linked suggestion', async ({ page, margin }) => {
  await page.locator('#tree').getByText('methods.tex', { exact: true }).click();
  await expect(page.locator('#current-file')).toHaveText('sections/methods.tex');
  await expect(page.locator('#btn-ask')).toBeDisabled();
  await expect(page.locator('#claude-status')).toContainText('Claude not connected yet');

  const phrase = 'held for 72 hours';
  await select(page, phrase);
  await expect(page.locator('#btn-ask')).toBeEnabled();
  await page.locator('#btn-ask').click();
  const box = page.locator('#ask-box');
  await expect(box).toBeVisible();
  await expect(box.locator('.quote')).toHaveText(phrase);
  await box.getByRole('button', { name: 'Concise' }).click();
  await expect(box.locator('textarea')).toHaveValue('Make this more concise.');
  await box.locator('textarea').fill('Why 72 hours? Justify it or suggest a citation.');
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/review/comment'));
  await box.locator('textarea').press('ControlOrMeta+Enter');
  const ask = await (await posted).json();
  expect(ask.ask).toBe(true);
  await expect(box).toBeHidden();
  await expect(page.locator('.toast.claude')).toContainText('/margin');

  const card = page.locator(`#cards .card[data-id="${ask.id}"]`);
  await expect(card.locator('.kind')).toContainText('Ask Claude');
  await expect(card.locator('.ask-state')).toHaveClass(/waiting/);
  await expect(card.locator('.ask-state')).toContainText('Waiting for Claude');
  await expect(page.locator('#claude-status')).toContainText('1 ask waiting');
  await expect(page.locator('#editor .cm-comment.ask')).toHaveText(phrase);

  // The author sends any prompt in their Claude terminal: the hook hands the ask over.
  const delivered = await rest(margin, '/asks/deliver', { method: 'POST', body: {} });
  expect(delivered.text).toContain('Why 72 hours?');
  await expect(card.locator('.ask-state')).toContainText('Claude is on it');
  await expect(page.locator('#claude-status')).toContainText('Claude active just now');
  await expect(page.locator('#claude-status')).not.toContainText('waiting');

  // Claude answers: a suggestion linked to the ask, and a reply on the thread.
  const c = await claude(margin);
  await c.call('suggest_edit', { file: 'sections/methods.tex', original: phrase, replacement: 'held for 72 hours, the median duration of recent events in the region,', rationale: 'Justifies the duration.', ask: ask.id });
  await c.call('reply', { id: ask.id, text: 'Suggested a justification; I can add a citation if you want one.' });
  await c.close();
  await expect(card.locator('.ask-state')).toContainText('Claude answered');
  await expect(card.locator('.reply.claude')).toContainText('Suggested a justification');
  const link = card.locator('.ask-link');
  await expect(link).toHaveText(/suggested edit · line \d+/);

  // The links go both ways and move the focus.
  const sugg = page.locator('#cards .card.suggestion');
  await expect(sugg.locator('.ask-link')).toContainText('Why 72 hours?');
  await link.click();
  await expect(sugg).toHaveClass(/active/);
  await sugg.locator('.ask-link').click();
  await expect(card).toHaveClass(/active/);

  // Resolving closes the ask.
  await card.getByRole('button', { name: 'Resolve' }).click();
  await expect(card).toHaveCount(0);
});

test('Ask Claude has a keyboard shortcut that leaves the editor\'s own keys alone', async ({ page }) => {
  await page.locator('#tree').getByText('methods.tex', { exact: true }).click();
  await select(page, 'Adult');
  await page.keyboard.press('ControlOrMeta+Alt+a');
  await expect(page.locator('#ask-box')).toBeVisible();
  await expect(page.locator('#ask-box .quote')).toHaveText('Adult');
  await expect(page.locator('#ask-box textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ask-box')).toBeHidden();
  // Opening it with the review pane hidden brings the pane back.
  await page.locator('#btn-review').click();
  await expect(page.locator('#review')).toHaveClass(/collapsed/);
  await select(page, 'Adult');
  await page.keyboard.press('ControlOrMeta+Alt+a');
  await expect(page.locator('#ask-box')).toBeVisible();
  await page.locator('#ask-box .cancel').click();
});

test('split screen: a short window switches automatically and keeps every control in view', async ({ page, margin }) => {
  await rest(margin, '/review/comment', { method: 'POST', body: { file: 'main.tex', quote: 'Marine heatwaves are becoming more', comment: 'Shorter?', ask: true } });
  await page.setViewportSize({ width: 1400, height: 550 });
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-layout', 'split');
  await expect(page.locator('#outline')).toHaveClass(/collapsed/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1400);

  for (const sel of ['#btn-compile', '#btn-compile-menu', '#btn-logs', '#btn-review', '#btn-sync', '#btn-settings',
    '#btn-ask', '#btn-comment', '#btn-forward', '#zoom-in', '#zoom-fit', '#tree .tree-item', '#cards .card', '#claude-status', '#wc-btn', '#editor .cm-scroller', '#pdf-scroll']) {
    await expectUsable(page, sel);
  }
  // The PDF and the editor keep most of the height.
  const pdf = await page.locator('#pdf-scroll').boundingBox();
  const ed = await page.locator('#editor').boundingBox();
  expect(pdf.height).toBeGreaterThan(550 - 100);
  expect(ed.height).toBeGreaterThan(550 - 100);

  // The composer fits, with its send button in view.
  await select(page, 'Marine heatwaves');
  await page.locator('#btn-ask').click();
  await expectUsable(page, '#ask-box .submit');
  await expectUsable(page, '#ask-box textarea');
  await page.locator('#ask-box .cancel').click();

  // The settings popover fits too, and Standard overrides Auto (remembered across a reload).
  await page.locator('#btn-settings').click();
  await expectUsable(page, '[data-layout-choice="split"]');
  await expect(page.locator('[data-layout-choice="auto"]')).toHaveClass(/\bon\b/);
  await page.locator('[data-layout-choice="standard"]').click();
  await expect(html).toHaveAttribute('data-layout', 'standard');
  await expect(page.locator('#outline')).not.toHaveClass(/collapsed/);
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect(html).toHaveAttribute('data-layout', 'standard');

  // A tall window stays standard on Auto, and Split screen can be chosen there too.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.locator('#btn-settings').click();
  await page.locator('[data-layout-choice="auto"]').click();
  await expect(html).toHaveAttribute('data-layout', 'standard');
  await page.setViewportSize({ width: 1500, height: 600 });
  await expect(html).toHaveAttribute('data-layout', 'split');
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect(html).toHaveAttribute('data-layout', 'standard');
  await expect(page.locator('#settings-menu')).toBeVisible(); // still open from the Auto click
  await page.locator('[data-layout-choice="split"]').click();
  await expect(html).toHaveAttribute('data-layout', 'split');
  const topbar = await page.locator('.topbar').boundingBox();
  expect(topbar.height).toBeLessThan(40);
});

test('split screen in the dark theme: ask cards and the composer stay readable', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 550 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await page.locator('[data-scope="all"]').click();
  const state = page.locator('#cards .ask-state').first();
  await expect(state).toBeVisible();
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const color = await state.locator('.ask-label').evaluate((el) => getComputedStyle(el).color);
  const bg = await page.locator('#cards .card').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lum(bg)).toBeLessThan(0.05);
  expect(contrast(color, bg)).toBeGreaterThan(4.5);
  const btn = page.locator('#btn-ask');
  const btnContrast = async () => contrast(await btn.evaluate((el) => getComputedStyle(el).color), await btn.evaluate((el) => getComputedStyle(el).backgroundColor));
  expect(await btnContrast()).toBeGreaterThan(4.5);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await btnContrast()).toBeGreaterThan(4.5);
});
