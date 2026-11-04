import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeCredential } from './credentials.ts';
import { loadDeliveryKey } from './secure-app.ts';
import { loadTLS } from './tls.ts';
import { tlsFixture } from './testing/tls-fixture.ts';
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'attuner-runtime-credential-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
it.skipIf(process.platform === 'win32')(
  'loads private runtime credentials without environment-secret fallback',
  async () => {
    const directory = await fixture(),
      key = randomBytes(32);
    await writeFile(join(directory, 'token-delivery-key'), key, { mode: 0o600 });
    const env = {
      CREDENTIALS_DIRECTORY: directory,
      ATTUNER_TOKEN_DELIVERY_KEY: randomBytes(32).toString('base64'),
    };
    expect(await loadDeliveryKey(env)).toEqual(key);
    await rm(join(directory, 'token-delivery-key'));
    await expect(loadDeliveryKey(env)).rejects.toThrow();
    const tls = await tlsFixture();
    try {
      await writeFile(join(directory, 'api-tls-key'), tls.tls.key, { mode: 0o600 });
      await writeFile(join(directory, 'api-tls-passphrase'), tls.passphrase, { mode: 0o600 });
      expect(
        (
          await loadTLS({
            CREDENTIALS_DIRECTORY: directory,
            ATTUNER_TLS_CERT: tls.certPath,
            ATTUNER_TLS_PASSPHRASE: 'ignored-wrong-value',
          })
        ).key,
      ).toEqual(tls.tls.key);
    } finally {
      await tls.close();
    }
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects readable-by-others, linked, missing and oversized secret files',
  async () => {
    const directory = await fixture(),
      file = join(directory, 'token-delivery-key');
    await writeFile(file, randomBytes(32), { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(
      runtimeCredential('token-delivery-key', 32, { CREDENTIALS_DIRECTORY: directory }),
    ).rejects.toThrow('Unsafe');
    await chmod(file, 0o600);
    await link(file, join(directory, 'alias'));
    await expect(
      runtimeCredential('token-delivery-key', 32, { CREDENTIALS_DIRECTORY: directory }),
    ).rejects.toThrow('Unsafe');
    await rm(file);
    await symlink(join(directory, 'alias'), file);
    await expect(
      runtimeCredential('token-delivery-key', 32, { CREDENTIALS_DIRECTORY: directory }),
    ).rejects.toThrow();
    await rm(file);
    await writeFile(file, randomBytes(33), { mode: 0o600 });
    await expect(
      runtimeCredential('token-delivery-key', 32, { CREDENTIALS_DIRECTORY: directory }),
    ).rejects.toThrow('Unsafe');
  },
);
