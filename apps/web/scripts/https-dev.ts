// Loopback development gateway only. No trust-store changes or credential logging.
import { createServer, request as upstream } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import next from 'next';
import { tlsFixture } from '../../api/src/testing/tls-fixture.ts';
const directory = resolve(process.env.ATTUNER_DATA_DIR ?? '../../.runtime');
await mkdir(directory, { recursive: true, mode: 0o700 });
const ca = await readFile(join(directory, 'development-ca.pem'));
const fixture = await tlsFixture();
await copyFile(fixture.caPath, join(directory, 'dashboard-ca.pem'));
const server = createServer(fixture.tls);
const app = next({ dev: true, hostname: '127.0.0.1', port: 4318, httpServer: server });
await app.prepare();
const handle = app.getRequestHandler();
server.on('request', (req, res) => {
  if (req.url?.startsWith('/api/v1/')) {
    const headers: IncomingHttpHeaders = { ...req.headers, host: '127.0.0.1:4317' };
    delete headers['forwarded'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    const proxy = upstream(
      {
        hostname: '127.0.0.1',
        port: 4317,
        path: req.url,
        method: req.method,
        headers,
        ca,
        rejectUnauthorized: true,
        timeout: 65000,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    proxy.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ code: 'API_UNAVAILABLE', message: 'The Attuner API is unavailable.' }),
        );
      } else res.destroy();
    });
    proxy.on('timeout', () => proxy.destroy());
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => {
      if (!res.writableEnded) proxy.destroy();
    });
    req.pipe(proxy);
  } else void handle(req, res);
});
server.listen(4318, '127.0.0.1', () =>
  console.log(
    'Attuner development dashboard: https://127.0.0.1:4318; public CA: .runtime/dashboard-ca.pem',
  ),
);
async function close() {
  server.close();
  server.closeAllConnections();
  await fixture.close();
  await app.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close());
