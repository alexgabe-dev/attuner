import { DatabaseWorker } from '@attuner/database';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Security } from './security/service.ts';
import { passwordHash } from './security/primitives.ts';
import { StringDecoder } from 'node:string_decoder';
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
const database = await DatabaseWorker.open(resolve(directory, 'attuner.sqlite'));
const security = new Security(database, { key: randomBytes(32), origin: () => '' });
try {
  if (command === 'bootstrap') {
    await security.bootstrap(username, password);
    console.log('Administrator created. No public registration is enabled.');
  } else {
    const hash = await passwordHash(password),
      rows = await database.query<{ id: string }>(
        "SELECT u.id FROM web_users u JOIN user_security s ON s.user_id=u.id WHERE u.username=? AND s.role='administrator'",
        [username.toLowerCase()],
      );
    if (!rows[0]) throw new Error('Administrator not found.');
    const id = rows[0].id,
      now = security.now();
    await database.transaction([
      { sql: 'UPDATE web_users SET password_hash=? WHERE id=?', params: [hash, id] },
      { sql: 'UPDATE user_security SET epoch=epoch+1 WHERE user_id=?', params: [id] },
      {
        sql: 'UPDATE devices SET revoked_at=coalesce(revoked_at,?) WHERE id IN (SELECT device_id FROM device_owners WHERE user_id=?)',
        params: [now, id],
      },
      ...security.auditStatements({ kind: 'user', id }, 'administrator.recovered', 'local-cli'),
    ]);
    console.log(
      'Administrator password reset. Existing web sessions and owned device access were revoked.',
    );
  }
} finally {
  await database.close();
}
