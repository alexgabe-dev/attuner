import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ReleaseMode = 'development' | 'signed';
export type ReleasePlatform = 'macos' | 'windows';
export const applicationIdentity = 'app.attuner.desktop';

export function checkReleaseVersions(values: string[]): string {
  const version = values[0];
  if (
    !version ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(version)
  )
    throw new Error('A canonical SemVer version is required.');
  const prerelease = version.slice(version.indexOf('-') + 1);
  if (version.includes('-') && prerelease.split('.').some((part) => /^0\d+$/.test(part)))
    throw new Error('Numeric prerelease identifiers cannot have leading zeroes.');
  if (!values.every((value) => value === version)) throw new Error('Release versions disagree.');
  return version;
}

export function validateDistributionEvidence(value: unknown, platform: ReleasePlatform): void {
  const evidence = value as Record<string, unknown> | null;
  if (
    !evidence ||
    evidence.schemaVersion !== 1 ||
    evidence.platform !== platform ||
    evidence.applicationIdentity !== applicationIdentity ||
    evidence.signatureVerified !== true ||
    (platform === 'macos' &&
      (evidence.notarizationVerified !== true || evidence.hardenedRuntimeVerified !== true)) ||
    (platform === 'windows' &&
      (evidence.timestampVerified !== true || evidence.uninstallerSignatureVerified !== true))
  )
    throw new Error('Missing platform signature/notarization validation.');
}

export async function sha256File(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n) throw new Error('Unsafe release artifact.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 20n * 1024n ** 3n)
      throw new Error('Unsafe or oversized release artifact.');
    if (before.dev !== entry.dev || before.ino !== entry.ino)
      throw new Error('Artifact changed before open.');
    const hash = createHash('sha256');
    let bytes = 0n;
    for await (const chunk of file.createReadStream({
      highWaterMark: 64 * 1024,
      autoClose: false,
    })) {
      bytes += BigInt(chunk.length);
      if (bytes > before.size) throw new Error('Artifact changed while hashing.');
      hash.update(chunk);
    }
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      bytes !== before.size
    )
      throw new Error('Artifact changed while hashing.');
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

export async function writeReleaseManifest(options: {
  directory: string;
  platform: ReleasePlatform;
  mode: ReleaseMode;
  sourceCommit: string;
  version: string;
  architecture: string;
  dirtySource?: boolean;
}): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('Full source commit required.');
  checkReleaseVersions([options.version]);
  if (!['aarch64', 'x86_64'].includes(options.architecture))
    throw new Error('Unsupported architecture.');
  const entries = (await readdir(options.directory)).sort();
  const suffixes = options.platform === 'macos' ? ['.app.zip', '.dmg'] : ['.exe'];
  const artifacts = entries.filter((name) => suffixes.some((suffix) => name.endsWith(suffix)));
  if (
    artifacts.length !== 2 ||
    !artifacts.every((name) => /^[A-Za-z0-9_.-]+$/.test(name)) ||
    (options.platform === 'macos' &&
      !suffixes.every((suffix) => artifacts.some((name) => name.endsWith(suffix)))) ||
    (options.platform === 'windows' &&
      (!artifacts.includes('Attuner.exe') || !artifacts.includes('Attuner-setup.exe')))
  )
    throw new Error('Expected exactly the application and installer artifacts.');
  let updater: { artifact: string; signature: string } | undefined;
  if (options.mode === 'signed') {
    if (options.dirtySource) throw new Error('Signed artifacts require a clean source checkout.');
    validateDistributionEvidence(
      JSON.parse(await readFile(join(options.directory, 'validation.json'), 'utf8')),
      options.platform,
    );
    if (options.platform === 'macos') {
      const notarization = JSON.parse(
        await readFile(join(options.directory, 'notarization.json'), 'utf8'),
      );
      if (notarization.status !== 'Accepted' || notarization.diskImageVerified !== true)
        throw new Error('Disk image notarization required.');
    }
    const artifact = options.platform === 'macos' ? 'Attuner.app.zip' : 'Attuner-setup.exe';
    const signatureFile = join(options.directory, artifact + '.sig');
    const signatureInfo = await lstat(signatureFile);
    if (!signatureInfo.isFile() || signatureInfo.nlink !== 1 || signatureInfo.size > 4096)
      throw new Error('Unsafe updater signature.');
    const signature = (await readFile(signatureFile, 'utf8')).trim();
    if (signature.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(signature))
      throw new Error('Missing updater signature.');
    updater = { artifact, signature };
  }
  const files = [];
  for (const name of artifacts) {
    files.push({ name, sha256: await sha256File(join(options.directory, name)) });
  }
  const manifest = {
    schemaVersion: 1,
    applicationIdentity,
    version: options.version,
    sourceCommit: options.sourceCommit,
    dirtySource: options.dirtySource ?? false,
    platform: options.platform,
    architecture: options.architecture,
    mode: options.mode,
    updater,
    files,
    protocolVersion: 1,
    namespaceVersion: 1,
    automaticUpdatesEnabled: false,
    publicDistributionReady: false,
    remainingGates: [
      ...(options.mode === 'development' ? ['signing-notarization'] : []),
      'windows-11-recovery',
      'signed-upgrade-credentials',
      'beta-release-review',
    ],
  };
  await writeFile(
    join(options.directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
}
