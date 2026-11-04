import { version } from '../package.json';
export type DiagnosticReport = {
  schemaVersion: 1;
  applicationVersion: string;
  protocolVersion: number;
  namespaceVersion: number;
  surface: 'web' | 'desktop';
  system: { os: string; architecture: string } | null;
  connectionConfigured: boolean;
  deviceEnrolled: boolean | null;
  enrollmentPending: boolean | null;
  busy: boolean;
  counts: Record<string, number>;
  safety: {
    realInstallationsEnabled: false;
    automaticSynchronizationEnabled: false;
    windowsFilesystemApplyEnabled: false;
    experimentalPacksEnabled: false;
  };
};
/** Allowlist by construction: no names, identifiers, origin, paths, errors,
 * manifests, certificates, cookies, credentials, user agent or browser storage. */
export function webDiagnostics(input: {
  connected: boolean;
  busy: boolean;
  profiles: number;
  devices: number;
  snapshots: number;
  jobs: number;
  conflicts: number;
}): DiagnosticReport {
  const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 && n <= 100000 ? n : 0);
  return {
    schemaVersion: 1,
    applicationVersion: version,
    protocolVersion: 1,
    namespaceVersion: 1,
    surface: 'web',
    system: null,
    connectionConfigured: input.connected === true,
    deviceEnrolled: null,
    enrollmentPending: null,
    busy: input.busy === true,
    counts: {
      loadedProfiles: count(input.profiles),
      loadedDevices: count(input.devices),
      loadedSnapshots: count(input.snapshots),
      loadedJobs: count(input.jobs),
      loadedConflictReports: count(input.conflicts),
    },
    safety: {
      realInstallationsEnabled: false,
      automaticSynchronizationEnabled: false,
      windowsFilesystemApplyEnabled: false,
      experimentalPacksEnabled: false,
    },
  };
}
