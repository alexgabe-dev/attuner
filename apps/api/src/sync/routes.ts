import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { blake3 } from 'hash-wasm';
import {
  LIMITS,
  blobIdentitySchema,
  downloadRangeSchema,
  publicationSchema,
  canonicalManifest,
  manifestDigest,
  validatePublicationManifest,
  hashSchema,
  type Manifest,
} from '@attuner/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Device } from '../security/service.ts';
import { Security } from '../security/service.ts';
import { ApiError, sha } from '../security/primitives.ts';
import { BlobStorage } from './storage.ts';
declare module 'fastify' {
  interface FastifyRequest {
    syncDevice?: Device;
  }
}
const prefix = '/api/v1/profiles/:profileId';
const params = (request: FastifyRequest) => z.object({ profileId: z.uuid() }).parse(request.params);
const jobParams = (request: FastifyRequest) =>
  z.object({ profileId: z.uuid(), sessionId: z.uuid() }).parse(request.params);
const uploadParams = (request: FastifyRequest) =>
  z.object({ profileId: z.uuid(), uploadId: z.uuid() }).parse(request.params);
const key = (request: FastifyRequest) => z.uuid().parse(request.headers['idempotency-key']);
type Session = {
  id: string;
  device_id: string;
  profile_id: string;
  candidate_manifest: string;
  state: string;
  expires_at: number;
};
type Upload = {
  id: string;
  device_id: string;
  profile_id: string;
  session_id: string;
  hash: string;
  size: number;
  state: string;
  expires_at: number;
};
export function syncRoutes(app: FastifyInstance, security: Security, storage: BlobStorage) {
  const authenticated = {
    onRequest: async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
      const device = await security.device(request, reply),
        { profileId } = params(request);
      await security.member(device, profileId, request.method !== 'GET');
      request.syncDevice = device;
      const release = storage.lease();
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    },
  };
  async function session(profileId: string, sessionId: string, device: Device) {
    const rows = await security.db.query<Session>(
      'SELECT * FROM sync_sessions WHERE id=? AND profile_id=? AND device_id=?',
      [sessionId, profileId, device.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Session not found.');
    return rows[0];
  }
  async function upload(profileId: string, uploadId: string, device: Device) {
    const rows = await security.db.query<Upload>(
      'SELECT * FROM upload_sessions WHERE id=? AND profile_id=? AND device_id=?',
      [uploadId, profileId, device.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Upload not found.');
    const u = rows[0],
      s = await session(profileId, u.session_id, device);
    if (
      u.expires_at <= security.now() ||
      s.expires_at <= security.now() ||
      s.state !== 'open' ||
      !['open', 'verified'].includes(u.state)
    )
      throw new ApiError(409, 'TRANSFER_CLOSED', 'Restart the closed transfer.');
    return u;
  }
  app.post(
    prefix + '/sessions',
    { ...authenticated, bodyLimit: LIMITS.manifestBytes + 65536 },
    async (request) => {
      const d = request.syncDevice!,
        { profileId } = params(request),
        body = publicationSchema.parse(request.body),
        requestKey = key(request);
      const policies = await security.db.query<{ roots: string; policy_version: number }>(
        'SELECT pp.roots,p.policy_version FROM profile_policies pp JOIN profiles p ON p.id=pp.profile_id WHERE p.id=?',
        [profileId],
      );
      const policy = policies[0]!;
      const roots = JSON.parse(policy.roots) as string[];
      if ([...body.coveredRoots].sort().join() !== [...roots].sort().join())
        throw new ApiError(400, 'INCOMPLETE_COVERAGE', 'All profile roots must be covered.');
      let manifest: Manifest;
      try {
        manifest = await validatePublicationManifest(
          body.manifest,
          profileId,
          roots,
          policy.policy_version,
        );
      } catch {
        throw new ApiError(400, 'UNSAFE_MANIFEST', 'Manifest failed policy validation.');
      }
      if ((await manifestDigest(manifest)) !== body.manifestHash)
        throw new ApiError(400, 'MANIFEST_HASH_MISMATCH', 'Manifest identity did not match.');
      const payloadHash = sha(
        JSON.stringify({ ...body, manifest: JSON.parse(canonicalManifest(manifest)) }),
      );
      const prior = await security.receipt(d.id, 'session.start', requestKey, payloadHash);
      if (prior) return prior;
      const sessionId = randomUUID(),
        result = { sessionId, state: 'open', expiresAt: security.now() + 1800 };
      try {
        await security.db.transaction([
          ...security.deviceGuard(d, profileId, true),
          {
            sql: "SELECT 1 WHERE (SELECT count(*) FROM sync_sessions WHERE device_id=? AND state='open')<16",
            params: [d.id],
            expect: 1,
            code: 'SESSION_LIMIT',
          },
          {
            sql: "INSERT INTO sync_sessions VALUES(?,?,?,?,?,?,?,'open',?,?,?)",
            params: [
              sessionId,
              d.id,
              profileId,
              body.expectedHead.snapshotId,
              body.baseSnapshotId,
              canonicalManifest(manifest),
              policy.policy_version,
              requestKey,
              result.expiresAt,
              security.now(),
            ],
          },
          {
            sql: 'INSERT INTO publication_details VALUES(?,?,?,?,?,NULL)',
            params: [
              sessionId,
              body.expectedHead.revision,
              body.expectedHead.manifestHash,
              body.manifestHash,
              payloadHash,
            ],
          },
          {
            sql: 'INSERT INTO request_receipts VALUES(?,?,?,?,?,?)',
            params: [
              d.id,
              'session.start',
              requestKey,
              payloadHash,
              JSON.stringify(result),
              security.now(),
            ],
          },
          ...security.auditStatements(
            { kind: 'device', id: d.id },
            'session.started',
            request.id,
            profileId,
            { sessionId },
          ),
        ]);
      } catch (error) {
        const prior = await security.receipt(d.id, 'session.start', requestKey, payloadHash);
        if (prior) return prior;
        throw error;
      }
      return result;
    },
  );
  app.get(prefix + '/sessions/:sessionId', authenticated, async (request) => {
    const { profileId, sessionId } = jobParams(request),
      s = await session(profileId, sessionId, request.syncDevice!);
    return {
      sessionId: s.id,
      state: s.state,
      expiresAt: s.expires_at,
      uploads: await security.db.query(
        'SELECT id,hash,size,state FROM upload_sessions WHERE session_id=? ORDER BY hash LIMIT 200',
        [s.id],
      ),
    };
  });
  app.post(prefix + '/sessions/:sessionId/cancellations', authenticated, async (request) => {
    const { profileId, sessionId } = jobParams(request),
      d = request.syncDevice!;
    const s = await session(profileId, sessionId, d);
    if (s.state === 'committed')
      throw new ApiError(409, 'ALREADY_COMMITTED', 'Published snapshots cannot be cancelled.');
    await security.db.transaction([
      ...security.deviceGuard(d, profileId, true),
      {
        sql: "UPDATE sync_sessions SET state='cancelled' WHERE id=? AND state!='committed'",
        params: [s.id],
        expect: 1,
        code: 'ALREADY_COMMITTED',
      },
      {
        sql: "UPDATE upload_sessions SET state='cancelled' WHERE session_id=? AND state!='verified'",
        params: [s.id],
      },
      ...security.auditStatements(
        { kind: 'device', id: d.id },
        'session.cancelled',
        request.id,
        profileId,
        { sessionId },
      ),
    ]);
    return { sessionId, state: 'cancelled' };
  });
  app.post(prefix + '/sessions/:sessionId/uploads', authenticated, async (request) => {
    const { profileId, sessionId } = jobParams(request),
      d = request.syncDevice!,
      s = await session(profileId, sessionId, d),
      body = blobIdentitySchema.parse(request.body);
    if (s.state !== 'open' || s.expires_at <= security.now())
      throw new ApiError(409, 'TRANSFER_CLOSED', 'Session is closed.');
    const manifest = JSON.parse(s.candidate_manifest) as Manifest;
    if (!manifest.files.some((f) => f.hash === body.hash && f.size === body.size))
      throw new ApiError(400, 'UNREFERENCED_BLOB', 'Blob is not part of the candidate snapshot.');
    const verified = await security.db.query(
      "SELECT 1 FROM profile_blobs WHERE profile_id=? AND hash=? AND size=? AND state='verified'",
      [profileId, body.hash, body.size],
    );
    if (verified.length) {
      await storage.verify(profileId, body.hash, body.size);
      return { verified: true, hash: body.hash };
    }
    const prior = await security.db.query<Upload>(
      'SELECT * FROM upload_sessions WHERE session_id=? AND hash=?',
      [s.id, body.hash],
    );
    if (prior[0]) {
      if (prior[0].size !== body.size)
        throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Blob size changed.');
      return { uploadId: prior[0].id, verified: prior[0].state === 'verified', hash: body.hash };
    }
    const uploadId = randomUUID();
    await storage.space(body.size);
    try {
      await security.db.transaction([
        ...security.deviceGuard(d, profileId, true),
        {
          sql: "SELECT 1 FROM sync_sessions WHERE id=? AND state='open' AND expires_at>?",
          params: [s.id, security.now()],
          expect: 1,
          code: 'TRANSFER_CLOSED',
        },
        {
          sql: "SELECT 1 FROM profile_policies pp WHERE pp.profile_id=? AND coalesce((SELECT sum(size) FROM profile_blobs WHERE profile_id=pp.profile_id),0)+coalesce((SELECT sum(size) FROM upload_sessions WHERE profile_id=pp.profile_id AND state!='verified'),0)+?<=pp.quota_bytes",
          params: [profileId, body.size],
          expect: 1,
          code: 'QUOTA_EXCEEDED',
        },
        {
          sql: "INSERT INTO upload_sessions VALUES(?,?,?,?,?,?,'open',?,?)",
          params: [
            uploadId,
            s.id,
            profileId,
            d.id,
            body.hash,
            body.size,
            s.expires_at,
            security.now(),
          ],
        },
        ...security.auditStatements(
          { kind: 'device', id: d.id },
          'upload.started',
          request.id,
          profileId,
          { uploadId, hash: body.hash, size: body.size },
        ),
      ]);
    } catch (error) {
      const prior = await security.db.query<Upload>(
        'SELECT * FROM upload_sessions WHERE session_id=? AND hash=?',
        [s.id, body.hash],
      );
      if (prior[0])
        return { uploadId: prior[0].id, verified: prior[0].state === 'verified', hash: body.hash };
      throw error;
    }
    return { uploadId, verified: false, hash: body.hash };
  });
  app.get(prefix + '/uploads/:uploadId', authenticated, async (request) => {
    const { profileId, uploadId } = uploadParams(request),
      u = await upload(profileId, uploadId, request.syncDevice!);
    return {
      uploadId,
      state: u.state,
      hash: u.hash,
      size: u.size,
      chunks: await security.db.query(
        'SELECT position,size,hash FROM upload_chunks WHERE upload_id=? ORDER BY position',
        [u.id],
      ),
    };
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: LIMITS.chunkBytes },
    (_request, body, done) => done(null, body),
  );
  app.put(
    prefix + '/uploads/:uploadId/chunks/:position',
    { ...authenticated, bodyLimit: LIMITS.chunkBytes },
    async (request) => {
      const { profileId, uploadId } = uploadParams(request),
        d = request.syncDevice!,
        position = z.coerce
          .number()
          .int()
          .min(0)
          .max(255)
          .parse((request.params as { position: string }).position),
        u = await upload(profileId, uploadId, d),
        bytes = request.body;
      if (!Buffer.isBuffer(bytes))
        throw new ApiError(400, 'INVALID_CHUNK', 'Use an octet-stream chunk.');
      const expected = Math.min(LIMITS.chunkBytes, u.size - position * LIMITS.chunkBytes);
      if (expected <= 0 || bytes.length !== expected)
        throw new ApiError(400, 'INVALID_CHUNK', 'Chunk length or offset was rejected.');
      const hash = await blake3(bytes),
        prior = await security.db.query<{ hash: string; size: number }>(
          'SELECT hash,size FROM upload_chunks WHERE upload_id=? AND position=?',
          [u.id, position],
        );
      if (prior[0] && (prior[0].hash !== hash || prior[0].size !== bytes.length))
        throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Chunk position has different bytes.');
      if (u.state !== 'open' && !prior[0])
        throw new ApiError(409, 'TRANSFER_CLOSED', 'Upload is closed.');
      await storage.chunk(u.id, position, bytes, hash);
      await security.db.transaction([
        ...security.deviceGuard(d, profileId, true),
        {
          sql: "SELECT 1 FROM upload_sessions WHERE id=? AND state IN ('open','verified') AND expires_at>?",
          params: [u.id, security.now()],
          expect: 1,
          code: 'TRANSFER_CLOSED',
        },
        {
          sql: 'INSERT OR IGNORE INTO upload_chunks VALUES(?,?,?,?,?)',
          params: [u.id, position, bytes.length, hash, security.now()],
        },
        {
          sql: 'SELECT 1 FROM upload_chunks WHERE upload_id=? AND position=? AND hash=? AND size=?',
          params: [u.id, position, hash, bytes.length],
          expect: 1,
          code: 'IDEMPOTENCY_MISMATCH',
        },
        ...security.auditStatements(
          { kind: 'device', id: d.id },
          'upload.chunk',
          request.id,
          profileId,
          { uploadId, position, hash },
        ),
      ]);
      return { position, size: bytes.length, hash };
    },
  );
  app.post(prefix + '/uploads/:uploadId/completion', authenticated, async (request) => {
    const { profileId, uploadId } = uploadParams(request),
      d = request.syncDevice!,
      u = await upload(profileId, uploadId, d);
    if (u.state === 'verified') {
      await storage.verify(profileId, u.hash, u.size);
      return { hash: u.hash, size: u.size, verified: true };
    }
    const chunks = await security.db.query<{ position: number; size: number; hash: string }>(
      'SELECT position,size,hash FROM upload_chunks WHERE upload_id=? ORDER BY position',
      [u.id],
    );
    if (
      chunks.length !== Math.ceil(u.size / LIMITS.chunkBytes) ||
      chunks.some(
        (c, i) =>
          c.position !== i ||
          c.size !== Math.min(LIMITS.chunkBytes, u.size - i * LIMITS.chunkBytes),
      )
    )
      throw new ApiError(409, 'UPLOAD_INCOMPLETE', 'Upload still has missing chunks.');
    await storage.assemble(profileId, u.id, u.hash, u.size, chunks);
    await security.db.transaction([
      ...security.deviceGuard(d, profileId, true),
      {
        sql: "SELECT 1 FROM upload_sessions u JOIN sync_sessions s ON s.id=u.session_id WHERE u.id=? AND u.state IN ('open','verified') AND s.state='open' AND s.expires_at>?",
        params: [u.id, security.now()],
        expect: 1,
        code: 'TRANSFER_CLOSED',
      },
      {
        sql: "INSERT OR IGNORE INTO blobs VALUES(?,?,'verified',?)",
        params: [u.hash, u.size, security.now()],
      },
      {
        sql: 'SELECT 1 FROM blobs WHERE hash=? AND size=?',
        params: [u.hash, u.size],
        expect: 1,
        code: 'BLOB_CORRUPT',
      },
      {
        sql: "INSERT INTO profile_blobs VALUES(?,?,?,'verified',?) ON CONFLICT(profile_id,hash) DO UPDATE SET state='verified' WHERE size=excluded.size",
        params: [profileId, u.hash, u.size, security.now()],
      },
      { sql: "UPDATE upload_sessions SET state='verified' WHERE id=?", params: [u.id] },
      ...security.auditStatements(
        { kind: 'device', id: d.id },
        'upload.verified',
        request.id,
        profileId,
        { uploadId, hash: u.hash, size: u.size },
      ),
    ]);
    return { hash: u.hash, size: u.size, verified: true };
  });
  app.get(prefix + '/blobs/:hash', authenticated, async (request, reply) => {
    const { profileId } = params(request),
      hash = hashSchema.parse((request.params as { hash: string }).hash),
      query = downloadRangeSchema.parse(request.query);
    const rows = await security.db.query<{ size: number }>(
      "SELECT size FROM profile_blobs WHERE profile_id=? AND hash=? AND state='verified'",
      [profileId, hash],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Blob not found.');
    const size = rows[0].size;
    if (query.offset + query.length > size || (size > 0 && query.length === 0))
      throw new ApiError(416, 'INVALID_RANGE', 'Range is outside the object.');
    if (request.headers['if-match'] !== `"${hash}"`)
      throw new ApiError(412, 'ETAG_REQUIRED', 'Use the verified blob identity.');
    const bytes = await storage.range(profileId, hash, size, query.offset, query.length);
    // Recheck after I/O; authorization is current when the read is audited and released.
    await security.db.transaction([
      ...security.deviceGuard(request.syncDevice!, profileId),
      ...security.auditStatements(
        { kind: 'device', id: request.syncDevice!.id },
        'blob.read',
        request.id,
        profileId,
        { hash, offset: query.offset, length: query.length },
      ),
    ]);
    reply
      .header('ETag', `"${hash}"`)
      .header('X-Blob-Size', String(size))
      .header('X-Blob-Offset', String(query.offset))
      .type('application/octet-stream');
    return bytes;
  });
}
