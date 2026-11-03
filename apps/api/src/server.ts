import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '@attuner/database';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
const config = readConfig();
const directory = resolve(config.dataDir);
mkdirSync(directory, { recursive: true });
const database = openDatabase(resolve(directory, 'attuner.sqlite'));
const app = buildApp(database);
app.addHook('onClose', async () => database.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
await app.listen({ host: config.host, port: config.port });
console.log(
  `Attuner foundation API: http://${config.host}:${config.port}/api/v1 (SQLite ${database.version}; no sync endpoints)`,
);
