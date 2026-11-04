import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [directory, platform] = process.argv.slice(2);
if (
  !directory ||
  !['macos', 'windows'].includes(platform ?? '') ||
  !process.env.TAURI_SIGNING_PRIVATE_KEY ||
  !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
)
  throw new Error('Configured encrypted updater signing credentials and platform required.');
const version = JSON.parse(await readFile('package.json', 'utf8')).version as string;
const entries = (await readdir(directory)).filter((name) =>
  platform === 'macos' ? name.endsWith('.app.zip') : name === 'Attuner-setup.exe',
);
if (entries.length !== 1) throw new Error('Expected exactly one updater artifact.');
// Environment delivery: private key/password never become command-line arguments.
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
for (const name of entries) {
  const args = [
    '--filter',
    '@attuner/desktop',
    'tauri',
    'signer',
    'sign',
    '--app-version',
    version,
    resolve(join(directory, name)),
  ];
  // Windows .cmd requires cmd.exe; every argument is fixed or an owned CI artifact
  // path, restricted before invoking the shell. Secrets stay in the environment.
  if (process.platform === 'win32') {
    if (args.some((arg) => /[&|<>^%!"\r\n]/.test(arg)))
      throw new Error('Unsafe Windows signing argument.');
    execFileSync(
      'cmd.exe',
      ['/d', '/s', '/c', [executable, ...args.map((arg) => `"${arg}"`)].join(' ')],
      { stdio: 'pipe' },
    );
  } else execFileSync(executable, args, { stdio: 'pipe' });
}
