// Test-only TCP relay. TLS remains end-to-end. No OS network settings change.
import { createServer, connect, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { performance } from 'node:perf_hooks';
export type Shape = { rttMs: number; uploadMbps: number; downloadMbps: number };
export async function shapedRelay(port: number, shape: Shape) {
  if (
    !Number.isInteger(port) ||
    port <= 1024 ||
    port > 65535 ||
    !Number.isFinite(shape.rttMs) ||
    shape.rttMs < 0 ||
    shape.rttMs > 1000 ||
    ![shape.uploadMbps, shape.downloadMbps].every((n) => Number.isFinite(n) && n >= 1 && n <= 10000)
  )
    throw new Error('Invalid isolated network shape.');
  const sockets = new Set<Socket>();
  const stats = { uploadWireBytes: 0, downloadWireBytes: 0, connections: 0 };
  class Pace extends Transform {
    private wireAvailable = 0;
    private pendingBytes = 0;
    private queue: { chunk: Buffer; ready: boolean }[] = [];
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private blocked = false;
    private release: TransformCallback | undefined;
    private finished: TransformCallback | undefined;
    constructor(private direction: 'upload' | 'download') {
      super({ highWaterMark: 65536 });
    }
    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      if (chunk.length > 65536) {
        callback(new Error('Relay chunk exceeded its bound.'));
        return;
      }
      const now = performance.now();
      this.wireAvailable =
        Math.max(now, this.wireAvailable) +
        (chunk.length * 8) /
          (shape[this.direction === 'upload' ? 'uploadMbps' : 'downloadMbps'] * 1000);
      const serializedIn = this.wireAvailable - now;
      stats[this.direction === 'upload' ? 'uploadWireBytes' : 'downloadWireBytes'] += chunk.length;
      const entry = { chunk, ready: false };
      this.queue.push(entry);
      this.pendingBytes += chunk.length;
      this.later(
        () => {
          entry.ready = true;
          this.drain();
        },
        serializedIn + shape.rttMs / 2,
      );
      // Propagation can overlap the next chunk's serialization. Queue/backpressure
      // remains bounded even when the receiver stops reading.
      this.later(() => {
        this.release = callback;
        this.drain();
      }, serializedIn);
    }
    private later(action: () => void, delay: number) {
      const timer = setTimeout(
        () => {
          this.timers.delete(timer);
          action();
        },
        Math.max(0, delay),
      );
      this.timers.add(timer);
    }
    private drain() {
      while (!this.blocked && this.queue[0]?.ready) {
        const entry = this.queue.shift()!;
        this.pendingBytes -= entry.chunk.length;
        this.blocked = !this.push(entry.chunk);
      }
      if (!this.blocked && this.pendingBytes < 2 * 1024 * 1024 && this.release) {
        const callback = this.release;
        this.release = undefined;
        callback();
      }
      if (!this.queue.length && this.finished) {
        const callback = this.finished;
        this.finished = undefined;
        callback();
      }
    }
    _read(size: number) {
      this.blocked = false;
      this.drain();
      super._read(size);
    }
    _flush(callback: TransformCallback) {
      this.finished = callback;
      this.drain();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
      this.queue = [];
      this.pendingBytes = 0;
      callback(error);
    }
  }
  const server = createServer({ highWaterMark: 65536, allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    const upload = new Pace('upload'),
      download = new Pace('download');
    stats.connections++;
    sockets.add(client);
    sockets.add(upstream);
    const stop = () => {
      client.destroy();
      upstream.destroy();
      upload.destroy();
      download.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', stop);
      socket.on('close', (hadError) => {
        sockets.delete(socket);
        // A clean upstream FIN can precede queued propagation. Pipes finish
        // naturally after their bounded queues drain; errors close both sides.
        if (hadError || socket === client) stop();
      });
    }
    upload.on('error', stop);
    download.on('error', stop);
    client.pipe(upload).pipe(upstream);
    upstream.pipe(download).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No isolated relay listener.');
  return {
    port: address.port,
    stats,
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
