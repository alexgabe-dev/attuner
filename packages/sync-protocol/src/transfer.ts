import { z } from 'zod';
import { hashSchema } from './manifest.ts';
import { LIMITS } from './publication.ts';
export const blobIdentitySchema = z.strictObject({
  hash: hashSchema,
  size: z.number().int().min(0).max(LIMITS.fileBytes),
});
export const chunkReceiptSchema = z.strictObject({
  position: z.number().int().min(0).max(255),
  size: z.number().int().min(1).max(LIMITS.chunkBytes),
  hash: hashSchema,
});
export const downloadRangeSchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(LIMITS.fileBytes),
  length: z.coerce.number().int().min(0).max(LIMITS.chunkBytes),
});
export type BlobIdentity = z.infer<typeof blobIdentitySchema>;
export type ChunkReceipt = z.infer<typeof chunkReceiptSchema>;
