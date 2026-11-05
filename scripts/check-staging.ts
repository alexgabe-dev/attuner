// Local-only qualification. No deployment, global trust changes or real files.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { tlsFixture } from '../apps/api/src/testing/tls-fixture.ts';
import { secureHarness, type Response } from '../apps/api/src/testing/secure-harness.ts';
import { managementScenario } from '../apps/api/src/testing/management-scenario.ts';
import { renderProxy, type ProxyConfig } from '../infrastructure/staging/nginx.ts';

if (process.platform === 'win32') throw new Error('Staging server qualification targets Unix.');
const docker = process.argv.includes('--docker');
const sharedHost = process.argv.includes('--shared-host');
const nginxBinary = process.env.ATTUNER_QUALIFICATION_NGINX ?? 'nginx';
if (docker && process.platform !== 'linux')
  throw new Error('Container qualification uses a Linux hosted runner only.');
const tools = JSON.parse(await readFile('infrastructure/staging/toolchain.json', 'utf8')) as {
  validationImage: string;
};
const root = await mkdtemp(join(tmpdir(), 'attuner-staging-qualification-'));
const tls = await tlsFixture();
let proxy: ChildProcess | undefined, web: ChildProcess | undefined;
let proxyLogs = '',
  processErrors = '';
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
const port = await freePort(),
  webPort = await freePort(),
  origin = `https://127.0.0.1:${port}`;
const h = await secureHarness({
  blobDirectory: join(root, 'blobs'),
  databaseFilename: join(root, 'attuner.sqlite'),
  publicOrigin: origin,
  trustLoopbackProxy: true,
});
const apiPort = Number(new URL(h.origin).port);
const children = new Set<ChildProcess>();
const containers = new Map<ChildProcess, string>();
function track(child: ChildProcess) {
  children.add(child);
  child.once('error', () => {});
  child.stderr?.on('data', (bytes: Buffer) => {
    if (processErrors.length < 32768) processErrors += bytes.toString();
  });
  return child;
}
async function stop(child: ChildProcess | undefined) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  children.delete(child);
  const container = containers.get(child);
  if (container) {
    const result = spawnSync('docker', ['rm', '-f', container], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.status !== 0 && !/No such container/.test(result.stderr ?? ''))
      throw new Error('Owned test container cleanup could not be verified.');
    containers.delete(child);
  }
}
const fifo = join(root, 'password.fifo');
execFileSync('mkfifo', ['-m', '600', fifo]);
async function providePassphrase(child: ChildProcess) {
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Proxy exited before credential delivery: ' + processErrors);
    try {
      const handle = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        await handle.writeFile(tls.passphrase + '\n');
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENXIO') ||
        Date.now() > deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
const configuration: ProxyConfig = {
  origin,
  listen: `127.0.0.1:${port}`,
  apiPort,
  webPort,
  apiCA: join(root, 'api-ca.pem'),
  apiName: 'localhost',
  edgeCertificate: join(root, 'edge-cert.pem'),
  edgeKey: join(root, 'edge-key.pem'),
  passwordFile: fifo,
  pid: join(root, 'nginx.pid'),
  cache: join(root, 'cache'),
  accessLog: join(root, 'proxy.log'),
  hosted: sharedHost,
};
// Existing host's HTTP context decrypts its synthetic key once; the Attuner
// include inherits that in-memory password without a second FIFO reader.
if (sharedHost) delete configuration.passwordFile;
async function checkOtherSite() {
  if (sharedHost) {
    for (const host of ['localhost', 'unknown.example.invalid']) {
      await new Promise<void>((resolve, reject) => {
        const call = request(
          origin + '/unrelated',
          { ca: tls.ca, servername: 'localhost', headers: { host } },
          (response) => {
            let content = '';
            response.on('data', (bytes: Buffer) => {
              content += bytes.toString();
              if (content.length > 128)
                response.destroy(new Error('Other-site fixture size limit.'));
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                assert.equal(response.statusCode, 200);
                assert.equal(content, 'unrelated synthetic site unchanged');
                resolve();
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        call.setTimeout(5000, () => call.destroy(new Error('Other-site fixture timeout.')));
        call.on('error', reject);
        call.end();
      });
    }
  }
}
function startProxy(validate = false) {
  const name = 'attuner-stage-test-' + randomUUID();
  const args = [
    '-p',
    root + '/',
    '-c',
    join(root, 'nginx.conf'),
    '-g',
    'daemon off;',
    ...(validate ? ['-t'] : []),
  ];
  const child = docker
    ? spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'host',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '--mount',
          `type=bind,src=${root},dst=${root}`,
          '--entrypoint',
          'nginx',
          tools.validationImage,
          ...args,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : spawn(nginxBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  track(child);
  if (docker) containers.set(child, name);
  child.stdout!.on('data', (bytes: Buffer) => {
    if (!validate && proxyLogs.length < 1024 * 1024) proxyLogs += bytes.toString();
  });
  return child;
}
async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const bytes =
    body === undefined
      ? undefined
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = request(
      origin + path,
      {
        method,
        ca: tls.ca,
        headers: {
          ...headers,
          ...(bytes
            ? {
                'content-type': Buffer.isBuffer(body)
                  ? 'application/octet-stream'
                  : 'application/json',
                'content-length': String(bytes.length),
              }
            : {}),
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        let size = 0;
        response.on('data', (part: Buffer) => {
          size += part.length;
          if (size > 18 * 1024 * 1024) response.destroy(new Error('Fixture response size limit.'));
          else parts.push(part);
        });
        response.on('error', reject);
        response.on('end', () => {
          const value = Buffer.concat(parts);
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: response.headers['content-type']?.includes('application/json')
              ? JSON.parse(value.toString('utf8'))
              : {},
            bytes: value,
          });
        });
      },
    );
    call.setTimeout(15000, () => call.destroy(new Error('Fixture request timeout.')));
    call.on('error', reject);
    call.end(bytes);
  });
}
async function waitProxy() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const response = await send('GET', '/api/v1/health/ready');
      if (response.status === 200) return;
    } catch {
      /* owned child startup */
    }
    if (Date.now() > deadline || proxy?.exitCode !== null)
      throw new Error('Proxy did not become ready: ' + processErrors);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  await mkdir(join(root, 'cache'), { mode: 0o700 });
  await copyFile(tls.keyPath, configuration.edgeKey);
  await copyFile(tls.certPath, configuration.edgeCertificate);
  await writeFile(configuration.apiCA, h.ca);
  const include = renderProxy(configuration);
  await writeFile(join(root, 'attuner-staging.conf'), include, { mode: 0o600 });
  const master = sharedHost
    ? `# Synthetic existing host; never written outside this temporary root.\nworker_processes 1;\npid "${join(root, 'nginx.pid')}";\nerror_log /dev/null;\nevents { worker_connections 256; }\nhttp {\naccess_log off;\n${['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((name) => `${name}_temp_path "${join(root, 'cache', name)}";`).join('\n')}\nssl_password_file "${fifo}";\nssl_certificate "${configuration.edgeCertificate}";\nssl_certificate_key "${configuration.edgeKey}";\nssl_protocols TLSv1.2 TLSv1.3;\nserver { listen 127.0.0.1:${port} ssl default_server; server_name localhost; location / { return 200 'unrelated synthetic site unchanged'; } }\ninclude "${join(root, 'attuner-staging.conf')}";\n}\n`
    : include;
  await writeFile(join(root, 'nginx.conf'), master, { mode: 0o600 });
  if (docker)
    execFileSync('docker', ['pull', tools.validationImage], { stdio: 'pipe', timeout: 120000 });
  const validation = startProxy(true),
    validated = once(validation, 'close');
  await providePassphrase(validation);
  assert.equal((await validated)[0], 0, processErrors);
  web = track(
    spawn(
      process.execPath,
      [
        resolve('apps/web/node_modules/next/dist/bin/next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(webPort),
      ],
      {
        cwd: resolve('apps/web'),
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  web.stdout!.resume();
  proxy = startProxy();
  await providePassphrase(proxy);
  await waitProxy();
  await checkOtherSite();
  const password = randomBytes(24).toString('base64url');
  await h.security.bootstrap('owner', password);
  const login = await send(
    'POST',
    '/api/v1/auth/login',
    { username: 'owner', password },
    { origin },
  );
  assert.equal(login.status, 200);
  const cookieHeader = login.headers['set-cookie']?.[0];
  assert(typeof cookieHeader === 'string');
  assert(cookieHeader.includes('Secure'));
  const owner = {
    cookie: cookieHeader.split(';')[0]!,
    csrfToken: login.body.csrfToken as string,
  };
  const webRequest = (
    method: string,
    path: string,
    session: typeof owner,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    send(method, path, body, {
      origin,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      ...headers,
    });
  const created = await webRequest(
    'POST',
    '/api/v1/profiles',
    owner,
    { name: 'Staging · Synthetic' },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(created.status, 200);
  await managementScenario(
    { origin, now: h.now, send, web: webRequest },
    created.body.id as string,
    owner,
  );
  assert.equal(
    (
      await send(
        'POST',
        '/api/v1/profiles',
        { name: 'Rejected origin' },
        {
          origin: 'https://untrusted.example.invalid',
          cookie: owner.cookie,
          'x-csrf-token': owner.csrfToken,
          'idempotency-key': randomUUID(),
        },
      )
    ).status,
    403,
  );
  assert.equal(
    (await send('POST', '/api/v1/auth/login', Buffer.alloc(18 * 1024 * 1024))).status,
    413,
  );
  assert.equal(
    (await send('GET', '/api/v1/capabilities')).body.serverId,
    (await h.send('GET', '/api/v1/capabilities')).body.serverId,
  );
  // Bad upstream trust must produce a gateway failure, never a verification bypass.
  await stop(proxy);
  proxy = undefined;
  const wrong = await tlsFixture();
  try {
    await writeFile(configuration.apiCA, wrong.ca);
  } finally {
    await wrong.close();
  }
  proxy = startProxy();
  await providePassphrase(proxy);
  let rejected: Response | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      rejected = await send('GET', '/api/v1/health/ready');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(rejected?.status, 502, 'Unknown API CA must fail closed.');
  await checkOtherSite();
  await stop(proxy);
  proxy = undefined;
  await writeFile(configuration.apiCA, h.ca);
  proxy = startProxy();
  await providePassphrase(proxy);
  await waitProxy();
  const browser = await chromium.launch({ headless: true });
  try {
    // Disposable synthetic browser context only; Node and the proxy independently
    // verify both TLS hops. No system/browser trust configuration is changed.
    const page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(origin);
    await page.getByLabel('Username').fill('owner');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await page
      .getByRole('combobox', { name: 'Profile', exact: true })
      .selectOption(created.body.id as string);
    await page.getByText('A few changes need your attention', { exact: true }).waitFor();
    await mkdir('artifacts/phase-4', { recursive: true });
    await page.screenshot({
      path: `artifacts/phase-4/staging-${sharedHost ? 'jammy-shared-' : 'web-'}${process.platform}-1440.png`,
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
  let rateLimited = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await send('POST', '/api/v1/auth/login', {}, { origin })).status === 429) {
      rateLimited = true;
      break;
    }
  }
  assert(rateLimited, 'Login request rate must be bounded at the gateway.');
  const monitorEnv = {
    ...process.env,
    ATTUNER_MONITOR_CA: configuration.apiCA,
    ATTUNER_INTERNAL_TLS_NAME: 'localhost',
    ATTUNER_MONITOR_PORT: String(apiPort),
  };
  async function runMonitor() {
    const child = track(
      spawn(process.execPath, [resolve('apps/api/src/monitor.ts')], {
        env: monitorEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    let stdout = '';
    child.stdout!.on('data', (bytes: Buffer) => {
      if (stdout.length < 8192) stdout += bytes.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const [status] = await once(child, 'close');
      return { status, stdout };
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  }
  const healthyMonitor = await runMonitor();
  assert.equal(healthyMonitor.status, 0);
  assert.equal(JSON.parse(healthyMonitor.stdout).ready, true);
  await h.quiesceStorage();
  assert.equal((await send('GET', '/api/v1/health/ready')).status, 502);
  await checkOtherSite();
  assert.equal(await readFile(join(root, 'nginx.conf'), 'utf8'), master);
  assert.equal(await readFile(join(root, 'attuner-staging.conf'), 'utf8'), include);
  const failedMonitor = await runMonitor();
  assert.equal(failedMonitor.status, 1);
  assert.equal(JSON.parse(failedMonitor.stdout).ready, false);
  await stop(proxy);
  proxy = undefined;
  proxyLogs = await readFile(configuration.accessLog!, 'utf8');
  assert(proxyLogs.length < 1024 * 1024);
  assert(!proxyLogs.includes(password));
  assert(!proxyLogs.includes(owner.cookie));
  assert(!proxyLogs.includes(owner.csrfToken));
  for (const line of proxyLogs.trim().split('\n')) {
    const event = JSON.parse(line);
    assert.equal(event.event, 'proxy.request');
    assert(!('uri' in event || 'headers' in event || 'remoteAddress' in event));
  }
  await writeFile(
    `artifacts/phase-4/staging-qualification-${sharedHost ? 'jammy-shared-' : ''}${process.platform}.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        environment: docker
          ? 'Linux container on hosted CI; loopback only'
          : `${process.platform} local Nginx; loopback only`,
        nginx: docker
          ? tools.validationImage
          : spawnSync(nginxBinary, ['-v'], { encoding: 'utf8' }).stderr.trim(),
        sharedHostInclude: sharedHost,
        unrelatedSyntheticSitePreserved: sharedHost,
        sharedHttpsListenerAndDefaultPreserved: sharedHost,
        checks: [
          'configuration syntax',
          'two verified TLS hops',
          'secure-cookie login',
          'scoped three-device enrollment',
          'two immutable revisions',
          'DPoP through proxy',
          'unknown-upstream-CA rejection',
          'real Next.js dashboard',
          'credential-free proxy logs',
          'CSRF origin rejection',
          'oversized request rejection',
          'login rate limit',
          'healthy/outage monitor',
        ],
        deployed: false,
        systemdServicesActivated: false,
        systemdEncryptedCredentialProvisioningQualified: false,
        realInstallationsAccessed: false,
        signedDistribution: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Staging qualification passed: verified TLS proxy, real API/Next.js, three scoped devices, immutable revisions, fail-closed upstream trust and sanitized logs. Nothing deployed.',
  );
} finally {
  await stop(proxy);
  await stop(web);
  for (const child of children) await stop(child);
  await h.close();
  await tls.close();
  await rm(root, { recursive: true });
}
