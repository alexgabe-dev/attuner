import { z } from 'zod';
import { manifestSchema, hashSchema, pathSchema } from './manifest.ts';
import { headSchema, jobStates } from './publication.ts';
export const decisionSchema = z.strictObject({
  root: z.enum(['account', 'addons', 'character']),
  path: pathSchema,
  choice: z.enum(['local', 'remote']),
});
export const jobReportSchema = z.strictObject({
  sourceGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(jobStates),
  localManifest: manifestSchema.nullable(),
  localManifestHash: hashSchema,
  baselineSnapshotId: z.uuid().nullable(),
  remoteHead: headSchema.nullable(),
  publishedHead: headSchema.nullable(),
  sessionId: z.uuid().nullable(),
  candidateManifestHash: hashSchema.nullable(),
  validatedProposalId: z.uuid().nullable(),
  reason: z.string().max(4096).nullable(),
});
export const proposalSchema = z.strictObject({
  sourceGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  localManifestHash: hashSchema,
  remoteHead: headSchema,
  decisions: z.array(decisionSchema).max(100000),
});
