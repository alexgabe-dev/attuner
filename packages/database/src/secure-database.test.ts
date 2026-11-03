import { it, expect } from 'vitest';
import { openDatabase } from './index';
import { DatabaseWorker } from './worker';
it('enforces scoped blob references, seals and forward-only profile heads', () => {
  const d = openDatabase();
  const s = d.sqlite;
  try {
    s.prepare("INSERT INTO profiles VALUES('p','Fixture','attuner-synthetic',1,NULL,1,1)").run();
    s.prepare("INSERT INTO profiles VALUES('q','Other','attuner-synthetic',1,NULL,1,1)").run();
    const hash = 'a'.repeat(64);
    s.prepare("INSERT INTO blobs VALUES(?,1,'verified',1)").run(hash);
    s.prepare("INSERT INTO profile_blobs VALUES('q',?,1,'verified',1)").run(hash);
    s.prepare("INSERT INTO snapshots VALUES('s','p',NULL,1,NULL,?,0,0,0,0,1)").run(hash);
    expect(() =>
      s.prepare("INSERT INTO snapshot_files VALUES('s','account','a.lua',?,1,'group')").run(hash),
    ).toThrow(/profile blob/);
    s.prepare("INSERT INTO profile_blobs VALUES('p',?,1,'verified',1)").run(hash);
    s.prepare("INSERT INTO snapshot_files VALUES('s','account','a.lua',?,1,'group')").run(hash);
    expect(() =>
      s.prepare("UPDATE profiles SET head_snapshot_id='s',next_revision=2 WHERE id='p'").run(),
    ).toThrow(/Unsealed/);
    s.prepare("INSERT INTO snapshot_seals VALUES('s',1,1,1,1)").run();
    s.prepare("UPDATE profiles SET head_snapshot_id='s',next_revision=2 WHERE id='p'").run();
    expect(() =>
      s.prepare("INSERT INTO snapshot_files VALUES('s','account','b.lua',?,1,'group')").run(hash),
    ).toThrow(/sealed/);
    expect(() => s.prepare("DELETE FROM snapshot_files WHERE snapshot_id='s'").run()).toThrow(
      /immutable/,
    );
    expect(() => s.prepare("DELETE FROM snapshots WHERE id='s'").run()).toThrow(/retained/);
    expect(() => s.prepare("UPDATE profiles SET head_snapshot_id=NULL WHERE id='p'").run()).toThrow(
      /monotonically/,
    );
    s.prepare("INSERT INTO audit_events VALUES(1,'p',NULL,'test','{}',1)").run();
    expect(() => s.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
  } finally {
    d.close();
  }
});
it('serializes worker transactions and rolls back all statements on failed CAS', async () => {
  const worker = await DatabaseWorker.open();
  try {
    await worker.run("INSERT INTO server_settings VALUES('n','0')");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        worker.transaction([
          {
            sql: "UPDATE server_settings SET value=CAST(value AS INTEGER)+1 WHERE key='n'",
            expect: 1,
          },
        ]),
      ),
    );
    expect(await worker.query('SELECT value FROM server_settings')).toEqual([{ value: '20' }]);
    await expect(
      worker.transaction([
        { sql: "UPDATE server_settings SET value='999' WHERE key='n'" },
        {
          sql: "UPDATE server_settings SET value='x' WHERE key='missing'",
          expect: 1,
          code: 'HEAD_MOVED',
        },
      ]),
    ).rejects.toThrow('HEAD_MOVED');
    expect(await worker.query('SELECT value FROM server_settings')).toEqual([{ value: '20' }]);
  } finally {
    await worker.close();
  }
  await expect(worker.query('SELECT 1')).rejects.toThrow('DATABASE_CLOSED');
});

it('upgrades existing history without granting access to unverified physical content', async () => {
  const { mkdtemp, readFile, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const directory = await mkdtemp(join(tmpdir(), 'attuner-upgrade-'));
  try {
    await mkdir(join(directory, 'migrations/meta'), { recursive: true });
    const journal = JSON.parse(
      await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 2);
    await writeFile(join(directory, 'migrations/meta/_journal.json'), JSON.stringify(journal));
    for (const name of ['0000_foundation.sql', '0001_immutable_snapshots.sql'])
      await writeFile(
        join(directory, 'migrations', name),
        await readFile(new URL('../migrations/' + name, import.meta.url)),
      );
    const filename = join(directory, 'database.sqlite'),
      old = new Database(filename);
    migrate(drizzle(old), { migrationsFolder: join(directory, 'migrations') });
    old.prepare("INSERT INTO profiles VALUES('p','Original','fixture',1,NULL,1,1)").run();
    old.prepare("INSERT INTO blobs VALUES(?,1,'verified',1)").run('a'.repeat(64));
    old
      .prepare("INSERT INTO snapshots VALUES('old','p',NULL,1,NULL,?,0,0,0,0,1)")
      .run('b'.repeat(64));
    old
      .prepare("INSERT INTO snapshot_files VALUES('old','account','original.lua',?,1,'group')")
      .run('a'.repeat(64));
    old.close();
    const upgraded = openDatabase(filename);
    try {
      expect(upgraded.sqlite.prepare('SELECT file_count,bytes FROM snapshot_seals').get()).toEqual({
        file_count: 1,
        bytes: 1,
      });
      expect(upgraded.sqlite.prepare('SELECT count(*) AS n FROM profile_blobs').get()).toEqual({
        n: 0,
      });
      expect(() => upgraded.sqlite.prepare("DELETE FROM snapshots WHERE id='old'").run()).toThrow(
        /retained/,
      );
      expect(upgraded.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
    const reopened = openDatabase(filename);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('bounds queued worker requests rather than accumulating unbounded work', async () => {
  const worker = await DatabaseWorker.open();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => worker.query('SELECT 1')),
    );
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    expect(await worker.query('SELECT 1 AS n')).toEqual([{ n: 1 }]);
  } finally {
    await worker.close();
  }
});
