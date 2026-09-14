import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './qa',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  use: {
    headless: true,
    storageState: process.env.PLAYWRIGHT_STORAGE_STATE || 'qa/.auth/state.json',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
});
