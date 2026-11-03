import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function navigate(page: Page, name: string) {
  await expect(page.locator('.app-shell')).toBeVisible();
  const sidebar = page.locator('aside.sidebar');
  const openNavigation = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (
    (await openNavigation.isVisible()) &&
    !((await sidebar.getAttribute('class')) ?? '').includes('sidebar-open')
  )
    await openNavigation.click();
  await sidebar.getByRole('link', { name, exact: true }).click();
}
test('all views navigate, keep the fixture label and fit the viewport', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  for (const [link, heading] of [
    ['Activity', 'Activity'],
    ['Snapshots', 'Snapshots'],
    ['Diff Explorer', 'Diff Explorer'],
    ['Conflicts', 'Conflicts'],
    ['Addons 132', 'Addons'],
    ['Devices 2', 'Devices'],
    ['Settings', 'Settings'],
    ['Overview', 'Overview'],
  ]) {
    await navigate(page, link!);
    await expect(
      page.getByRole('heading', { name: heading!, exact: true, level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  await expect(page.getByText('Interactive preview', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test('five scenarios have honest distinct status and conflicts survive navigation', async ({
  page,
}) => {
  await page.goto('/');
  for (const [scenario, title] of [
    ['pending', 'A few changes to bring along.'],
    ['offline', 'Your MacBook is taking a break.'],
    ['error', 'Your files are safe. Let’s try again.'],
    ['conflict', 'Two changes. One decision.'],
    ['synchronized', 'Everything is in tune.'],
  ]) {
    await page.getByLabel('Demo scenario', { exact: true }).selectOption(scenario!);
    await expect(page.getByRole('heading', { name: title!, exact: true })).toBeVisible();
  }
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('conflict');
  await page.getByRole('button', { name: 'Review conflict', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'WeakAuras.lua', exact: true })).toBeVisible();
  await expect(page.getByText('Version preserved', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Resolve in demo', exact: true }).click();
  await page.getByRole('radio', { name: /MacBook Pro/ }).check();
  await page.getByRole('button', { name: 'Use selected in demo' }).click();
  await expect(
    page.getByRole('heading', { name: 'A decision made. Both versions kept.' }),
  ).toBeVisible();
  await navigate(page, 'Overview');
  await expect(page.getByRole('heading', { name: 'Everything is in tune.' })).toBeVisible();
});
test('activity filtering, empty recovery and detail dialogs work', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Activity');
  await page.getByLabel('Filter by device').selectOption('MacBook Pro');
  await expect(page.getByText('2 events', { exact: true })).toBeVisible();
  await page.getByLabel('Search activity').fill('not-a-real-addon');
  await expect(page.getByRole('heading', { name: 'No matching activity' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('6 events', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /WeakAuras configuration updated/ }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'WTF/Account/DEMO/SavedVariables/WeakAuras.lua',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('snapshot selection controls comparison and restore is explicitly read-only', async ({
  page,
}) => {
  await page.goto('/');
  await navigate(page, 'Snapshots');
  await page.getByRole('checkbox', { name: 'Compare revision 4891' }).uncheck();
  await expect(page.getByRole('button', { name: 'Compare 2 revisions' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Compare revision 4890' }).check();
  await page.getByRole('button', { name: 'Compare selected' }).click();
  await expect(page.getByRole('heading', { name: 'Diff Explorer', exact: true })).toBeVisible();
  await expect(page.getByLabel('Before revision', { exact: true })).toHaveValue('4890');
  await navigate(page, 'Snapshots');
  await page.getByRole('button', { name: 'Preview restore revision 4891' }).click();
  await expect(page.getByRole('dialog')).toContainText('read-only preview');
  await expect(page.getByRole('button', { name: 'Restore · Phase 5' })).toBeDisabled();
});
test('diff files, modes, search and swap change the comparison', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Diff Explorer');
  await page.getByRole('button', { name: 'Bartender4.lua', exact: true }).click();
  await expect(page.locator('.diff-file-heading')).toContainText('Bartender4.lua');
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unified', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Search diff').fill('buttonSize');
  await expect(page.locator('.code-line')).toHaveCount(2);
  await page.getByRole('button', { name: 'Swap revisions' }).click();
  await expect(page.getByLabel('Before revision', { exact: true })).toHaveValue('4892');
  await page.getByLabel('Search diff').fill('');
  await page.getByLabel('After revision', { exact: true }).selectOption('4892');
  await expect(page.getByText('No changes', { exact: true })).toBeVisible();
});
test('addon category and text filters compose', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Addons 132');
  await page.getByLabel('Filter addon category').selectOption('Combat');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByLabel('Search addons').fill('Plater');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Plater');
  await page.getByLabel('Search addons').fill('unknown');
  await expect(page.getByRole('heading', { name: 'No addons found' })).toBeVisible();
});
test('device details lead to filtered history and pairing does not mint credentials', async ({
  page,
}) => {
  await page.goto('/');
  await navigate(page, 'Devices 2');
  await page.getByRole('button', { name: /MacBook Pro.*macOS/ }).click();
  await expect(page.getByRole('dialog')).toContainText('No real credentials issued');
  await page.getByRole('button', { name: 'View device activity' }).click();
  await expect(page.getByLabel('Filter by device')).toHaveValue('MacBook Pro');
  await expect(page.getByText('2 events', { exact: true })).toBeVisible();
  await navigate(page, 'Devices 2');
  await page.getByRole('button', { name: 'Pairing preview' }).click();
  await expect(page.getByRole('dialog')).toContainText('No code or credential has been generated.');
});
test('sync progresses, cancels safely, and never invents an offline acknowledgement', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('pending');
  await page.getByRole('button', { name: 'Sync demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop demo' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await expect(page.getByRole('heading', { name: 'A few changes to bring along.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sync demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Everything is in tune.' })).toBeVisible({
    timeout: 6000,
  });
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('offline');
  await page.getByRole('button', { name: 'Sync demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your MacBook is taking a break.' })).toBeVisible({
    timeout: 6000,
  });
  await expect(page.locator('.devices-panel')).toContainText('Offline');
});
test('preferences save, discard and affect compact rendering', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
  await page.getByRole('switch', { name: /Compact activity rows/ }).check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/compact/);
  await page.getByLabel('Demo backup retention').selectOption('90 days');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Demo backup retention')).toHaveValue('30 days');
  await navigate(page, 'Overview');
  await expect(page.locator('.app-shell')).toHaveClass(/compact/);
});
test('command menu supports keyboard access and dialog focus containment', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open command menu' }).click();
  await page.getByLabel('Search commands').fill('snapshots');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Snapshots', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Snapshots', exact: true })).toBeVisible();
});
test('overview and conflict dialog meet automated WCAG checks', async ({ page }) => {
  await page.goto('/');
  let report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(report.violations).toEqual([]);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('conflict');
  await page.getByRole('button', { name: 'Review conflict', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve in demo' }).click();
  report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(report.violations).toEqual([]);
});

test('explorer views meet automated accessibility checks', async ({ page }) => {
  await page.goto('/');
  for (const name of [
    'Activity',
    'Snapshots',
    'Diff Explorer',
    'Addons 132',
    'Devices 2',
    'Settings',
  ]) {
    await navigate(page, name);
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(report.violations, `Accessibility findings on ${name}`).toEqual([]);
  }
});
