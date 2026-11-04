import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [app, output] = process.argv.slice(2);
const team = process.env.ATTUNER_APPLE_TEAM_ID;
if (
  process.platform !== 'darwin' ||
  !app?.endsWith('/Attuner.app') ||
  !output ||
  !/^[A-Z0-9]{10}$/.test(team ?? '')
)
  throw new Error(
    'macOS, an Attuner bundle, output directory and expected Apple team are required.',
  );
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' });
// codesign writes public signature metadata to stderr.
const { spawnSync } = await import('node:child_process');
const metadata = spawnSync('codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
if (
  metadata.status !== 0 ||
  !metadata.stderr.includes(`TeamIdentifier=${team}\n`) ||
  !metadata.stderr.includes('Authority=Developer ID Application:') ||
  !metadata.stderr.includes('Identifier=app.attuner.desktop\n') ||
  !/flags=.*\bruntime\b/.test(metadata.stderr)
)
  throw new Error('Expected Developer ID, application identity and hardened runtime are required.');
execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'pipe' });
execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'pipe' });
await writeFile(
  join(output, 'validation.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: 'macos',
      applicationIdentity: 'app.attuner.desktop',
      signatureVerified: true,
      notarizationVerified: true,
      hardenedRuntimeVerified: true,
      team,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
