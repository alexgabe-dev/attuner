import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createBLAKE3 } from 'hash-wasm';

const magic = Buffer.from('ATTBKP01');
export type FileDigest = { size: number; sha256: string; blake3: string };
export type Checkpoint = (point: string) => void | Promise<void>;
export async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error('MAINTENANCE_UNSAFE_DIRECTORY');
}
export async function digestFile(path: string, maxBytes: number): Promise<FileDigest> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes))
      throw new Error('MAINTENANCE_UNSAFE_FILE');
    const sha = createHash('sha256'),
      blake = await createBLAKE3();
    blake.init();
    let total = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes || BigInt(total) > before.size)
        throw new Error('MAINTENANCE_FILE_CHANGED');
      sha.update(buffer.subarray(0, bytesRead));
      blake.update(buffer.subarray(0, bytesRead));
    }
    const after = await input.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      BigInt(total) !== before.size
    )
      throw new Error('MAINTENANCE_FILE_CHANGED');
    return { size: total, sha256: sha.digest('hex'), blake3: blake.digest() };
  } finally {
    await input.close();
  }
}

/** Files are streamed; the key is never serialized or written to the archive. */
export async function encryptFile(
  source: string,
  target: string,
  key: Buffer,
  context: string,
  maxBytes: number,
  checkpoint: Checkpoint = () => {},
): Promise<FileDigest> {
  if (key.length !== 32) throw new Error('MAINTENANCE_KEY_REQUIRED');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes))
      throw new Error('MAINTENANCE_UNSAFE_FILE');
    output = await open(target, 'wx', 0o600);
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('attuner-backup-v1:' + context));
    await output.writeFile(Buffer.concat([magic, nonce]));
    const sha = createHash('sha256'),
      blake = await createBLAKE3();
    blake.init();
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      await checkpoint('encrypt-chunk');
      const { bytesRead } = await input.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes || BigInt(total) > before.size)
        throw new Error('MAINTENANCE_FILE_CHANGED');
      const bytes = buffer.subarray(0, bytesRead);
      sha.update(bytes);
      blake.update(bytes);
      await output.writeFile(cipher.update(bytes));
    }
    const after = await input.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      BigInt(total) !== before.size
    )
      throw new Error('MAINTENANCE_FILE_CHANGED');
    await output.writeFile(cipher.final());
    await output.writeFile(cipher.getAuthTag());
    await output.sync();
    return { size: total, sha256: sha.digest('hex'), blake3: blake.digest() };
  } finally {
    await input.close();
    await output?.close();
  }
}

export async function decryptFile(
  source: string,
  target: string,
  key: Buffer,
  context: string,
  maxBytes: number,
  checkpoint: Checkpoint = () => {},
): Promise<FileDigest> {
  if (key.length !== 32) throw new Error('MAINTENANCE_KEY_REQUIRED');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 36n ||
      before.size > BigInt(maxBytes) + 36n
    )
      throw new Error('MAINTENANCE_UNSAFE_CIPHERTEXT');
    const header = Buffer.alloc(20),
      tag = Buffer.alloc(16);
    if (
      (await input.read(header, 0, 20, 0)).bytesRead !== 20 ||
      !header.subarray(0, 8).equals(magic) ||
      (await input.read(tag, 0, 16, Number(before.size) - 16)).bytesRead !== 16
    )
      throw new Error('MAINTENANCE_CIPHERTEXT_HEADER');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
    decipher.setAAD(Buffer.from('attuner-backup-v1:' + context));
    decipher.setAuthTag(tag);
    output = await open(target, 'wx', 0o600);
    const sha = createHash('sha256'),
      blake = await createBLAKE3();
    blake.init();
    const buffer = Buffer.alloc(65536);
    let offset = 20,
      total = 0;
    const end = Number(before.size) - 16;
    while (offset < end) {
      await checkpoint('decrypt-chunk');
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, end - offset),
        offset,
      );
      if (!bytesRead) throw new Error('MAINTENANCE_TRUNCATED');
      offset += bytesRead;
      const bytes = decipher.update(buffer.subarray(0, bytesRead));
      total += bytes.length;
      if (total > maxBytes) throw new Error('MAINTENANCE_SIZE_LIMIT');
      sha.update(bytes);
      blake.update(bytes);
      await output.writeFile(bytes);
    }
    const tail = decipher.final();
    total += tail.length;
    sha.update(tail);
    blake.update(tail);
    await output.writeFile(tail);
    const after = await input.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error('MAINTENANCE_FILE_CHANGED');
    await output.sync();
    return { size: total, sha256: sha.digest('hex'), blake3: blake.digest() };
  } finally {
    await input.close();
    await output?.close();
  }
}
