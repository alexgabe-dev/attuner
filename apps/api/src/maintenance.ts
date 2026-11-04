import { readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBackup, restoreBackup } from './maintenance/recovery.ts';
import { readConfig } from './config.ts';

const args = process.argv.slice(2);
const keyFlag = args.indexOf('--key-fd');
if (keyFlag < 0 || keyFlag !== args.length - 2 || !/^\d{1,3}$/.test(args[keyFlag + 1] ?? ''))
  throw new Error(
    'Supply a 32-byte backup key through --key-fd <descriptor>, never an argument value.',
  );
const descriptor = Number(args[keyFlag + 1]);
if (descriptor < 3)
  throw new Error('Use a dedicated inherited descriptor >= 3 for backup credentials.');
const key = Buffer.alloc(33);
let size = 0;
try {
  for (;;) {
    const count = readSync(descriptor, key, size, key.length - size, null);
    if (!count) break;
    size += count;
    if (size === key.length) throw new Error('The backup key must be exactly 32 raw bytes.');
  }
} finally {
  closeSync(descriptor);
}
if (size !== 32) {
  key.fill(0);
  throw new Error('The backup key must be exactly 32 raw bytes.');
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => controller.abort(new Error('MAINTENANCE_CANCELLED')));
try {
  const [command, first, second] = args.slice(0, keyFlag);
  const options = {
    key: key.subarray(0, 32),
    signal: controller.signal,
    diskReserveBytes: readConfig().diskReserveBytes,
  };
  if (command === 'backup' && first && !second) {
    if (!process.env.ATTUNER_DATA_DIR)
      throw new Error('Set ATTUNER_DATA_DIR explicitly to the private service data directory.');
    const data = resolve(process.env.ATTUNER_DATA_DIR);
    const result = await createBackup(data, resolve(first), options);
    console.log(JSON.stringify({ operation: 'backup', ...result }));
  } else if (command === 'restore' && first && second && keyFlag === 3) {
    const result = await restoreBackup(resolve(first), resolve(second), options);
    console.log(JSON.stringify({ operation: 'restore', ...result }));
  } else
    throw new Error(
      'Usage: maintenance.ts backup <new-backup-directory> --key-fd 3 | restore <backup-directory> <new-data-directory> --key-fd 3',
    );
} finally {
  key.fill(0);
}
