import { readFile } from 'node:fs/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { runtimeCredential } from './credentials.ts';
export type ServerTLS = { key: Buffer; cert: Buffer; passphrase: string; minVersion: 'TLSv1.2' };
export async function loadTLS(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServerTLS> {
  const keyPath = env.ATTUNER_TLS_KEY,
    certPath = env.ATTUNER_TLS_CERT;
  const credentialKey = await runtimeCredential('api-tls-key', 32768, env);
  const credentialPassword = await runtimeCredential('api-tls-passphrase', 1024, env);
  let passphrase: string | undefined;
  try {
    passphrase = credentialPassword
      ? new TextDecoder('utf8', { fatal: true }).decode(credentialPassword).replace(/\r?\n$/, '')
      : env.ATTUNER_TLS_PASSPHRASE;
  } finally {
    credentialPassword?.fill(0);
  }
  if ((!keyPath && !credentialKey) || !certPath || !passphrase)
    throw new Error(
      'TLS is required: set ATTUNER_TLS_KEY, ATTUNER_TLS_CERT and ATTUNER_TLS_PASSPHRASE. No HTTP credential listener is available.',
    );
  const [key, cert] = await Promise.all([credentialKey ?? readFile(keyPath!), readFile(certPath)]);
  return validateTLS(key, cert, passphrase);
}
export function validateTLS(key: Buffer, cert: Buffer, passphrase: string): ServerTLS {
  if (!key.toString('utf8').includes('ENCRYPTED PRIVATE KEY'))
    throw new Error('The configured TLS private key must be encrypted PKCS#8.');
  createPrivateKey({ key, passphrase });
  new X509Certificate(cert);
  return { key, cert, passphrase, minVersion: 'TLSv1.2' };
}
