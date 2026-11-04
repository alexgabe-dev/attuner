import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
type CredentialName = 'api-tls-key' | 'api-tls-passphrase' | 'token-delivery-key';
/** systemd supplies read-only runtime credentials decrypted from authenticated
 * encrypted-at-rest blobs. Never fall back to environment values when configured. */
export async function runtimeCredential(
  name: CredentialName,
  maximum: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Buffer | undefined> {
  const directory = env.CREDENTIALS_DIRECTORY;
  if (!directory) return undefined;
  if (process.platform === 'win32' || !isAbsolute(directory))
    throw new Error('Invalid runtime credential directory.');
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error('Unsafe runtime credential directory.');
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error('Unsafe runtime credential.');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    for (;;) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > maximum) {
        bytes.fill(0);
        throw new Error('Runtime credential size limit.');
      }
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    ) {
      bytes.fill(0);
      throw new Error('Runtime credential changed.');
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
