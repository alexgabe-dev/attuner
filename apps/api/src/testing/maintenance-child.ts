// Private synthetic fault harness. Never imported by the API or exposed over HTTP.
import { readSync, closeSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { createBackup, restoreBackup } from '../maintenance/recovery.ts';
if (process.env.ATTUNER_MAINTENANCE_FIXTURE !== '1')
  throw new Error('Synthetic test harness only.');
const [root, operation, input, output, boundary] = process.argv.slice(2);
if (
  !root ||
  !boundary ||
  !input ||
  !output ||
  !['backup', 'restore'].includes(operation ?? '') ||
  dirname(await realpath(root)) !== (await realpath(tmpdir())) ||
  !basename(root).startsWith('attuner-server-recovery-test-') ||
  !/^[a-z0-9-]+$/.test(input) ||
  !/^[a-z0-9-]+$/.test(output)
)
  throw new Error('Invalid owned fixture handoff.');
const key = Buffer.alloc(33);
let size = 0;
try {
  for (;;) {
    const count = readSync(3, key, size, key.length - size, null);
    if (!count) break;
    size += count;
    if (size === 33) throw new Error('Invalid test key size.');
  }
} finally {
  closeSync(3);
}
if (size !== 32) throw new Error('Dedicated key descriptor required.');
const checkpoint = async (point: string) => {
  if (point !== boundary) return;
  process.stdout.write(`BOUNDARY:${point}\n`);
  // The parent terminates this process. No graceful cleanup/SQLite close occurs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise<void>(() => {});
  } finally {
    clearInterval(keepAlive);
  }
};
try {
  const options = { key: key.subarray(0, 32), checkpoint };
  if (operation === 'backup') await createBackup(join(root, input), join(root, output), options);
  else await restoreBackup(join(root, input), join(root, output), options);
} finally {
  key.fill(0);
}
