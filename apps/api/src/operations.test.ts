import { expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@attuner/database';
import { buildApp } from './app.ts';
import { BlobStorage } from './sync/storage.ts';
import { readConfig } from './config.ts';
it('structured request logs contain allowlisted metadata without credentials, payloads, paths or queries', async () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const database = openDatabase(),
    app = buildApp(database, { structuredLogging: true, logStream: stream });
  app.post('/safe/:id', async () => {
    throw new Error('PRIVATE_ERROR_CREDENTIAL');
  });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/safe/PRIVATE_PATH?code=PRIVATE_QUERY',
      headers: {
        authorization: 'Bearer PRIVATE_AUTH',
        cookie: 'PRIVATE_COOKIE',
        dpop: 'PRIVATE_PROOF',
      },
      payload: { password: 'PRIVATE_PASSWORD', config: 'PRIVATE_CONFIG' },
    });
    expect(result.statusCode).toBe(500);
    const events = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'http.request',
      method: 'POST',
      route: '/safe/:id',
      statusCode: 500,
    });
    expect(output).not.toContain('PRIVATE_');
    expect(output).not.toContain('hostname');
    expect(Object.keys(events[0]).sort()).toEqual(
      ['level', 'time', 'event', 'requestId', 'method', 'route', 'statusCode', 'durationMs'].sort(),
    );
  } finally {
    await app.close();
    database.close();
  }
});
it('readiness refuses unavailable storage without exposing disk paths or free space', async () => {
  const database = openDatabase(),
    app = buildApp(database, { storageReady: async () => false });
  try {
    const result = await app.inject('/api/v1/health/ready');
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({
      status: 'not_ready',
      database: 'ready',
      storage: 'unavailable',
    });
    expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
  } finally {
    await app.close();
    database.close();
  }
});
it.skipIf(process.platform === 'win32')(
  'checks actual storage availability and validates reserve/proxy configuration',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'attuner-storage-health-test-'));
    try {
      const path = join(root, 'blobs'),
        storage = new BlobStorage(path);
      await storage.initialize();
      expect(await storage.ready()).toBe(true);
      await rename(path, join(root, 'preserved-blobs'));
      expect(await storage.ready()).toBe(false);
      expect(() => new BlobStorage(path, 1)).toThrow('reserve');
      expect(() => readConfig({ ATTUNER_DISK_RESERVE_BYTES: '1' })).toThrow();
      expect(
        readConfig({ ATTUNER_TRUST_LOOPBACK_PROXY: '1', ATTUNER_DISK_RESERVE_BYTES: '536870912' }),
      ).toMatchObject({ trustLoopbackProxy: true, diskReserveBytes: 536870912 });
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
