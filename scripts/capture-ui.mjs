import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch();
try {
  for (const capture of [
    { name: 'web-overview', url: 'http://127.0.0.1:3000', width: 1440, height: 1050 },
    { name: 'desktop-browser-overview', url: 'http://127.0.0.1:1420', width: 1180, height: 850 },
    { name: 'web-mobile', url: 'http://127.0.0.1:3000', width: 390, height: 844 },
    { name: 'web-diff', url: 'http://127.0.0.1:3000/diff', width: 1440, height: 950 },
    {
      name: 'web-conflict',
      url: 'http://127.0.0.1:3000/conflicts?scenario=conflict',
      width: 1440,
      height: 950,
    },
  ]) {
    const context = await browser.newContext({
      viewport: { width: capture.width, height: capture.height },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(capture.url);
    await page.locator('h1').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `artifacts/${capture.name}.png`, fullPage: true });
    console.log(`Captured ${capture.name}`);
    await context.close();
  }
} finally {
  await browser.close();
}
