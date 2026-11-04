import { it, expect } from 'vitest';
import { webDiagnostics } from './diagnostics';
it('exports only allowlisted metadata even when the input contains sensitive strings', () => {
  const injected = {
    connected: true,
    busy: false,
    profiles: 1,
    devices: 3,
    snapshots: 2,
    jobs: 1,
    conflicts: 1,
    password: 'must-not-export-password',
    cookie: 'must-not-export-cookie',
    origin: 'https://private.invalid',
    path: '/private/installation',
    error: 'private config bytes',
    manifest: { files: ['secret.lua'] },
  };
  const report = webDiagnostics(injected);
  const text = JSON.stringify(report);
  for (const value of [
    'must-not-export',
    'private.invalid',
    '/private/installation',
    'private config bytes',
    'secret.lua',
  ])
    expect(text).not.toContain(value);
  expect(report.counts).toEqual({
    loadedProfiles: 1,
    loadedDevices: 3,
    loadedSnapshots: 2,
    loadedJobs: 1,
    loadedConflictReports: 1,
  });
  expect(report.system).toBeNull();
  expect(report.safety.windowsFilesystemApplyEnabled).toBe(false);
});
it('rejects invalid or unbounded counts instead of serializing arbitrary values', () => {
  const result = webDiagnostics({
    connected: true,
    busy: false,
    profiles: Infinity,
    devices: -1,
    snapshots: 100001,
    jobs: NaN,
    conflicts: 'private-string' as unknown as number,
  });
  expect(Object.values(result.counts)).toEqual([0, 0, 0, 0, 0]);
});
