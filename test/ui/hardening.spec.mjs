import { test, expect } from './fixtures.mjs';

// A browser that blocks site storage (some private modes, strict cookie settings) throws on any
// localStorage access. Margin keeps only conveniences there, so the paper must still open.
test.describe('storage blocked', () => {
  test.use({ page: async ({ browser, margin }, use) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  } });

  test('the paper still opens and the review toggle still works', async ({ page, margin }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(margin.baseURL + '/');
    await expect(page.locator('#current-file')).not.toHaveText('');
    await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
    await page.locator('#btn-review').click();
    await expect(page.locator('#review')).toHaveClass(/collapsed/);
    expect(errors).toEqual([]);
  });
});

// Clickjacking: no other site may put a paper page in a frame (the hub already refuses).
test('paper pages refuse to be framed by other sites', async ({ margin }) => {
  const res = await fetch(margin.baseURL + '/');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
});
