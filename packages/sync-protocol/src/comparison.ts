import { manifestSchema, type Manifest, type ManifestFile } from './manifest.ts';
import { validateNamespace, compareUtf8 } from './publication.ts';
export type ConflictEntry = {
  root: ManifestFile['root'];
  path: string;
  baseline: ManifestFile | null;
  local: ManifestFile | null;
  remote: ManifestFile | null;
  group: string | null;
  reason: 'modificationOrDeletion' | 'addonGroup';
};
export type VariantDecision = { root: string; path: string; choice: 'local' | 'remote' };
const key = (file: { root: string; path: string }) => file.root + '\0' + file.path;
const equal = (a?: ManifestFile | null, b?: ManifestFile | null) =>
  a?.hash === b?.hash && a?.size === b?.size;
/** Read-only metadata comparison. The native Rust engine independently validates every proposal. */
export function compareManifests(baseline: Manifest, local: Manifest, remote: Manifest) {
  for (const manifest of [baseline, local, remote]) {
    manifestSchema.parse(manifest);
    validateNamespace(manifest);
    if (
      manifest.profileId !== baseline.profileId ||
      manifest.policyVersion !== baseline.policyVersion
    )
      throw new Error('POLICY_MISMATCH');
  }
  const b = new Map(baseline.files.map((f) => [key(f), f])),
    l = new Map(local.files.map((f) => [key(f), f])),
    r = new Map(remote.files.map((f) => [key(f), f]));
  const keys = [...new Set([...b.keys(), ...l.keys(), ...r.keys()])].sort(compareUtf8);
  const changedGroups = (side: Map<string, ManifestFile>) =>
    new Set(
      keys.flatMap((k) => {
        const before = b.get(k),
          after = side.get(k);
        return equal(before, after)
          ? []
          : [before, after]
              .filter((f): f is ManifestFile => f?.root === 'addons')
              .map((f) => f.group);
      }),
    );
  const lg = changedGroups(l),
    rg = changedGroups(r),
    contested = new Set([...lg].filter((g) => rg.has(g)));
  const conflicts: ConflictEntry[] = [],
    merged: ManifestFile[] = [];
  for (const k of keys) {
    const before = b.get(k),
      left = l.get(k),
      right = r.get(k),
      file = before ?? left ?? right!;
    const grouped =
      [before, left, right].some((f) => f && contested.has(f.group)) && !equal(left, right);
    if (grouped || (!equal(left, right) && !equal(before, left) && !equal(before, right))) {
      conflicts.push({
        root: file.root,
        path: file.path,
        baseline: before ?? null,
        local: left ?? null,
        remote: right ?? null,
        group: grouped ? file.group : null,
        reason: grouped ? 'addonGroup' : 'modificationOrDeletion',
      });
      continue;
    }
    const result = equal(left, right) ? left : equal(before, left) ? right : left;
    if (result) merged.push(result);
  }
  const manifest = { ...baseline, files: merged };
  if (!conflicts.length) validateNamespace(manifest);
  return { conflicts, merged: conflicts.length ? null : manifest };
}
export function resolveComparison(
  baseline: Manifest,
  local: Manifest,
  remote: Manifest,
  decisions: VariantDecision[],
): Manifest {
  const comparison = compareManifests(baseline, local, remote);
  if (comparison.merged) {
    if (decisions.length) throw new Error('INVALID_DECISIONS');
    return comparison.merged;
  }
  if (decisions.length !== comparison.conflicts.length) throw new Error('INCOMPLETE_DECISIONS');
  const conflictIndex = new Map(comparison.conflicts.map((c) => [key(c), c]));
  const choices = new Map<string, VariantDecision['choice']>(),
    groups = new Map<string, VariantDecision['choice']>();
  for (const decision of decisions) {
    const k = key(decision),
      conflict = conflictIndex.get(k);
    if (!conflict || choices.has(k)) throw new Error('INVALID_DECISIONS');
    choices.set(k, decision.choice);
    if (conflict.group) {
      const previous = groups.get(conflict.group);
      if (previous && previous !== decision.choice) throw new Error('INCONSISTENT_GROUP');
      groups.set(conflict.group, decision.choice);
    }
  }
  const files = new Map<string, ManifestFile>();
  for (const f of [...baseline.files, ...local.files, ...remote.files]) files.set(key(f), f);
  const b = new Map(baseline.files.map((f) => [key(f), f])),
    l = new Map(local.files.map((f) => [key(f), f])),
    r = new Map(remote.files.map((f) => [key(f), f]));
  const selected: ManifestFile[] = [];
  for (const k of [...files.keys()].sort(compareUtf8)) {
    const left = l.get(k),
      right = r.get(k),
      before = b.get(k),
      choice = choices.get(k);
    const result = choice
      ? choice === 'local'
        ? left
        : right
      : equal(left, right)
        ? left
        : equal(before, left)
          ? right
          : left;
    if (result) selected.push(result);
  }
  const manifest = { ...baseline, files: selected };
  validateNamespace(manifest);
  return manifest;
}
