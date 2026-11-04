import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

it('produces a bounded Jammy shared-host inventory, configurable ports and no replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attuner-jammy-bundle-'));
  const output = join(root, 'bundle');
  function render(
    origin = 'https://attuner-staging.example.com',
    directory = output,
    extra: string[] = [],
  ) {
    return execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/render-staging.ts', origin, directory, ...extra],
      { stdio: 'pipe' },
    );
  }
  try {
    render(undefined, undefined, ['--api-port', '14317', '--web-port', '14318']);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(manifest.target.systemdMinimum).toBe(249);
    expect(manifest.activationApproved).toBe(false);
    expect(manifest.deployed).toBe(false);
    expect(manifest.containsSecrets).toBe(false);
    const names = await readdir(output);
    expect(names).not.toContain('attuner-staging-proxy.service');
    expect(names).not.toContain('nginx.conf');
    const env = await readFile(join(output, 'service.env'), 'utf8');
    expect(env).toContain('ATTUNER_PORT=14317\n');
    expect(env).toContain('ATTUNER_MONITOR_PORT=14317\n');
    expect(env).toContain('ATTUNER_WEB_PORT=14318\n');
    expect(env).toContain('ATTUNER_DISK_RESERVE_BYTES=10737418240');
    for (const entry of manifest.files) {
      const bytes = await readFile(join(output, entry.name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      if (entry.name.endsWith('.service')) {
        expect(bytes.toString()).not.toContain('LoadCredentialEncrypted=');
        expect(bytes.toString()).toContain('Slice=attuner-staging.slice');
        expect(bytes.toString()).toContain('User=attuner-');
      }
    }
    expect(() => render()).toThrow();
    for (const origin of [
      'https://pry.hu',
      'https://bad..example.com',
      'http://attuner.example.com',
      'https://attuner.example.com/path',
    ])
      expect(() => render(origin, join(root, 'rejected'))).toThrow();
    expect(() => render(undefined, join(root, 'ports'), ['--api-port', '4318'])).toThrow();
    expect(await readdir(root)).toEqual(['bundle']);
  } finally {
    await rm(root, { recursive: true });
  }
}, 15000);
