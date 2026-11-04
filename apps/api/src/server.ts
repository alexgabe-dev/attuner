import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseWorker } from '@attuner/database';
import { loadTLS } from './tls.js';
import { createSecureApp, loadDeliveryKey } from './secure-app.ts';
import { readConfig } from './config.js';
import { assertRestoreReady } from './maintenance/recovery.ts';
const config = readConfig();
const directory = resolve(config.dataDir);
mkdirSync(directory, { recursive: true, mode: 0o700 });
await assertRestoreReady(directory);
const tls = await loadTLS();
const database = await DatabaseWorker.open(resolve(directory, 'attuner.sqlite'));
const { app } = await createSecureApp(database, {
  tls,
  blobDirectory: resolve(directory, 'blobs'),
  deliveryKey: await loadDeliveryKey(),
  publicOrigin: process.env.ATTUNER_PUBLIC_ORIGIN ?? `https://${config.host}:${config.port}`,
  structuredLogging: true,
  trustLoopbackProxy: config.trustLoopbackProxy,
  diskReserveBytes: config.diskReserveBytes,
});
app.addHook('onClose', async () => database.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
await app.listen({ host: config.host, port: config.port });
app.log.info({
  event: 'server.started',
  protocolVersion: 1,
  sqliteVersion: database.version,
  host: config.host,
  port: config.port,
});
