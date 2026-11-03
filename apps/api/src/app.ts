import Fastify from 'fastify';
import { PROTOCOL_VERSION, LIMITS, NAMESPACE_VERSION } from '@attuner/sync-protocol';
import { DatabaseWorker, type AttunerDatabase } from '@attuner/database';
import type { ServerTLS } from './tls';
export function buildApp(
  database: AttunerDatabase | DatabaseWorker,
  options: { tls?: ServerTLS; secure?: boolean; serverId?: string } = {},
) {
  const app = Fastify({
    logger: false,
    allowErrorHandlerOverride: false,
    bodyLimit: 65536,
    requestTimeout: 120000,
    ...(options.tls ? { https: options.tls } : {}),
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/v1/health/live', async () => ({ status: 'ok', service: 'attuner-api' }));
  app.get('/api/v1/health/ready', async (_request, reply) => {
    try {
      if (database instanceof DatabaseWorker) await database.query('SELECT 1');
      else database.sqlite.prepare('SELECT 1').get();
      return { status: 'ready', database: 'ready', sqliteVersion: database.version };
    } catch {
      reply.code(503);
      return { status: 'not_ready', database: 'unavailable' };
    }
  });
  app.get('/api/v1/capabilities', async () => ({
    protocolVersion: PROTOCOL_VERSION,
    phase: options.secure ? 3 : 1,
    mode: options.secure ? 'secure-synthetic' : 'foundation',
    serverId: options.serverId,
    namespaceVersion: NAMESPACE_VERSION,
    limits: LIMITS,
    features: {
      pairing: !!options.secure,
      synchronization: false,
      restore: false,
      activityStreaming: false,
      webAuthentication: !!options.secure,
    },
    demoData: options.secure ? 'synthetic installations only' : 'client-side fixtures only',
  }));
  app.setNotFoundHandler((request, reply) => {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    reply.code(mutation ? 501 : 404).send({
      code: mutation ? 'PHASE_NOT_IMPLEMENTED' : 'NOT_FOUND',
      message: mutation ? 'This operation is not available.' : 'Endpoint not found.',
      requestId: request.id,
      retryable: false,
    });
  });
  if (!options.secure)
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
