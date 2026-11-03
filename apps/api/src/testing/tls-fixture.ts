import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadTLS } from '../tls.ts';
export async function tlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'attuner-tls-'));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'certificate.pem'),
    caPath = join(directory, 'ca.pem'),
    caKey = join(directory, 'ca-key.pem'),
    csr = join(directory, 'request.csr'),
    extensions = join(directory, 'extensions.conf');
  const passphrase = randomBytes(32).toString('base64url');
  const gitOpenSSL = join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Git',
    'usr',
    'bin',
    'openssl.exe',
  );
  const executable =
    process.platform === 'win32' && existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl';
  const config = join(directory, 'openssl.conf');
  const caConfig = join(directory, 'ca-openssl.conf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n');
  await writeFile(
    caConfig,
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Attuner Synthetic CA\n',
  );
  const run = (args: string[]) => {
    if (spawnSync(executable, args, { input: passphrase + '\n', encoding: 'utf8' }).status !== 0)
      throw new Error('OpenSSL could not create the isolated encrypted TLS fixture.');
  };
  try {
    run([
      'req',
      '-config',
      caConfig,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      caKey,
      '-out',
      caPath,
      '-days',
      '2',
      '-subj',
      '/CN=Attuner Synthetic CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-passout',
      'stdin',
    ]);
    run([
      'req',
      '-config',
      config,
      '-new',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      csr,
      '-subj',
      '/CN=localhost',
      '-passout',
      'stdin',
    ]);
    await writeFile(
      extensions,
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    );
    run([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caPath,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      certPath,
      '-days',
      '2',
      '-extfile',
      extensions,
      '-passin',
      'stdin',
    ]);
    await chmod(keyPath, 0o600);
    await chmod(caKey, 0o600);
    return {
      directory,
      keyPath,
      certPath,
      caPath,
      passphrase,
      ca: await readFile(caPath),
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
