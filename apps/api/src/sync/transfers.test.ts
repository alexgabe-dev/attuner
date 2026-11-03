import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { blake3 } from 'hash-wasm';
import { manifestDigest, consistencyGroup, LIMITS, type Manifest } from '@attuner/sync-protocol';
import { secureHarness, SyntheticDevice, type Harness } from '../testing/secure-harness.ts';
import { BlobStorage } from './storage.ts';
import { ApiError } from '../security/primitives.ts';
import { sha } from '../security/primitives.ts';
let h: Harness, directory: string, profileId: string, owner: { cookie: string; csrfToken: string };
const password = 'isolated synthetic transfer password';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'attuner-transfer-'));
  h = await secureHarness({
    blobDirectory: join(directory, 'objects'),
    databaseFilename: join(directory, 'metadata.sqlite'),
  });
  await h.security.bootstrap('owner', password);
  owner = await h.login('owner', password);
  const result = await h.web(
    'POST',
    '/api/v1/profiles',
    owner,
    { name: 'Synthetic transfer fixtures' },
    { 'idempotency-key': randomUUID() },
  );
  profileId = result.body.id as string;
});
afterAll(async () => {
  await h.close();
  await rm(directory, { recursive: true, force: true });
});
async function enroll(permission: 'read' | 'write' = 'write') {
  const d = new SyntheticDevice(),
    start = await d.send(
      h,
      'POST',
      '/api/v1/auth/enrollments',
      {
        deviceName: 'Transfer fixture',
        os: 'macos',
        clientVersion: '0.1.0',
        codeChallenge: sha(d.verifier),
        state: d.state,
      },
      randomUUID(),
    );
  const enrollmentId = start.body.enrollmentId as string;
  const decision = await h.web('POST', `/api/v1/auth/enrollments/${enrollmentId}/decision`, owner, {
    approve: true,
    grants: [{ profileId, permission }],
  });
  expect(decision.status).toBe(200);
  const uri = new URL(decision.body.redirectUri as string);
  d.accept(
    await d.send(
      h,
      'POST',
      '/api/v1/auth/token',
      {
        grantType: 'authorization_code',
        enrollmentId,
        code: uri.searchParams.get('code'),
        codeVerifier: d.verifier,
      },
      randomUUID(),
      '',
    ),
  );
  return d;
}
async function candidate(d: SyntheticDevice, bytes: Buffer, overrideHash?: string) {
  const hash = overrideHash ?? (await blake3(bytes));
  const manifest: Manifest = {
    protocolVersion: 1,
    profileId,
    policyVersion: 1,
    files: [
      {
        root: 'account',
        path: 'Synthetic.lua',
        hash,
        size: bytes.length,
        group: await consistencyGroup('account', 'Synthetic.lua'),
      },
    ],
  };
  const body = {
    publicationVersion: 1,
    namespaceVersion: 1,
    expectedHead: { snapshotId: null, revision: 0, manifestHash: null },
    baseSnapshotId: null,
    coveredRoots: ['account', 'addons'],
    manifest,
    manifestHash: await manifestDigest(manifest),
  };
  const response = await d.send(
    h,
    'POST',
    `/api/v1/profiles/${profileId}/sessions`,
    body,
    randomUUID(),
  );
  expect(response.status).toBe(200);
  const start = await d.send(
    h,
    'POST',
    `/api/v1/profiles/${profileId}/sessions/${response.body.sessionId}/uploads`,
    { hash, size: bytes.length },
  );
  return {
    sessionId: response.body.sessionId as string,
    hash,
    start,
    uploadId: start.body.uploadId as string,
  };
}
const chunkPath = (u: string, i = 0) => `/api/v1/profiles/${profileId}/uploads/${u}/chunks/${i}`;
const completePath = (u: string) => `/api/v1/profiles/${profileId}/uploads/${u}/completion`;
it('resumes durable chunks after a server restart and never uploads verified unchanged bytes again', async () => {
  const d = await enroll(),
    bytes = Buffer.alloc(LIMITS.chunkBytes + 17, 0x57),
    c = await candidate(d, bytes);
  expect(c.start.status).toBe(200);
  expect(
    (await d.send(h, 'PUT', chunkPath(c.uploadId), bytes.subarray(0, LIMITS.chunkBytes))).status,
  ).toBe(200);
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).body.code).toBe(
    'UPLOAD_INCOMPLETE',
  );
  await h.close();
  h = await secureHarness({
    blobDirectory: join(directory, 'objects'),
    databaseFilename: join(directory, 'metadata.sqlite'),
  });
  owner = await h.login('owner', password);
  const status = await d.send(h, 'GET', `/api/v1/profiles/${profileId}/uploads/${c.uploadId}`);
  expect(status.body.chunks).toHaveLength(1);
  expect(
    (await d.send(h, 'PUT', chunkPath(c.uploadId, 1), bytes.subarray(LIMITS.chunkBytes))).status,
  ).toBe(200);
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).body.verified).toBe(true);
  const reuse = await candidate(d, bytes);
  expect(reuse.start.body).toEqual({ verified: true, hash: c.hash });
  const path = `/api/v1/profiles/${profileId}/blobs/${c.hash}?offset=${LIMITS.chunkBytes}&length=17`;
  // DPoP binds the URI without its query per RFC 9449.
  const result = await h.send('GET', path, undefined, {
    authorization: 'DPoP ' + d.accessToken,
    dpop: d.proof(h, 'GET', path.split('?')[0]!),
    'if-match': `"${c.hash}"`,
  });
  expect(result.status).toBe(200);
  expect(result.bytes.equals(bytes.subarray(LIMITS.chunkBytes))).toBe(true);
  expect(result.headers.etag).toBe(`"${c.hash}"`);
});
it('retries after durable file creation but failed database receipt without overwriting content', async () => {
  const d = await enroll(),
    bytes = Buffer.from('synthetic interrupted receipt'),
    c = await candidate(d, bytes);
  const spy = vi
    .spyOn(h.db, 'transaction')
    .mockRejectedValueOnce(new Error('injected receipt interruption'));
  const lost = await d.send(h, 'PUT', chunkPath(c.uploadId), bytes);
  expect(lost.status).toBe(503);
  spy.mockRestore();
  expect(
    await h.db.query('SELECT * FROM upload_chunks WHERE upload_id=?', [c.uploadId]),
  ).toHaveLength(0);
  expect((await d.send(h, 'PUT', chunkPath(c.uploadId), bytes)).status).toBe(200);
  expect(
    (await d.send(h, 'PUT', chunkPath(c.uploadId), Buffer.alloc(bytes.length, 0))).body.code,
  ).toBe('IDEMPOTENCY_MISMATCH');
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).status).toBe(200);
});
it('rejects corrupted chunks, final identities, links and stored blobs', async () => {
  const d = await enroll(),
    bytes = Buffer.from('synthetic corruption boundary'),
    c = await candidate(d, bytes);
  expect((await d.send(h, 'PUT', chunkPath(c.uploadId), bytes)).status).toBe(200);
  const path = join(directory, 'objects', 'u-' + c.uploadId, '0');
  await writeFile(path, Buffer.alloc(bytes.length, 0));
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).body.code).toBe('BLOB_CORRUPT');
  expect(
    await h.db.query('SELECT 1 FROM profile_blobs WHERE profile_id=? AND hash=?', [
      profileId,
      c.hash,
    ]),
  ).toHaveLength(0);
  const falseIdentity = await candidate(
    d,
    Buffer.from('different bytes'),
    await blake3('not those bytes'),
  );
  await d.send(h, 'PUT', chunkPath(falseIdentity.uploadId), Buffer.from('different bytes'));
  expect((await d.send(h, 'POST', completePath(falseIdentity.uploadId), {})).body.code).toBe(
    'BLOB_CORRUPT',
  );
  const linked = await candidate(d, Buffer.from('synthetic symlink'));
  await d.send(h, 'PUT', chunkPath(linked.uploadId), Buffer.from('synthetic symlink'));
  const linkPath = join(directory, 'objects', 'u-' + linked.uploadId, '0');
  await rm(linkPath);
  await symlink(path, linkPath);
  expect((await d.send(h, 'POST', completePath(linked.uploadId), {})).status).toBe(503);
  const intact = await candidate(d, Buffer.from('verified then corrupt'));
  await d.send(h, 'PUT', chunkPath(intact.uploadId), Buffer.from('verified then corrupt'));
  await d.send(h, 'POST', completePath(intact.uploadId), {});
  const object = join(directory, 'objects', 'p-' + profileId, intact.hash),
    original = await readFile(object);
  await writeFile(object, Buffer.alloc(original.length, 0));
  expect((await candidate(d, Buffer.from('verified then corrupt'))).start.body.code).toBe(
    'BLOB_CORRUPT',
  );
});
it('enforces profile isolation, read-only grants, bounds and quota reservations', async () => {
  const reader = await enroll('read');
  const denied = await reader.send(h, 'POST', `/api/v1/profiles/${profileId}/sessions`, {});
  expect(denied.status).toBe(404);
  const d = await enroll(),
    bytes = Buffer.from('quota test'),
    hash = await blake3(bytes);
  const foreign = await d.send(
    h,
    'GET',
    `/api/v1/profiles/${randomUUID()}/blobs/${hash}?offset=0&length=1`,
  );
  expect(foreign.status).toBe(404);
  await h.db.run('UPDATE profile_policies SET quota_bytes=1 WHERE profile_id=?', [profileId]);
  expect((await candidate(d, bytes)).start.body.code).toBe('QUOTA_EXCEEDED');
  await h.db.run('UPDATE profile_policies SET quota_bytes=10737418240 WHERE profile_id=?', [
    profileId,
  ]);
  const c = await candidate(d, bytes);
  expect(
    (await d.send(h, 'PUT', chunkPath(c.uploadId), Buffer.alloc(bytes.length + 1))).body.code,
  ).toBe('INVALID_CHUNK');
  await h.web('POST', `/api/v1/devices/${d.deviceId}/revocations`, owner, {});
  expect((await d.send(h, 'PUT', chunkPath(c.uploadId), bytes)).status).toBe(401);
});

it('does not expose an object before durable completion and safely retries publication receipt loss', async () => {
  const d = await enroll(),
    bytes = Buffer.from('completion receipt recovery'),
    c = await candidate(d, bytes);
  await d.send(h, 'PUT', chunkPath(c.uploadId), bytes);
  const space = vi
    .spyOn(BlobStorage.prototype, 'space')
    .mockRejectedValueOnce(
      new ApiError(507, 'INSUFFICIENT_SPACE', 'Synthetic disk budget exhausted.'),
    );
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).status).toBe(507);
  space.mockRestore();
  expect(
    await h.db.query('SELECT 1 FROM profile_blobs WHERE profile_id=? AND hash=?', [
      profileId,
      c.hash,
    ]),
  ).toHaveLength(0);
  const receipt = vi
    .spyOn(h.db, 'transaction')
    .mockRejectedValueOnce(new Error('completion receipt interruption'));
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).status).toBe(503);
  receipt.mockRestore();
  expect(
    await h.db.query('SELECT 1 FROM profile_blobs WHERE profile_id=? AND hash=?', [
      profileId,
      c.hash,
    ]),
  ).toHaveLength(0);
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).body.verified).toBe(true);
  expect(
    (
      await d.send(
        h,
        'POST',
        `/api/v1/profiles/${profileId}/sessions/${c.sessionId}/cancellations`,
        {},
      )
    ).status,
  ).toBe(200);
  expect((await d.send(h, 'POST', completePath(c.uploadId), {})).body.code).toBe('TRANSFER_CLOSED');
});
