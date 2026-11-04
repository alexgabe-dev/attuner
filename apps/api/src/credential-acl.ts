import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);
/** systemd 255 prefers root ownership plus one named service-user ACL. The
 * POSIX group mode bits are its ACL mask, not evidence of a group grant. */
export function validateCredentialAcl(text: string, uid: number, directory: boolean) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || text.length > 4096)
    throw new Error('Invalid credential ACL.');
  const permissions = directory ? 'r-x' : 'r--';
  const expected = new Set([
    `user::${permissions}`,
    `user:${uid}:${permissions}`,
    'group::---',
    `mask::${permissions}`,
    'other::---',
  ]);
  const actual = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    actual.length !== expected.size ||
    new Set(actual).size !== expected.size ||
    actual.some((line) => !expected.has(line))
  )
    throw new Error('Credential ACL grants unexpected access.');
}
export async function verifySystemdCredentialAcl(directory: string, path: string, uid: number) {
  if (
    process.platform !== 'linux' ||
    !/^\/run\/credentials\/attuner[-a-zA-Z0-9_.@]*\.service$/.test(directory)
  )
    throw new Error('Root-owned credentials require an Attuner systemd credential directory.');
  const binary = '/usr/bin/getfacl',
    executable = await lstat(binary);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.uid !== 0 ||
    (executable.mode & 0o022) !== 0
  )
    throw new Error('A trusted system ACL reader is required.');
  await Promise.all(
    [directory, path].map(async (entry, index) => {
      let stdout: string;
      try {
        ({ stdout } = await execute(
          binary,
          ['--omit-header', '--numeric', '--absolute-names', '--', entry],
          {
            encoding: 'utf8',
            maxBuffer: 4096,
            timeout: 2000,
            env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', NODE_ENV: 'production' },
          },
        ));
      } catch {
        throw new Error('Cannot verify runtime credential ACL.');
      }
      validateCredentialAcl(stdout, uid, index === 0);
    }),
  );
}
