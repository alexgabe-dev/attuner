import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@attuner/sync-protocol';
import type { AttunerDatabase } from '@attuner/database';
export function buildApp(database: AttunerDatabase) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/v1/health/live', async () => ({ status: 'ok', service: 'attuner-api' }));
  app.get('/api/v1/health/ready', async (_request, reply) => {
    try {
      database.sqlite.prepare('SELECT 1').get();
      return { status: 'ready', database: 'ready', sqliteVersion: database.version };
    } catch {
      reply.code(503);
      return { status: 'not_ready', database: 'unavailable' };
    }
  });
  app.get('/api/v1/capabilities', async () => ({
    protocolVersion: PROTOCOL_VERSION,
    phase: 1,
    mode: 'foundation',
    features: {
      pairing: false,
      synchronization: false,
      restore: false,
      activityStreaming: false,
      webAuthentication: false,
    },
    demoData: 'client-side fixtures only',
  }));
  app.setNotFoundHandler((request, reply) => {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    reply.code(mutation ? 501 : 404).send({
      code: mutation ? 'PHASE_NOT_IMPLEMENTED' : 'NOT_FOUND',
      message: mutation
        ? 'Synchronization and authentication are not implemented in Phase 1.'
        : 'Endpoint not found.',
      requestId: request.id,
      retryable: false,
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    reply.code(status).send({
      code: status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      message: status < 500 ? 'Request could not be accepted.' : 'An internal error occurred.',
      requestId: request.id,
      retryable: false,
    });
  });
  return app;
}
