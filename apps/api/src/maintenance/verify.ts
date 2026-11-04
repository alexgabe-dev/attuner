import { createHash } from 'node:crypto';
import { openDatabase, openMaintenanceDatabase } from '@attuner/database';
import { manifestDigest, validatePublicationManifest, type Manifest } from '@attuner/sync-protocol';
import { z } from 'zod';

export type MaintenanceDatabase = ReturnType<typeof openMaintenanceDatabase>;
export type VerificationSummary = {
  serverId: string;
  schemaHash: string;
  snapshots: number;
  profiles: number;
  headsDigest: string;
  auditCount: number;
  auditMax: number;
  auditDigest: string;
};
export function schemaDigest(database: MaintenanceDatabase): string {
  const hash = createHash('sha256');
  for (const row of database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .iterate())
    hash.update(JSON.stringify(row) + '\n');
  return hash.digest('hex');
}
let expectedSchema: string | undefined;
function knownSchema() {
  if (!expectedSchema) {
    const reference = openDatabase();
    try {
      expectedSchema = schemaDigest(reference.sqlite);
    } finally {
      reference.close();
    }
  }
  return expectedSchema;
}
export function assertKnownSchema(database: MaintenanceDatabase) {
  if (schemaDigest(database) !== knownSchema()) throw new Error('MAINTENANCE_UNSUPPORTED_SCHEMA');
}
export function appendMaintenanceAudit(
  database: MaintenanceDatabase,
  type: string,
  operationId: string,
  payload: Record<string, unknown> = {},
) {
  const append = database.transaction(() => {
    const event = database
      .prepare(
        'INSERT INTO audit_events(profile_id,device_id,type,payload,created_at) VALUES(NULL,NULL,?,?,?)',
      )
      .run(type, JSON.stringify({ operationId, ...payload }), Math.floor(Date.now() / 1000));
    database
      .prepare(
        "INSERT INTO audit_details VALUES(?,'operator','local-maintenance',?,NULL,'success')",
      )
      .run(event.lastInsertRowid, operationId);
  });
  // Nested transactions become savepoints when an outer capture lock is held.
  append.immediate();
}

export async function verifyDatabase(database: MaintenanceDatabase): Promise<VerificationSummary> {
  if (
    database.pragma('quick_check', { simple: true }) !== 'ok' ||
    (database.pragma('foreign_key_check') as unknown[]).length
  )
    throw new Error('MAINTENANCE_DATABASE_INTEGRITY');
  const schemaHash = schemaDigest(database);
  if (schemaHash !== knownSchema()) throw new Error('MAINTENANCE_UNSUPPORTED_SCHEMA');
  const setting = database
    .prepare("SELECT value FROM server_settings WHERE key='server_id'")
    .get() as { value?: string } | undefined;
  const serverId = z.uuid().parse(setting?.value);
  if (
    database
      .prepare(
        'SELECT 1 FROM audit_events e LEFT JOIN audit_details d ON d.event_id=e.id WHERE d.event_id IS NULL OR length(e.payload)>1048576 OR NOT json_valid(e.payload) LIMIT 1',
      )
      .get()
  )
    throw new Error('MAINTENANCE_AUDIT_INTEGRITY');
  const audit = createHash('sha256');
  let auditCount = 0,
    auditMax = 0;
  for (const row of database
    .prepare(
      'SELECT e.id,e.profile_id,e.device_id,e.type,e.payload,e.created_at,d.actor_kind,d.actor_id,d.request_id,d.job_id,d.outcome FROM audit_events e JOIN audit_details d ON d.event_id=e.id ORDER BY e.id',
    )
    .iterate() as Iterable<{ id: number }>) {
    if (!Number.isSafeInteger(row.id) || row.id <= auditMax)
      throw new Error('MAINTENANCE_AUDIT_INTEGRITY');
    audit.update(JSON.stringify(row) + '\n');
    auditCount++;
    auditMax = row.id;
  }
  if (
    database
      .prepare(
        "SELECT 1 FROM snapshot_files f JOIN snapshots s ON s.id=f.snapshot_id LEFT JOIN profile_blobs b ON b.profile_id=s.profile_id AND b.hash=f.hash AND b.size=f.size AND b.state='verified' WHERE b.hash IS NULL LIMIT 1",
      )
      .get()
  )
    throw new Error('MAINTENANCE_UNVERIFIED_REFERENCE');
  const heads = createHash('sha256');
  let profiles = 0,
    snapshots = 0;
  type Profile = {
    id: string;
    head_snapshot_id: string | null;
    next_revision: number;
    policy_version: number;
    roots: string;
    namespace_version: number;
  };
  type Snapshot = {
    id: string;
    parent_id: string | null;
    revision: number;
    manifest_hash: string;
    file_count: number;
    bytes: number;
    namespace_version: number;
  };
  for (const profile of database
    .prepare(
      'SELECT p.id,p.head_snapshot_id,p.next_revision,p.policy_version,pp.roots,pp.namespace_version FROM profiles p LEFT JOIN profile_policies pp ON pp.profile_id=p.id ORDER BY p.id',
    )
    .iterate() as Iterable<Profile>) {
    z.uuid().parse(profile.id);
    if (
      profile.namespace_version !== 1 ||
      typeof profile.roots !== 'string' ||
      profile.roots.length > 256
    )
      throw new Error('MAINTENANCE_PROFILE_POLICY');
    const roots = z
      .array(z.enum(['account', 'character', 'addons']))
      .min(1)
      .max(3)
      .parse(JSON.parse(profile.roots));
    let previous: string | null = null,
      revision = 0;
    for (const snapshot of database
      .prepare(
        'SELECT s.id,s.parent_id,s.revision,s.manifest_hash,x.file_count,x.bytes,x.namespace_version FROM snapshots s LEFT JOIN snapshot_seals x ON x.snapshot_id=s.id WHERE s.profile_id=? ORDER BY s.revision',
      )
      .iterate(profile.id) as Iterable<Snapshot>) {
      z.uuid().parse(snapshot.id);
      if (
        snapshot.parent_id !== previous ||
        snapshot.revision !== revision + 1 ||
        snapshot.namespace_version !== 1 ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.file_count > 100000
      )
        throw new Error('MAINTENANCE_SNAPSHOT_CHAIN');
      const files = database
        .prepare(
          'SELECT root,path,hash,size,consistency_group AS "group" FROM snapshot_files WHERE snapshot_id=? LIMIT 100001',
        )
        .all(snapshot.id) as Manifest['files'];
      if (
        files.length !== snapshot.file_count ||
        files.reduce((sum, file) => sum + file.size, 0) !== snapshot.bytes
      )
        throw new Error('MAINTENANCE_SNAPSHOT_SEAL');
      const policies = database
        .prepare(
          'SELECT s.policy_version FROM sync_sessions s JOIN publication_details d ON d.session_id=s.id WHERE d.committed_snapshot_id=? LIMIT 2',
        )
        .all(snapshot.id) as { policy_version: number }[];
      if (policies.length > 1) throw new Error('MAINTENANCE_SNAPSHOT_PUBLICATION');
      const policyVersion = policies[0]?.policy_version ?? profile.policy_version;
      const manifest = await validatePublicationManifest(
        { protocolVersion: 1, profileId: profile.id, policyVersion, files },
        profile.id,
        roots,
        policyVersion,
      );
      if ((await manifestDigest(manifest)) !== snapshot.manifest_hash)
        throw new Error('MAINTENANCE_MANIFEST_DIGEST');
      previous = snapshot.id;
      revision = snapshot.revision;
      snapshots++;
    }
    if (profile.head_snapshot_id !== previous || profile.next_revision !== revision + 1)
      throw new Error('MAINTENANCE_PROFILE_HEAD');
    heads.update(JSON.stringify(profile) + '\n');
    profiles++;
  }
  return {
    serverId,
    schemaHash,
    snapshots,
    profiles,
    headsDigest: heads.digest('hex'),
    auditCount,
    auditMax,
    auditDigest: audit.digest('hex'),
  };
}

export type ObjectReference = { relative: string; hash: string; size: number };
export function* referencedObjects(database: MaintenanceDatabase): Generator<ObjectReference> {
  type Blob = { profile_id: string; hash: string; size: number; state: string };
  for (const row of database
    .prepare('SELECT profile_id,hash,size,state FROM profile_blobs ORDER BY profile_id,hash')
    .iterate() as Iterable<Blob>) {
    z.uuid().parse(row.profile_id);
    if (
      row.profile_id !== row.profile_id.toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(row.hash) ||
      row.state !== 'verified' ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > 1073741824
    )
      throw new Error('MAINTENANCE_OBJECT_REFERENCE');
    yield { relative: `blobs/p-${row.profile_id}/${row.hash}`, hash: row.hash, size: row.size };
  }
  type Chunk = { upload_id: string; position: number; hash: string; size: number };
  for (const row of database
    .prepare('SELECT upload_id,position,hash,size FROM upload_chunks ORDER BY upload_id,position')
    .iterate() as Iterable<Chunk>) {
    z.uuid().parse(row.upload_id);
    if (
      row.upload_id !== row.upload_id.toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(row.hash) ||
      !Number.isInteger(row.position) ||
      row.position < 0 ||
      row.position >= 256 ||
      !Number.isInteger(row.size) ||
      row.size < 1 ||
      row.size > 4194304
    )
      throw new Error('MAINTENANCE_CHUNK_REFERENCE');
    yield { relative: `blobs/u-${row.upload_id}/${row.position}`, hash: row.hash, size: row.size };
  }
}
