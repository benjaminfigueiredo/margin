import { defineConfig, devices } from '@playwright/test';

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
