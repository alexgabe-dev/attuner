import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './index';
const directory = resolve(process.env.ATTUNER_DATA_DIR ?? '../../.runtime');
mkdirSync(directory, { recursive: true });
const db = openDatabase(resolve(directory, 'attuner.sqlite'));
console.log(`Migrations applied. SQLite ${db.version}; foreign keys enabled.`);
db.close();
