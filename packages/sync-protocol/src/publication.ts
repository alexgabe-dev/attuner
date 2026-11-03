import { z } from 'zod';
import { blake3 } from 'hash-wasm';
import namespace from '../../../fixtures/unicode/namespace-v1.json';
import { manifestSchema, hashSchema, type Manifest, isPortablePath } from './manifest';
export const LIMITS = Object.freeze({
  fileBytes: 1073741824,
  treeBytes: 4294967296,
  manifestBytes: 16777216,
  entries: 100000,
  chunkBytes: 4194304,
  page: 200,
});
export const NAMESPACE_VERSION = 1;
const fold: Record<string, string> = namespace.fold;
export function namespaceKey(text: string): string {
  return Array.from(text.normalize('NFKC'), (char) => fold[String(char.codePointAt(0))] ?? char)
    .join('')
    .normalize('NFKC');
}
export function assignedPath(text: string): boolean {
  return Array.from(text).every((char) => {
    const point = char.codePointAt(0)!;
    return namespace.assigned.some(([start, end]) => point >= start! && point <= end!);
  });
}
export function validateNamespace(manifest: Manifest): void {
  const seen = new Map<string, { spelling: string; file: boolean }>();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (!isPortablePath(entry.path) || !assignedPath(entry.path) || entry.size > LIMITS.fileBytes)
      throw new Error('UNSAFE_MANIFEST');
    bytes += entry.size;
    if (bytes > LIMITS.treeBytes) throw new Error('LIMIT_EXCEEDED');
    const parts = entry.path.split('/');
    if (parts.length > 64) throw new Error('LIMIT_EXCEEDED');
    for (let index = 1; index <= parts.length; index++) {
      const spelling = `${entry.root}/${parts.slice(0, index).join('/')}`;
      const file = index === parts.length;
      const key = namespaceKey(spelling);
      const prior = seen.get(key);
      if (prior && (prior.spelling !== spelling || prior.file || file))
        throw new Error('PATH_COLLISION');
      seen.set(key, { spelling, file });
    }
  }
}
function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function canonicalManifest(input: unknown): string {
  const manifest = manifestSchema.parse(input);
  validateNamespace(manifest);
  const files = [...manifest.files]
    .sort((a, b) => compareUtf8(a.root, b.root) || compareUtf8(a.path, b.path))
    .map((f) => ({ group: f.group, hash: f.hash, path: f.path, root: f.root, size: f.size }));
  const value = JSON.stringify({
    files,
    policyVersion: manifest.policyVersion,
    profileId: manifest.profileId,
    protocolVersion: manifest.protocolVersion,
  });
  if (new TextEncoder().encode(value).length > LIMITS.manifestBytes)
    throw new Error('LIMIT_EXCEEDED');
  return value;
}
export async function manifestDigest(input: unknown): Promise<string> {
  return blake3(canonicalManifest(input));
}
export async function consistencyGroup(root: string, path: string): Promise<string> {
  const groupPath = root === 'addons' ? path.split('/')[0]! : path;
  return `${root}:${(await blake3(groupPath)).slice(0, 24)}`;
}
export async function validatePublicationManifest(
  input: unknown,
  profileId: string,
  roots: readonly string[],
  policyVersion: number,
): Promise<Manifest> {
  const manifest = manifestSchema.parse(input);
  canonicalManifest(manifest);
  if (
    manifest.profileId !== profileId ||
    manifest.policyVersion !== policyVersion ||
    new Set(roots).size !== roots.length
  )
    throw new Error('POLICY_MISMATCH');
  for (const file of manifest.files) {
    if (!roots.includes(file.root) || file.group !== (await consistencyGroup(file.root, file.path)))
      throw new Error('POLICY_MISMATCH');
  }
  return manifest;
}
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const headSchema = z
  .strictObject({ snapshotId: z.uuid().nullable(), revision, manifestHash: hashSchema.nullable() })
  .refine(
    (v) =>
      (v.revision === 0 && v.snapshotId === null && v.manifestHash === null) ||
      (v.revision > 0 && v.snapshotId !== null && v.manifestHash !== null),
    'Invalid head',
  );
export const publicationSchema = z
  .strictObject({
    publicationVersion: z.literal(1),
    namespaceVersion: z.literal(1),
    expectedHead: headSchema,
    baseSnapshotId: z.uuid().nullable(),
    coveredRoots: z
      .array(z.enum(['account', 'addons', 'character']))
      .min(1)
      .max(3),
    manifest: manifestSchema,
    manifestHash: hashSchema,
  })
  .superRefine((v, ctx) => {
    if (new Set(v.coveredRoots).size !== v.coveredRoots.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate coverage' });
  });
export type Publication = z.infer<typeof publicationSchema>;
export type Head = z.infer<typeof headSchema>;
export const jobStates = [
  'ready',
  'capturing',
  'fetching',
  'comparing',
  'bootstrapReview',
  'conflictReview',
  'transferring',
  'awaitingApproval',
  'publishing',
  'remoteCommitted',
  'applying',
  'recoveryRequired',
  'acknowledgementPending',
  'complete',
  'cancelled',
  'offline',
  'revoked',
  'failed',
] as const;
