import { z } from 'zod';
export const profileGrantSchema = z.strictObject({
  profileId: z.uuid(),
  permission: z.enum(['read', 'write']),
});
export const profileGrantsSchema = z
  .array(profileGrantSchema)
  .min(1)
  .max(20)
  .refine((v) => new Set(v.map((g) => g.profileId)).size === v.length);
export const enrollmentRequestSchema = z.strictObject({
  deviceName: z.string().trim().min(1).max(80),
  os: z.enum(['macos', 'windows', 'linux']),
  clientVersion: z.string().min(1).max(32),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
});
export const enrollmentResponseSchema = z.strictObject({
  enrollmentId: z.uuid(),
  authorizationUrl: z.url().max(2048),
  expiresIn: z.number().int().min(1).max(600),
});
export const enrollmentDecisionSchema = z.strictObject({
  approve: z.boolean(),
  grants: profileGrantsSchema.optional(),
});
export const tokenRequestSchema = z.discriminatedUnion('grantType', [
  z.strictObject({
    grantType: z.literal('authorization_code'),
    enrollmentId: z.uuid(),
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  }),
  z.strictObject({
    grantType: z.literal('refresh_token'),
    refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
]);
export const tokenResponseSchema = z.strictObject({
  deviceId: z.uuid(),
  tokenType: z.literal('DPoP'),
  accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresIn: z.literal(300),
});
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
