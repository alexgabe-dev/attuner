import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
const caPath = process.env.ATTUNER_MONITOR_CA;
const name = process.env.ATTUNER_INTERNAL_TLS_NAME ?? 'attuner-api.internal';
const port = Number(process.env.ATTUNER_MONITOR_PORT ?? '4317');
if (
  !caPath ||
  !/^[a-z0-9.-]+$/.test(name) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Public monitor CA, internal TLS name and loopback port required.');
let ready: boolean;
try {
  const ca = await readFile(caPath);
  if (ca.length > 32768) throw new Error('Monitor CA size limit.');
  ready = await new Promise<boolean>((resolve, reject) => {
    const call = request(
      {
        hostname: '127.0.0.1',
        port,
        servername: name,
        path: '/api/v1/health/ready',
        ca,
        minVersion: 'TLSv1.2',
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (bytes: Buffer) => {
          size += bytes.length;
          if (size > 8192) {
            response.destroy(new Error('Monitor response limit.'));
            return;
          }
          chunks.push(bytes);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve(
              response.statusCode === 200 &&
                JSON.parse(Buffer.concat(chunks).toString('utf8')).status === 'ready',
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    call.setTimeout(10000, () => call.destroy(new Error('Monitor timeout.')));
    call.on('error', reject);
    call.end();
  });
} catch {
  ready = false;
}
console.log(
  JSON.stringify({ event: 'monitor.readiness', ready, checkedAt: new Date().toISOString() }),
);
process.exitCode = ready ? 0 : 1;
