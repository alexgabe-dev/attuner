// Development/test certificates only. Production loads externally managed TLS material.
import 'reflect-metadata';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, KeyObject } from 'node:crypto';
import {
  X509CertificateGenerator,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  ExtendedKeyUsageExtension,
  ExtendedKeyUsage,
  SubjectAlternativeNameExtension,
} from '@peculiar/x509';
import { loadTLS } from '../tls.ts';
export async function tlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'attuner-tls-'));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'certificate.pem'),
    caPath = join(directory, 'ca.pem');
  const passphrase = randomBytes(32).toString('base64url');
  try {
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const caKeys = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const dates = {
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 2 * 86400000),
    };
    const ca = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=Attuner Synthetic CA',
      keys: caKeys,
      signingAlgorithm: algorithm,
      ...dates,
      extensions: [
        new BasicConstraintsExtension(true, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    const cert = await X509CertificateGenerator.create({
      subject: 'CN=localhost',
      issuer: ca.subject,
      publicKey: keys.publicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: algorithm,
      ...dates,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([
          { type: 'dns', value: 'localhost' },
          { type: 'ip', value: '127.0.0.1' },
        ]),
      ],
    });
    // WebCrypto keys remain in memory; only encrypted PKCS#8 is written.
    const key = KeyObject.from(keys.privateKey).export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    });
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(certPath, cert.toString('pem'));
    await writeFile(caPath, ca.toString('pem'));
    return {
      directory,
      keyPath,
      certPath,
      caPath,
      passphrase,
      ca: Buffer.from(ca.toString('pem')),
      tls: await loadTLS({
        ATTUNER_TLS_KEY: keyPath,
        ATTUNER_TLS_CERT: certPath,
        ATTUNER_TLS_PASSPHRASE: passphrase,
      }),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
