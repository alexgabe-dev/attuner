import { DatabaseWorker } from '@attuner/database';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Security } from './security/service.ts';
import { StringDecoder } from 'node:string_decoder';
import { assertRestoreReady } from './maintenance/recovery.ts';
async function readPassword() {
  if (!process.stdin.isTTY)
    throw new Error(
      'Use an interactive terminal. Passwords are never read from arguments or files.',
    );
  process.stdout.write('Password (at least 12 bytes; input hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', read);
      process.stdout.write('\n');
    };
    const read = (buffer: Buffer) => {
      for (const character of decoder.write(buffer)) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === '\u007f') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ' && Buffer.byteLength(value) < 1024) value += character;
      }
    };
    process.stdin.on('data', read);
  });
}
const command = process.argv[2],
  username = process.argv[3];
if (!['bootstrap', 'reset'].includes(command ?? '') || !username)
  throw new Error('Usage: pnpm --filter @attuner/api admin bootstrap|reset <username>');
const password = await readPassword();
const directory = resolve(process.env.ATTUNER_DATA_DIR ?? '../../.runtime');
await mkdir(directory, { recursive: true, mode: 0o700 });
await assertRestoreReady(directory);
const database = await DatabaseWorker.open(resolve(directory, 'attuner.sqlite'));
const security = new Security(database, { key: randomBytes(32), origin: () => '' });
try {
  if (command === 'bootstrap') {
    await security.bootstrap(username, password);
    console.log('Administrator created. No public registration is enabled.');
  } else {
    await security.recoverAdministrator(username, password);
    console.log(
      'Administrator password reset. Existing web sessions and owned device access were revoked.',
    );
  }
} finally {
  await database.close();
}
