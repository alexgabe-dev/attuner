import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decryptFile, encryptFile } from './crypto.ts';
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'attuner-encrypted-backup-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it('authenticates empty and multi-chunk original bytes with bounded streaming', async () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('original\0\r\n'),
    randomBytes(1024 * 1024 + 17),
  ]) {
    const root = await fixture(),
      key = randomBytes(32);
    await writeFile(join(root, 'source'), bytes);
    const encrypted = await encryptFile(
      join(root, 'source'),
      join(root, 'encrypted'),
      key,
      'fixture:object',
      bytes.length,
    );
    const restored = await decryptFile(
      join(root, 'encrypted'),
      join(root, 'restored'),
      key,
      'fixture:object',
      bytes.length,
    );
    expect(restored).toEqual(encrypted);
    expect(await readFile(join(root, 'restored'))).toEqual(bytes);
    key.fill(0);
  }
});
it('refuses swapped contexts, wrong keys and size-limit overruns', async () => {
  const root = await fixture(),
    key = randomBytes(32);
  await writeFile(join(root, 'source'), randomBytes(1024));
  await encryptFile(join(root, 'source'), join(root, 'encrypted'), key, 'backup-a:object-a', 1024);
  await expect(
    decryptFile(join(root, 'encrypted'), join(root, 'swapped'), key, 'backup-b:object-a', 1024),
  ).rejects.toThrow();
  await expect(
    decryptFile(
      join(root, 'encrypted'),
      join(root, 'wrong-key'),
      randomBytes(32),
      'backup-a:object-a',
      1024,
    ),
  ).rejects.toThrow();
  await expect(
    decryptFile(join(root, 'encrypted'), join(root, 'too-large'), key, 'backup-a:object-a', 10),
  ).rejects.toThrow('MAINTENANCE_UNSAFE_CIPHERTEXT');
  await expect(
    encryptFile(
      join(root, 'source'),
      join(root, 'too-large-encrypt'),
      key,
      'backup-a:object-a',
      10,
    ),
  ).rejects.toThrow('MAINTENANCE_UNSAFE_FILE');
  key.fill(0);
});
it.skipIf(process.platform === 'win32')(
  'rejects symlink/hard-link source aliases and never clobbers output',
  async () => {
    const root = await fixture(),
      key = randomBytes(32);
    await writeFile(join(root, 'source'), 'original');
    await symlink(join(root, 'source'), join(root, 'symlink'));
    await expect(
      encryptFile(join(root, 'symlink'), join(root, 'out'), key, 'fixture', 64),
    ).rejects.toThrow();
    await writeFile(join(root, 'out'), 'unrelated destination');
    await expect(
      encryptFile(join(root, 'source'), join(root, 'out'), key, 'fixture', 64),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'out'), 'utf8')).toBe('unrelated destination');
    await link(join(root, 'source'), join(root, 'hardlink'));
    await expect(
      encryptFile(join(root, 'source'), join(root, 'new-out'), key, 'fixture', 64),
    ).rejects.toThrow('MAINTENANCE_UNSAFE_FILE');
    key.fill(0);
  },
);
