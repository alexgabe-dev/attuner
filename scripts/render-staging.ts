import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderProxy } from '../infrastructure/staging/nginx.ts';
import { jammy, jammyUnit, slice, logrotate, journal } from '../infrastructure/staging/jammy.ts';
import { parseArgs } from 'node:util';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'api-port': { type: 'string', default: '4317' },
    'web-port': { type: 'string', default: '4318' },
    certificate: { type: 'string', default: '/etc/attuner-staging/edge-cert.pem' },
    key: { type: 'string', default: '/etc/attuner-staging/edge-key.pem' },
  },
});
const [origin, directory] = positionals;
if (!origin || !directory || positionals.length !== 2)
  throw new Error(
    'Usage: render-staging.ts <https://dedicated-hostname> <new-output-directory> [--api-port N --web-port N --certificate PATH --key PATH]',
  );
const url = new URL(origin);
if (
  url.port ||
  ['localhost', 'pry.hu'].includes(url.hostname) ||
  /^[0-9.]+$/.test(url.hostname) ||
  url.hostname.length > 253 ||
  !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
  !url.hostname.includes('.')
)
  throw new Error(
    'Supply the planned dedicated HTTPS DNS hostname on port 443. Nothing is deployed.',
  );
const apiPort = Number(values['api-port']),
  webPort = Number(values['web-port']);
if (apiPort === webPort) throw new Error('API/dashboard require distinct loopback ports.');
const configuration = renderProxy({
  origin,
  listen: '443',
  hosted: true,
  apiPort,
  webPort,
  apiCA: '/etc/attuner-staging/api-ca.pem',
  apiName: 'attuner-api.internal',
  edgeCertificate: values.certificate!,
  edgeKey: values.key!,
  pid: '/run/attuner-staging-proxy/nginx.pid',
  cache: '/var/cache/attuner-staging',
  accessLog: '/var/log/attuner-staging/access.log',
});
const output = resolve(directory);
await mkdir(output, { mode: 0o700 });
await writeFile(join(output, 'attuner-staging.conf'), configuration, { flag: 'wx', mode: 0o600 });
await writeFile(join(output, 'attuner-staging.slice'), slice, { flag: 'wx', mode: 0o600 });
await writeFile(join(output, 'attuner-staging.logrotate'), logrotate, { flag: 'wx', mode: 0o600 });
await writeFile(join(output, 'journald-attuner-staging.conf'), journal, {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  join(output, 'service.env'),
  [
    '# Ubuntu 22.04 / systemd 249. Non-secret settings only. Explicit tmpfs unlock + LoadCredential.',
    'ATTUNER_NODE=/opt/attuner/toolchains/node-v24.22.2-linux-x64/bin/node',
    'ATTUNER_HOST=127.0.0.1',
    `ATTUNER_PORT=${apiPort}`,
    `ATTUNER_WEB_PORT=${webPort}`,
    `ATTUNER_MONITOR_PORT=${apiPort}`,
    'ATTUNER_DATA_DIR=/srv/attuner-staging/data',
    'ATTUNER_TLS_CERT=/etc/attuner-staging/api-cert.pem',
    `ATTUNER_PUBLIC_ORIGIN=${url.origin}`,
    'ATTUNER_TRUST_LOOPBACK_PROXY=1',
    'ATTUNER_DISK_RESERVE_BYTES=10737418240',
    'ATTUNER_MONITOR_CA=/etc/attuner-staging/api-ca.pem',
    'ATTUNER_INTERNAL_TLS_NAME=attuner-api.internal',
    'NEXT_TELEMETRY_DISABLED=1',
    'NODE_ENV=production',
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o600 },
);
for (const name of await readdir('infrastructure/staging')) {
  if (!/\.(?:service|timer|sh|json|py)$/.test(name) || name === 'attuner-staging-proxy.service')
    continue;
  if (name.endsWith('.service')) {
    await writeFile(
      join(output, name),
      jammyUnit(name, await readFile(join('infrastructure/staging', name), 'utf8')),
      { flag: 'wx', mode: 0o600 },
    );
  } else await copyFile(join('infrastructure/staging', name), join(output, name));
}
await writeFile(join(output, 'README.md'), await readFile('docs/operations/staging.md'), {
  flag: 'wx',
  mode: 0o600,
});
const files = [];
for (const name of (await readdir(output)).sort()) {
  files.push({
    name,
    sha256: createHash('sha256')
      .update(await readFile(join(output, name)))
      .digest('hex'),
  });
}
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      target: jammy,
      sharedNginx: true,
      apiPort,
      webPort,
      activationApproved: false,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirtySource:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          encoding: 'utf8',
        }).length > 0,
      publicOrigin: url.origin,
      files,
      deployed: false,
      containsSecrets: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(
  `Prepared local staging files in ${output}. No installation, service activation or deployment was performed.`,
);
