import { constants } from 'node:fs';
import { mkdir, open, link, unlink, lstat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBLAKE3 } from 'hash-wasm';
import { ApiError } from '../security/primitives.ts';
const reserve = 16n * 1024n * 1024n;
/** Server-owned storage only; no caller paths. The production server targets a local Unix filesystem. */
export class BlobStorage {
  private active = 0;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async initialize() {
    if (process.platform === 'win32')
      throw new Error(
        'The blob server requires a qualified Unix filesystem. Windows is a client platform.',
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const s = await lstat(this.directory);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe blob storage root.');
    await this.syncDirectory(this.directory);
  }
  lease() {
    if (this.active >= 2)
      throw new ApiError(429, 'TRANSFER_BUSY', 'Two transfers are already active.');
    this.active++;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.active--;
      }
    };
  }
  private async syncDirectory(directory: string) {
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async folder(name: string) {
    const path = join(this.directory, name);
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe storage directory.');
    await this.syncDirectory(this.directory);
    return path;
  }
  async space(bytes: number) {
    const fs = await statfs(this.directory, { bigint: true });
    if (fs.bavail * fs.bsize < BigInt(bytes) + reserve)
      throw new ApiError(507, 'INSUFFICIENT_SPACE', 'Storage has insufficient free space.');
  }
  private async readVerified(path: string, expectedSize: number, expectedHash: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize)
        throw new ApiError(422, 'BLOB_CORRUPT', 'Stored content failed verification.');
      const hash = await createBLAKE3();
      hash.init();
      const buffer = Buffer.alloc(65536);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > expectedSize) throw new ApiError(422, 'BLOB_CORRUPT', 'Stored content grew.');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (
        offset !== expectedSize ||
        hash.digest() !== expectedHash ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new ApiError(422, 'BLOB_CORRUPT', 'Stored content failed verification.');
    } finally {
      await handle.close();
    }
  }
  async verify(profile: string, hash: string, size: number) {
    await this.readVerified(join(this.directory, 'p-' + profile, hash), size, hash);
  }
  async chunk(upload: string, position: number, bytes: Buffer, hash: string) {
    const folder = await this.folder('u-' + upload),
      target = join(folder, String(position)),
      temporary = join(folder, '.' + randomUUID());
    await this.space(bytes.length);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await unlink(temporary);
      throw error;
    } finally {
      await handle.close();
    }
    try {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    } finally {
      await unlink(temporary);
    }
    await this.syncDirectory(folder);
    await this.readVerified(target, bytes.length, hash);
  }
  async assemble(
    profile: string,
    upload: string,
    hash: string,
    size: number,
    chunks: { position: number; size: number; hash: string }[],
  ) {
    const folder = await this.folder('p-' + profile),
      target = join(folder, hash),
      temporary = join(folder, '.' + randomUUID());
    await this.space(size);
    const output = await open(temporary, 'wx', 0o600),
      digest = await createBLAKE3();
    digest.init();
    let total = 0;
    try {
      const buffer = Buffer.alloc(65536);
      for (const chunk of chunks) {
        const source = join(this.directory, 'u-' + upload, String(chunk.position));
        await this.readVerified(source, chunk.size, chunk.hash);
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          let offset = 0;
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) break;
            offset += bytesRead;
            total += bytesRead;
            if (offset > chunk.size || total > size)
              throw new ApiError(422, 'BLOB_CORRUPT', 'Upload size changed.');
            digest.update(buffer.subarray(0, bytesRead));
            await output.writeFile(buffer.subarray(0, bytesRead));
          }
          if (offset !== chunk.size)
            throw new ApiError(422, 'BLOB_CORRUPT', 'Upload was truncated.');
        } finally {
          await input.close();
        }
      }
      if (total !== size || digest.digest() !== hash)
        throw new ApiError(422, 'BLOB_CORRUPT', 'Upload content does not match its identity.');
      await output.sync();
    } catch (error) {
      await output.close();
      await unlink(temporary);
      throw error;
    }
    await output.close();
    try {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    } finally {
      await unlink(temporary);
    }
    await this.syncDirectory(folder);
    await this.verify(profile, hash, size);
  }
  async range(profile: string, hash: string, size: number, offset: number, length: number) {
    await this.verify(profile, hash, size);
    const handle = await open(
      join(this.directory, 'p-' + profile, hash),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const part = await handle.read(bytes, read, length - read, offset + read);
        if (!part.bytesRead)
          throw new ApiError(422, 'BLOB_CORRUPT', 'Stored content was truncated.');
        read += part.bytesRead;
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
