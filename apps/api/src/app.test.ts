import { describe, expect, it } from 'vitest';
import { openDatabase } from '@attuner/database';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
describe('foundation API', () => {
  it('reports real readiness and explicitly unavailable capabilities', async () => {
    const db = openDatabase();
    const app = buildApp(db);
    try {
      expect((await app.inject('/api/v1/health/live')).json()).toMatchObject({ status: 'ok' });
      expect((await app.inject('/api/v1/health/ready')).json()).toMatchObject({
        status: 'ready',
        sqliteVersion: db.version,
      });
      expect((await app.inject('/api/v1/capabilities')).json()).toMatchObject({
        phase: 1,
        features: { synchronization: false, webAuthentication: false },
      });
      const mutation = await app.inject({
        method: 'POST',
        url: '/api/v1/profiles/demo/sync-sessions',
        payload: {},
      });
      expect(mutation.statusCode).toBe(501);
      expect(mutation.json().code).toBe('PHASE_NOT_IMPLEMENTED');
      db.close();
      expect((await app.inject('/api/v1/health/ready')).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
  it('rejects public binding and invalid ports', () => {
    expect(() => readConfig({ ATTUNER_HOST: '0.0.0.0' })).toThrow();
    expect(() => readConfig({ ATTUNER_PORT: '65536' })).toThrow();
    expect(readConfig({}).host).toBe('127.0.0.1');
    expect(
      readConfig({ ATTUNER_HOST: '0.0.0.0', ATTUNER_CONTAINER_BIND: '1' }).containerBinding,
    ).toBe(true);
  });
});
