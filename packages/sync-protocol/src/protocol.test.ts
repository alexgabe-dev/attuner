import { describe, expect, it } from 'vitest';
import { blake3 } from 'hash-wasm';
import cases from '../../../fixtures/protocol/manifests.json';
import hashes from '../../../fixtures/protocol/hashes.json';
import { changeSchema, manifestSchema, prepareSchema } from './index';
describe('protocol v1 conformance', () => {
  for (const fixture of cases)
    it(fixture.name, () =>
      expect(manifestSchema.safeParse(fixture.manifest).success).toBe(fixture.valid),
    );
  for (const vector of hashes)
    it(`BLAKE3 vector ${JSON.stringify(vector.text)}`, async () =>
      expect(await blake3(vector.text)).toBe(vector.hash));
  it('requires an explicit deletion and rejects no-op changes', () => {
    expect(
      changeSchema.safeParse({
        root: 'account',
        path: 'a.lua',
        beforeHash: hashes[0]!.hash,
        afterHash: null,
      }).success,
    ).toBe(true);
    expect(
      changeSchema.safeParse({ root: 'account', path: 'a.lua', beforeHash: null, afterHash: null })
        .success,
    ).toBe(false);
  });
  it('requires nonempty scan coverage', () =>
    expect(
      prepareSchema.safeParse({
        protocolVersion: 1,
        expectedHead: null,
        baseSnapshotId: null,
        policyVersion: 1,
        changes: [],
        coveredRoots: [],
      }).success,
    ).toBe(false));
});
