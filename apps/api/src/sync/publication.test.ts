import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { blake3 } from 'hash-wasm';
import { manifestDigest, consistencyGroup, type Manifest, type Head } from '@attuner/sync-protocol';
import { secureHarness, SyntheticDevice, type Harness } from '../testing/secure-harness.ts';
import { sha } from '../security/primitives.ts';
let h: Harness, directory: string, profileId: string, owner: { cookie: string; csrfToken: string };
const password = 'isolated publication account password';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'attuner-publication-'));
  h = await secureHarness({ blobDirectory: join(directory, 'objects') });
  await h.security.bootstrap('owner', password);
  owner = await h.login('owner', password);
  const p = await h.web(
    'POST',
    '/api/v1/profiles',
    owner,
    { name: 'Immutable synthetic history' },
    { 'idempotency-key': randomUUID() },
  );
  profileId = p.body.id as string;
});
afterAll(async () => {
  await h.close();
  await rm(directory, { recursive: true, force: true });
});
async function enroll() {
  const d = new SyntheticDevice(),
    start = await d.send(
      h,
      'POST',
      '/api/v1/auth/enrollments',
      {
        deviceName: 'Isolated publication client',
        os: 'macos',
        clientVersion: '0.1.0',
        codeChallenge: sha(d.verifier),
        state: d.state,
      },
      randomUUID(),
    ),
    enrollmentId = start.body.enrollmentId as string;
  const a = await h.web('POST', `/api/v1/auth/enrollments/${enrollmentId}/decision`, owner, {
    approve: true,
    grants: [{ profileId, permission: 'write' }],
  });
  const uri = new URL(a.body.redirectUri as string);
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
async function head(d: SyntheticDevice) {
  return (await d.send(h, 'GET', `/api/v1/profiles/${profileId}/head`)).body.head as Head;
}
async function stage(
  d: SyntheticDevice,
  expectedHead: Head,
  entries: Record<string, string>,
  upload = true,
) {
  const files = await Promise.all(
    Object.entries(entries).map(async ([path, bytes]) => ({
      root: 'account' as const,
      path,
      hash: await blake3(bytes),
      size: Buffer.byteLength(bytes),
      group: await consistencyGroup('account', path),
    })),
  );
  const manifest: Manifest = { protocolVersion: 1, profileId, policyVersion: 1, files };
  const body = {
    publicationVersion: 1,
    namespaceVersion: 1,
    expectedHead,
    baseSnapshotId: expectedHead.snapshotId,
    coveredRoots: ['account', 'addons'],
    manifest,
    manifestHash: await manifestDigest(manifest),
  };
  const session = await d.send(
    h,
    'POST',
    `/api/v1/profiles/${profileId}/sessions`,
    body,
    randomUUID(),
  );
  expect(session.status).toBe(200);
  const sessionId = session.body.sessionId as string;
  if (upload)
    for (const f of files) {
      const start = await d.send(
        h,
        'POST',
        `/api/v1/profiles/${profileId}/sessions/${sessionId}/uploads`,
        { hash: f.hash, size: f.size },
      );
      expect(start.status).toBe(200);
      if (start.body.verified) continue;
      const uploadId = start.body.uploadId as string;
      expect(
        (
          await d.send(
            h,
            'PUT',
            `/api/v1/profiles/${profileId}/uploads/${uploadId}/chunks/0`,
            Buffer.from(entries[f.path]!),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await d.send(
            h,
            'POST',
            `/api/v1/profiles/${profileId}/uploads/${uploadId}/completion`,
            {},
          )
        ).status,
      ).toBe(200);
    }
  return { sessionId, manifest, body };
}
const commit = (d: SyntheticDevice, sessionId: string) =>
  d.send(h, 'POST', `/api/v1/profiles/${profileId}/sessions/${sessionId}/commit`, {
    approve: true,
  });
it('publishes immutable complete snapshots and idempotently recovers a lost commit response', async () => {
  const d = await enroll(),
    initial = await head(d);
  expect(initial.revision).toBe(0);
  const staged = await stage(d, initial, {
    'A.lua': 'original bytes\r\n',
    'B.lua': 'to be removed',
  });
  expect(
    (
      await d.send(
        h,
        'POST',
        `/api/v1/profiles/${profileId}/sessions/${staged.sessionId}/commit`,
        {},
      )
    ).status,
  ).toBe(400);
  const first = await commit(d, staged.sessionId);
  expect(first.status).toBe(200);
  expect(first.body.revision).toBe(1);
  expect((await commit(d, staged.sessionId)).body).toEqual(first.body);
  const snapshot = await h.web(
    'GET',
    `/api/v1/profiles/${profileId}/snapshots/${first.body.snapshotId}`,
    owner,
  );
  expect(await manifestDigest(snapshot.body.manifest)).toBe(first.body.manifestHash);
  await expect(
    h.db.run("UPDATE sync_sessions SET candidate_manifest='{}' WHERE id=?", [staged.sessionId]),
  ).rejects.toThrow('immutable');
  await expect(
    h.db.run('DELETE FROM snapshots WHERE id=?', [first.body.snapshotId as string]),
  ).rejects.toThrow('retained');
  const second = await stage(d, await head(d), {
    'A.lua': 'modified original bytes',
    'C.lua': 'new bytes',
  });
  expect((await commit(d, second.sessionId)).body.revision).toBe(2);
  const history = await h.web('GET', `/api/v1/profiles/${profileId}/snapshots`, owner);
  expect(history.body.snapshots).toMatchObject([
    { revision: 2, added: 1, modified: 1, removed: 1 },
    { revision: 1, added: 2, modified: 0, removed: 0 },
  ]);
  const changes = await h.db.query(
    'SELECT kind FROM file_changes WHERE session_id=? ORDER BY kind',
    [second.sessionId],
  );
  expect(changes).toEqual([{ kind: 'add' }, { kind: 'delete' }, { kind: 'modify' }]);
});
it('gives exactly one winner to concurrent devices and rejects stale heads without a revision hole', async () => {
  const a = await enroll(),
    b = await enroll(),
    expected = await head(a);
  const left = await stage(a, expected, { 'A.lua': 'concurrent left' }),
    right = await stage(b, expected, { 'A.lua': 'concurrent right' });
  const results = await Promise.all([commit(a, left.sessionId), commit(b, right.sessionId)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(results.find((r) => r.status === 409)!.body.code).toBe('HEAD_MOVED');
  expect((await head(a)).revision).toBe(expected.revision + 1);
  const winner = results[0]!.status === 200 ? a : b,
    session = results[0]!.status === 200 ? left : right;
  const retried = await Promise.all([
    commit(winner, session.sessionId),
    commit(winner, session.sessionId),
  ]);
  expect(retried[0]!.body).toEqual(retried[1]!.body);
});
it('rolls back snapshot, seal, head and result together if the publication audit fails', async () => {
  const d = await enroll(),
    before = await head(d),
    s = await stage(d, before, { 'Audit.lua': 'atomic audit content' });
  await h.db.run(
    "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events WHEN NEW.type='snapshot.published' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  expect((await commit(d, s.sessionId)).status).toBe(503);
  expect(await head(d)).toEqual(before);
  expect(
    await h.db.query('SELECT 1 FROM snapshots WHERE profile_id=? AND revision=?', [
      profileId,
      before.revision + 1,
    ]),
  ).toHaveLength(0);
  await h.db.run('DROP TRIGGER synthetic_audit_failure');
  expect((await commit(d, s.sessionId)).body.revision).toBe(before.revision + 1);
  const events = await h.web('GET', `/api/v1/profiles/${profileId}/activity`, owner);
  expect(
    (events.body.events as { type: string }[]).some((e) => e.type === 'snapshot.published'),
  ).toBe(true);
});
it('requires verified content, denies revoked publication and prevents acknowledgement regression', async () => {
  const d = await enroll(),
    before = await head(d),
    missing = await stage(d, before, { 'Missing.lua': 'not uploaded' }, false);
  expect((await commit(d, missing.sessionId)).body.code).toBe('BLOBS_MISSING');
  const staged = await stage(d, before, { 'Ack.lua': 'acknowledge original' });
  const first = await commit(d, staged.sessionId);
  const later = await stage(d, await head(d), { 'Ack.lua': 'acknowledge latest' });
  const second = await commit(d, later.sessionId);
  const ack = (body: Record<string, unknown>) =>
    d.send(h, 'POST', `/api/v1/profiles/${profileId}/acknowledgements`, {
      snapshotId: body.snapshotId,
      manifestHash: body.manifestHash,
    });
  expect((await ack(second.body)).status).toBe(200);
  expect((await ack(first.body)).body.code).toBe('ACK_REGRESSION');
  const pending = await stage(d, await head(d), {
    'Revoked.lua': 'not publishable after revocation',
  });
  await h.web('POST', `/api/v1/devices/${d.deviceId}/revocations`, owner, {});
  expect((await commit(d, pending.sessionId)).status).toBe(401);
});
