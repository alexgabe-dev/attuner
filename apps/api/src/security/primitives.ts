import {
  argon2,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  verify,
} from 'node:crypto';
import { z } from 'zod';
export class ApiError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}
export const secret = () => randomBytes(32).toString('base64url');
export const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('base64url');
export const csrf = (key: Buffer, token: string) =>
  createHmac('sha256', key)
    .update('attuner-csrf\0' + token)
    .digest('base64url');
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
let hashing = false;
async function derive(password: string, salt: Buffer) {
  if (hashing) throw new ApiError(503, 'AUTH_BUSY', 'Authentication is busy. Retry shortly.');
  hashing = true;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      argon2(
        'argon2id',
        { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    hashing = false;
  }
}
export async function passwordHash(password: string) {
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024)
    throw new ApiError(400, 'PASSWORD_LENGTH', 'Use a password between 12 and 1024 UTF-8 bytes.');
  const salt = randomBytes(16),
    key = await derive(password, salt);
  return `argon2id$v=19$m=65536,t=3,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function passwordMatches(password: string, encoded: string) {
  const parts = encoded.split('$');
  if (
    parts.length !== 5 ||
    parts[0] !== 'argon2id' ||
    parts[1] !== 'v=19' ||
    parts[2] !== 'm=65536,t=3,p=1'
  )
    return false;
  return equal(
    (await derive(password, Buffer.from(parts[3]!, 'base64url'))).toString('base64url'),
    parts[4]!,
  );
}
export function encrypt(key: Buffer, value: unknown, aad: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function decrypt<T>(key: Buffer, encoded: string, aad: string): T {
  const bytes = Buffer.from(encoded, 'base64url'),
    cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
  ) as T;
}
const coordinate = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(
    (v) =>
      Buffer.from(v, 'base64url').length === 32 &&
      Buffer.from(v, 'base64url').toString('base64url') === v,
  );
export const jwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
});
export type PublicJwk = z.infer<typeof jwkSchema>;
export const thumbprint = (jwk: PublicJwk) =>
  sha(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
const headerSchema = z.strictObject({
  typ: z.literal('dpop+jwt'),
  alg: z.literal('ES256'),
  jwk: jwkSchema,
});
const claimsSchema = z.strictObject({
  jti: z.string().min(16).max(128),
  htm: z.string().max(16),
  htu: z.url().max(2048),
  iat: z.number().int(),
  nonce: z.string().min(16).max(128).optional(),
  ath: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export function decodeProof(
  value: unknown,
  method: string,
  uri: string,
  now: number,
  accessToken?: string,
) {
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    const pieces = value.split('.');
    if (pieces.length !== 3) throw new Error();
    const header = headerSchema.parse(
      JSON.parse(Buffer.from(pieces[0]!, 'base64url').toString('utf8')),
    );
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString('utf8')),
    );
    const key = createPublicKey({ key: header.jwk, format: 'jwk' }),
      signature = Buffer.from(pieces[2]!, 'base64url');
    if (
      signature.length !== 64 ||
      !verify(
        'sha256',
        Buffer.from(pieces[0] + '.' + pieces[1]),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      )
    )
      throw new Error();
    if (
      claims.htm !== method ||
      claims.htu !== uri ||
      Math.abs(now - claims.iat) > 60 ||
      (accessToken !== undefined && !equal(claims.ath ?? '', sha(accessToken)))
    )
      throw new Error();
    return { claims, jwk: header.jwk, thumbprint: thumbprint(header.jwk) };
  } catch {
    throw new ApiError(401, 'INVALID_DPOP', 'A valid device proof is required.');
  }
}
