import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AttunerDatabase } from './index';
let database: AttunerDatabase | undefined;
afterEach(() => database?.close());
function seed() {
  database = openDatabase();
  const s = database.sqlite;
  s.prepare("insert into devices values ('d','Main PC','windows','0.1.0',1,NULL)").run();
  s.prepare("insert into profiles values ('p','Forever','fixture',1,NULL,1,1)").run();
  s.prepare("insert into snapshots values ('s','p',NULL,1,'d',?,0,0,0,0,1)").run('a'.repeat(64));
  return s;
}
describe('reviewed SQLite foundation migration', () => {
  it('creates all required tables on a patched runtime', () => {
    database = openDatabase();
    const tables = database.sqlite
      .prepare("select name from sqlite_master where type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'devices',
        'profiles',
        'snapshots',
        'snapshot_files',
        'blobs',
        'sync_sessions',
        'file_changes',
        'conflicts',
        'audit_events',
        'device_heartbeats',
        'restore_requests',
      ]),
    );
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });
  it('enforces foreign keys, unique revisions, blob identity and explicit deletion', () => {
    const s = seed();
    expect(() =>
      s
        .prepare("insert into snapshots values ('other','p',NULL,1,'d',?,0,0,0,0,1)")
        .run('a'.repeat(64)),
    ).toThrow(/UNIQUE/);
    expect(() =>
      s
        .prepare("insert into snapshot_files values ('s','account','a.lua',?,0,'addon')")
        .run('a'.repeat(64)),
    ).toThrow(/FOREIGN KEY/);
    expect(() => s.prepare("insert into blobs values ('invalid',0,'verified',1)").run()).toThrow(
      /CHECK/,
    );
    expect(() =>
      s
        .prepare(
          "insert into file_changes values ('f',NULL,'s','account','a.lua','delete',NULL,NULL)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
  it('prevents published snapshot mutation', () => {
    const s = seed();
    expect(() => s.prepare("update snapshots set revision=2 where id='s'").run()).toThrow(
      /immutable/,
    );
  });
  it('rejects cross-profile head and acknowledgement references', () => {
    const s = seed();
    s.prepare("insert into profiles values ('q','Other','fixture',1,NULL,1,1)").run();
    expect(() => s.prepare("update profiles set head_snapshot_id='s' where id='q'").run()).toThrow(
      /FOREIGN KEY/,
    );
    expect(() =>
      s.prepare("insert into device_profiles values ('d','q','s',1,0,'current')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
  it('migrates idempotently and persists across reopen', () => {
    const folder = mkdtempSync(join(tmpdir(), 'attuner-migration-'));
    try {
      database = openDatabase(join(folder, 'test.sqlite'));
      database.sqlite
        .prepare("insert into profiles values ('p','Forever','fixture',1,NULL,1,1)")
        .run();
      database.close();
      database = undefined;
      database = openDatabase(join(folder, 'test.sqlite'));
      expect(database.sqlite.prepare('select count(*) as n from profiles').get()).toEqual({ n: 1 });
      expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      database.close();
      database = undefined;
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
