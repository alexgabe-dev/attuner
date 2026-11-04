import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { backupReceiptSchema } from './recovery.ts';
import { digestFile, privateDirectory } from './crypto.ts';

/** Operational freshness only. This cannot authenticate/decrypt a backup and
 * never authorizes restore/retention. Full drills remain independently required. */
export async function backupStatus(directory: string, maximumAgeSeconds = 86400, now = Date.now()) {
  let completed = 0,
    incomplete = 0,
    newest: { time: number; catalog: string; hash: string } | undefined;
  let reason: string;
  try {
    if (
      !Number.isSafeInteger(maximumAgeSeconds) ||
      maximumAgeSeconds < 60 ||
      maximumAgeSeconds > 31536000
    )
      throw new Error('Invalid freshness policy.');
    await privateDirectory(directory);
    const entries = await opendir(directory);
    let count = 0;
    for await (const entry of entries) {
      if (++count > 1000)
        return {
          freshReceipt: false,
          completed,
          incomplete,
          newestAgeSeconds: null,
          reason: 'inventory_limit',
        };
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        incomplete++;
        continue;
      }
      try {
        const folder = join(directory, entry.name);
        await privateDirectory(folder);
        const file = await open(
          join(folder, 'receipt.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let parsed, info;
        try {
          info = await file.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > 8192)
            throw new Error('Invalid receipt.');
          const bytes = Buffer.alloc(8193);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== info.size) throw new Error('Receipt changed.');
          parsed = backupReceiptSchema.parse(
            JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
          );
        } finally {
          await file.close();
        }
        const catalog = join(folder, 'catalog.sealed'),
          object = await lstat(catalog);
        if (
          !object.isFile() ||
          object.isSymbolicLink() ||
          object.nlink !== 1 ||
          object.size < 36 ||
          object.size > 128 * 1024 ** 2 + 36
        )
          throw new Error('Invalid catalog.');
        if (info.mtimeMs > now + 300000) throw new Error('Future receipt.');
        completed++;
        if (!newest || info.mtimeMs > newest.time)
          newest = { time: info.mtimeMs, catalog, hash: parsed.catalogHash };
      } catch {
        incomplete++;
      }
    }
    reason = incomplete
      ? 'incomplete_capture'
      : !newest
        ? 'none'
        : now - newest.time > maximumAgeSeconds * 1000
          ? 'stale'
          : 'ready';
    if (newest && (await digestFile(newest.catalog, 128 * 1024 ** 2 + 36)).sha256 !== newest.hash)
      reason = 'catalog_corrupt';
  } catch {
    reason = 'unavailable';
  }
  return {
    freshReceipt: reason === 'ready',
    completed,
    incomplete,
    newestAgeSeconds: newest ? Math.max(0, Math.floor((now - newest.time) / 1000)) : null,
    reason,
  };
}
