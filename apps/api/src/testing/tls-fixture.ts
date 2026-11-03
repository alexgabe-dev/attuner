import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadTLS } from '../tls.ts';
export async function tlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'attuner-tls-'));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'certificate.pem');
  const passphrase = randomBytes(32).toString('base64url');
  const process = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-passout',
      'stdin',
    ],
    { input: passphrase + '\n', encoding: 'utf8' },
  );
  if (process.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      'Could not generate the isolated TLS fixture. OpenSSL with req -addext support is required.',
    );
  }
  await chmod(keyPath, 0o600);
  return {
    directory,
    keyPath,
    certPath,
    passphrase,
    ca: await readFile(certPath),
    tls: await loadTLS({
      ATTUNER_TLS_KEY: keyPath,
      ATTUNER_TLS_CERT: certPath,
      ATTUNER_TLS_PASSPHRASE: passphrase,
    }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
