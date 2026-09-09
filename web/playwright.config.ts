import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  webServer: {
    command: 'npm run dev -- --strictPort',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: 'pipe',
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium' },
    },
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
});
