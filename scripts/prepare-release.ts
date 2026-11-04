import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { checkReleaseVersions, writeReleaseManifest } from './release-policy.ts';

const [command, directory, platform, mode] = process.argv.slice(2);
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version as string;
const desktopVersion = JSON.parse(await readFile('apps/desktop/package.json', 'utf8'))
  .version as string;
const config = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
const cargo = await readFile('Cargo.toml', 'utf8');
const rustVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1] ?? '';
const version = checkReleaseVersions([packageVersion, desktopVersion, config.version, rustVersion]);
if (config.identifier !== 'app.attuner.desktop') throw new Error('Application identity changed.');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirtySource =
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
    .length > 0;
if (process.env.CI === 'true' && dirtySource)
  throw new Error('CI distribution requires a clean source checkout.');
if (command === 'preflight') {
  console.log(`Attuner ${version}; protocol 1; namespace 1; identity ${config.identifier}`);
} else if (
  command === 'manifest' &&
  directory &&
  (platform === 'macos' || platform === 'windows') &&
  (mode === 'development' || mode === 'signed')
) {
  await writeReleaseManifest({
    directory,
    platform,
    mode,
    sourceCommit,
    version,
    dirtySource,
    architecture:
      process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch,
  });
} else {
  throw new Error(
    'Usage: prepare-release.ts preflight | manifest <directory> <macos|windows> <development|signed>',
  );
}
