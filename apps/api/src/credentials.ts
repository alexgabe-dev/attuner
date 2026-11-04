import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { verifySystemdCredentialAcl } from './credential-acl.ts';
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
  const folder = await lstat(directory, { bigint: true });
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error('Unsafe runtime credential directory.');
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error('Unsafe runtime credential.');
    const uid = process.getuid!();
    const privateOwner =
      before.uid === BigInt(uid) &&
      folder.uid === BigInt(uid) &&
      (before.mode & 0o077n) === 0n &&
      (folder.mode & 0o077n) === 0n;
    if (!privateOwner) {
      // Root ownership + named read-only ACL is systemd's preferred mode. Do not
      // merely allow group-readable files or trust CREDENTIALS_DIRECTORY alone.
      if (
        before.uid !== 0n ||
        before.gid !== 0n ||
        folder.uid !== 0n ||
        folder.gid !== 0n ||
        (before.mode & 0o333n) !== 0n ||
        (before.mode & 0o007n) !== 0n ||
        (folder.mode & 0o222n) !== 0n ||
        (folder.mode & 0o007n) !== 0n
      )
        throw new Error('Unsafe runtime credential permissions.');
      await verifySystemdCredentialAcl(directory, join(directory, name), uid);
    }
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
    const afterFolder = await lstat(directory, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.mode !== after.mode ||
      folder.dev !== afterFolder.dev ||
      folder.ino !== afterFolder.ino ||
      folder.uid !== afterFolder.uid ||
      folder.gid !== afterFolder.gid ||
      folder.mode !== afterFolder.mode ||
      folder.ctimeNs !== afterFolder.ctimeNs
    ) {
      bytes.fill(0);
      throw new Error('Runtime credential changed.');
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
