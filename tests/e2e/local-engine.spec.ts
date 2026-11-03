import { expect, test } from '@playwright/test';
test('desktop browser clearly disables native local access', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-shell', 'The local lab is desktop-specific.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Local engine', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Open the native app to use the local engine.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Demo scenario')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remote demo', exact: true }).click();
  await expect(page.getByLabel('Demo scenario')).toBeVisible();
});
test('local lab UI consumes the native command contract', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-shell', 'The local lab is desktop-specific.');
  // Bridge stub tests rendering only; Rust integration tests and native QA exercise real I/O.
  await page.addInitScript(() => {
    let snapshot = false;
    let scanned = false;
    let opened = false;
    let verified = false;
    const view = () => ({
      opened,
      workspacePath: '/synthetic-test-only',
      adapterVersion: 1,
      sqliteVersion: 'test-bridge',
      scanned,
      files: scanned ? 3 : 0,
      bytes: 154,
      scanMs: 1.5,
      entries: scanned
        ? [
            {
              root: 'account',
              path: 'SavedVariables/WeakAuras.lua',
              hash: 'a'.repeat(64),
              size: 72,
            },
          ]
        : [],
      changes:
        scanned && !snapshot
          ? [{ root: 'account', path: 'SavedVariables/WeakAuras.lua', kind: 'added' }]
          : [],
      changeCount: scanned && !snapshot ? 3 : 0,
      snapshots: snapshot
        ? [{ id: 1, label: 'Local fixture snapshot', files: 3, bytes: 154, createdAt: 1700000000 }]
        : [],
      verification: verified ? { files: 3, bytes: 154, verified: true } : null,
      baselineId: snapshot ? 1 : null,
    });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'get_app_info') return { version: 'test', mode: 'local-fixture-engine' };
          if (command === 'local_lab_create') opened = true;
          if (command === 'local_lab_scan') scanned = true;
          if (command === 'local_lab_snapshot') snapshot = true;
          if (command === 'local_lab_verify') verified = true;
          return view();
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Local engine', exact: true }).click();
  await page.getByRole('button', { name: 'Create fixture workspace' }).click();
  await expect(page.getByRole('button', { name: 'Capture snapshot' })).toBeDisabled();
  await page.getByRole('button', { name: 'Scan fixture files' }).click();
  await expect(page.getByRole('region', { name: 'Real fixture files' })).toContainText(
    'SavedVariables/WeakAuras.lua',
  );
  await page.getByRole('button', { name: 'Capture snapshot' }).click();
  await page.getByRole('button', { name: 'Verify backups' }).click();
  await expect(page.getByText('Backup integrity verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Snapshots · 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Real snapshot history' })).toContainText(
    'Local #1',
  );
});
