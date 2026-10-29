import { defineConfig, devices } from '@playwright/test';

// Commits made by the server under test (Sync, pull --autostash) need a git identity. CI machines
// have none configured, so give the test run its own instead of relying on the developer's.
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Margin test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Margin test', GIT_COMMITTER_EMAIL: 'test@example.org' })) process.env[k] ??= v;

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.mjs',
  outputDir: '.playwright/results',
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 900 }, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
