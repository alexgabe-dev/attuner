import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';
export { schema };
export function openDatabase(filename = ':memory:') {
  const sqlite = new Database(filename);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const version = (
      sqlite.prepare('select sqlite_version() as version').get() as { version: string }
    ).version;
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3))))
      throw new Error(`SQLite ${version} is below the verified WAL baseline 3.51.3`);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
    return { db, sqlite, version, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
export type AttunerDatabase = ReturnType<typeof openDatabase>;
