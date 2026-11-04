import { it, expect } from 'vitest';
import cases from '../../../fixtures/protocol/comparisons.json';
import { compareManifests, resolveComparison } from './comparison';
import { manifestSchema } from './manifest';
it('matches the shared Rust comparison fixtures', () => {
  for (const fixture of cases) {
    const b = manifestSchema.parse(fixture.baseline),
      l = manifestSchema.parse(fixture.local),
      r = manifestSchema.parse(fixture.remote),
      result = compareManifests(b, l, r);
    expect(
      result.conflicts.map((c) => c.root + '/' + c.path),
      fixture.name,
    ).toEqual(fixture.conflictPaths);
    expect(result.merged, fixture.name).toEqual(fixture.merged);
  }
});
it('requires complete explicit choices and consistent addon groups', () => {
  const fixture = cases.find((c) => c.name === 'addon consistency group')!,
    b = manifestSchema.parse(fixture.baseline),
    l = manifestSchema.parse(fixture.local),
    r = manifestSchema.parse(fixture.remote),
    conflicts = compareManifests(b, l, r).conflicts;
  expect(() => resolveComparison(b, l, r, [])).toThrow('INCOMPLETE');
  const choices = conflicts.map((c) => ({ root: c.root, path: c.path, choice: 'local' as const }));
  expect(resolveComparison(b, l, r, choices)).toEqual(l);
  expect(() =>
    resolveComparison(b, l, r, [choices[0]!, { ...choices[1]!, choice: 'remote' }]),
  ).toThrow('INCONSISTENT');
});
