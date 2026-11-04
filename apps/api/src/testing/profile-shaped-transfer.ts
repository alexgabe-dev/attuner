// Emulated WAN, actual HTTPS/DPoP/API/SQLite/CAS; never a remote VPS claim.
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { blake3 } from 'hash-wasm';
import { LIMITS, consistencyGroup, manifestDigest, type Manifest } from '@attuner/sync-protocol';
import { secureHarness, SyntheticDevice, type Harness, type Response } from './secure-harness.ts';
import { shapedRelay } from './shaped-relay.ts';
import { sha } from '../security/primitives.ts';
const results: unknown[] = [];
for (const shape of [
  { rttMs: 0, uploadMbps: 10000, downloadMbps: 10000 },
  { rttMs: 80, uploadMbps: 5, downloadMbps: 20 },
  { rttMs: 160, uploadMbps: 2, downloadMbps: 10 },
]) {
  for (const entropy of [false, true]) {
    console.error(
      `Isolated HTTPS transfer: RTT ${shape.rttMs}ms, ${entropy ? 'high entropy' : 'compressible'}`,
    );
    const root = await mkdtemp(join(tmpdir(), 'attuner-shaped-transfer-'));
    const h = await secureHarness({
      databaseFilename: join(root, 'server.sqlite'),
      blobDirectory: join(root, 'objects'),
    });
    const relay = await shapedRelay(Number(new URL(h.origin).port), shape);
    try {
      const password = randomBytes(32).toString('base64url');
      await h.security.bootstrap('operator', password);
      const owner = await h.login('operator', password);
      const profile = await h.web(
        'POST',
        '/api/v1/profiles',
        owner,
        { name: 'Synthetic shaped transfer' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(profile.status, 200);
      const profileId = profile.body.id as string,
        base = `/api/v1/profiles/${profileId}`;
      const device = new SyntheticDevice();
      const start = await device.send(
        h,
        'POST',
        '/api/v1/auth/enrollments',
        {
          deviceName: 'Synthetic transfer client',
          os: platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux',
          clientVersion: '0.1.0',
          codeChallenge: sha(device.verifier),
          state: device.state,
        },
        randomUUID(),
      );
      assert.equal(start.status, 200);
      const enrollmentId = start.body.enrollmentId as string;
      const decision = await h.web(
        'POST',
        `/api/v1/auth/enrollments/${enrollmentId}/decision`,
        owner,
        { approve: true, grants: [{ profileId, permission: 'write' }] },
      );
      assert.equal(decision.status, 200);
      device.accept(
        await device.send(
          h,
          'POST',
          '/api/v1/auth/token',
          {
            grantType: 'authorization_code',
            enrollmentId,
            code: new URL(decision.body.redirectUri as string).searchParams.get('code'),
            codeVerifier: device.verifier,
          },
          randomUUID(),
          '',
        ),
      );
      const transport: Pick<Harness, 'origin' | 'now' | 'send'> = {
        origin: h.origin,
        now: h.now,
        send: async (method, path, body, headers = {}) => {
          const data =
            body === undefined
              ? undefined
              : Buffer.isBuffer(body)
                ? body
                : Buffer.from(JSON.stringify(body));
          return new Promise<Response>((resolve, reject) => {
            const q = request(
              `https://127.0.0.1:${relay.port}` + path,
              {
                method,
                ca: h.ca,
                agent: false,
                headers: {
                  ...(data
                    ? {
                        'content-type': Buffer.isBuffer(body)
                          ? 'application/octet-stream'
                          : 'application/json',
                        'content-length': String(data.length),
                      }
                    : {}),
                  ...headers,
                },
              },
              (res) => {
                const parts: Buffer[] = [];
                let size = 0;
                res.on('data', (part: Buffer) => {
                  size += part.length;
                  if (size > LIMITS.chunkBytes + 65536) {
                    res.destroy(new Error('Response limit'));
                    return;
                  }
                  parts.push(part);
                });
                res.on('error', reject);
                res.on('end', () => {
                  const bytes = Buffer.concat(parts);
                  try {
                    resolve({
                      status: res.statusCode!,
                      headers: res.headers,
                      bytes,
                      body: res.headers['content-type']?.includes('application/json')
                        ? JSON.parse(bytes.toString())
                        : {},
                    });
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            q.setTimeout(60000, () => q.destroy(new Error('Transfer timeout')));
            q.on('error', reject);
            q.end(data);
          });
        },
      };
      const bytes = Buffer.alloc(LIMITS.chunkBytes + 17, 0x57);
      if (entropy) {
        let seed = 0x12345678;
        for (let i = 0; i < bytes.length; i++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          bytes[i] = seed & 255;
        }
      }
      const hash = await blake3(bytes);
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
      const candidate = {
        publicationVersion: 1,
        namespaceVersion: 1,
        expectedHead: { snapshotId: null, revision: 0, manifestHash: null },
        baseSnapshotId: null,
        coveredRoots: ['account', 'addons'],
        manifest,
        manifestHash: await manifestDigest(manifest),
      };
      const t = performance.now();
      const session = await device.send(
        transport,
        'POST',
        base + '/sessions',
        candidate,
        randomUUID(),
      );
      assert.equal(session.status, 200);
      const uploadPath = `${base}/sessions/${session.body.sessionId}/uploads`;
      const upload = await device.send(transport, 'POST', uploadPath, { hash, size: bytes.length });
      assert.equal(upload.status, 200);
      const id = upload.body.uploadId as string;
      assert.equal(
        (
          await device.send(
            transport,
            'PUT',
            `${base}/uploads/${id}/chunks/0`,
            bytes.subarray(0, LIMITS.chunkBytes),
          )
        ).status,
        200,
      );
      relay.dropConnections();
      const receipt = await device.send(transport, 'GET', `${base}/uploads/${id}`);
      assert.equal(receipt.status, 200);
      assert.equal((receipt.body.chunks as unknown[]).length, 1);
      assert.equal(
        (
          await device.send(
            transport,
            'PUT',
            `${base}/uploads/${id}/chunks/1`,
            bytes.subarray(LIMITS.chunkBytes),
          )
        ).status,
        200,
      );
      const completion = await device.send(
        transport,
        'POST',
        `${base}/uploads/${id}/completion`,
        {},
      );
      assert.equal(completion.body.verified, true);
      const uploadMs = performance.now() - t;
      const commit = await device.send(
        transport,
        'POST',
        `${base}/sessions/${session.body.sessionId}/commit`,
        { approve: true },
      );
      assert.equal(commit.status, 200);
      const reuseStart = performance.now();
      const again = await device.send(
        transport,
        'POST',
        base + '/sessions',
        { ...candidate, expectedHead: commit.body, baseSnapshotId: commit.body.snapshotId },
        randomUUID(),
      );
      assert.equal(again.status, 200);
      const reused = await device.send(
        transport,
        'POST',
        `${base}/sessions/${again.body.sessionId}/uploads`,
        { hash, size: bytes.length },
      );
      assert.equal(reused.body.verified, true);
      const reuseMs = performance.now() - reuseStart,
        downloadStart = performance.now();
      const downloaded: Buffer[] = [];
      for (let offset = 0; offset < bytes.length; offset += LIMITS.chunkBytes) {
        const length = Math.min(LIMITS.chunkBytes, bytes.length - offset),
          path = `${base}/blobs/${hash}?offset=${offset}&length=${length}`;
        const response = await transport.send('GET', path, undefined, {
          authorization: 'DPoP ' + device.accessToken,
          dpop: device.proof(transport, 'GET', path),
          'if-match': `"${hash}"`,
        });
        assert.equal(response.status, 200);
        assert.equal(response.bytes.length, length);
        downloaded.push(response.bytes);
      }
      assert.equal(await blake3(Buffer.concat(downloaded)), hash);
      results.push({
        shape,
        content: entropy ? 'high-entropy' : 'compressible',
        bytes: bytes.length,
        uploadMs,
        downloadMs: performance.now() - downloadStart,
        reuseMs,
        reusePayloadBytes: 0,
        receiptResumeVerified: true,
        originalBlake3Verified: true,
        wire: { ...relay.stats },
      });
    } finally {
      await relay.close();
      await h.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}
const report = {
  schemaVersion: 1,
  os: platform(),
  architecture: arch(),
  scope:
    'Actual TLS/DPoP/API/SQLite/CAS over a userspace loopback TCP relay. Emulated propagation delay and bandwidth, not a geographic WAN measurement. No OS network changes or deployment.',
  limitations:
    'No jitter/loss/congestion/TCP WAN window model; agent:false includes a new TLS connection for each request. Payload is raw protocol content, not the experimental local pack format. Harness holds at most one 4 MiB+17 synthetic source and bounded chunk responses.',
  results,
};
await writeFile(
  `artifacts/phase-4/shaped-transfer-${platform()}.json`,
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  'Synthetic shaped HTTPS transfer qualification passed; no WAN/VPS or deployment claim.',
);
