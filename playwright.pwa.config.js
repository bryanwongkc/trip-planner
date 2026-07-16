/* global process */

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/pwa',
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'pwa-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4176',
    env: { ...process.env, VITE_DISABLE_FIREBASE: 'true' },
    reuseExistingServer: true,
    timeout: 120_000,
    url: 'http://127.0.0.1:4176',
  },
})
