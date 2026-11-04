import { randomBytes, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { DatabaseWorker } from '@attuner/database';
import { buildApp } from './app.ts';
import type { ServerTLS } from './tls.ts';
import { Security } from './security/service.ts';
import { securityRoutes } from './security/routes.ts';
import { BlobStorage } from './sync/storage.ts';
import { managementRoutes } from './sync/management.ts';
import { publicationRoutes } from './sync/publication.ts';
import { syncRoutes } from './sync/routes.ts';
import { ApiError } from './security/primitives.ts';
import { runtimeCredential } from './credentials.ts';
import type { Writable } from 'node:stream';
export type SecureOptions = {
  tls: ServerTLS;
  deliveryKey: Buffer;
  publicOrigin?: string;
  now?: () => number;
  blobDirectory?: string;
  structuredLogging?: boolean;
  logStream?: Writable;
  trustLoopbackProxy?: boolean;
  diskReserveBytes?: number;
};
export async function createSecureApp(database: DatabaseWorker, options: SecureOptions) {
  await database.run("INSERT OR IGNORE INTO server_settings VALUES('server_id',?)", [randomUUID()]);
  const settings = await database.query<{ value: string }>(
    "SELECT value FROM server_settings WHERE key='server_id'",
  );
  let storage: BlobStorage | undefined;
  const app = buildApp(database, {
    tls: options.tls,
    secure: true,
    serverId: settings[0]!.value,
    connectedSync: !!options.blobDirectory,
    ...(options.structuredLogging ? { structuredLogging: true } : {}),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    ...(options.trustLoopbackProxy ? { trustLoopbackProxy: true } : {}),
    ...(options.blobDirectory
      ? { storageReady: async () => (storage ? storage.ready() : false) }
      : {}),
  });
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
      STALE_REPORT: [409, 'STALE_REPORT'],
      REVIEW_MOVED: [409, 'REVIEW_MOVED'],
      HEAD_MOVED: [409, 'HEAD_MOVED'],
      BLOBS_MISSING: [409, 'BLOBS_MISSING'],
      SESSION_COMMITTED: [409, 'SESSION_COMMITTED'],
      ACK_REGRESSION: [409, 'ACK_REGRESSION'],
      ALREADY_COMMITTED: [409, 'ALREADY_COMMITTED'],
      SESSION_LIMIT: [429, 'SESSION_LIMIT'],
      QUOTA_EXCEEDED: [413, 'QUOTA_EXCEEDED'],
      TRANSFER_CLOSED: [409, 'TRANSFER_CLOSED'],
      BLOB_CORRUPT: [422, 'BLOB_CORRUPT'],
      IDEMPOTENCY_MISMATCH: [409, 'IDEMPOTENCY_MISMATCH'],
    };
    const mapped = error instanceof Error ? transactionErrors[error.message] : undefined;
    if (error instanceof Error && 'code' in error && error.code === 'ENOSPC')
      error = new ApiError(507, 'INSUFFICIENT_SPACE', 'Storage has insufficient free space.');
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('FST_ERR_CTP_')
    )
      error = new ApiError(
        error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : 400,
        'INVALID_REQUEST',
        'Request body was not accepted.',
      );
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
  if (options.blobDirectory) {
    storage = new BlobStorage(options.blobDirectory, options.diskReserveBytes);
    await storage.initialize();
    syncRoutes(app, security, storage);
    publicationRoutes(app, security, storage);
    managementRoutes(app, security, storage);
  }
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
export async function loadDeliveryKey(env: NodeJS.ProcessEnv = process.env) {
  const credential = await runtimeCredential('token-delivery-key', 32, env);
  if (credential) {
    if (credential.length !== 32) {
      credential.fill(0);
      throw new Error('A 32-byte runtime token-delivery key is required.');
    }
    return credential;
  }
  return deliveryKey(env);
}
