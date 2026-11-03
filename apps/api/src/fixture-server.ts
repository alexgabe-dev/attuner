// Isolated development TLS. Private keys are encrypted and passphrases live only in memory.
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseWorker } from '@attuner/database';
import { createSecureApp, ephemeralDevelopmentDeliveryKey } from './secure-app.ts';
import { tlsFixture } from './testing/tls-fixture.ts';
const directory = resolve(process.env.ATTUNER_DATA_DIR ?? '../../.runtime');
await mkdir(directory, { recursive: true, mode: 0o700 });
const fixture = await tlsFixture();
await copyFile(fixture.caPath, join(directory, 'development-ca.pem'));
const database = await DatabaseWorker.open(join(directory, 'attuner.sqlite'));
const { app } = await createSecureApp(database, {
  tls: fixture.tls,
  blobDirectory: join(directory, 'blobs'),
  deliveryKey: ephemeralDevelopmentDeliveryKey(),
});
app.addHook('onClose', async () => {
  await database.close();
  await fixture.close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
await app.listen({ host: '127.0.0.1', port: 4317 });
console.log(
  `Attuner synthetic development API: https://127.0.0.1:4317; public CA: ${join(directory, 'development-ca.pem')}`,
);
