import { defineConfig, devices } from '@playwright/test';

// Commits made by the server under test (Sync, pull --autostash) need a git identity. CI machines
// have none configured, so give the test run its own instead of relying on the developer's.
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Margin test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Margin test', GIT_COMMITTER_EMAIL: 'test@example.org' })) process.env[k] ??= v;

// Safari's engine (WebKit) runs only where MARGIN_PW_WEBKIT is set: the informational job in
// .github/workflows/macos-app.yml. Local runs and the Linux CI stay Chromium-only.
const projects = [{ name: 'chromium', use: { browserName: 'chromium' } }];
if (process.env.MARGIN_PW_WEBKIT) projects.push({ name: 'webkit', use: { ...devices['Desktop Safari'], browserName: 'webkit', viewport: { width: 1500, height: 900 } } });

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.mjs',
  outputDir: '.playwright/results',
  workers: 1,
  retries: 0,
  // On CI also report failures as GitHub annotations, so they show on the commit without opening logs.
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 900 }, trace: 'retain-on-failure' },
  projects,
});
