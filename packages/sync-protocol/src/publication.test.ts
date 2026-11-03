import { describe, it, expect } from 'vitest';
import vectors from '../../../fixtures/protocol/publications.json';
import {
  canonicalManifest,
  manifestDigest,
  validatePublicationManifest,
  namespaceKey,
  headSchema,
  publicationSchema,
} from './index';
describe('publication contract', () => {
  for (const vector of vectors)
    it('shares canonical bytes and digest with Rust', async () => {
      expect(canonicalManifest(vector.manifest)).toBe(vector.canonical);
      expect(await manifestDigest(vector.manifest)).toBe(vector.hash);
      await validatePublicationManifest(
        vector.manifest,
        vector.manifest.profileId,
        ['account', 'addons'],
        1,
      );
      expect(
        canonicalManifest({ ...vector.manifest, files: [...vector.manifest.files].reverse() }),
      ).toBe(vector.canonical);
    });
  it.each([
    ['Straße', 'STRASSE'],
    ['Ａ', 'a'],
    ['Café', 'Cafe\u0301'],
    ['Ꭰ', 'ꭰ'],
  ])('shares Unicode namespace %s / %s', (a, b) => expect(namespaceKey(a)).toBe(namespaceKey(b)));
  it('rejects aliases of virtual directories and ancestor files', () => {
    const vector = vectors[0]!;
    for (const paths of [
      ['Ａ/one.lua', 'A/two.lua'],
      ['Ａ/one.lua', 'A'],
    ])
      expect(() =>
        canonicalManifest({
          ...vector.manifest,
          files: paths.map((path) => ({ ...vector.manifest.files[0]!, path })),
        }),
      ).toThrow();
  });
  it('binds policy, profile and consistency groups', async () => {
    const m = vectors[0]!.manifest;
    await expect(
      validatePublicationManifest(m, '22222222-2222-4222-8222-222222222222', ['account'], 1),
    ).rejects.toThrow();
    await expect(
      validatePublicationManifest(
        { ...m, files: [{ ...m.files[0]!, group: 'forged' }] },
        m.profileId,
        ['account'],
        1,
      ),
    ).rejects.toThrow();
  });
  it('rejects mismatched head references and duplicate coverage', () => {
    expect(
      headSchema.safeParse({ revision: 0, snapshotId: null, manifestHash: null }).success,
    ).toBe(true);
    expect(
      headSchema.safeParse({ revision: 1, snapshotId: null, manifestHash: null }).success,
    ).toBe(false);
    expect(
      headSchema.safeParse({
        revision: 1,
        snapshotId: vectors[0]!.manifest.profileId,
        manifestHash: null,
      }).success,
    ).toBe(false);
    expect(
      publicationSchema.safeParse({
        publicationVersion: 1,
        namespaceVersion: 1,
        expectedHead: { revision: 0, snapshotId: null, manifestHash: null },
        baseSnapshotId: null,
        coveredRoots: ['account', 'account'],
        manifest: vectors[0]!.manifest,
        manifestHash: vectors[0]!.hash,
      }).success,
    ).toBe(false);
  });
});
