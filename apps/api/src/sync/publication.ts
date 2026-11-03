import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Manifest } from '@attuner/sync-protocol';
import { Security, type Device, type User } from '../security/service.ts';
import { ApiError } from '../security/primitives.ts';
import { BlobStorage } from './storage.ts';
const prefix = '/api/v1/profiles/:profileId';
const profile = (r: FastifyRequest) => z.object({ profileId: z.uuid() }).parse(r.params).profileId;
const page = z.object({
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
type Candidate = {
  id: string;
  device_id: string;
  profile_id: string;
  expected_head: string | null;
  base_snapshot_id: string | null;
  candidate_manifest: string;
  policy_version: number;
  state: string;
  expires_at: number;
  expected_revision: number;
  expected_hash: string | null;
  manifest_hash: string;
  committed_snapshot_id: string | null;
};
type Snapshot = { snapshotId: string; revision: number; manifestHash: string };
export function publicationRoutes(app: FastifyInstance, security: Security, storage: BlobStorage) {
  async function reader(request: FastifyRequest, reply: FastifyReply): Promise<User | Device> {
    const actor = request.headers.authorization
      ? await security.device(request, reply)
      : await security.user(request);
    await security.member(actor, profile(request));
    return actor;
  }
  async function result(snapshotId: string, profileId: string) {
    const rows = await security.db.query<Snapshot>(
      'SELECT id AS snapshotId,revision,manifest_hash AS manifestHash FROM snapshots WHERE id=? AND profile_id=?',
      [snapshotId, profileId],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Snapshot not found.');
    return rows[0];
  }
  app.get(prefix + '/head', async (request, reply) => {
    await reader(request, reply);
    const rows = await security.db.query<{
      snapshotId: string | null;
      revision: number;
      manifestHash: string | null;
      policyVersion: number;
      roots: string;
    }>(
      'SELECT p.head_snapshot_id AS snapshotId,coalesce(s.revision,0) AS revision,s.manifest_hash AS manifestHash,p.policy_version AS policyVersion,pp.roots FROM profiles p JOIN profile_policies pp ON pp.profile_id=p.id LEFT JOIN snapshots s ON s.id=p.head_snapshot_id WHERE p.id=?',
      [profile(request)],
    );
    const head = rows[0]!;
    return {
      head: {
        snapshotId: head.snapshotId,
        revision: head.revision,
        manifestHash: head.manifestHash,
      },
      policyVersion: head.policyVersion,
      namespaceVersion: 1,
      roots: JSON.parse(head.roots),
    };
  });
  app.get(prefix + '/snapshots', async (request, reply) => {
    await reader(request, reply);
    const query = page.parse(request.query),
      rows = await security.db.query(
        'SELECT id,revision,parent_id AS parentId,source_device_id AS sourceDeviceId,manifest_hash AS manifestHash,added,modified,removed,transferred_bytes AS transferredBytes,created_at AS createdAt FROM snapshots WHERE profile_id=? AND revision<? ORDER BY revision DESC LIMIT 200',
        [profile(request), query.before ?? Number.MAX_SAFE_INTEGER],
      );
    return {
      snapshots: rows,
      nextBefore: rows.length === 200 ? rows[rows.length - 1]!.revision : null,
    };
  });
  app.get(prefix + '/snapshots/:snapshotId', async (request, reply) => {
    await reader(request, reply);
    const profileId = profile(request),
      snapshotId = z.uuid().parse((request.params as { snapshotId: string }).snapshotId),
      snapshot = await result(snapshotId, profileId);
    const profiles = await security.db.query<{ policy_version: number }>(
      'SELECT policy_version FROM profiles WHERE id=?',
      [profileId],
    );
    // Snapshot policy is immutable in its canonical manifest's originating session.
    const policies = await security.db.query<{ policy_version: number }>(
      'SELECT s.policy_version FROM sync_sessions s JOIN publication_details d ON d.session_id=s.id WHERE d.committed_snapshot_id=?',
      [snapshotId],
    );
    const files = await security.db.query<Manifest['files'][number]>(
      'SELECT root,path,hash,size,consistency_group AS "group" FROM snapshot_files WHERE snapshot_id=? ORDER BY root,path',
      [snapshotId],
    );
    return {
      ...snapshot,
      manifest: {
        protocolVersion: 1,
        profileId,
        policyVersion: policies[0]?.policy_version ?? profiles[0]!.policy_version,
        files,
      },
    };
  });
  app.get(prefix + '/activity', async (request, reply) => {
    await reader(request, reply);
    const query = page.parse(request.query),
      rows = await security.db.query<{ id: number; payload: string }>(
        'SELECT e.id,e.type,e.created_at AS createdAt,e.payload,d.actor_kind AS actorKind,d.actor_id AS actorId,d.outcome,d.job_id AS jobId FROM audit_events e JOIN audit_details d ON d.event_id=e.id WHERE e.profile_id=? AND e.id<? ORDER BY e.id DESC LIMIT 200',
        [profile(request), query.before ?? Number.MAX_SAFE_INTEGER],
      );
    return {
      events: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      nextBefore: rows.length === 200 ? rows[rows.length - 1]!.id : null,
    };
  });
  app.post(
    prefix + '/sessions/:sessionId/commit',
    {
      onRequest: async (request, reply) => {
        request.syncDevice = await security.device(request, reply);
        await security.member(request.syncDevice, profile(request), true);
        const release = storage.lease();
        reply.raw.once('finish', release);
        reply.raw.once('close', release);
      },
    },
    async (request) => {
      z.strictObject({ approve: z.literal(true) }).parse(request.body);
      const profileId = profile(request),
        d = request.syncDevice!,
        sessionId = z.uuid().parse((request.params as { sessionId: string }).sessionId);
      async function candidate() {
        const rows = await security.db.query<Candidate>(
          'SELECT s.*,p.expected_revision,p.expected_hash,p.manifest_hash,p.committed_snapshot_id FROM sync_sessions s JOIN publication_details p ON p.session_id=s.id WHERE s.id=? AND s.profile_id=? AND s.device_id=?',
          [sessionId, profileId, d.id],
        );
        if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Session not found.');
        return rows[0];
      }
      const s = await candidate();
      if (s.state === 'committed' && s.committed_snapshot_id) {
        await security.db.transaction([
          ...security.deviceGuard(d, profileId, true),
          ...security.auditStatements(
            { kind: 'device', id: d.id },
            'publication.retried',
            request.id,
            profileId,
            { sessionId },
          ),
        ]);
        return result(s.committed_snapshot_id, profileId);
      }
      if (s.state !== 'open' || s.expires_at <= security.now())
        throw new ApiError(409, 'TRANSFER_CLOSED', 'Session is closed.');
      if (s.expected_revision >= Number.MAX_SAFE_INTEGER - 1)
        throw new ApiError(409, 'REVISION_EXHAUSTED', 'Profile revisions are exhausted.');
      const manifest = JSON.parse(s.candidate_manifest) as Manifest,
        unique = new Map(manifest.files.map((f) => [f.hash, f.size]));
      for (const [hash, size] of unique) {
        const pinned = await security.db.query(
          "SELECT 1 FROM profile_blobs WHERE profile_id=? AND hash=? AND size=? AND state='verified'",
          [profileId, hash, size],
        );
        if (!pinned.length)
          throw new ApiError(409, 'BLOBS_MISSING', 'Upload and verify all required content.');
        await storage.verify(profileId, hash, size);
      }
      const prior = s.expected_head
        ? await security.db.query<{ root: string; path: string; hash: string }>(
            'SELECT root,path,hash FROM snapshot_files WHERE snapshot_id=?',
            [s.expected_head],
          )
        : [];
      const before = new Map(prior.map((f) => [f.root + '\0' + f.path, f.hash]));
      let added = 0,
        modified = 0;
      for (const f of manifest.files) {
        const key = f.root + '\0' + f.path,
          old = before.get(key);
        if (old === undefined) added++;
        else if (old !== f.hash) modified++;
        before.delete(key);
      }
      const removed = before.size,
        snapshotId = randomUUID(),
        revision = s.expected_revision + 1;
      const published = { snapshotId, revision, manifestHash: s.manifest_hash };
      try {
        await security.db.transaction([
          ...security.deviceGuard(d, profileId, true),
          {
            sql: "SELECT 1 FROM sync_sessions s JOIN profiles p ON p.id=s.profile_id JOIN profile_policies pp ON pp.profile_id=p.id WHERE s.id=? AND s.state='open' AND s.expires_at>? AND s.policy_version=p.policy_version AND pp.namespace_version=1",
            params: [s.id, security.now()],
            expect: 1,
            code: 'TRANSFER_CLOSED',
          },
          {
            sql: 'SELECT 1 FROM profiles p LEFT JOIN snapshots h ON h.id=p.head_snapshot_id WHERE p.id=? AND p.head_snapshot_id IS ? AND p.next_revision=? AND h.manifest_hash IS ?',
            params: [profileId, s.expected_head, revision, s.expected_hash],
            expect: 1,
            code: 'HEAD_MOVED',
          },
          {
            sql: "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM json_each((SELECT candidate_manifest FROM sync_sessions WHERE id=?),'$.files') f LEFT JOIN profile_blobs b ON b.profile_id=? AND b.hash=json_extract(f.value,'$.hash') AND b.size=json_extract(f.value,'$.size') AND b.state='verified' WHERE b.hash IS NULL)",
            params: [s.id, profileId],
            expect: 1,
            code: 'BLOBS_MISSING',
          },
          {
            sql: "INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,coalesce((SELECT sum(size) FROM upload_sessions WHERE session_id=? AND state='verified'),0),?)",
            params: [
              snapshotId,
              profileId,
              s.expected_head,
              revision,
              d.id,
              s.manifest_hash,
              added,
              modified,
              removed,
              s.id,
              security.now(),
            ],
          },
          {
            sql: "INSERT INTO snapshot_files SELECT ?,json_extract(value,'$.root'),json_extract(value,'$.path'),json_extract(value,'$.hash'),json_extract(value,'$.size'),json_extract(value,'$.group') FROM json_each((SELECT candidate_manifest FROM sync_sessions WHERE id=?),'$.files')",
            params: [snapshotId, s.id],
          },
          {
            sql: 'INSERT INTO snapshot_seals VALUES(?,?,?,1,?)',
            params: [
              snapshotId,
              manifest.files.length,
              manifest.files.reduce((sum, f) => sum + f.size, 0),
              security.now(),
            ],
          },
          {
            sql: 'UPDATE profiles SET head_snapshot_id=?,next_revision=? WHERE id=?',
            params: [snapshotId, revision + 1, profileId],
          },
          {
            sql: 'UPDATE publication_details SET committed_snapshot_id=? WHERE session_id=? AND committed_snapshot_id IS NULL',
            params: [snapshotId, s.id],
            expect: 1,
            code: 'SESSION_COMMITTED',
          },
          {
            sql: "UPDATE sync_sessions SET state='committed' WHERE id=? AND state='open'",
            params: [s.id],
            expect: 1,
            code: 'SESSION_COMMITTED',
          },
          {
            sql: "INSERT INTO file_changes SELECT lower(hex(randomblob(16))),?,?,f.root,f.path,CASE WHEN old.hash IS NULL THEN 'add' ELSE 'modify' END,old.hash,f.hash FROM snapshot_files f LEFT JOIN snapshot_files old ON old.snapshot_id=? AND old.root=f.root AND old.path=f.path WHERE f.snapshot_id=? AND (old.hash IS NULL OR old.hash!=f.hash)",
            params: [s.id, snapshotId, s.expected_head, snapshotId],
          },
          {
            sql: "INSERT INTO file_changes SELECT lower(hex(randomblob(16))),?,?,old.root,old.path,'delete',old.hash,NULL FROM snapshot_files old LEFT JOIN snapshot_files f ON f.snapshot_id=? AND f.root=old.root AND f.path=old.path WHERE old.snapshot_id=? AND f.hash IS NULL",
            params: [s.id, snapshotId, snapshotId, s.expected_head],
          },
          ...security.auditStatements(
            { kind: 'device', id: d.id },
            'snapshot.published',
            request.id,
            profileId,
            { ...published, added, modified, removed },
            'success',
            s.id,
          ),
        ]);
      } catch (error) {
        const current = await candidate();
        if (current.state === 'committed' && current.committed_snapshot_id)
          return result(current.committed_snapshot_id, profileId);
        throw error;
      }
      return published;
    },
  );
  app.post(prefix + '/acknowledgements', async (request, reply) => {
    const d = await security.device(request, reply),
      profileId = profile(request);
    await security.member(d, profileId);
    const body = z
      .strictObject({ snapshotId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.body);
    const snapshot = await result(body.snapshotId, profileId);
    if (snapshot.manifestHash !== body.manifestHash)
      throw new ApiError(400, 'MANIFEST_HASH_MISMATCH', 'Acknowledgement identity did not match.');
    await security.db.transaction([
      ...security.deviceGuard(d, profileId),
      {
        sql: 'SELECT 1 FROM device_profiles d LEFT JOIN snapshots old ON old.id=d.acknowledged_snapshot_id WHERE d.device_id=? AND d.profile_id=? AND coalesce(old.revision,0)<=?',
        params: [d.id, profileId, snapshot.revision],
        expect: 1,
        code: 'ACK_REGRESSION',
      },
      {
        sql: "UPDATE device_profiles SET acknowledged_snapshot_id=?,state='active',pending_changes=0 WHERE device_id=? AND profile_id=?",
        params: [snapshot.snapshotId, d.id, profileId],
        expect: 1,
        code: 'NOT_FOUND',
      },
      ...security.auditStatements(
        { kind: 'device', id: d.id },
        'snapshot.acknowledged',
        request.id,
        profileId,
        { snapshotId: snapshot.snapshotId, revision: snapshot.revision },
      ),
    ]);
    return { acknowledged: true, ...snapshot };
  });
}
