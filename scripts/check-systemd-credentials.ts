// Hosted Linux qualification only. One transient, non-networked unit reads a
// public marker, not an authentication secret. No installation/deployment/key.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeCredential } from '../apps/api/src/credentials.ts';
const execute = promisify(execFile),
  marker = 'attuner-public-qualification-marker';
if (process.argv[2] === 'probe') {
  assert.equal(process.platform, 'linux');
  assert(process.getuid!() > 0);
  assert.match(
    process.env.CREDENTIALS_DIRECTORY ?? '',
    /^\/run\/credentials\/attuner-credential-qualification-[0-9a-f-]+\.service$/,
  );
  const bytes = await runtimeCredential('token-delivery-key', 64);
  assert(bytes);
  assert(bytes.equals(Buffer.from(marker)));
  bytes.fill(0);
  const file = await lstat(join(process.env.CREDENTIALS_DIRECTORY!, 'token-delivery-key'));
  const privateOwner = process.argv[3] === 'service-owner';
  // Jammy's native 249 delivers service-owned private files on this runner;
  // 255 qualification must still exercise its separate root-owned ACL branch.
  assert.equal(file.uid, privateOwner ? process.getuid!() : 0);
  console.log(
    JSON.stringify({
      passed: true,
      rootOwnedAclPathExercised: !privateOwner,
      privateOwnerPathExercised: privateOwner,
      fileMode: (file.mode & 0o777).toString(8),
    }),
  );
} else {
  if (
    process.platform !== 'linux' ||
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.getuid!() === 0
  )
    throw new Error(
      'This transient-unit probe runs only on the isolated non-root hosted Linux CI runner.',
    );
  assert.equal((await readFile('/proc/1/comm', 'utf8')).trim(), 'systemd');
  const unit = `attuner-credential-qualification-${randomUUID()}.service`;
  const loadMarker = process.argv.includes('--load-marker');
  const { stdout: version } = await execute('systemd', ['--version'], {
    encoding: 'utf8',
    maxBuffer: 4096,
    timeout: 2000,
  });
  const privateOwner = loadMarker && /^systemd 249\b/.test(version);
  const publicSource = loadMarker
    ? await mkdtemp(join(tmpdir(), 'attuner-public-credential-probe-'))
    : undefined;
  if (publicSource)
    await writeFile(join(publicSource, 'marker'), marker, { mode: 0o600, flag: 'wx' });
  let stdout: string;
  try {
    ({ stdout } = await execute(
      'sudo',
      [
        '--non-interactive',
        'systemd-run',
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        `--unit=${unit}`,
        `--property=User=${process.getuid!()}`,
        `--property=Group=${process.getgid!()}`,
        `--property=WorkingDirectory=${process.cwd()}`,
        '--property=NoNewPrivileges=yes',
        '--property=PrivateTmp=yes',
        '--property=ProtectSystem=strict',
        '--property=ProtectHome=read-only',
        '--property=PrivateNetwork=yes',
        '--property=LimitCORE=0',
        '--property=RuntimeMaxSec=30',
        publicSource
          ? `--property=LoadCredential=token-delivery-key:${join(publicSource, 'marker')}`
          : `--property=SetCredential=token-delivery-key:${marker}`,
        process.execPath,
        '--import',
        'tsx',
        'scripts/check-systemd-credentials.ts',
        'probe',
        privateOwner ? 'service-owner' : 'root-acl',
      ],
      { encoding: 'utf8', maxBuffer: 16384, timeout: 40000 },
    ));
    const probe = JSON.parse(stdout.trim()) as {
      passed: boolean;
      rootOwnedAclPathExercised: boolean;
      privateOwnerPathExercised: boolean;
      fileMode: string;
    };
    assert.equal(probe.passed, true);
    assert.equal(probe.rootOwnedAclPathExercised, !privateOwner);
    assert.equal(probe.privateOwnerPathExercised, privateOwner);
    await writeFile(
      loadMarker
        ? '.runtime/jammy-systemd-credential-qualification.json'
        : 'artifacts/phase-4/systemd-credential-qualification-linux.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          sourceCommit: process.env.GITHUB_SHA,
          systemd: version.split('\n')[0],
          probe,
          scope: `One owned transient non-networked unit; public non-secret ${loadMarker ? 'LoadCredential' : 'SetCredential'} marker only.`,
          installationPerformed: false,
          attunerServicesActivated: false,
          vpsAccessed: false,
          encryptedCredentialProvisioningQualified: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Actual systemd ${privateOwner ? 'private service-owned credential' : 'root-owned service-user ACL'} loading passed; no secrets, installation or deployment.`,
    );
  } finally {
    // UUID-scoped unit only; --collect normally already unloaded it. Never stop
    // Attuner/user services or alter the host credential key/global ACLs.
    await execute('sudo', ['--non-interactive', 'systemctl', 'stop', unit], {
      encoding: 'utf8',
      maxBuffer: 4096,
      timeout: 10000,
    }).catch(() => undefined);
    const state = await execute(
      'sudo',
      ['--non-interactive', 'systemctl', 'show', '--property=ActiveState', '--value', unit],
      { encoding: 'utf8', maxBuffer: 4096, timeout: 10000 },
    ).catch((error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      if (
        [1, 4].includes(failure.code ?? 0) &&
        failure.stderr?.includes(unit) &&
        /not found|could not be found|not loaded/.test(failure.stderr)
      )
        return { stdout: 'inactive' };
      throw error;
    });
    assert(
      ['inactive', 'failed'].includes(state.stdout.trim()),
      'Owned credential probe must not remain active',
    );
    if (publicSource) await rm(publicSource, { recursive: true });
  }
}
