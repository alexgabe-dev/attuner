import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderProxy } from '../infrastructure/staging/nginx.ts';
const [origin, directory] = process.argv.slice(2);
if (!origin || !directory || process.argv.length !== 4)
  throw new Error('Usage: render-staging.ts <https://staging-hostname> <new-output-directory>');
const url = new URL(origin);
if (url.port || url.hostname === 'localhost' || /^[0-9.]+$/.test(url.hostname))
  throw new Error(
    'Supply the planned dedicated HTTPS DNS hostname on port 443. Nothing is deployed.',
  );
const configuration = renderProxy({
  origin,
  listen: '443',
  apiPort: 4317,
  webPort: 4318,
  apiCA: '/etc/attuner-staging/api-ca.pem',
  apiName: 'attuner-api.internal',
  edgeCertificate: '/etc/attuner-staging/edge-cert.pem',
  edgeKey: '/run/credentials/attuner-staging-proxy.service/edge-tls-key',
  passwordFile: '/run/credentials/attuner-staging-proxy.service/edge-tls-passphrase',
  pid: '/run/attuner-staging-proxy/nginx.pid',
  cache: '/var/cache/attuner-staging-proxy',
});
const output = resolve(directory);
await mkdir(output, { mode: 0o700 });
await writeFile(join(output, 'nginx.conf'), configuration, { flag: 'wx', mode: 0o600 });
await writeFile(
  join(output, 'service.env'),
  [
    '# Non-secret settings only. Secrets use LoadCredentialEncrypted.',
    'ATTUNER_NODE=/opt/attuner/toolchains/node-v24.22.2-linux-x64/bin/node',
    'ATTUNER_HOST=127.0.0.1',
    'ATTUNER_PORT=4317',
    'ATTUNER_DATA_DIR=/srv/attuner-staging/data',
    'ATTUNER_TLS_CERT=/etc/attuner-staging/api-cert.pem',
    `ATTUNER_PUBLIC_ORIGIN=${url.origin}`,
    'ATTUNER_TRUST_LOOPBACK_PROXY=1',
    'ATTUNER_DISK_RESERVE_BYTES=536870912',
    'ATTUNER_MONITOR_CA=/etc/attuner-staging/api-ca.pem',
    'ATTUNER_INTERNAL_TLS_NAME=attuner-api.internal',
    'NEXT_TELEMETRY_DISABLED=1',
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o600 },
);
for (const name of await readdir('infrastructure/staging')) {
  if (!/\.(?:service|timer|sh|json)$/.test(name)) continue;
  await copyFile(join('infrastructure/staging', name), join(output, name));
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
