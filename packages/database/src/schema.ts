import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  check,
  foreignKey,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
const id = () => text('id').primaryKey();
const created = () => integer('created_at').notNull();
export const devices = sqliteTable('devices', {
  id: id(),
  name: text('name').notNull(),
  os: text('os').notNull(),
  clientVersion: text('client_version').notNull(),
  createdAt: created(),
  revokedAt: integer('revoked_at'),
});
export const profiles = sqliteTable(
  'profiles',
  {
    id: id(),
    name: text('name').notNull(),
    adapter: text('adapter').notNull(),
    policyVersion: integer('policy_version').notNull().default(1),
    headSnapshotId: text('head_snapshot_id'),
    nextRevision: integer('next_revision').notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    check('positive_profile_revision', sql`${t.nextRevision} > 0 AND ${t.policyVersion} > 0`),
    foreignKey({
      columns: [t.id, t.headSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
  ],
);
export const blobs = sqliteTable(
  'blobs',
  {
    hash: text('hash').primaryKey(),
    size: integer('size').notNull(),
    state: text('state', { enum: ['verified'] }).notNull(),
    createdAt: created(),
  },
  (t) => [
    check('blob_hash', sql`length(${t.hash}) = 64 AND ${t.hash} NOT GLOB '*[^a-f0-9]*'`),
    check('blob_size', sql`${t.size} >= 0`),
    check('blob_verified', sql`${t.state} = 'verified'`),
  ],
);
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: id(),
    profileId: text('profile_id')
      .notNull()
      .references((): AnySQLiteColumn => profiles.id),
    parentId: text('parent_id'),
    revision: integer('revision').notNull(),
    sourceDeviceId: text('source_device_id').references(() => devices.id),
    manifestHash: text('manifest_hash').notNull(),
    added: integer('added').notNull().default(0),
    modified: integer('modified').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    transferredBytes: integer('transferred_bytes').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('snapshot_revision').on(t.profileId, t.revision),
    uniqueIndex('snapshot_profile_id').on(t.profileId, t.id),
    check('positive_revision', sql`${t.revision} > 0`),
    foreignKey({ columns: [t.profileId, t.parentId], foreignColumns: [t.profileId, t.id] }),
  ],
);
export const snapshotFiles = sqliteTable(
  'snapshot_files',
  {
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => snapshots.id),
    root: text('root').notNull(),
    path: text('path').notNull(),
    hash: text('hash')
      .notNull()
      .references(() => blobs.hash),
    size: integer('size').notNull(),
    group: text('consistency_group').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotId, t.root, t.path] }),
    check('snapshot_file_size', sql`${t.size} >= 0`),
  ],
);
export const deviceProfiles = sqliteTable(
  'device_profiles',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    profileId: text('profile_id')
      .notNull()
      .references((): AnySQLiteColumn => profiles.id),
    acknowledgedSnapshotId: text('acknowledged_snapshot_id'),
    policyVersion: integer('policy_version').notNull(),
    pendingChanges: integer('pending_changes').notNull().default(0),
    state: text('state').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.profileId] }),
    foreignKey({
      columns: [t.profileId, t.acknowledgedSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
  ],
);
export const syncSessions = sqliteTable(
  'sync_sessions',
  {
    id: id(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    profileId: text('profile_id')
      .notNull()
      .references((): AnySQLiteColumn => profiles.id),
    expectedHead: text('expected_head'),
    baseSnapshotId: text('base_snapshot_id'),
    candidateManifest: text('candidate_manifest', { mode: 'json' }),
    policyVersion: integer('policy_version').notNull(),
    state: text('state').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('session_idempotency').on(t.deviceId, t.idempotencyKey),
    foreignKey({
      columns: [t.profileId, t.expectedHead],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
    foreignKey({
      columns: [t.profileId, t.baseSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
  ],
);
export const fileChanges = sqliteTable(
  'file_changes',
  {
    id: id(),
    sessionId: text('session_id').references(() => syncSessions.id),
    snapshotId: text('snapshot_id').references(() => snapshots.id),
    root: text('root').notNull(),
    path: text('path').notNull(),
    kind: text('kind', { enum: ['add', 'modify', 'delete'] }).notNull(),
    beforeHash: text('before_hash').references(() => blobs.hash),
    afterHash: text('after_hash').references(() => blobs.hash),
  },
  (t) => [
    check(
      'valid_change',
      sql`(${t.kind} = 'add' AND ${t.beforeHash} IS NULL AND ${t.afterHash} IS NOT NULL) OR (${t.kind} = 'delete' AND ${t.beforeHash} IS NOT NULL AND ${t.afterHash} IS NULL) OR (${t.kind} = 'modify' AND ${t.beforeHash} IS NOT NULL AND ${t.afterHash} IS NOT NULL AND ${t.beforeHash} != ${t.afterHash})`,
    ),
  ],
);
export const conflicts = sqliteTable(
  'conflicts',
  {
    id: id(),
    profileId: text('profile_id')
      .notNull()
      .references((): AnySQLiteColumn => profiles.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => syncSessions.id),
    baseSnapshotId: text('base_snapshot_id'),
    headSnapshotId: text('head_snapshot_id').notNull(),
    state: text('state', { enum: ['open', 'resolved'] }).notNull(),
    resolutionSnapshotId: text('resolution_snapshot_id'),
    createdAt: created(),
  },
  (t) => [
    index('conflict_profile_state').on(t.profileId, t.state),
    foreignKey({
      columns: [t.profileId, t.baseSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
    foreignKey({
      columns: [t.profileId, t.headSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
    foreignKey({
      columns: [t.profileId, t.resolutionSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
  ],
);
export const conflictFiles = sqliteTable(
  'conflict_files',
  {
    conflictId: text('conflict_id')
      .notNull()
      .references(() => conflicts.id),
    root: text('root').notNull(),
    path: text('path').notNull(),
    baseHash: text('base_hash').references(() => blobs.hash),
    localHash: text('local_hash').references(() => blobs.hash),
    remoteHash: text('remote_hash').references(() => blobs.hash),
  },
  (t) => [primaryKey({ columns: [t.conflictId, t.root, t.path] })],
);
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: text('profile_id').references((): AnySQLiteColumn => profiles.id),
    deviceId: text('device_id').references(() => devices.id),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: created(),
  },
  (t) => [index('audit_profile_cursor').on(t.profileId, t.id)],
);
export const deviceHeartbeats = sqliteTable(
  'device_heartbeats',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    receivedAt: integer('received_at').notNull(),
    engineState: text('engine_state').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.receivedAt] })],
);
export const deviceCredentials = sqliteTable('device_credentials', {
  id: id(),
  deviceId: text('device_id')
    .notNull()
    .references(() => devices.id),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
  createdAt: created(),
});
export const pairingRequests = sqliteTable('pairing_requests', {
  id: id(),
  deviceName: text('device_name').notNull(),
  codeHash: text('code_hash').notNull().unique(),
  state: text('state').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: integer('expires_at').notNull(),
  createdAt: created(),
});
export const webUsers = sqliteTable('web_users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: created(),
});
export const webSessions = sqliteTable('web_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => webUsers.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: created(),
});
export const restoreRequests = sqliteTable(
  'restore_requests',
  {
    id: id(),
    profileId: text('profile_id')
      .notNull()
      .references((): AnySQLiteColumn => profiles.id),
    snapshotId: text('snapshot_id').notNull(),
    expectedHead: text('expected_head'),
    state: text('state').notNull(),
    scope: text('scope', { mode: 'json' }).notNull(),
    resultingSnapshotId: text('resulting_snapshot_id'),
    createdAt: created(),
  },
  (t) => [
    foreignKey({
      columns: [t.profileId, t.snapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
    foreignKey({
      columns: [t.profileId, t.expectedHead],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
    foreignKey({
      columns: [t.profileId, t.resultingSnapshotId],
      foreignColumns: [snapshots.profileId, snapshots.id],
    }),
  ],
);
export const sessionBlobs = sqliteTable(
  'session_blobs',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => syncSessions.id),
    hash: text('hash')
      .notNull()
      .references(() => blobs.hash),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.hash] })],
);

// Phase 3 ownership and publication records. Existing immutable rows are retained.
export const profileMembers = sqliteTable(
  'profile_members',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id),
    userId: text('user_id')
      .notNull()
      .references(() => webUsers.id),
    role: text('role', { enum: ['owner', 'writer', 'reader'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.userId] }),
    check('member_role', sql`${t.role} IN ('owner','writer','reader')`),
  ],
);
export const deviceOwners = sqliteTable('device_owners', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id),
  userId: text('user_id')
    .notNull()
    .references(() => webUsers.id),
});
export const profilePolicies = sqliteTable(
  'profile_policies',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id),
    roots: text('roots', { mode: 'json' }).notNull(),
    namespaceVersion: integer('namespace_version').notNull().default(1),
    quotaBytes: integer('quota_bytes').notNull().default(10737418240),
  },
  (t) => [
    check('namespace_v1', sql`${t.namespaceVersion}=1`),
    check('positive_quota', sql`${t.quotaBytes}>0`),
  ],
);
export const profileBlobs = sqliteTable(
  'profile_blobs',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id),
    hash: text('hash')
      .notNull()
      .references(() => blobs.hash),
    size: integer('size').notNull(),
    state: text('state', { enum: ['verified', 'quarantined'] }).notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.hash] }),
    check('profile_blob_size', sql`${t.size}>=0 AND ${t.size}<=1073741824`),
    check('profile_blob_state', sql`${t.state} IN ('verified','quarantined')`),
  ],
);
export const snapshotSeals = sqliteTable('snapshot_seals', {
  snapshotId: text('snapshot_id')
    .primaryKey()
    .references(() => snapshots.id),
  fileCount: integer('file_count').notNull(),
  bytes: integer('bytes').notNull(),
  namespaceVersion: integer('namespace_version').notNull().default(1),
  createdAt: created(),
});
export const publicationDetails = sqliteTable('publication_details', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => syncSessions.id),
  expectedRevision: integer('expected_revision').notNull(),
  expectedHash: text('expected_hash'),
  manifestHash: text('manifest_hash').notNull(),
  payloadHash: text('payload_hash').notNull(),
  committedSnapshotId: text('committed_snapshot_id').references(() => snapshots.id),
});
export const uploadSessions = sqliteTable(
  'upload_sessions',
  {
    id: id(),
    sessionId: text('session_id')
      .notNull()
      .references(() => syncSessions.id),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    hash: text('hash').notNull(),
    size: integer('size').notNull(),
    state: text('state').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('session_upload_hash').on(t.sessionId, t.hash),
    check('upload_size', sql`${t.size}>=0 AND ${t.size}<=1073741824`),
    check('upload_hash', sql`length(${t.hash})=64 AND ${t.hash} NOT GLOB '*[^a-f0-9]*'`),
    check('upload_state', sql`${t.state} IN ('open','verifying','verified','cancelled','failed')`),
  ],
);
export const uploadChunks = sqliteTable(
  'upload_chunks',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => uploadSessions.id),
    position: integer('position').notNull(),
    size: integer('size').notNull(),
    hash: text('hash').notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.uploadId, t.position] }),
    check(
      'chunk_bounds',
      sql`${t.position}>=0 AND ${t.position}<256 AND ${t.size}>0 AND ${t.size}<=4194304`,
    ),
  ],
);
export const requestReceipts = sqliteTable(
  'request_receipts',
  {
    principal: text('principal').notNull(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    result: text('result', { mode: 'json' }).notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.principal, t.scope, t.key] })],
);
export const auditDetails = sqliteTable('audit_details', {
  eventId: integer('event_id')
    .primaryKey()
    .references(() => auditEvents.id),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  requestId: text('request_id').notNull(),
  jobId: text('job_id'),
  outcome: text('outcome').notNull(),
});
export const serverSettings = sqliteTable('server_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const userSecurity = sqliteTable(
  'user_security',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => webUsers.id),
    role: text('role').notNull(),
    disabledAt: integer('disabled_at'),
    epoch: integer('epoch').notNull().default(1),
  },
  (t) => [check('user_role', sql`${t.role} IN ('administrator','user')`)],
);
export const webSessionSecurity = sqliteTable('web_session_security', {
  tokenHash: text('token_hash')
    .primaryKey()
    .references(() => webSessions.tokenHash),
  csrfHash: text('csrf_hash').notNull(),
  epoch: integer('epoch').notNull(),
  authenticatedAt: integer('authenticated_at').notNull(),
});
export const deviceKeys = sqliteTable('device_keys', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id),
  thumbprint: text('thumbprint').notNull().unique(),
  jwk: text('jwk', { mode: 'json' }).notNull(),
  createdAt: created(),
});
export const enrollments = sqliteTable(
  'enrollments',
  {
    id: id(),
    thumbprint: text('thumbprint').notNull(),
    jwk: text('jwk', { mode: 'json' }).notNull(),
    challenge: text('challenge').notNull(),
    clientState: text('client_state').notNull(),
    deviceName: text('device_name').notNull(),
    os: text('os').notNull(),
    clientVersion: text('client_version').notNull(),
    state: text('state').notNull(),
    userId: text('user_id').references(() => webUsers.id),
    profileIds: text('profile_ids', { mode: 'json' }),
    codeHash: text('code_hash').unique(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [check('enrollment_state', sql`${t.state} IN ('pending','approved','denied','redeemed')`)],
);
export const credentialSecurity = sqliteTable(
  'credential_security',
  {
    credentialId: text('credential_id')
      .primaryKey()
      .references(() => deviceCredentials.id),
    kind: text('kind').notNull(),
    thumbprint: text('thumbprint').notNull(),
    familyId: text('family_id').notNull(),
    familyExpiresAt: integer('family_expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [
    index('credential_family').on(t.familyId),
    check('credential_kind', sql`${t.kind} IN ('access','refresh')`),
  ],
);
export const tokenDeliveries = sqliteTable('token_deliveries', {
  key: text('key').primaryKey(),
  principal: text('principal').notNull(),
  payloadHash: text('payload_hash').notNull(),
  familyId: text('family_id').notNull(),
  deviceId: text('device_id')
    .notNull()
    .references(() => devices.id),
  ciphertext: text('ciphertext').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: created(),
});
export const proofNonces = sqliteTable(
  'proof_nonces',
  {
    hash: text('hash').primaryKey(),
    thumbprint: text('thumbprint').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('nonce_key').on(t.thumbprint)],
);
export const proofReplays = sqliteTable(
  'proof_replays',
  {
    thumbprint: text('thumbprint').notNull(),
    jti: text('jti').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.thumbprint, t.jti] })],
);
export const deviceProfileScopes = sqliteTable(
  'device_profile_scopes',
  {
    deviceId: text('device_id').notNull(),
    profileId: text('profile_id').notNull(),
    permission: text('permission').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.profileId] }),
    foreignKey({
      columns: [t.deviceId, t.profileId],
      foreignColumns: [deviceProfiles.deviceId, deviceProfiles.profileId],
    }),
    check('device_permission', sql`${t.permission} IN ('read','write')`),
  ],
);
export const enrollmentDecisions = sqliteTable('enrollment_decisions', {
  enrollmentId: text('enrollment_id')
    .primaryKey()
    .references(() => enrollments.id),
  userId: text('user_id')
    .notNull()
    .references(() => webUsers.id),
  payloadHash: text('payload_hash').notNull(),
  ciphertext: text('ciphertext').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const profileBlobChunks = sqliteTable(
  'profile_blob_chunks',
  {
    profileId: text('profile_id').notNull(),
    hash: text('hash').notNull(),
    position: integer('position').notNull(),
    size: integer('size').notNull(),
    chunkHash: text('chunk_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.hash, t.position] }),
    foreignKey({
      columns: [t.profileId, t.hash],
      foreignColumns: [profileBlobs.profileId, profileBlobs.hash],
    }),
    check(
      'verified_chunk_bounds',
      sql`${t.position}>=0 AND ${t.position}<256 AND ${t.size}>0 AND ${t.size}<=4194304`,
    ),
    check(
      'verified_chunk_hash',
      sql`length(${t.chunkHash})=64 AND ${t.chunkHash} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
