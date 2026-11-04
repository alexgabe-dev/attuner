import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
const temporary = process.env.RUNNER_TEMP;
if (process.env.CI !== 'true' || !temporary || !process.env.GITHUB_ENV)
  throw new Error('This helper is restricted to an ephemeral CI runner.');
if (process.argv[2] === 'create') {
  const key = process.env.ATTUNER_APPLE_API_PRIVATE_KEY;
  if (!key?.startsWith('-----BEGIN PRIVATE KEY-----') || key.length > 8192)
    throw new Error('A configured App Store Connect private key is required.');
  const directory = await mkdtemp(join(temporary, 'attuner-notary-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'AuthKey.p8');
  await writeFile(path, key, { flag: 'wx', mode: 0o600 });
  await appendFile(process.env.GITHUB_ENV, `APPLE_API_KEY_PATH=${path}\n`);
} else if (process.argv[2] === 'remove') {
  const path = process.env.APPLE_API_KEY_PATH;
  if (
    path &&
    dirname(dirname(path)) === temporary &&
    basename(dirname(path)).startsWith('attuner-notary-') &&
    basename(path) === 'AuthKey.p8'
  )
    await rm(dirname(path), { recursive: true });
} else throw new Error('Expected create or remove.');
