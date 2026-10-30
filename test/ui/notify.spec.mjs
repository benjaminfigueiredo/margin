// Notifications: a claude-event from the server (the Stop / Notification hooks) becomes a notify
// request to the Mac app (window.webkit.messageHandlers.margin, stubbed here), and in a browser a
// Web Notification only after the author turned them on and only while the page is in the background.
import { test, expect } from './fixtures.mjs';

const hook = (margin, body) => fetch(`${margin.baseURL}/api/claude/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
// The server coalesces events a few seconds apart; space them out instead of waiting.
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('in the Mac app, a claude-event is handed to the app, and the split button posts splitWithClaude', async ({ browser, margin }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__posted = [];
    window.webkit = { messageHandlers: { margin: { postMessage: (m) => window.__posted.push(JSON.parse(JSON.stringify(m))) } } };
  });
  const page = await context.newPage();
  await page.goto(margin.baseURL + '/');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);

  const r = await hook(margin, { event: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  expect(r.sent).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__posted.length)).toBe(1);
  expect(await page.evaluate(() => window.__posted[0])).toEqual({ type: 'notify', title: 'Claude needs you — paper', body: 'Claude needs your permission to use Bash', tag: 'claude' });
  // The browser toggle is not offered in the app (macOS settings decide there).
  await page.locator('#btn-settings').click();
  await expect(page.locator('#set-notify')).toHaveCount(0);
  await expect(page.locator('#notify-hint')).toContainText('System Settings');
  await page.keyboard.press('Escape');

  // One click: the page asks the app to put this window above Terminal running claude.
  await expect(page.locator('#btn-split-claude')).toBeVisible();
  await page.locator('#btn-split-claude').click();
  expect(await page.evaluate(() => window.__posted.at(-1))).toEqual({ type: 'splitWithClaude' });
  await context.close();
});

test('in a browser: silent unless turned on, and then only while the page is in the background', async ({ browser, margin }) => {
  await pause(5200); // past the previous test's "needs you"
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__shown = [];
    class FakeNotification {
      static permission = 'default';
      static async requestPermission() { FakeNotification.permission = 'granted'; return 'granted'; }
      constructor(title, opts) { window.__shown.push({ title, ...opts }); }
      close() {}
    }
    window.Notification = FakeNotification;
    window.__background = false;
    Object.defineProperty(document, 'visibilityState', { get: () => (window.__background ? 'hidden' : 'visible') });
    document.hasFocus = () => !window.__background;
  });
  const page = await context.newPage();
  await page.goto(margin.baseURL + '/');
  await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  await expect(page.locator('#btn-split-claude')).toBeHidden(); // only in the Mac app

  // Off (the default): nothing, even in the background, and no permission prompt on load.
  await page.evaluate(() => { window.__background = true; });
  expect((await hook(margin, { event: 'Stop', last_assistant_message: 'First turn done.' })).sent).toBe(true);
  await pause(300);
  expect(await page.evaluate(() => window.__shown.length)).toBe(0);
  expect(await page.evaluate(() => window.Notification.permission)).toBe('default');

  // Turned on in Aa: the browser asks then. In the foreground: still nothing (a toast instead).
  await page.evaluate(() => { window.__background = false; });
  await page.locator('#btn-settings').click();
  await page.locator('#set-notify').check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('margin:notify'))).toBe('1');
  expect(await page.evaluate(() => window.Notification.permission)).toBe('granted');
  await page.keyboard.press('Escape');
  await pause(5200);
  expect((await hook(margin, { event: 'Stop', last_assistant_message: 'Second turn done.' })).sent).toBe(true);
  await expect(page.locator('.toast', { hasText: 'Claude is done: Second turn done.' })).toBeVisible();
  expect(await page.evaluate(() => window.__shown.length)).toBe(0);

  // In the background: a notification.
  await page.evaluate(() => { window.__background = true; });
  await pause(5200);
  expect((await hook(margin, { event: 'Stop', last_assistant_message: 'Third turn done.' })).sent).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__shown.length)).toBe(1);
  const shown = await page.evaluate(() => window.__shown[0]);
  expect(shown.title).toBe('Claude is done — paper');
  expect(shown.body).toBe('Third turn done.');
  expect(shown.tag).toMatch(/-claude$/);
  await context.close();
});
