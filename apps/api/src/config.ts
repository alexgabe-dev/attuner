import { z } from 'zod';
export const configSchema = z
  .object({
    host: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'),
    port: z.coerce.number().int().min(1).max(65535).default(4317),
    dataDir: z.string().min(1).default('../../.runtime'),
    containerBinding: z.boolean().default(false),
    trustLoopbackProxy: z.boolean().default(false),
    diskReserveBytes: z.coerce
      .number()
      .int()
      .min(16777216)
      .max(1024 ** 4)
      .default(268435456),
  })
  .refine((config) => config.host !== '0.0.0.0' || config.containerBinding, {
    message: 'Non-loopback binding requires explicit isolated-container configuration',
  });
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return configSchema.parse({
    host: env.ATTUNER_HOST,
    port: env.ATTUNER_PORT,
    dataDir: env.ATTUNER_DATA_DIR,
    containerBinding: env.ATTUNER_CONTAINER_BIND === '1',
    trustLoopbackProxy: env.ATTUNER_TRUST_LOOPBACK_PROXY === '1',
    diskReserveBytes: env.ATTUNER_DISK_RESERVE_BYTES,
  });
}
