import { it, expect } from 'vitest';
import { request } from 'node:https';
import { DatabaseWorker } from '@attuner/database';
import { buildApp } from './app';
import { loadTLS, validateTLS } from './tls';
import { createPrivateKey } from 'node:crypto';
import { tlsFixture } from './testing/tls-fixture';
it('serves the real worker-backed API over certificate-verified TLS', async () => {
  const fixture = await tlsFixture(),
    database = await DatabaseWorker.open();
  const app = buildApp(database, { tls: fixture.tls });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No TLS listener');
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port: address.port, path: '/api/v1/health/ready', ca: fixture.ca },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(body)).toMatchObject({ status: 'ready', sqliteVersion: database.version });
    await expect(
      new Promise((resolve, reject) => {
        const req = request(
          { hostname: '127.0.0.1', port: address.port, path: '/api/v1/health/live' },
          resolve,
        );
        req.on('error', reject);
        req.end();
      }),
    ).rejects.toThrow();
  } finally {
    await app.close();
    await database.close();
    await fixture.close();
  }
});
it('rejects missing TLS and does not accept an unencrypted key', async () => {
  await expect(loadTLS({})).rejects.toThrow('TLS is required');
  const fixture = await tlsFixture();
  try {
    const plaintext = createPrivateKey({
      key: fixture.tls.key,
      passphrase: fixture.passphrase,
    }).export({ type: 'pkcs8', format: 'pem' });
    expect(() => validateTLS(Buffer.from(plaintext), fixture.tls.cert, fixture.passphrase)).toThrow(
      'encrypted',
    );
  } finally {
    await fixture.close();
  }
});
