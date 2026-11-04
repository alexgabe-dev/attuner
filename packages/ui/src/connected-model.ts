import type { Manifest, ConflictEntry, VariantDecision, jobStates } from '@attuner/sync-protocol';
export type { Manifest, ConflictEntry, VariantDecision };
export type Head = { snapshotId: string | null; revision: number; manifestHash: string | null };
export type ReadRequest =
  | { view: 'profiles' }
  | { view: 'head' | 'devices'; profile: string }
  | { view: 'snapshots' | 'jobs' | 'activity'; profile: string; before?: number }
  | { view: 'snapshot'; profile: string; snapshot: string }
  | { view: 'conflicts'; profile: string; job: string; offset?: number }
  | { view: 'proposals'; profile: string; job: string }
  | { view: 'preview'; profile: string; snapshot: string; root: string; path: string };
export function readPath(request: ReadRequest): string {
  if (request.view === 'profiles') return '/api/v1/profiles';
  const base = `/api/v1/profiles/${encodeURIComponent(request.profile)}`;
  if (request.view === 'snapshot')
    return `${base}/snapshots/${encodeURIComponent(request.snapshot)}`;
  if (request.view === 'preview')
    return `${base}/snapshots/${encodeURIComponent(request.snapshot)}/preview?${new URLSearchParams({ root: request.root, path: request.path })}`;
  if (request.view === 'conflicts' || request.view === 'proposals')
    return `${base}/jobs/${encodeURIComponent(request.job)}/${request.view}${request.view === 'conflicts' ? `?offset=${request.offset ?? 0}` : ''}`;
  return `${base}/${request.view}${'before' in request && request.before !== undefined ? `?before=${request.before}` : ''}`;
}
export type Profile = { id: string; name: string; role?: string; permission?: string };
export type Device = {
  id: string;
  name: string;
  os: string;
  clientVersion: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  acknowledgedRevision: number | null;
  owned: number;
};
export type Snapshot = {
  id: string;
  revision: number;
  parentId: string | null;
  manifestHash: string;
  added: number;
  modified: number;
  removed: number;
  transferredBytes: number;
  createdAt: number;
  sourceDeviceId: string;
};
export type Report = {
  id: string;
  cursor: number;
  deviceId: string;
  deviceName: string;
  revokedAt: number | null;
  state: string;
  sourceGeneration: number;
  localManifestHash: string;
  candidateManifestHash: string | null;
  remoteHead: Head | null;
  publishedHead: Head | null;
  receivedAt: number;
  reason: string | null;
  plannedBytes: number;
  transferredBytes: number;
  pendingProposals: number;
};
export type Audit = {
  id: number;
  type: string;
  createdAt: number;
  actorKind: string;
  actorId: string;
  outcome: string;
  payload: Record<string, unknown>;
};
export type ConflictReview = {
  jobId: string;
  sourceGeneration: number;
  localManifestHash: string;
  remoteHead: Head;
  conflicts: ConflictEntry[];
  total: number;
  nextOffset: number | null;
};
export type Proposal = {
  id: string;
  username: string;
  candidateManifestHash: string;
  sourceGeneration: number;
  createdAt: number;
  decisions: VariantDecision[];
};
export type LocalJob = {
  id: string;
  state: string;
  generation: number;
  reason: string | null;
  digest: string | null;
  publishedHead: Head | null;
  remoteHead: Head | null;
  localFiles: number | null;
  candidateFiles: number | null;
  changeCount: number;
  changes: { root: string; path: string; kind: string }[];
  conflicts: ConflictEntry[];
  conflictTotal: number;
  publicationChangeCount: number;
  publicationChanges: { root: string; path: string; kind: string }[];
  resumeState: string | null;
};
export type LocalInspection = {
  jobs: LocalJob[];
  snapshots: { id: number; files: number }[];
  operations: { id: number; state: string; error: string | null }[];
  pendingAcknowledgements: number;
};
export type NativeStatus = {
  busy: boolean;
  localSupported: boolean;
  connection?: { origin: string; ca: string; serverId: string };
  device?: { enrolled: boolean; deviceId: string | null; enrollmentPending: boolean };
  fixtures?: { id: string; profileId: string; adapterVersion: number }[];
  progress?: {
    phase: string;
    index?: number;
    path?: string;
    transfer?: { completedBytes: number; totalBytes: number; reusedBytes: number };
  };
  error?: string;
};
export type NativeBridge = {
  diagnostics?(): Promise<import('./diagnostics').DiagnosticReport>;
  exportDiagnostics?(): Promise<{ saved: boolean; revealed: boolean }>;
  status(): Promise<NativeStatus>;
  connect(origin: string, ca: string): Promise<unknown>;
  enroll(name: string): Promise<unknown>;
  finish(): Promise<unknown>;
  disconnect(forgetOnly: boolean): Promise<unknown>;
  dashboard(): Promise<unknown>;
  cancel(): Promise<unknown>;
  local<T>(request: Record<string, unknown>): Promise<T>;
};
export type ConnectedController = {
  read<T>(request: ReadRequest): Promise<T>;
  session?(): Promise<{ user: { username: string } }>;
  login?(username: string, password: string): Promise<unknown>;
  write?<T>(path: string, body: unknown, key?: string): Promise<T>;
  native?: NativeBridge;
};
export const stateLabels: Record<(typeof jobStates)[number], string> = {
  ready: 'Ready',
  capturing: 'Capturing files',
  offline: 'Waiting for connection',
  fetching: 'Reading remote revision',
  comparing: 'Comparing changes',
  bootstrapReview: 'Initial setup review',
  conflictReview: 'Conflicts to review',
  awaitingApproval: 'Ready for publication',
  transferring: 'Transferring content',
  publishing: 'Publishing revision',
  remoteCommitted: 'Published · application pending',
  applying: 'Applying locally',
  acknowledgementPending: 'Applied · receipt pending',
  revoked: 'Device access revoked',
  complete: 'Synchronized',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
  recoveryRequired: 'Recovery required',
};
export const stateLabel = (state: string) =>
  stateLabels[state as keyof typeof stateLabels] ?? state;
export const terminal = (state: string) => ['complete', 'failed', 'cancelled'].includes(state);
export function bytes(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1048576).toFixed(1)} MiB`;
}

const operationLabels: Record<string, string> = {
  discover: 'Inspecting synthetic installation',
  scanEntry: 'Scanning files',
  hashChunk: 'Reading original bytes',
  scanValidated: 'Scan verified',
  backupChunk: 'Backing up files',
  backupVerified: 'Backup verified',
  backupReused: 'Verifying saved content',
  backupEncode: 'Saving new content',
  backupFlush: 'Securing backups',
  backupObjectVerify: 'Verifying backups',
  captureScan: 'Rechecking captured files',
  captureDatabase: 'Saving snapshot',
  stageChunk: 'Staging verified content',
  prepared: 'Recovery prepared',
  intent: 'Applying reviewed changes',
  evacuated: 'Preserving original files',
  installed: 'Installing verified content',
  stepDurable: 'Saving recovery progress',
  beforeVerification: 'Verifying applied files',
  beforeCommit: 'Committing local revision',
  committed: 'Local revision saved',
  recoveryIntent: 'Preparing recovery',
  recoveryEvacuated: 'Preserving recovery files',
  recoveryInstalled: 'Restoring original files',
  recovered: 'Recovery complete',
  transfer: 'Transferring verified content',
};
export const progressLabel = (value: string) =>
  operationLabels[value] ?? (value.includes(' ') ? value : 'Working');
