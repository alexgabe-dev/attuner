// Test-only private IPC controller. No network route or runtime flag enables auto-approval.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureHarness } from './secure-harness.ts';
if (process.env.ATTUNER_TEST_FIXTURE !== '1')
  throw new Error('This fixture is only available to the synthetic integration harness.');
const blobDirectory =
  process.env.ATTUNER_TEST_BLOBS === '1'
    ? await mkdtemp(join(tmpdir(), 'attuner-native-transfer-'))
    : undefined;
let corruptWireHash = '';
let loseCommitReply = false;
const h = await secureHarness({
  ...(blobDirectory ? { blobDirectory } : {}),
  transformResponse: (path, payload) => {
    if (loseCommitReply && path.endsWith('/commit')) {
      loseCommitReply = false;
      throw new Error('Synthetic committed response interruption');
    }
    if (
      corruptWireHash &&
      Buffer.isBuffer(payload) &&
      path.includes('/blobs/' + corruptWireHash + '?') &&
      payload.length
    ) {
      const corrupted = Buffer.from(payload);
      corrupted[0] = corrupted[0]! ^ 1;
      return corrupted;
    }
    return payload;
  },
});
const password = randomUUID() + randomUUID();
await h.security.bootstrap('synthetic-owner', password);
const session = await h.login('synthetic-owner', password);
const profile = await h.web(
  'POST',
  '/api/v1/profiles',
  session,
  { name: 'Three synthetic clients' },
  { 'idempotency-key': randomUUID() },
);
const profileId = profile.body.id as string;
const capabilities = await h.send('GET', '/api/v1/capabilities');
// Only public connection material is emitted at startup.
process.stdout.write(
  JSON.stringify({ origin: h.origin, ca: h.ca, serverId: capabilities.body.serverId, profileId }) +
    '\n',
);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const command = JSON.parse(line) as {
    kind: string;
    enrollmentId?: string;
    deviceId?: string;
    hash?: string;
    jobId?: string;
    decisions?: unknown;
  };
  if (command.kind === 'approve') {
    const response = await h.web(
      'POST',
      `/api/v1/auth/enrollments/${command.enrollmentId}/decision`,
      session,
      { approve: true, grants: [{ profileId, permission: 'write' }] },
    );
    process.stdout.write(
      JSON.stringify({ status: response.status, redirectUri: response.body.redirectUri }) + '\n',
    );
  } else if (command.kind === 'revoke') {
    const response = await h.web(
      'POST',
      `/api/v1/devices/${command.deviceId}/revocations`,
      session,
      {},
    );
    process.stdout.write(JSON.stringify({ status: response.status }) + '\n');
  } else if (command.kind === 'pause') {
    h.app.server.closeIdleConnections();
    h.app.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      h.app.server.close((error) => (error ? reject(error) : resolve())),
    );
    process.stdout.write(JSON.stringify({ paused: true }) + '\n');
  } else if (command.kind === 'resume') {
    await new Promise<void>((resolve, reject) => {
      h.app.server.once('error', reject);
      h.app.server.listen(Number(new URL(h.origin).port), '127.0.0.1', () => {
        h.app.server.removeListener('error', reject);
        resolve();
      });
    });
    process.stdout.write(JSON.stringify({ resumed: true }) + '\n');
  } else if (command.kind === 'propose') {
    const rows = await h.db.query<{
      source_generation: number;
      local_manifest_hash: string;
      remote_head: string;
    }>('SELECT * FROM device_sync_jobs WHERE id=?', [command.jobId!]);
    if (!rows[0])
      process.stdout.write(JSON.stringify({ status: 404, code: 'REPORT_MISSING' }) + '\n');
    else {
      const row = rows[0];
      const response = await h.web(
        'POST',
        `/api/v1/profiles/${profileId}/jobs/${command.jobId}/proposals`,
        session,
        {
          sourceGeneration: row.source_generation,
          localManifestHash: row.local_manifest_hash,
          remoteHead: JSON.parse(row.remote_head),
          decisions: command.decisions,
        },
      );
      process.stdout.write(
        JSON.stringify({
          status: response.status,
          code: response.body.code,
          proposalId: response.body.proposalId,
        }) + '\n',
      );
    }
  } else if (command.kind === 'loseCommitReply') {
    loseCommitReply = true;
    process.stdout.write(JSON.stringify({ armed: true }) + '\n');
  } else if (command.kind === 'corruptWire') {
    corruptWireHash = command.hash ?? '';
    process.stdout.write(JSON.stringify({ changed: true }) + '\n');
  } else if (command.kind === 'counts') {
    const devices = await h.db.query<{ n: number }>('SELECT count(*) AS n FROM devices');
    const reports = await h.db.query<{ n: number }>('SELECT count(*) AS n FROM device_sync_jobs');
    const credentials = await h.db.query<{ n: number }>(
      'SELECT count(*) AS n FROM device_credentials',
    );
    process.stdout.write(
      JSON.stringify({
        devices: devices[0]!.n,
        credentials: credentials[0]!.n,
        reports: reports[0]!.n,
      }) + '\n',
    );
  } else if (command.kind === 'stop') {
    break;
  } else process.stdout.write(JSON.stringify({ error: 'unknown-test-command' }) + '\n');
}
await h.close();
if (blobDirectory) await rm(blobDirectory, { recursive: true, force: true });
