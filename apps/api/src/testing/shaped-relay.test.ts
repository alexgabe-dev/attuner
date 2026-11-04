import { it, expect } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { shapedRelay } from './shaped-relay.ts';
it('paces ordered bytes with bounded backpressure and closes only its own sockets', async () => {
  const sockets = new Set<Socket>();
  const echo = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  if (!address || typeof address === 'string') throw new Error('No echo fixture');
  const relay = await shapedRelay(address.port, { rttMs: 20, uploadMbps: 50, downloadMbps: 50 });
  let client: Socket | undefined;
  try {
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const result = await new Promise<Buffer>((resolve, reject) => {
      client = connect({ host: '127.0.0.1', port: relay.port }, () => client!.end(payload));
      const chunks: Buffer[] = [];
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
      client.on('end', () => resolve(Buffer.concat(chunks)));
      client.on('error', reject);
      client.setTimeout(5000, () => client!.destroy(new Error('Relay test timeout')));
      // Exercise receiver backpressure while propagation is queued.
      client.pause();
      setTimeout(() => client!.resume(), 100);
    });
    expect(result.equals(payload)).toBe(true);
    expect(relay.stats.uploadWireBytes).toBe(payload.length);
    expect(relay.stats.downloadWireBytes).toBe(payload.length);
    expect(relay.stats.connections).toBe(1);
  } finally {
    client?.destroy();
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('rejects nonlocal upstream specifications and invalid shaping budgets', async () => {
  await expect(shapedRelay(80, { rttMs: 20, uploadMbps: 10, downloadMbps: 10 })).rejects.toThrow();
  await expect(
    shapedRelay(4317, { rttMs: Infinity, uploadMbps: 10, downloadMbps: 10 }),
  ).rejects.toThrow();
});
