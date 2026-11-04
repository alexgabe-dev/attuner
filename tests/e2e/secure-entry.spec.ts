import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('HTTP never renders account credential fields', async ({ page }, info) => {
  test.skip(
    info.project.name === 'desktop-shell' || String(info.project.use.baseURL).startsWith('https:'),
    'Native desktop credentials are handled by the Rust HTTPS client.',
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Use a secure connection', exact: true }),
  ).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  if (info.project.name === 'web')
    await page.screenshot({ path: 'artifacts/phase-3/web-https-required.png', fullPage: true });
  await expect(page.getByRole('link', { name: 'Open HTTPS workspace' })).toHaveAttribute(
    'href',
    'https://127.0.0.1:4318/',
  );
});
