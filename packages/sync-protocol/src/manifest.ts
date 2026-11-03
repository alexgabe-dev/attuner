import { z } from 'zod';
export const PROTOCOL_VERSION = 1 as const;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function isPortablePath(path: string): boolean {
  return (
    path.length > 0 &&
    new TextEncoder().encode(path).length <= 1024 &&
    path.normalize('NFC') === path &&
    !/[\\:<>"|?*]/.test(path) &&
    !Array.from(path).some(
      (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
    ) &&
    path
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          new TextEncoder().encode(part).length <= 255 &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !reserved.test(part),
      )
  );
}
export const pathSchema = z.string().refine(isPortablePath, 'Path is not portable');
export const manifestFileSchema = z.strictObject({
  root: z.enum(['account', 'character', 'addons']),
  path: pathSchema,
  hash: hashSchema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  group: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).length <= 128),
});
export const manifestSchema = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    profileId: z.uuid(),
    policyVersion: z.number().int().min(1).max(2147483647),
    files: z.array(manifestFileSchema).max(100_000),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.files.forEach((file, index) => {
      const key = `${file.root}/${file.path.toLowerCase()}`;
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          message: 'Portable path collision',
          path: ['files', index, 'path'],
        });
      seen.add(key);
    });
    manifest.files.forEach((file, index) => {
      const parts = file.path.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) {
        if (seen.has(`${file.root}/${parts.slice(0, i).join('/')}`))
          ctx.addIssue({
            code: 'custom',
            message: 'File/directory path collision',
            path: ['files', index, 'path'],
          });
      }
    });
  });
export const changeSchema = z
  .strictObject({
    root: z.enum(['account', 'character', 'addons']),
    path: pathSchema,
    beforeHash: hashSchema.nullable(),
    afterHash: hashSchema.nullable(),
  })
  .refine((c) => c.beforeHash !== c.afterHash, 'Change must alter content or explicitly delete it');
export const prepareSchema = z.strictObject({
  protocolVersion: z.literal(1),
  expectedHead: z.uuid().nullable(),
  baseSnapshotId: z.uuid().nullable(),
  policyVersion: z.number().int().positive(),
  changes: z.array(changeSchema).max(100_000),
  coveredRoots: z.array(z.enum(['account', 'character', 'addons'])).min(1),
});
export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  retryable: z.boolean(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = z.infer<typeof manifestFileSchema>;
export type PrepareRequest = z.infer<typeof prepareSchema>;
