// Trusted, freshly built CI archive only. Never a downloaded/user-selected archive.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { tlsFixture } from '../apps/api/src/testing/tls-fixture.ts';

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('This archive probe runs only on the isolated Linux CI build.');
const root = await mkdtemp(join(tmpdir(), 'attuner-runtime-fixture-'));
const tls = await tlsFixture();
let child: ReturnType<typeof spawn> | undefined;
let output = '';
try {
  const runtime = join(root, 'runtime'),
    credentials = join(root, 'credentials');
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(credentials, { mode: 0o700 });
  execFileSync(
    'tar',
    ['-xzf', resolve('.runtime/attuner-staging-jammy-runtime.tar.gz'), '-C', runtime],
    { timeout: 60000 },
  );
  await copyFile(tls.keyPath, join(credentials, 'api-tls-key'));
  await writeFile(join(credentials, 'api-tls-passphrase'), tls.passphrase, { mode: 0o600 });
  await writeFile(join(credentials, 'token-delivery-key'), randomBytes(32), { mode: 0o600 });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  child = spawn(process.execPath, [join(runtime, 'apps/api/dist/apps/api/src/server.js')], {
    cwd: join(runtime, 'apps/api'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ATTUNER_HOST: '127.0.0.1',
      ATTUNER_PORT: String(port),
      ATTUNER_DATA_DIR: join(root, 'data'),
      ATTUNER_TLS_CERT: tls.certPath,
      CREDENTIALS_DIRECTORY: credentials,
      ATTUNER_PUBLIC_ORIGIN: `https://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('error', () => {});
  for (const stream of [child.stdout, child.stderr])
    stream!.on('data', (bytes: Buffer) => {
      if (output.length < 32768) output += bytes.toString();
    });
  const health = () =>
    new Promise<number>((resolve, reject) => {
      const call = request(
        `https://127.0.0.1:${port}/api/v1/health/ready`,
        { ca: tls.ca },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      call.setTimeout(2000, () => call.destroy(new Error('runtime probe timeout')));
      call.on('error', reject);
      call.end();
    });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await health()) === 200) break;
    } catch {
      /* own fixture startup only */
    }
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error('Packaged runtime failed: ' + output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(!output.includes(tls.passphrase));
  console.log(
    'Extracted Jammy runtime passed: compiled API, native SQLite migration/worker, runtime credential loader and certificate-verified readiness; synthetic temporary data only.',
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  await tls.close();
  await rm(root, { recursive: true });
}
