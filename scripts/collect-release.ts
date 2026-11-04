import { execFileSync } from 'node:child_process';
import { copyFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const [platform, build, mode] = process.argv.slice(2);
if (
  !['macos', 'windows'].includes(platform ?? '') ||
  !['debug', 'release'].includes(build ?? '') ||
  !['development', 'signed'].includes(mode ?? '') ||
  (mode === 'signed' && build !== 'release')
)
  throw new Error('Expected platform, build and mode.');
const bundle = join('target', build!, 'bundle');
const output = 'artifacts-release';
if (platform === 'macos') {
  const app = resolve(bundle, 'macos', 'Attuner.app');
  if (mode === 'signed')
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/validate-macos-release.ts', app, output],
      { stdio: 'pipe' },
    );
  execFileSync('ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    app,
    join(output, 'Attuner.app.zip'),
  ]);
  const images = (await readdir(join(bundle, 'dmg'))).filter((name) => name.endsWith('.dmg'));
  if (images.length !== 1) throw new Error('Expected one DMG.');
  await copyFile(join(bundle, 'dmg', images[0]!), join(output, 'Attuner.dmg'));
} else {
  await copyFile(join('target', build!, 'attuner-desktop.exe'), join(output, 'Attuner.exe'));
  const installers = (await readdir(join(bundle, 'nsis'))).filter((name) => name.endsWith('.exe'));
  if (installers.length !== 1) throw new Error('Expected one NSIS installer.');
  await copyFile(join(bundle, 'nsis', installers[0]!), join(output, 'Attuner-setup.exe'));
}
