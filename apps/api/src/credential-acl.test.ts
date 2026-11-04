import { it, expect } from 'vitest';
import { validateCredentialAcl, verifySystemdCredentialAcl } from './credential-acl.ts';
const file = 'user::r--\nuser:1001:r--\ngroup::---\nmask::r--\nother::---\n';
const directory = 'user::r-x\nuser:1001:r-x\ngroup::---\nmask::r-x\nother::---\n';
it('accepts only the exact systemd root/service read-only ACL for each entry type', () => {
  expect(() => validateCredentialAcl(file, 1001, false)).not.toThrow();
  expect(() => validateCredentialAcl(directory, 1001, true)).not.toThrow();
  expect(() => validateCredentialAcl(file, 1001, true)).toThrow();
  expect(() => validateCredentialAcl(directory, 1001, false)).toThrow();
});
it('rejects extra users/groups, writable or public access, wrong UID, defaults, duplicates and unbounded output', () => {
  for (const text of [
    file + 'user:1002:r--\n',
    file + 'group:1002:r--\n',
    file.replace('group::---', 'group::r--'),
    file.replace('other::---', 'other::r--'),
    file.replace('user:1001:r--', 'user:1001:rw-'),
    file.replace('1001', '1002'),
    file + 'default:user::r--\n',
    file.replace('other::---', 'mask::r--'),
    'x'.repeat(4097),
  ])
    expect(() => validateCredentialAcl(text, 1001, false)).toThrow();
  expect(() => validateCredentialAcl(file, 0, false)).toThrow();
});
it('refuses a root-owned ACL exception for an arbitrary caller-chosen directory', async () => {
  await expect(
    verifySystemdCredentialAcl('/tmp/arbitrary', '/tmp/arbitrary/key', 1001),
  ).rejects.toThrow('Attuner systemd');
});
