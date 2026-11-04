import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [directory] = process.argv.slice(2);
const identity = process.env.APPLE_SIGNING_IDENTITY;
const keyPath = process.env.APPLE_API_KEY_PATH;
const keyID = process.env.APPLE_API_KEY;
const issuer = process.env.APPLE_API_ISSUER;
if (
  process.platform !== 'darwin' ||
  !directory ||
  !identity?.startsWith('Developer ID Application:') ||
  !keyPath ||
  !keyID ||
  !issuer
)
  throw new Error('Configured macOS signing and notarization are required.');
const image = join(directory, 'Attuner.dmg');
execFileSync('codesign', ['--force', '--sign', identity, '--timestamp', image], { stdio: 'pipe' });
const reply = execFileSync(
  'xcrun',
  [
    'notarytool',
    'submit',
    image,
    '--key',
    keyPath,
    '--key-id',
    keyID,
    '--issuer',
    issuer,
    '--wait',
    '--output-format',
    'json',
  ],
  { encoding: 'utf8', stdio: 'pipe', timeout: 30 * 60 * 1000 },
);
const result = JSON.parse(reply);
if (result.status !== 'Accepted' || typeof result.id !== 'string')
  throw new Error('Disk image notarization was not accepted.');
execFileSync('xcrun', ['stapler', 'staple', image], { stdio: 'pipe' });
execFileSync('xcrun', ['stapler', 'validate', image], { stdio: 'pipe' });
execFileSync('codesign', ['--verify', '--strict', image], { stdio: 'pipe' });
execFileSync(
  'spctl',
  ['--assess', '--type', 'open', '--context', 'context:primary-signature', image],
  { stdio: 'pipe' },
);
await writeFile(
  join(directory, 'notarization.json'),
  JSON.stringify(
    { schemaVersion: 1, requestID: result.id, status: result.status, diskImageVerified: true },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
