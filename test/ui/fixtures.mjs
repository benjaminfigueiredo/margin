// Playwright fixtures: a throwaway Margin server on a copy of examples/sample-paper.
// One paper (and server) per spec file, shared by the tests in that file, which therefore run serially.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/app.js';
import { freePort } from '../free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-ui-'));
  const paper = path.join(tmp, 'paper');
  fs.cpSync(path.join(here, '..', '..', 'examples', 'sample-paper'), paper, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: paper, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'init');
  const port = await freePort();
  const running = await startServer({ root: paper, port });
  return { tmp, paper, baseURL: `http://127.0.0.1:${port}`, running };
}

export const test = base.extend({
  // Worker-scoped registry, so servers are torn down even if a spec file fails midway.
  _servers: [async ({}, use) => {
    const byFile = new Map();
    await use(byFile);
    for (const s of byFile.values()) {
      await s.running.close();
      fs.rmSync(s.tmp, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],

  margin: async ({ _servers }, use, testInfo) => {
    if (!_servers.has(testInfo.file)) _servers.set(testInfo.file, await launch());
    const s = _servers.get(testInfo.file);
    await use({ baseURL: s.baseURL, paper: s.paper });
  },

  // Opens the UI and waits until it has booted (main file loaded, WebSocket connected).
  page: async ({ page, margin }, use) => {
    await page.goto(margin.baseURL + '/');
    await expect(page.locator('#current-file')).not.toHaveText('');
    await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
    await use(page);
  },
});

export { expect };

export const readDisk = (margin, rel) => fs.readFileSync(path.join(margin.paper, rel), 'utf8');

export async function rest(margin, apiPath, { method = 'GET', body } = {}) {
  const res = await fetch(`${margin.baseURL}/api${apiPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
