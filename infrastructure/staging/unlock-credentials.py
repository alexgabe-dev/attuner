#!/usr/bin/python3
"""Explicit Jammy operator action. No environment/password/path arguments.

Only fixed Attuner IDs, authenticated age ciphertext on disk, plaintext on tmpfs.
Does not start/stop services, overwrite credentials or change host security.
"""
import fcntl
import os
import stat
import subprocess
import sys
import uuid
from pathlib import Path

ROLES = {
    "api": {"api-tls-key": (1, 16384), "api-tls-passphrase": (1, 1024), "token-delivery-key": (32, 32)},
    "backup": {"backup.key": (32, 32)},
}
AGE = "/usr/bin/age"


def private(info, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Expected private owned credential material")
    if not directory and info.st_nlink != 1:
        raise ValueError("Hard-linked credential material refused")


def decode(source, output):
    subprocess.run([AGE, "--decrypt"], stdin=source, stdout=output,
                   check=True, timeout=180, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})


def unlock(role, source, destination, decrypt=decode):
    """Paths are fixed by main. Injected private fixture paths/decoder in tests only."""
    ids = ROLES[role]
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with_source = os.open(source, directory_flags)
    target = os.open(destination, directory_flags)
    try:
        private(os.fstat(with_source), True)
        private(os.fstat(target), True)
        # flock on the directory inode: no mutable lock file or credential reuse.
        fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in [*ids, role + ".ready"]:
            try:
                os.stat(name, dir_fd=target, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ValueError("Existing runtime material retained; stop/review/lock first")
        stage = ".unlock-" + uuid.uuid4().hex
        os.mkdir(stage, 0o700, dir_fd=target)
        staged = os.open(stage, directory_flags, dir_fd=target)
        try:
            for name, (minimum, maximum) in ids.items():
                incoming = os.open(name + ".age", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=with_source)
                with os.fdopen(incoming, "rb") as ciphertext:
                    before = os.fstat(ciphertext.fileno())
                    private(before)
                    if not 1 <= before.st_size <= 32768:
                        raise ValueError("Ciphertext size limit")
                    fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=staged)
                    with os.fdopen(fd, "w+b") as output:
                        decrypt(ciphertext, output)
                        output.flush()
                        after = os.fstat(ciphertext.fileno())
                        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                            raise ValueError("Ciphertext changed during authentication")
                        private(after)
                        if not minimum <= os.fstat(output.fileno()).st_size <= maximum:
                            raise ValueError("Decrypted credential size mismatch")
                        os.fsync(output.fileno())
            # No credential is published before the entire role authenticates.
            # link is no-clobber; a partial publication never has a ready receipt.
            for name in ids:
                os.link(name, name, src_dir_fd=staged, dst_dir_fd=target, follow_symlinks=False)
                os.unlink(name, dir_fd=staged)
            ready = os.open(role + ".ready", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o600, dir_fd=target)
            os.close(ready)
        finally:
            os.close(staged)
        os.rmdir(stage, dir_fd=target)
    finally:
        os.close(with_source)
        os.close(target)


def main():
    if sys.platform != "linux" or os.geteuid() != 0 or sys.argv[1:] not in (["api"], ["backup"]):
        raise ValueError("Usage: sudo python3 unlock-credentials.py api|backup (Linux root operator only)")
    # Never downgrade to a disk-backed runtime folder or modify mounts/swap.
    if Path("/run").resolve() != Path("/run"):
        raise ValueError("Unexpected runtime mount")
    kind = subprocess.check_output(["/usr/bin/findmnt", "--noheadings", "--output", "FSTYPE", "--target", "/run"],
                                   timeout=5, text=True).strip()
    if kind != "tmpfs":
        raise ValueError("Root runtime path must be tmpfs")
    binary = os.lstat(AGE)
    if not stat.S_ISREG(binary.st_mode) or binary.st_uid != 0 or binary.st_mode & 0o022:
        raise ValueError("Trusted distribution age executable required")
    destination = "/run/attuner-staging-secrets"
    try:
        os.mkdir(destination, 0o700)
    except FileExistsError:
        pass
    unlock(sys.argv[1], "/srv/attuner-staging/secrets", destination)
    print("Selected Attuner credential role authenticated on tmpfs; no services activated.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        # Never serialize provider output, passphrases or decrypted bytes.
        print("Credential unlock refused. Private partial material retained; no ready receipt issued for this attempt.", file=sys.stderr)
        sys.exit(1)
