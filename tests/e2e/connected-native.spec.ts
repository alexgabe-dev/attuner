import { test, expect } from '@playwright/test';
test('connected desktop keeps publication and local application as separate reviewed actions', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop-shell',
    'Native bridge rendering contract only. Real I/O has separate Rust and packaged-app qualification.',
  );
  await page.addInitScript(() => {
    const profile = '22222222-2222-4222-8222-222222222222',
      fixture = '33333333-3333-4333-8333-333333333333';
    let created = false,
      state = '',
      published = false,
      applied = false,
      acknowledged = false;
    const changes = [
      { root: 'account', path: 'SavedVariables/Synthetic.lua', kind: 'added' },
      { root: 'addons', path: 'Fixture/Fixture.toc', kind: 'added' },
      { root: 'addons', path: 'Fixture/Fixture.lua', kind: 'added' },
    ];
    const job = () => ({
      id: '44444444-4444-4444-8444-444444444444',
      state,
      generation: 3,
      reason: null,
      digest: 'a'.repeat(64),
      publishedHead: published
        ? {
            snapshotId: '55555555-5555-4555-8555-555555555555',
            revision: 1,
            manifestHash: 'b'.repeat(64),
          }
        : null,
      remoteHead: { snapshotId: null, revision: 0, manifestHash: null },
      localFiles: 3,
      candidateFiles: state === 'bootstrapReview' ? null : 3,
      changeCount: 0,
      changes: [],
      publicationChangeCount: 3,
      publicationChanges: changes,
      conflicts: [],
      conflictTotal: 0,
      resumeState: null,
    });
    const inspection = () => ({
      jobs: state && !acknowledged ? [job()] : [],
      snapshots: [],
      operations: [],
      pendingAcknowledgements: applied && !acknowledged ? 1 : 0,
    });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { request?: Record<string, unknown> }) => {
          if (command === 'get_app_info') return { version: 'test', mode: 'local-fixture-engine' };
          if (command === 'sync_status')
            return {
              busy: false,
              localSupported: true,
              device: { enrolled: true, deviceId: 'fixture-device', enrollmentPending: false },
              fixtures: created ? [{ id: fixture, profileId: profile, adapterVersion: 1 }] : [],
            };
          const request = args?.request;
          if (command === 'sync_remote') {
            if (request?.view === 'profiles')
              return { profiles: [{ id: profile, name: 'Bridge contract fixture' }] };
            if (request?.view === 'head')
              return {
                head: { snapshotId: null, revision: published ? 1 : 0, manifestHash: null },
              };
            return { devices: [], snapshots: [], jobs: [], events: [], nextBefore: null };
          }
          if (command === 'sync_local') {
            if (request?.action === 'create') {
              if ('fixture' in request)
                throw new Error('Create must not carry an existing fixture ID');
              created = true;
            }
            if (request?.action === 'prepare') state = 'bootstrapReview';
            if (request?.action === 'bootstrap') state = 'awaitingApproval';
            if (request?.action === 'publish') {
              if (request.digest !== 'a'.repeat(64)) throw new Error('Review identity missing');
              published = true;
              state = 'remoteCommitted';
            }
            if (request?.action === 'apply') {
              if (!published || request.digest !== 'a'.repeat(64))
                throw new Error('Separate reviewed apply required');
              applied = true;
              state = 'acknowledgementPending';
            }
            if (request?.action === 'acknowledge') {
              acknowledged = true;
              state = 'complete';
            }
            return inspection();
          }
          throw new Error('Unexpected test bridge command');
        },
      },
      __attunerQualificationApplied: () => applied,
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Compare changes', exact: true }).click();
  await page.getByRole('button', { name: 'Use this device’s setup', exact: true }).click();
  await page.getByRole('button', { name: 'Review & publish', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('account/SavedVariables/Synthetic.lua');
  await expect(dialog).toContainText('Published changes');
  await dialog.getByRole('button', { name: 'Approve publication', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Review local application', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __attunerQualificationApplied: () => boolean }
      ).__attunerQualificationApplied(),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Review local application', exact: true }).click();
  await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __attunerQualificationApplied: () => boolean }
      ).__attunerQualificationApplied(),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Review local application', exact: true }).click();
  await dialog.getByRole('button', { name: 'Approve local application', exact: true }).click();
  await expect(page.getByText('Applied · receipt pending', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Send receipt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compare changes', exact: true })).toBeEnabled();
});
