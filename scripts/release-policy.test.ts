import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  checkReleaseVersions,
  sha256File,
  validateDistributionEvidence,
  writeReleaseManifest,
} from './release-policy.ts';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'attuner-release-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
describe('distribution policy', () => {
  it('rejects incompatible versions and signature evidence from the wrong platform', () => {
    expect(checkReleaseVersions(['0.1.0', '0.1.0'])).toBe('0.1.0');
    for (const values of [['0.1.0', '0.2.0'], ['latest'], ['1.0.0\n'], ['01.0.0'], ['1.0.0-01']]) {
      expect(() => checkReleaseVersions(values)).toThrow();
    }
    expect(() =>
      validateDistributionEvidence(
        {
          schemaVersion: 1,
          platform: 'macos',
          applicationIdentity: 'app.attuner.desktop',
          signatureVerified: true,
        },
        'macos',
      ),
    ).toThrow();
    expect(() =>
      validateDistributionEvidence(
        {
          schemaVersion: 1,
          platform: 'windows',
          applicationIdentity: 'app.attuner.desktop',
          signatureVerified: true,
          timestampVerified: true,
        },
        'macos',
      ),
    ).toThrow();
  });
  it('hashes original artifact bytes and refuses symlink and hard-link aliases', async () => {
    const root = await fixture();
    const file = join(root, 'original.exe');
    const bytes = Buffer.from('synthetic artifact\0\r\n');
    await writeFile(file, bytes);
    expect(await sha256File(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
    if (process.platform !== 'win32') {
      const alias = join(root, 'symlink.exe');
      await symlink(file, alias);
      await expect(sha256File(alias)).rejects.toThrow('Unsafe');
    }
    await link(file, join(root, 'hardlink.exe'));
    await expect(sha256File(file)).rejects.toThrow('Unsafe');
  });
  it('marks development artifacts non-distributable and never overwrites an existing manifest', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'Attuner.exe'), 'synthetic executable');
    await writeFile(join(directory, 'Attuner-setup.exe'), 'synthetic installer');
    const options = {
      directory,
      platform: 'windows' as const,
      mode: 'development' as const,
      sourceCommit: 'a'.repeat(40),
      version: '0.1.0',
      architecture: 'x86_64',
    };
    await writeReleaseManifest(options);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.publicDistributionReady).toBe(false);
    expect(manifest.automaticUpdatesEnabled).toBe(false);
    expect(manifest.mode).toBe('development');
    expect(manifest.files).toHaveLength(2);
    await expect(writeReleaseManifest(options)).rejects.toThrow();
  });
  it('refuses signed mode without platform verification and incomplete artifact inventories', async () => {
    const directory = await fixture();
    const options = {
      directory,
      platform: 'windows' as const,
      mode: 'signed' as const,
      sourceCommit: 'a'.repeat(40),
      version: '0.1.0',
      architecture: 'x86_64',
    };
    await expect(writeReleaseManifest(options)).rejects.toThrow('Expected exactly');
    await writeFile(join(directory, 'Attuner.exe'), 'synthetic executable');
    await writeFile(join(directory, 'Attuner-setup.exe'), 'synthetic installer');
    await expect(writeReleaseManifest(options)).rejects.toThrow();
    await writeFile(
      join(directory, 'validation.json'),
      JSON.stringify({ signatureVerified: true }),
    );
    await expect(writeReleaseManifest(options)).rejects.toThrow('Missing platform');
  });
});
