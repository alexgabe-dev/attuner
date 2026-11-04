import { resolve } from 'node:path';
import { backupStatus } from './maintenance/status.ts';
const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error('Usage: backup-status.ts <private-backup-directory>');
const result = await backupStatus(
  resolve(directory),
  Number(process.env.ATTUNER_BACKUP_MAX_AGE_SECONDS ?? '86400'),
);
console.log(
  JSON.stringify({
    event: 'monitor.backup-receipt',
    ...result,
    checkedAt: new Date().toISOString(),
  }),
);
process.exitCode = result.freshReceipt ? 0 : 1;
