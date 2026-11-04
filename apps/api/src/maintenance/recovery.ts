import { mkdir, mkdtemp, open, rm, statfs, lstat, type FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { openMaintenanceDatabase } from '@attuner/database';
import { z } from 'zod';
import {
  decryptFile,
  digestFile,
  encryptFile,
  privateDirectory,
  syncDirectory,
  type Checkpoint,
} from './crypto.ts';
import {
  appendMaintenanceAudit,
  assertKnownSchema,
  referencedObjects,
  verifyDatabase,
  type VerificationSummary,
} from './verify.ts';

const databaseLimit = 4 * 1024 ** 3,
  objectLimit = 1024 ** 3,
  catalogLimit = 128 * 1024 ** 2;
const entryLimit = 1_000_000,
  totalLimit = 1024 ** 4;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const summarySchema = z.strictObject({
  serverId: z.uuid(),
  schemaHash: hash,
  snapshots: z.number().int().nonnegative(),
  profiles: z.number().int().nonnegative(),
  headsDigest: hash,
  auditCount: z.number().int().nonnegative(),
  auditMax: z.number().int().nonnegative(),
  auditDigest: hash,
});
const headerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  backupId: z.uuid(),
  summary: summarySchema,
  entryCount: z.number().int().min(1).max(entryLimit),
});
const entrySchema = z.strictObject({
  index: z.number().int().nonnegative(),
  relative: z.string().max(160),
  size: z.number().int().min(0).max(databaseLimit),
  sha256: hash,
  blake3: hash,
});
export const backupReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  backupId: z.uuid(),
  catalogHash: hash,
  entryCount: z.number().int().min(1).max(entryLimit),
  totalBytes: z.number().int().min(0).max(totalLimit),
});
type Options = {
  key: Buffer;
  signal?: AbortSignal;
  checkpoint?: Checkpoint;
  diskBudgetBytes?: number;
};
function control(options: Options): Checkpoint {
  return async (point) => {
    options.signal?.throwIfAborted();
    await options.checkpoint?.(point);
    options.signal?.throwIfAborted();
  };
}
function unix() {
  if (process.platform === 'win32') throw new Error('MAINTENANCE_UNSUPPORTED_PLATFORM');
}
async function smallJSON(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 8192)
      throw new Error('MAINTENANCE_INVALID_RECEIPT');
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1
    )
      throw new Error('MAINTENANCE_INVALID_RECEIPT');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}
async function* boundedLines(file: FileHandle): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of file.createReadStream({ highWaterMark: 4096, autoClose: false })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > 8192) throw new Error('MAINTENANCE_CATALOG_LINE_LIMIT');
      yield pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
    }
    if (pending.length > 8192) throw new Error('MAINTENANCE_CATALOG_LINE_LIMIT');
  }
  if (pending.length) throw new Error('MAINTENANCE_CATALOG_TRUNCATED');
}
async function writeJSON(path: string, value: unknown) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}
async function budget(directory: string, required: number, options: Options) {
  const space = await statfs(directory, { bigint: true });
  const available =
    options.diskBudgetBytes === undefined
      ? space.bavail * space.bsize
      : BigInt(options.diskBudgetBytes);
  if (
    !Number.isSafeInteger(required) ||
    required > totalLimit ||
    available < BigInt(required) + 16n * 1024n ** 2n
  )
    throw new Error('MAINTENANCE_INSUFFICIENT_SPACE');
}
async function sourceObject(directory: string, relative: string) {
  const parts = relative.split('/');
  if (
    parts.length !== 3 ||
    parts[0] !== 'blobs' ||
    !/^[pu]-[a-f0-9-]{36}$/.test(parts[1]!) ||
    !/^(?:[a-f0-9]{64}|\d{1,3})$/.test(parts[2]!)
  )
    throw new Error('MAINTENANCE_UNSAFE_REFERENCE');
  await privateDirectory(join(directory, 'blobs'));
  await privateDirectory(join(directory, 'blobs', parts[1]!));
  return join(directory, ...parts);
}

export async function createBackup(dataDirectory: string, destination: string, options: Options) {
  unix();
  await privateDirectory(dataDirectory);
  await privateDirectory(dirname(destination));
  if (options.key.length !== 32) throw new Error('MAINTENANCE_KEY_REQUIRED');
  const checkpoint = control(options),
    backupId = randomUUID();
  const databasePath = join(dataDirectory, 'attuner.sqlite');
  await digestFile(databasePath, databaseLimit);
  const writer = openMaintenanceDatabase(databasePath);
  let reader: ReturnType<typeof openMaintenanceDatabase> | undefined;
  let scratch: string | undefined,
    completed = false;
  try {
    assertKnownSchema(writer);
    await checkpoint('backup-before-capture-audit');
    appendMaintenanceAudit(writer, 'server.backup.capture', backupId);
    writer.exec('BEGIN IMMEDIATE');
    reader = openMaintenanceDatabase(databasePath, true);
    const summary = await verifyDatabase(reader);
    const databaseBytes =
      Number(reader.pragma('page_count', { simple: true })) *
      Number(reader.pragma('page_size', { simple: true }));
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes > databaseLimit)
      throw new Error('MAINTENANCE_DATABASE_SIZE');
    let count = 1,
      total = databaseBytes;
    for (const object of referencedObjects(reader)) {
      count++;
      total += object.size;
    }
    if (count > entryLimit) throw new Error('MAINTENANCE_ENTRY_LIMIT');
    await budget(dirname(destination), total + count * 512 + 1024 * 1024, options);
    await budget(dataDirectory, databaseBytes + catalogLimit, options);
    // Exclusive creation: never overwrite/adopt an existing backup directory.
    await mkdir(destination, { mode: 0o700 });
    await syncDirectory(dirname(destination));
    const maintenanceRoot = join(dataDirectory, '.maintenance');
    await mkdir(maintenanceRoot, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    await privateDirectory(maintenanceRoot);
    scratch = await mkdtemp(join(maintenanceRoot, 'capture-'));
    await syncDirectory(maintenanceRoot);
    const snapshot = join(scratch, 'attuner.sqlite');
    const empty = await open(snapshot, 'wx', 0o600);
    await empty.close();
    await reader.backup(snapshot, {
      progress: () => {
        options.signal?.throwIfAborted();
        return 128;
      },
    });
    const captured = openMaintenanceDatabase(snapshot, true);
    try {
      if (JSON.stringify(await verifyDatabase(captured)) !== JSON.stringify(summary))
        throw new Error('MAINTENANCE_CAPTURE_CHANGED');
    } finally {
      captured.close();
    }
    await checkpoint('backup-database-captured');
    const catalogPath = join(scratch, 'catalog.ndjson'),
      catalog = await open(catalogPath, 'wx', 0o600);
    let catalogBytes = 0,
      index = 0,
      totalBytes = 0;
    const line = async (value: unknown) => {
      const bytes = JSON.stringify(value) + '\n';
      catalogBytes += Buffer.byteLength(bytes);
      if (catalogBytes > catalogLimit) throw new Error('MAINTENANCE_CATALOG_LIMIT');
      await catalog.writeFile(bytes);
    };
    try {
      await line({ schemaVersion: 1, backupId, summary, entryCount: count });
      const databaseDigest = await encryptFile(
        snapshot,
        join(destination, '0.sealed'),
        options.key,
        `${backupId}:attuner.sqlite`,
        databaseLimit,
        checkpoint,
      );
      await line({ index: index++, relative: 'attuner.sqlite', ...databaseDigest });
      totalBytes += databaseDigest.size;
      for (const object of referencedObjects(reader)) {
        await checkpoint('backup-object');
        const source = await sourceObject(dataDirectory, object.relative);
        const value = await encryptFile(
          source,
          join(destination, `${index}.sealed`),
          options.key,
          `${backupId}:${object.relative}`,
          object.size,
          checkpoint,
        );
        if (value.size !== object.size || value.blake3 !== object.hash)
          throw new Error('MAINTENANCE_OBJECT_CORRUPT');
        await line({ index: index++, relative: object.relative, ...value });
        totalBytes += value.size;
      }
      if (index !== count || totalBytes > totalLimit)
        throw new Error('MAINTENANCE_CAPTURE_CHANGED');
      await line({ sealed: true, entryCount: count, totalBytes });
      await catalog.sync();
    } finally {
      await catalog.close();
    }
    await encryptFile(
      catalogPath,
      join(destination, 'catalog.sealed'),
      options.key,
      `${backupId}:catalog`,
      catalogLimit,
      checkpoint,
    );
    await syncDirectory(destination);
    const catalogHash = (await digestFile(join(destination, 'catalog.sealed'), catalogLimit + 36))
      .sha256;
    await checkpoint('backup-before-seal-audit');
    appendMaintenanceAudit(writer, 'server.backup.sealed', backupId, {
      auditCutoff: summary.auditMax,
      catalogHash,
    });
    writer.exec('COMMIT');
    await checkpoint('backup-before-receipt');
    await writeJSON(join(destination, 'receipt.json'), {
      schemaVersion: 1,
      backupId,
      catalogHash,
      entryCount: count,
      totalBytes,
    });
    completed = true;
    // Publication is already durable: a progress/cancellation callback cannot
    // turn that fact into a failed backup or authorize changing the receipt.
    try {
      await options.checkpoint?.('backup-receipt');
    } catch {
      /* committed fact */
    }
    return { backupId, entryCount: count, totalBytes, summary };
  } finally {
    reader?.close();
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close();
    // Only a fully sealed operation removes its own private plaintext scratch.
    // A failed/interrupted operation is retained for explicit operator review.
    if (completed && scratch) await rm(scratch, { recursive: true });
  }
}

export async function assertRestoreReady(directory: string) {
  const intentPath = join(directory, 'restore-intent.json');
  try {
    await lstat(intentPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const intent = z
    .strictObject({ schemaVersion: z.literal(1), backupId: z.uuid() })
    .parse(await smallJSON(intentPath));
  const ready = z
    .strictObject({
      schemaVersion: z.literal(1),
      backupId: z.uuid(),
      serverId: z.uuid(),
      auditCutoff: z.number().int().nonnegative(),
    })
    .parse(await smallJSON(join(directory, 'restore-ready.json')));
  if (ready.backupId !== intent.backupId) throw new Error('MAINTENANCE_RESTORE_INCOMPLETE');
}

export async function restoreBackup(
  backupDirectory: string,
  destination: string,
  options: Options,
) {
  unix();
  await privateDirectory(backupDirectory);
  await privateDirectory(dirname(destination));
  const checkpoint = control(options);
  const receipt = backupReceiptSchema.parse(await smallJSON(join(backupDirectory, 'receipt.json')));
  if (
    (await digestFile(join(backupDirectory, 'catalog.sealed'), catalogLimit + 36)).sha256 !==
    receipt.catalogHash
  )
    throw new Error('MAINTENANCE_CATALOG_CORRUPT');
  await budget(dirname(destination), receipt.totalBytes + catalogLimit, options);
  await mkdir(destination, { mode: 0o700 });
  await syncDirectory(dirname(destination));
  await writeJSON(join(destination, 'restore-intent.json'), {
    schemaVersion: 1,
    backupId: receipt.backupId,
  });
  const catalogPath = join(destination, 'restore-catalog.ndjson');
  await decryptFile(
    join(backupDirectory, 'catalog.sealed'),
    catalogPath,
    options.key,
    `${receipt.backupId}:catalog`,
    catalogLimit,
    checkpoint,
  );
  const catalog = await open(catalogPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let database: ReturnType<typeof openMaintenanceDatabase> | undefined;
  let header: z.infer<typeof headerSchema> | undefined,
    index = 0,
    totalBytes = 0,
    footer = false;
  let expected: ReturnType<typeof referencedObjects> | undefined;
  try {
    for await (const line of boundedLines(catalog)) {
      options.signal?.throwIfAborted();
      if (Buffer.byteLength(line) > 8192 || footer) throw new Error('MAINTENANCE_CATALOG_INVALID');
      const value = JSON.parse(line) as unknown;
      if (!header) {
        header = headerSchema.parse(value);
        if (header.backupId !== receipt.backupId || header.entryCount !== receipt.entryCount)
          throw new Error('MAINTENANCE_CATALOG_INVALID');
        continue;
      }
      if (index === receipt.entryCount) {
        const end = z
          .strictObject({ sealed: z.literal(true), entryCount: z.number(), totalBytes: z.number() })
          .parse(value);
        if (
          end.entryCount !== index ||
          end.totalBytes !== totalBytes ||
          totalBytes !== receipt.totalBytes ||
          expected?.next().done !== true
        )
          throw new Error('MAINTENANCE_CATALOG_INVALID');
        footer = true;
        continue;
      }
      const entry = entrySchema.parse(value);
      if (entry.index !== index) throw new Error('MAINTENANCE_CATALOG_ORDER');
      const reference =
        index === 0
          ? { relative: 'attuner.sqlite', size: entry.size, hash: entry.blake3 }
          : expected?.next().value;
      if (
        !reference ||
        entry.relative !== reference.relative ||
        entry.size !== reference.size ||
        entry.blake3 !== reference.hash
      )
        throw new Error('MAINTENANCE_CATALOG_REFERENCE');
      if (index > 0) {
        await mkdir(join(destination, 'blobs'), { mode: 0o700 }).catch((e: unknown) => {
          if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
        });
        await privateDirectory(join(destination, 'blobs'));
        await mkdir(dirname(join(destination, reference.relative)), { mode: 0o700 }).catch(
          (e: unknown) => {
            if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
          },
        );
        await privateDirectory(dirname(join(destination, reference.relative)));
      }
      const target = join(destination, reference.relative);
      const digest = await decryptFile(
        join(backupDirectory, `${index}.sealed`),
        target,
        options.key,
        `${receipt.backupId}:${reference.relative}`,
        index === 0 ? databaseLimit : objectLimit,
        checkpoint,
      );
      if (
        digest.size !== entry.size ||
        digest.sha256 !== entry.sha256 ||
        digest.blake3 !== entry.blake3
      )
        throw new Error('MAINTENANCE_RESTORED_CONTENT');
      await syncDirectory(dirname(target));
      index++;
      totalBytes += digest.size;
      if (index === 1) {
        database = openMaintenanceDatabase(target, true);
        const actual = await verifyDatabase(database);
        if (JSON.stringify(actual) !== JSON.stringify(header.summary))
          throw new Error('MAINTENANCE_RESTORED_DATABASE');
        expected = referencedObjects(database);
      }
      await checkpoint('restore-entry');
    }
  } finally {
    expected?.return(undefined);
    database?.close();
    await catalog.close();
  }
  if (!header || !footer || index !== receipt.entryCount)
    throw new Error('MAINTENANCE_CATALOG_TRUNCATED');
  const restored = openMaintenanceDatabase(join(destination, 'attuner.sqlite'));
  try {
    await checkpoint('restore-before-audit');
    const original = header.summary;
    restored
      .transaction(() => {
        const now = Math.floor(Date.now() / 1000);
        restored.prepare('UPDATE devices SET revoked_at=coalesce(revoked_at,?)').run(now);
        restored
          .prepare('UPDATE device_credentials SET revoked_at=coalesce(revoked_at,?)')
          .run(now);
        restored
          .prepare('UPDATE user_security SET epoch=epoch+1,disabled_at=coalesce(disabled_at,?)')
          .run(now);
        restored
          .prepare("UPDATE enrollments SET state='denied' WHERE state IN ('pending','approved')")
          .run();
        appendMaintenanceAudit(restored, 'server.restore.verified', receipt.backupId, {
          sourceAuditCutoff: original.auditMax,
          sourceAuditDigest: original.auditDigest,
          credentialPolicy: 'revoke-all-and-recover-administrator',
        });
      })
      .immediate();
    restored.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    restored.close();
  }
  const databaseFile = await open(
    join(destination, 'attuner.sqlite'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await databaseFile.sync();
  } finally {
    await databaseFile.close();
  }
  await syncDirectory(destination);
  await checkpoint('restore-before-ready');
  await writeJSON(join(destination, 'restore-ready.json'), {
    schemaVersion: 1,
    backupId: receipt.backupId,
    serverId: header.summary.serverId,
    auditCutoff: header.summary.auditMax,
  });
  await assertRestoreReady(destination);
  try {
    await options.checkpoint?.('restore-ready');
  } catch {
    /* committed fact */
  }
  return {
    backupId: receipt.backupId,
    entryCount: index,
    totalBytes,
    summary: header.summary as VerificationSummary,
  };
}
