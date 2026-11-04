import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { openMaintenanceDatabase } from '@attuner/database';
import { secureHarness, SyntheticDevice } from '../testing/secure-harness.ts';
import { sha } from '../security/primitives.ts';
import { managementScenario } from '../testing/management-scenario.ts';
import { assertRestoreReady, createBackup, restoreBackup } from './recovery.ts';
import { appendMaintenanceAudit, verifyDatabase } from './verify.ts';

describe.skipIf(process.platform === 'win32')('encrypted server disaster recovery', () => {
  let root: string, source: string, profile: string, originalPassword: string;
  let scenario: Awaited<ReturnType<typeof managementScenario>>;
  const key = randomBytes(32);
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'attuner-server-recovery-test-'));
    source = join(root, 'source');
    await mkdir(source, { mode: 0o700 });
    const h = await secureHarness({
      databaseFilename: join(source, 'attuner.sqlite'),
      blobDirectory: join(source, 'blobs'),
    });
    try {
      originalPassword = randomBytes(24).toString('base64url');
      await h.security.bootstrap('owner', originalPassword);
      const owner = await h.login('owner', originalPassword);
      const response = await h.web(
        'POST',
        '/api/v1/profiles',
        owner,
        {
          name: 'Synthetic recovery setup',
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(response.status).toBe(200);
      profile = response.body.id as string;
      scenario = await managementScenario(h, profile, owner);
    } finally {
      await h.close();
    }
  });
  afterAll(async () => {
    key.fill(0);
    if (root) await rm(root, { recursive: true });
  });
  const path = (prefix: string) => join(root, prefix + '-' + randomUUID());

  it('restores immutable history, audit cutoff, resumable chunks and three enrolled clients', async () => {
    const backup = path('backup'),
      restored = path('restored');
    const captured = await createBackup(source, backup, { key });
    expect(captured.summary.snapshots).toBe(2);
    const result = await restoreBackup(backup, restored, { key });
    expect(result.summary).toEqual(captured.summary);
    await assertRestoreReady(restored);
    const database = openMaintenanceDatabase(join(restored, 'attuner.sqlite'), true);
    try {
      const summary = await verifyDatabase(database);
      expect(summary.serverId).toBe(captured.summary.serverId);
      expect(summary.headsDigest).toBe(captured.summary.headsDigest);
      expect(summary.auditCount).toBe(captured.summary.auditCount + 1);
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE type='server.restore.verified'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
    // Real authenticated protocol clients, distinct from the Rust-native reconnect drill.
    const h = await secureHarness({
      databaseFilename: join(restored, 'attuner.sqlite'),
      blobDirectory: join(restored, 'blobs'),
    });
    try {
      for (const client of Object.values(scenario.devices)) {
        const response = await client.send(h, 'GET', `/api/v1/profiles/${profile}/head`);
        expect(response.status).toBe(401);
      }
      await expect(h.login('owner', originalPassword)).rejects.toThrow('Synthetic login failed');
      const recoveredPassword = randomBytes(24).toString('base64url');
      await h.security.recoverAdministrator('owner', recoveredPassword);
      const owner = await h.login('owner', recoveredPassword);
      for (let index = 0; index < 3; index++) {
        const device = new SyntheticDevice();
        const start = await device.send(
          h,
          'POST',
          '/api/v1/auth/enrollments',
          {
            deviceName: `Restored fixture ${index}`,
            os: 'macos',
            clientVersion: '0.1.0',
            codeChallenge: sha(device.verifier),
            state: device.state,
          },
          randomUUID(),
        );
        const enrollmentId = start.body.enrollmentId as string;
        const approval = await h.web(
          'POST',
          `/api/v1/auth/enrollments/${enrollmentId}/decision`,
          owner,
          { approve: true, grants: [{ profileId: profile, permission: 'write' }] },
        );
        device.accept(
          await device.send(
            h,
            'POST',
            '/api/v1/auth/token',
            {
              grantType: 'authorization_code',
              enrollmentId,
              code: new URL(approval.body.redirectUri as string).searchParams.get('code'),
              codeVerifier: device.verifier,
            },
            randomUUID(),
            '',
          ),
        );
        const response = await device.send(h, 'GET', `/api/v1/profiles/${profile}/head`);
        expect(response.status).toBe(200);
        expect(response.body.head).toEqual(scenario.second);
      }
    } finally {
      await h.close();
    }
    for (const entry of await readdir(backup)) {
      if (!entry.endsWith('.sealed')) continue;
      const bytes = await readFile(join(backup, entry));
      expect(bytes.subarray(0, 8).toString()).toBe('ATTBKP01');
      expect(bytes.includes(Buffer.from('Fixture ='))).toBe(false);
      expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
    }
  });

  it('refuses existing destinations and a wrong key without modifying source history', async () => {
    const backup = path('backup');
    await createBackup(source, backup, { key });
    const before = await readFile(join(backup, 'receipt.json'));
    await expect(createBackup(source, backup, { key })).rejects.toThrow();
    expect(await readFile(join(backup, 'receipt.json'))).toEqual(before);
    const restored = path('wrong-key');
    await expect(restoreBackup(backup, restored, { key: randomBytes(32) })).rejects.toThrow();
    await expect(assertRestoreReady(restored)).rejects.toThrow();
    await expect(restoreBackup(backup, restored, { key })).rejects.toThrow();
  });

  it('rejects missing receipts, corrupted catalogs, corrupted blobs and truncated objects', async () => {
    const original = path('backup');
    await createBackup(source, original, { key });
    for (const failure of ['receipt', 'catalog', 'blob', 'truncated']) {
      const backup = path('corrupt');
      await cp(original, backup, { recursive: true, errorOnExist: true });
      if (failure === 'receipt') await rm(join(backup, 'receipt.json'));
      else {
        const target = join(backup, failure === 'catalog' ? 'catalog.sealed' : '1.sealed');
        if (failure === 'truncated') await writeFile(target, Buffer.alloc(12));
        else {
          const file = await open(target, 'r+');
          try {
            const byte = Buffer.alloc(1);
            await file.read(byte, 0, 1, 24);
            byte[0] = byte[0]! ^ 0x80;
            await file.write(byte, 0, 1, 24);
          } finally {
            await file.close();
          }
        }
      }
      const restored = path('rejected');
      await expect(restoreBackup(backup, restored, { key })).rejects.toThrow();
      // A destination may not exist yet; if created, it must remain unavailable.
      if ((await readdir(root)).includes(restored.split('/').at(-1)!))
        await expect(assertRestoreReady(restored)).rejects.toThrow();
    }
  });

  it('does not seal disk-full/cancelled/interrupted captures or activate interrupted restores', async () => {
    const noSpace = path('no-space');
    await expect(createBackup(source, noSpace, { key, diskBudgetBytes: 1 })).rejects.toThrow(
      'MAINTENANCE_INSUFFICIENT_SPACE',
    );
    for (const point of [
      'backup-database-captured',
      'backup-object',
      'backup-before-seal-audit',
      'backup-before-receipt',
    ]) {
      const backup = path('interrupted');
      await expect(
        createBackup(source, backup, {
          key,
          checkpoint: (at) => {
            if (at === point) throw new Error('INJECTED_INTERRUPTION');
          },
        }),
      ).rejects.toThrow('INJECTED_INTERRUPTION');
      await expect(readFile(join(backup, 'receipt.json'))).rejects.toThrow();
    }
    const signal = AbortSignal.abort(new Error('CANCELLED'));
    await expect(createBackup(source, path('cancelled'), { key, signal })).rejects.toThrow(
      'CANCELLED',
    );
    const backup = path('backup');
    await createBackup(source, backup, { key });
    for (const point of ['restore-entry', 'restore-before-audit', 'restore-before-ready']) {
      const restored = path('interrupted-restore');
      await expect(
        restoreBackup(backup, restored, {
          key,
          checkpoint: (at) => {
            if (at === point) throw new Error('INJECTED_INTERRUPTION');
          },
        }),
      ).rejects.toThrow('INJECTED_INTERRUPTION');
      await expect(assertRestoreReady(restored)).rejects.toThrow();
    }
    const database = openMaintenanceDatabase(join(source, 'attuner.sqlite'));
    try {
      appendMaintenanceAudit(database, 'test.lock-released', randomUUID());
    } finally {
      database.close();
    }
  });

  it('rolls back actual failed audit writes atomically and refuses unsupported schema', async () => {
    const database = openMaintenanceDatabase(join(source, 'attuner.sqlite'));
    try {
      const before = database.prepare('SELECT count(*) AS count FROM audit_events').get();
      database.exec(
        "CREATE TEMP TRIGGER deny_maintenance_details BEFORE INSERT ON audit_details BEGIN SELECT RAISE(ABORT,'INJECTED_AUDIT_FAILURE'); END",
      );
      expect(() => appendMaintenanceAudit(database, 'test.audit-failure', randomUUID())).toThrow(
        'INJECTED_AUDIT_FAILURE',
      );
      expect(database.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual(before);
      database.exec('DROP TRIGGER deny_maintenance_details');
      database.exec('CREATE TEMP TABLE temporary_probe(value TEXT)');
      expect((await verifyDatabase(database)).snapshots).toBe(2);
    } finally {
      database.close();
    }
    // Schema tampering is isolated to a restored synthetic copy, never the source.
    const backup = path('backup'),
      restored = path('schema-test');
    await createBackup(source, backup, { key });
    await restoreBackup(backup, restored, { key });
    const modified = openMaintenanceDatabase(join(restored, 'attuner.sqlite'));
    try {
      modified.exec('CREATE TABLE unrecognized(value TEXT)');
      await expect(verifyDatabase(modified)).rejects.toThrow('MAINTENANCE_UNSUPPORTED_SCHEMA');
    } finally {
      modified.close();
    }
  });

  it('holds a real SQLite writer lock throughout capture and releases it on completion', async () => {
    const second = openMaintenanceDatabase(join(source, 'attuner.sqlite'));
    let blocked = false;
    try {
      await createBackup(source, path('locked-capture'), {
        key,
        checkpoint: (point) => {
          if (point === 'backup-database-captured') {
            expect(() =>
              appendMaintenanceAudit(second, 'test.concurrent-write', randomUUID()),
            ).toThrow();
            blocked = true;
          }
        },
      });
      expect(blocked).toBe(true);
      appendMaintenanceAudit(second, 'test.writer-resumed', randomUUID());
    } finally {
      second.close();
    }
  });

  it('detects manifest tampering even when the known schema is restored exactly', async () => {
    const backup = path('backup'),
      restored = path('tamper-test');
    await createBackup(source, backup, { key });
    await restoreBackup(backup, restored, { key });
    const database = openMaintenanceDatabase(join(restored, 'attuner.sqlite'));
    try {
      const trigger = database
        .prepare("SELECT sql FROM sqlite_schema WHERE name='snapshots_immutable'")
        .get() as { sql: string };
      database.exec('DROP TRIGGER snapshots_immutable');
      database
        .prepare('UPDATE snapshots SET manifest_hash=? WHERE id=?')
        .run('0'.repeat(64), scenario.first.snapshotId);
      database.exec(trigger.sql);
      await expect(verifyDatabase(database)).rejects.toThrow('MAINTENANCE_MANIFEST_DIGEST');
    } finally {
      database.close();
    }
    await expect(createBackup(restored, path('refused-tampered-history'), { key })).rejects.toThrow(
      'MAINTENANCE_MANIFEST_DIGEST',
    );
  });

  it('survives real process kills before and after backup/restore publication', async () => {
    async function terminate(
      operation: 'backup' | 'restore',
      input: string,
      output: string,
      point: string,
    ) {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../testing/maintenance-child.ts', import.meta.url)),
          root,
          operation,
          input,
          output,
          point,
        ],
        {
          env: { ...process.env, ATTUNER_MAINTENANCE_FIXTURE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        },
      );
      const closed = once(child, 'close');
      (child.stdio[3] as Writable).end(key);
      let stderr = '';
      child.stderr!.on('data', (bytes: Buffer) => {
        if (stderr.length < 8192) stderr += bytes.toString();
      });
      let pending = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Child boundary timeout: ' + stderr)), 15000);
          child.once('error', reject);
          child.once('exit', () => reject(new Error('Child exited before boundary: ' + stderr)));
          child.stdout!.on('data', (bytes: Buffer) => {
            pending += bytes.toString();
            if (pending.includes(`BOUNDARY:${point}\n`)) resolve();
          });
        });
        expect(child.kill('SIGKILL')).toBe(true);
        const [code, signal] = await closed;
        expect(code).toBeNull();
        expect(signal).toBe('SIGKILL');
      } finally {
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      }
    }
    for (const point of [
      'backup-database-captured',
      'backup-before-seal-audit',
      'backup-before-receipt',
      'backup-receipt',
    ]) {
      const destination = path('hard-kill-backup');
      await terminate('backup', 'source', basename(destination), point);
      if (point === 'backup-receipt')
        await restoreBackup(destination, path('hard-kill-verified'), { key });
      else await expect(readFile(join(destination, 'receipt.json'))).rejects.toThrow();
      const writer = openMaintenanceDatabase(join(source, 'attuner.sqlite'));
      try {
        appendMaintenanceAudit(writer, 'test.after-hard-kill', randomUUID());
      } finally {
        writer.close();
      }
    }
    const backup = path('backup');
    await createBackup(source, backup, { key });
    for (const point of [
      'restore-entry',
      'restore-before-audit',
      'restore-before-ready',
      'restore-ready',
    ]) {
      const destination = path('hard-kill-restore');
      await terminate('restore', basename(backup), basename(destination), point);
      if (point === 'restore-ready') await assertRestoreReady(destination);
      else await expect(assertRestoreReady(destination)).rejects.toThrow();
    }
  }, 45000);
});
