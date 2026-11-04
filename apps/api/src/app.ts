import Fastify, { LogController } from 'fastify';
import { PROTOCOL_VERSION, LIMITS, NAMESPACE_VERSION } from '@attuner/sync-protocol';
import { DatabaseWorker, type AttunerDatabase } from '@attuner/database';
import type { ServerTLS } from './tls';
import type { Writable } from 'node:stream';
export function buildApp(
  database: AttunerDatabase | DatabaseWorker,
  options: {
    tls?: ServerTLS;
    secure?: boolean;
    serverId?: string;
    connectedSync?: boolean;
    structuredLogging?: boolean;
    logStream?: Writable;
    trustLoopbackProxy?: boolean;
    storageReady?: () => Promise<boolean>;
  } = {},
) {
  const app = Fastify({
    logger: options.structuredLogging
      ? {
          level: 'info',
          base: null,
          serializers: {
            req: () => ({}),
            res: () => ({}),
            err: () => ({ type: 'Error', message: 'omitted', stack: '' }),
          },
          redact: { paths: ['req', 'res', 'err'], remove: true },
          ...(options.logStream ? { stream: options.logStream } : {}),
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustLoopbackProxy ? ['127.0.0.1', '::1'] : false,
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
  if (options.structuredLogging)
    app.addHook('onResponse', async (request, reply) => {
      app.log.info({
        event: 'http.request',
        requestId: request.id,
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
          request.method,
        )
          ? request.method
          : 'OTHER',
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    });
  app.get('/api/v1/health/live', async () => ({ status: 'ok', service: 'attuner-api' }));
  app.get('/api/v1/health/ready', async (_request, reply) => {
    try {
      if (database instanceof DatabaseWorker) await database.query('SELECT 1');
      else database.sqlite.prepare('SELECT 1').get();
      if (options.storageReady && !(await options.storageReady())) {
        reply.code(503);
        return { status: 'not_ready', database: 'ready', storage: 'unavailable' };
      }
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
      synchronization: !!options.connectedSync,
      blobTransfers: !!options.connectedSync,
      immutableSnapshots: !!options.connectedSync,
      jobReporting: !!options.connectedSync,
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
