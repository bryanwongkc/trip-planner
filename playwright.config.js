/* global process */

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175',
    env: { ...process.env, VITE_DISABLE_FIREBASE: 'true' },
    reuseExistingServer: true,
    timeout: 120_000,
    url: 'http://127.0.0.1:4175',
  },
})
