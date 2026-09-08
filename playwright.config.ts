import { defineConfig, devices } from '@playwright/test'

// Playwright config for roam-platform end-to-end tests.
// Runs against the deployed URL specified in BASE_URL (defaults to production).
// Test credentials are loaded from .env — never commit real creds.

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Serial for now — tests share the same production DB.
  forbidOnly: !!process.env.CI, // Fail CI if a `.only` test slipped in.
  retries: process.env.CI ? 2 : 0, // Retry flakes on CI, not locally.
  workers: 1, // One at a time to keep DB state predictable.
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  timeout: 60_000, // 60s per test — long enough for slow API calls.

  use: {
    baseURL: process.env.BASE_URL || 'https://phc-team.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
