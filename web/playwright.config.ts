import { defineConfig, devices } from '@playwright/test';
const deployedUrl = process.env.PLAYWRIGHT_BASE_URL;
/*
  Невыкаченный веб против стенда (`scripts/stand-dev.mjs`): браузер открывает имя стенда, но страница
  приходит с dev-сервера этого каталога, а ядро, SFU и службы — настоящие. Без переменной — как всегда.
*/
const standDev = process.env.CORD_STAND_DEV;
const standArgs =
  standDev && deployedUrl
    ? [
        `--host-resolver-rules=MAP ${new URL(deployedUrl).hostname}:443 ${standDev}`,
        '--ignore-certificate-errors',
      ]
    : [];
export default defineConfig({
  testDir: './e2e',
  // Все сценарии, кроме знакомства, — от лица уже знакомого человека (E13, `e2e/global-setup.ts`).
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  webServer: deployedUrl
    ? undefined
    : {
        command: 'npm run dev -- --strictPort',
        url: 'http://127.0.0.1:5173/',
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
        stdout: 'pipe',
      },
  use: {
    baseURL: deployedUrl ?? 'http://localhost:5173',
    storageState: '.local/e2e/returning.json',
    // Сценарии читают русский текст. Язык браузера выбирается сам из переведённых (E14-B), а
    // Playwright по умолчанию — en-US: без этой строки e2e увидели бы английский интерфейс.
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        ...standArgs,
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
