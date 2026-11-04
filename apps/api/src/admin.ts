import { DatabaseWorker } from '@attuner/database';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Security } from './security/service.ts';
import { StringDecoder } from 'node:string_decoder';
import { assertRestoreReady } from './maintenance/recovery.ts';
import { LocalAccounts } from './security/local-accounts.ts';
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
if (
  !['bootstrap', 'reset', 'users', 'user-create', 'user-disable', 'user-reset'].includes(
    command ?? '',
  ) ||
  (command !== 'users' && !username) ||
  process.argv.length > 4
)
  throw new Error(
    'Usage: admin bootstrap|reset|user-create|user-disable|user-reset <username>, or admin users [after-username]. Passwords are prompted locally.',
  );
const password = ['bootstrap', 'reset', 'user-create', 'user-reset'].includes(command!)
  ? await readPassword()
  : undefined;
const directory = resolve(process.env.ATTUNER_DATA_DIR ?? '../../.runtime');
await mkdir(directory, { recursive: true, mode: 0o700 });
await assertRestoreReady(directory);
const database = await DatabaseWorker.open(resolve(directory, 'attuner.sqlite'));
const security = new Security(database, { key: randomBytes(32), origin: () => '' });
try {
  if (command === 'bootstrap') {
    await security.bootstrap(username!, password!);
    console.log('Administrator created. No public registration is enabled.');
  } else if (command === 'reset') {
    await security.recoverAdministrator(username!, password!);
    console.log(
      'Administrator password reset. Existing web sessions and owned device access were revoked.',
    );
  } else {
    const accounts = new LocalAccounts(security);
    if (command === 'users') console.log(JSON.stringify(await accounts.list(username), null, 2));
    else if (command === 'user-create') {
      await accounts.create(username!, password!);
      console.log('Local user created. No existing profiles or administrator privileges granted.');
    } else {
      await accounts.change(username!, command === 'user-disable' ? 'disable' : 'reset', password);
      console.log(
        command === 'user-disable'
          ? 'Local user disabled. Sessions, device credentials and pending approvals revoked.'
          : 'Local user recovered with a new password. Existing sessions, devices and approvals remain revoked; enroll new devices explicitly.',
      );
    }
  }
} finally {
  await database.close();
}
