// Test-only private IPC controller. No network route or runtime flag enables auto-approval.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { secureHarness } from './secure-harness.ts';
if (process.env.ATTUNER_TEST_FIXTURE !== '1')
  throw new Error('This fixture is only available to the synthetic integration harness.');
const h = await secureHarness();
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
  const command = JSON.parse(line) as { kind: string; enrollmentId?: string; deviceId?: string };
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
  } else if (command.kind === 'counts') {
    const devices = await h.db.query<{ n: number }>('SELECT count(*) AS n FROM devices');
    const credentials = await h.db.query<{ n: number }>(
      'SELECT count(*) AS n FROM device_credentials',
    );
    process.stdout.write(
      JSON.stringify({ devices: devices[0]!.n, credentials: credentials[0]!.n }) + '\n',
    );
  } else if (command.kind === 'stop') {
    break;
  } else process.stdout.write(JSON.stringify({ error: 'unknown-test-command' }) + '\n');
}
await h.close();
