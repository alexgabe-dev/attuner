import { readFile } from 'node:fs/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
export type ServerTLS = { key: Buffer; cert: Buffer; passphrase: string; minVersion: 'TLSv1.2' };
export async function loadTLS(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServerTLS> {
  const keyPath = env.ATTUNER_TLS_KEY,
    certPath = env.ATTUNER_TLS_CERT,
    passphrase = env.ATTUNER_TLS_PASSPHRASE;
  if (!keyPath || !certPath || !passphrase)
    throw new Error(
      'TLS is required: set ATTUNER_TLS_KEY, ATTUNER_TLS_CERT and ATTUNER_TLS_PASSPHRASE. No HTTP credential listener is available.',
    );
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return validateTLS(key, cert, passphrase);
}
export function validateTLS(key: Buffer, cert: Buffer, passphrase: string): ServerTLS {
  if (!key.toString('utf8').includes('ENCRYPTED PRIVATE KEY'))
    throw new Error('The configured TLS private key must be encrypted PKCS#8.');
  createPrivateKey({ key, passphrase });
  new X509Certificate(cert);
  return { key, cert, passphrase, minVersion: 'TLSv1.2' };
}
