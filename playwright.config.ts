import { defineConfig } from '@playwright/test';
const webOrigin = process.env.ATTUNER_E2E_WEB_ORIGIN ?? 'http://127.0.0.1:3000';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ignoreHTTPSErrors: webOrigin === 'https://127.0.0.1:4318',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'web',
      use: { baseURL: webOrigin, viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'desktop-shell',
      use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1180, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        baseURL: webOrigin,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet',
      use: { baseURL: webOrigin, viewport: { width: 768, height: 1024 } },
    },
  ],
  webServer: [
    ...(process.env.ATTUNER_E2E_WEB_ORIGIN
      ? []
      : [{ command: 'pnpm dev:web', url: webOrigin, reuseExistingServer: !process.env.CI }]),
    {
      command: 'pnpm dev:desktop:browser',
      url: 'http://127.0.0.1:1420',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
