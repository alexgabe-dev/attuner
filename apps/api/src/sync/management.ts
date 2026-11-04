import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  LIMITS,
  jobReportSchema,
  proposalSchema,
  manifestDigest,
  canonicalManifest,
  validatePublicationManifest,
  compareManifests,
  resolveComparison,
  type Manifest,
  type Head,
} from '@attuner/sync-protocol';
import type { Statement } from '@attuner/database';
import { Security, type Actor, type Device, type User } from '../security/service.ts';
import { ApiError, sha } from '../security/primitives.ts';
import { BlobStorage } from './storage.ts';
declare module 'fastify' {
  interface FastifyRequest {
    managementPrincipal?: User | Device;
  }
}
const prefix = '/api/v1/profiles/:profileId';
const profile = (r: FastifyRequest) => z.object({ profileId: z.uuid() }).parse(r.params).profileId;
const jobId = (r: FastifyRequest) => z.uuid().parse((r.params as { jobId: string }).jobId);
const pagination = z.object({
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
type Report = {
  id: string;
  profile_id: string;
  device_id: string;
  source_generation: number;
  state: string;
  local_manifest: string;
  local_manifest_hash: string;
  baseline_snapshot_id: string | null;
  remote_head: string | null;
  published_head: string | null;
  session_id: string | null;
  candidate_manifest_hash: string | null;
  payload_hash: string;
  received_at: number;
};
type Proposal = {
  id: string;
  job_id: string;
  user_id: string;
  source_generation: number;
  local_manifest_hash: string;
  remote_head: string;
  decisions: string;
  candidate_manifest_hash: string;
  state: string;
  created_at: number;
};
export function managementRoutes(app: FastifyInstance, security: Security, storage: BlobStorage) {
  async function principal(request: FastifyRequest, reply: FastifyReply) {
    if (request.managementPrincipal) return request.managementPrincipal;
    const actor = request.headers.authorization
      ? await security.device(request, reply)
      : await security.user(request);
    await security.member(actor, profile(request));
    request.managementPrincipal = actor;
    return actor;
  }
  function guards(actor: Device | User, profileId: string, write = false) {
    return 'userId' in actor
      ? security.deviceGuard(actor, profileId, write)
      : [
          security.userGuard(actor),
          {
            sql: "SELECT 1 FROM profile_members WHERE user_id=? AND profile_id=? AND (?=0 OR role IN ('owner','writer'))",
            params: [actor.id, profileId, write ? 1 : 0],
            expect: 1,
            code: 'NOT_FOUND',
          },
        ];
  }
  function supersede(
    job: string,
    profileId: string,
    actor: Actor,
    requestId: string,
    before?: number,
  ): Statement[] {
    const condition =
      "job_id=? AND state='pending'" + (before === undefined ? '' : ' AND source_generation<?');
    const params = before === undefined ? [job] : [job, before];
    return [
      {
        sql: `INSERT INTO audit_events(profile_id,device_id,type,payload,created_at) SELECT ?,?,'proposal.superseded',json_object('jobId',job_id,'proposalId',id),? FROM review_proposals WHERE ${condition}`,
        params: [profileId, actor.kind === 'device' ? actor.id : null, security.now(), ...params],
      },
      {
        sql: "INSERT INTO audit_details(event_id,actor_kind,actor_id,request_id,job_id,outcome) SELECT last_insert_rowid(),?,?,?,?,'success' WHERE changes()=1",
        params: [actor.kind, actor.id, requestId, job],
      },
      { sql: `UPDATE review_proposals SET state='superseded' WHERE ${condition}`, params },
    ];
  }
  async function report(profileId: string, id: string) {
    const rows = await security.db.query<Report>(
      'SELECT * FROM device_sync_jobs WHERE id=? AND profile_id=?',
      [id, profileId],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Synchronization job not found.');
    return rows[0];
  }
  async function manifest(profileId: string, id: string, policy: number) {
    const rows = await security.db.query('SELECT 1 FROM snapshots WHERE id=? AND profile_id=?', [
      id,
      profileId,
    ]);
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Snapshot not found.');
    return {
      protocolVersion: 1 as const,
      profileId,
      policyVersion: policy,
      files: await security.db.query<Manifest['files'][number]>(
        'SELECT root,path,hash,size,consistency_group AS "group" FROM snapshot_files WHERE snapshot_id=? ORDER BY root,path',
        [id],
      ),
    };
  }
  async function comparison(row: Report) {
    if (!row.remote_head || !row.baseline_snapshot_id)
      throw new ApiError(
        409,
        'BOOTSTRAP_REQUIRED',
        'Review the initial setup on the source device.',
      );
    const local = JSON.parse(row.local_manifest) as Manifest,
      head = JSON.parse(row.remote_head) as Head;
    if (!head.snapshotId)
      throw new ApiError(409, 'REVIEW_UNAVAILABLE', 'No remote snapshot is available.');
    return {
      baseline: await manifest(row.profile_id, row.baseline_snapshot_id, local.policyVersion),
      local,
      remote: await manifest(row.profile_id, head.snapshotId, local.policyVersion),
      head,
    };
  }
  const readBounded = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      await principal(request, reply);
      const release = storage.lease();
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    },
  };
  const webBody = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await security.user(request, true);
      await security.member(user, profile(request), true);
      request.managementPrincipal = user;
      const release = storage.lease();
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    },
    bodyLimit: LIMITS.manifestBytes + 65536,
  };
  const deviceBody = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      request.syncDevice = await security.device(request, reply);
      await security.member(request.syncDevice, profile(request));
      const release = storage.lease();
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    },
    bodyLimit: LIMITS.manifestBytes + 65536,
  };
  app.put(prefix + '/jobs/:jobId', deviceBody, async (request) => {
    const profileId = profile(request),
      id = jobId(request),
      d = request.syncDevice!,
      body = jobReportSchema.parse(request.body);
    const prior = (
      await security.db.query<Report>('SELECT * FROM device_sync_jobs WHERE id=?', [id])
    )[0];
    if (prior && (prior.profile_id !== profileId || prior.device_id !== d.id))
      throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
    const policies = await security.db.query<{ roots: string; policy_version: number }>(
      'SELECT pp.roots,p.policy_version FROM profile_policies pp JOIN profiles p ON p.id=pp.profile_id WHERE p.id=?',
      [profileId],
    );
    const policy = policies[0]!;
    let local: Manifest;
    if (body.localManifest) {
      try {
        local = await validatePublicationManifest(
          body.localManifest,
          profileId,
          JSON.parse(policy.roots),
          policy.policy_version,
        );
      } catch {
        throw new ApiError(
          400,
          'UNSAFE_MANIFEST',
          'Local capture failed namespace or policy validation.',
        );
      }
      if ((await manifestDigest(local)) !== body.localManifestHash)
        throw new ApiError(400, 'MANIFEST_HASH_MISMATCH', 'Local capture identity did not match.');
    } else {
      if (!prior || prior.local_manifest_hash !== body.localManifestHash)
        throw new ApiError(428, 'MANIFEST_REQUIRED', 'Send the complete local capture.');
      local = JSON.parse(prior.local_manifest) as Manifest;
    }
    for (const head of [body.remoteHead, body.publishedHead])
      if (head?.snapshotId) {
        const scoped = await security.db.query(
          'SELECT 1 FROM snapshots WHERE profile_id=? AND id=? AND revision=? AND manifest_hash=?',
          [profileId, head.snapshotId, head.revision, head.manifestHash],
        );
        if (!scoped.length)
          throw new ApiError(404, 'NOT_FOUND', 'Snapshot identity was not found.');
      }
    if (body.sessionId) {
      const session = await security.db.query(
        'SELECT 1 FROM sync_sessions WHERE id=? AND profile_id=? AND device_id=?',
        [body.sessionId, profileId, d.id],
      );
      if (!session.length) throw new ApiError(404, 'NOT_FOUND', 'Session not found.');
    }
    if (
      body.baselineSnapshotId &&
      !(
        await security.db.query('SELECT 1 FROM snapshots WHERE id=? AND profile_id=?', [
          body.baselineSnapshotId,
          profileId,
        ])
      ).length
    )
      throw new ApiError(404, 'NOT_FOUND', 'Baseline not found.');
    const semantic = { ...body, localManifest: undefined },
      payloadHash = sha(JSON.stringify(semantic));
    if (prior && body.sourceGeneration <= prior.source_generation) {
      if (body.sourceGeneration === prior.source_generation && payloadHash === prior.payload_hash)
        return { accepted: true, sourceGeneration: prior.source_generation };
      throw new ApiError(409, 'STALE_REPORT', 'Source generation is no longer current.');
    }
    if (prior && ['complete', 'failed', 'cancelled'].includes(prior.state))
      throw new ApiError(409, 'REPORT_CLOSED', 'This source job is closed.');
    const statements = [
      ...security.deviceGuard(d, profileId),
      {
        sql: 'INSERT INTO device_sync_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_generation=excluded.source_generation,state=excluded.state,local_manifest=excluded.local_manifest,local_manifest_hash=excluded.local_manifest_hash,baseline_snapshot_id=excluded.baseline_snapshot_id,remote_head=excluded.remote_head,published_head=excluded.published_head,session_id=excluded.session_id,candidate_manifest_hash=excluded.candidate_manifest_hash,payload_hash=excluded.payload_hash,reason=excluded.reason,received_at=excluded.received_at WHERE device_id=excluded.device_id AND profile_id=excluded.profile_id AND source_generation<excluded.source_generation',
        params: [
          id,
          profileId,
          d.id,
          body.sourceGeneration,
          body.state,
          canonicalManifest(local),
          body.localManifestHash,
          body.baselineSnapshotId,
          body.remoteHead ? JSON.stringify(body.remoteHead) : null,
          body.publishedHead ? JSON.stringify(body.publishedHead) : null,
          body.sessionId,
          body.candidateManifestHash,
          payloadHash,
          body.reason,
          security.now(),
        ],
        expect: 1,
        code: 'STALE_REPORT',
      },
    ];
    if (body.validatedProposalId) {
      statements.push(
        {
          sql: 'SELECT 1 FROM review_proposals WHERE id=? AND job_id=? AND source_generation<? AND local_manifest_hash=? AND remote_head=? AND candidate_manifest_hash=?',
          params: [
            body.validatedProposalId,
            id,
            body.sourceGeneration,
            body.localManifestHash,
            body.remoteHead ? JSON.stringify(body.remoteHead) : null,
            body.candidateManifestHash,
          ],
          expect: 1,
          code: 'REVIEW_MOVED',
        },
        {
          sql: "UPDATE review_proposals SET state='validated' WHERE id=?",
          params: [body.validatedProposalId],
        },
        ...security.auditStatements(
          { kind: 'device', id: d.id },
          'proposal.validated',
          request.id,
          profileId,
          { jobId: id, proposalId: body.validatedProposalId },
        ),
      );
    }
    statements.push(
      ...supersede(id, profileId, { kind: 'device', id: d.id }, request.id, body.sourceGeneration),
      ...security.auditStatements(
        { kind: 'device', id: d.id },
        'job.reported',
        request.id,
        profileId,
        { jobId: id, sourceGeneration: body.sourceGeneration, state: body.state },
      ),
    );
    try {
      await security.db.transaction(statements);
    } catch (error) {
      const saved = (
        await security.db.query<Report>(
          'SELECT * FROM device_sync_jobs WHERE id=? AND profile_id=? AND device_id=?',
          [id, profileId, d.id],
        )
      )[0];
      if (
        !saved ||
        saved.source_generation !== body.sourceGeneration ||
        saved.payload_hash !== payloadHash
      )
        throw error;
    }
    return { accepted: true, sourceGeneration: body.sourceGeneration };
  });
  app.get(prefix + '/jobs', async (request, reply) => {
    await principal(request, reply);
    const { before } = pagination.parse(request.query),
      profileId = profile(request);
    const rows = await security.db.query<{
      cursor: number;
      remoteHead: string | null;
      publishedHead: string | null;
    }>(
      "SELECT j.rowid AS cursor,j.id,j.device_id AS deviceId,d.name AS deviceName,d.revoked_at AS revokedAt,j.source_generation AS sourceGeneration,j.state,j.local_manifest_hash AS localManifestHash,j.candidate_manifest_hash AS candidateManifestHash,j.remote_head AS remoteHead,j.published_head AS publishedHead,j.received_at AS receivedAt,j.reason,j.session_id AS sessionId,(SELECT coalesce(sum(c.size),0) FROM upload_sessions u JOIN upload_chunks c ON c.upload_id=u.id WHERE u.session_id=j.session_id) AS transferredBytes,(SELECT coalesce(sum(size),0) FROM upload_sessions WHERE session_id=j.session_id) AS plannedBytes,(SELECT count(*) FROM review_proposals WHERE job_id=j.id AND state='pending') AS pendingProposals FROM device_sync_jobs j JOIN devices d ON d.id=j.device_id WHERE j.profile_id=? AND j.rowid<? ORDER BY j.rowid DESC LIMIT 200",
      [profileId, before ?? Number.MAX_SAFE_INTEGER],
    );
    return {
      jobs: rows.map((r) => ({
        ...r,
        remoteHead: r.remoteHead ? JSON.parse(r.remoteHead) : null,
        publishedHead: r.publishedHead ? JSON.parse(r.publishedHead) : null,
      })),
      nextBefore: rows.length === 200 ? rows[rows.length - 1]!.cursor : null,
    };
  });
  app.get(prefix + '/jobs/:jobId/conflicts', readBounded, async (request, reply) => {
    await principal(request, reply);
    const row = await report(profile(request), jobId(request)),
      query = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(request.query);
    const data = await comparison(row),
      result = compareManifests(data.baseline, data.local, data.remote);
    return {
      jobId: row.id,
      sourceGeneration: row.source_generation,
      localManifestHash: row.local_manifest_hash,
      remoteHead: data.head,
      conflicts: result.conflicts.slice(query.offset, query.offset + 200),
      total: result.conflicts.length,
      nextOffset: query.offset + 200 < result.conflicts.length ? query.offset + 200 : null,
    };
  });
  app.post(prefix + '/jobs/:jobId/proposals', webBody, async (request) => {
    const u = await security.user(request, true),
      profileId = profile(request);
    await security.member(u, profileId, true);
    const row = await report(profileId, jobId(request)),
      body = proposalSchema.parse(request.body);
    const data = await comparison(row);
    if (
      row.state !== 'conflictReview' ||
      row.source_generation !== body.sourceGeneration ||
      row.local_manifest_hash !== body.localManifestHash ||
      JSON.stringify(data.head) !== JSON.stringify(body.remoteHead)
    )
      throw new ApiError(409, 'REVIEW_MOVED', 'Refresh this comparison before proposing choices.');
    let candidate: Manifest;
    try {
      candidate = resolveComparison(data.baseline, data.local, data.remote, body.decisions);
    } catch {
      throw new ApiError(
        400,
        'INVALID_DECISIONS',
        'Choose every conflict and keep addon groups consistent.',
      );
    }
    const candidateHash = await manifestDigest(candidate),
      id = randomUUID();
    await security.db.transaction([
      ...guards(u, profileId, true),
      {
        sql: "SELECT 1 FROM device_sync_jobs j JOIN devices d ON d.id=j.device_id WHERE j.id=? AND j.source_generation=? AND j.state='conflictReview' AND d.revoked_at IS NULL",
        params: [row.id, body.sourceGeneration],
        expect: 1,
        code: 'REVIEW_MOVED',
      },
      {
        sql: 'SELECT 1 FROM profiles p JOIN snapshots s ON s.id=p.head_snapshot_id WHERE p.id=? AND s.id=? AND s.revision=? AND s.manifest_hash=?',
        params: [profileId, data.head.snapshotId, data.head.revision, data.head.manifestHash],
        expect: 1,
        code: 'HEAD_MOVED',
      },
      ...supersede(row.id, profileId, { kind: 'user', id: u.id }, request.id),
      {
        sql: "INSERT INTO review_proposals VALUES(?,?,?,?,?,?,?,?,'pending',?)",
        params: [
          id,
          row.id,
          u.id,
          body.sourceGeneration,
          body.localManifestHash,
          JSON.stringify(body.remoteHead),
          JSON.stringify(body.decisions),
          candidateHash,
          security.now(),
        ],
      },
      ...security.auditStatements(
        { kind: 'user', id: u.id },
        'proposal.created',
        request.id,
        profileId,
        { jobId: row.id, proposalId: id, sourceGeneration: body.sourceGeneration },
      ),
    ]);
    return { proposalId: id, state: 'pending', candidateManifestHash: candidateHash };
  });
  app.get(prefix + '/jobs/:jobId/proposals', readBounded, async (request, reply) => {
    const actor = await principal(request, reply),
      row = await report(profile(request), jobId(request));
    if ('userId' in actor && actor.id !== row.device_id)
      throw new ApiError(404, 'NOT_FOUND', 'Source job not found.');
    const rows = await security.db.query<Proposal & { username: string }>(
      "SELECT p.*,u.username FROM review_proposals p JOIN web_users u ON u.id=p.user_id WHERE p.job_id=? AND p.state='pending' ORDER BY p.created_at DESC,p.id DESC LIMIT 1",
      [row.id],
    );
    return {
      proposals: rows.map((p) => ({
        id: p.id,
        jobId: p.job_id,
        username: p.username,
        sourceGeneration: p.source_generation,
        localManifestHash: p.local_manifest_hash,
        remoteHead: JSON.parse(p.remote_head),
        decisions: JSON.parse(p.decisions),
        candidateManifestHash: p.candidate_manifest_hash,
        state: p.state,
        createdAt: p.created_at,
      })),
    };
  });
  app.post(prefix + '/proposals/:proposalId/withdrawals', async (request) => {
    const u = await security.user(request, true),
      profileId = profile(request);
    await security.member(u, profileId, true);
    const id = z.uuid().parse((request.params as { proposalId: string }).proposalId);
    await security.db.transaction([
      ...guards(u, profileId, true),
      {
        sql: "UPDATE review_proposals SET state='withdrawn' WHERE id=? AND user_id=? AND state='pending' AND job_id IN (SELECT id FROM device_sync_jobs WHERE profile_id=?)",
        params: [id, u.id, profileId],
        expect: 1,
        code: 'REVIEW_MOVED',
      },
      ...security.auditStatements(
        { kind: 'user', id: u.id },
        'proposal.withdrawn',
        request.id,
        profileId,
        { proposalId: id },
      ),
    ]);
    return { withdrawn: true };
  });
  app.get(prefix + '/devices', async (request, reply) => {
    const actor = await principal(request, reply),
      profileId = profile(request);
    const devices = await security.db.query(
      'SELECT d.id,d.name,d.os,d.client_version AS clientVersion,d.created_at AS createdAt,d.revoked_at AS revokedAt,(SELECT max(received_at) FROM device_heartbeats WHERE device_id=d.id) AS lastSeenAt,dp.acknowledged_snapshot_id AS acknowledgedSnapshotId,s.revision AS acknowledgedRevision,CASE WHEN o.user_id=? THEN 1 ELSE 0 END AS owned FROM device_profiles dp JOIN devices d ON d.id=dp.device_id JOIN device_owners o ON o.device_id=d.id LEFT JOIN snapshots s ON s.id=dp.acknowledged_snapshot_id WHERE dp.profile_id=? ORDER BY d.created_at DESC,d.id LIMIT 200',
      ['userId' in actor ? actor.userId : actor.id, profileId],
    );
    return { devices };
  });
  app.get(prefix + '/snapshots/:snapshotId/preview', readBounded, async (request, reply) => {
    const actor = await principal(request, reply),
      profileId = profile(request),
      id = z.uuid().parse((request.params as { snapshotId: string }).snapshotId);
    const query = z
      .strictObject({
        root: z.enum(['account', 'addons', 'character']),
        path: z.string().min(1).max(1024),
      })
      .parse(request.query);
    const rows = await security.db.query<{ hash: string; size: number }>(
      "SELECT f.hash,f.size FROM snapshot_files f JOIN snapshots s ON s.id=f.snapshot_id JOIN profile_blobs b ON b.profile_id=s.profile_id AND b.hash=f.hash AND b.state='verified' WHERE s.profile_id=? AND f.snapshot_id=? AND f.root=? AND f.path=?",
      [profileId, id, query.root, query.path],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    const file = rows[0],
      length = Math.min(file.size, 65536),
      chunks = await security.db.query<{ position: number; size: number; hash: string }>(
        'SELECT position,size,chunk_hash AS hash FROM profile_blob_chunks WHERE profile_id=? AND hash=? AND position=0',
        [profileId, file.hash],
      );
    const bytes = await storage.range(profileId, file.hash, file.size, 0, length, chunks);
    await security.db.transaction([
      ...guards(actor, profileId),
      ...security.auditStatements(
        'userId' in actor ? { kind: 'device', id: actor.id } : { kind: 'user', id: actor.id },
        'snapshot.preview',
        request.id,
        profileId,
        { snapshotId: id, root: query.root, path: query.path },
      ),
    ]);
    let text: string | null = null;
    try {
      if (!bytes.includes(0))
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
          stream: file.size > length,
        });
    } catch {
      /* Binary/non-UTF8 content is never coerced. */
    }
    return {
      hash: file.hash,
      size: file.size,
      truncated: file.size > length,
      kind: text === null ? 'binary' : 'text',
      text,
    };
  });
}
