import { randomBytes, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { DatabaseWorker } from '@attuner/database';
import { buildApp } from './app.ts';
import type { ServerTLS } from './tls.ts';
import { Security } from './security/service.ts';
import { securityRoutes } from './security/routes.ts';
import { ApiError } from './security/primitives.ts';
export type SecureOptions = {
  tls: ServerTLS;
  deliveryKey: Buffer;
  publicOrigin?: string;
  now?: () => number;
};
export async function createSecureApp(database: DatabaseWorker, options: SecureOptions) {
  await database.run("INSERT OR IGNORE INTO server_settings VALUES('server_id',?)", [randomUUID()]);
  const settings = await database.query<{ value: string }>(
    "SELECT value FROM server_settings WHERE key='server_id'",
  );
  const app = buildApp(database, { tls: options.tls, secure: true, serverId: settings[0]!.value });
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('The public origin must be a root HTTPS origin.');
  }
  const security = new Security(database, {
    key: options.deliveryKey,
    origin: () => {
      if (options.publicOrigin) return new URL(options.publicOrigin).origin;
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('TLS listener is not ready');
      return `https://127.0.0.1:${address.port}`;
    },
    ...(options.now ? { now: options.now } : {}),
  });
  await security.initialize();
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/v1/health/')) security.tls(request);
  });
  app.setErrorHandler(async (error, request, reply) => {
    const transactionErrors: Record<string, [number, string]> = {
      NOT_FOUND: [404, 'NOT_FOUND'],
      AUTH_REQUIRED: [401, 'AUTH_REQUIRED'],
      DEVICE_REVOKED: [401, 'DEVICE_REVOKED'],
      ENROLLMENT_CLOSED: [409, 'ENROLLMENT_CLOSED'],
      REFRESH_MOVED: [409, 'REFRESH_MOVED'],
    };
    const mapped = error instanceof Error ? transactionErrors[error.message] : undefined;
    if (mapped)
      error = new ApiError(mapped[0], mapped[1], 'The request is no longer authorized or current.');
    const status =
      error instanceof ApiError ? error.statusCode : error instanceof ZodError ? 400 : 503;
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof ZodError
          ? 'INVALID_REQUEST'
          : 'SERVICE_UNAVAILABLE';
    try {
      await security.audit(
        request.attunerActor ?? { kind: 'anonymous', id: null },
        'request.denied',
        request.id,
        null,
        { code },
        'denied',
      );
    } catch {
      reply.code(503).send({
        code: 'AUDIT_UNAVAILABLE',
        message: 'The service cannot safely accept this request.',
        requestId: request.id,
        retryable: true,
      });
      return;
    }
    if (
      status === 401 &&
      (request.headers.dpop || request.headers.authorization?.startsWith('DPoP '))
    )
      reply.header(
        'WWW-Authenticate',
        `DPoP error="${code === 'use_dpop_nonce' ? code : 'invalid_token'}"`,
      );
    reply.code(status).send({
      code,
      message:
        error instanceof ApiError
          ? error.message
          : status === 400
            ? 'Request was not accepted.'
            : 'The service is temporarily unavailable.',
      requestId: request.id,
      retryable: status === 503 || status === 429,
    });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'GET' && reply.statusCode < 400 && request.attunerActor) {
      await security.audit(request.attunerActor, 'resource.read', request.id, null, {
        route: request.routeOptions.url ?? '',
        resource: request.url.split('?')[0],
      });
    }
    return payload;
  });
  securityRoutes(app, security);
  return { app, security };
}
export function deliveryKey(env: NodeJS.ProcessEnv = process.env) {
  const value = env.ATTUNER_TOKEN_DELIVERY_KEY;
  if (!value)
    throw new Error(
      'ATTUNER_TOKEN_DELIVERY_KEY is required. Supply a 32-byte base64 secret through the process secret provider.',
    );
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('The token-delivery key must contain 32 bytes.');
  return key;
}
export const ephemeralDevelopmentDeliveryKey = () => randomBytes(32);
