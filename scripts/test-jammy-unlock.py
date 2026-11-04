#!/usr/bin/python3
"""Synthetic credential-boundary tests. Optional real age AEAD test on Jammy CI."""
import importlib.util
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("unlock", Path(__file__).resolve().parents[1] / "infrastructure/staging/unlock-credentials.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
age = sys.argv[sys.argv.index("--age") + 1] if "--age" in sys.argv else None
if age:
    del sys.argv[sys.argv.index("--age"):sys.argv.index("--age") + 2]


class Boundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="attuner-credential-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source, self.output = self.root / "ciphertext", self.root / "runtime"
        self.source.mkdir(mode=0o700)
        self.output.mkdir(mode=0o700)
        self.ciphertext = self.source / "backup.key.age"
        self.ciphertext.write_bytes(b"synthetic-authenticated-fixture")
        self.ciphertext.chmod(0o600)

    @staticmethod
    def fixture_decode(source, output):
        source.read()
        output.write(b"x" * 32)

    def unlock(self, decoder=None):
        module.unlock("backup", self.source, self.output, decoder or self.fixture_decode)

    def test_publishes_exact_private_role_once(self):
        self.unlock()
        self.assertEqual((self.output / "backup.key").read_bytes(), b"x" * 32)
        self.assertEqual(stat.S_IMODE((self.output / "backup.key").stat().st_mode), 0o600)
        self.assertEqual((self.output / "backup.key").stat().st_nlink, 1)
        self.assertTrue((self.output / "backup.ready").is_file())
        with self.assertRaises(ValueError):
            self.unlock()
        self.assertEqual((self.output / "backup.key").read_bytes(), b"x" * 32)

    def test_authentication_failure_retains_private_stage_without_receipt(self):
        def fail(source, output):
            output.write(b"unverified partial")
            raise subprocess.CalledProcessError(1, "age")
        with self.assertRaises(subprocess.SubprocessError):
            self.unlock(fail)
        self.assertFalse((self.output / "backup.ready").exists())
        self.assertFalse((self.output / "backup.key").exists())
        stages = list(self.output.glob(".unlock-*"))
        self.assertEqual(len(stages), 1)
        self.assertEqual(stat.S_IMODE(stages[0].stat().st_mode), 0o700)

    def test_wrong_size_and_source_changes_never_publish(self):
        for kind in ["size", "changed"]:
            def fail(source, output):
                output.write(b"x" * (31 if kind == "size" else 32))
                if kind == "changed":
                    self.ciphertext.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                self.unlock(fail)
            self.assertFalse((self.output / "backup.ready").exists())
            self.assertFalse((self.output / "backup.key").exists())

    def test_linked_or_broadly_readable_input_is_refused(self):
        self.ciphertext.chmod(0o644)
        with self.assertRaises(ValueError):
            self.unlock()
        self.ciphertext.chmod(0o600)
        os.link(self.ciphertext, self.source / "alias")
        with self.assertRaises(ValueError):
            self.unlock()
        (self.source / "alias").unlink()
        self.ciphertext.unlink()
        self.ciphertext.symlink_to(self.root / "outside")
        with self.assertRaises(OSError):
            self.unlock()
        self.assertFalse((self.output / "backup.ready").exists())

    def test_unrelated_creation_is_not_overwritten(self):
        def concurrent(source, output):
            self.fixture_decode(source, output)
            (self.output / "backup.key").write_bytes(b"unrelated original")
        with self.assertRaises(FileExistsError):
            self.unlock(concurrent)
        self.assertEqual((self.output / "backup.key").read_bytes(), b"unrelated original")
        self.assertFalse((self.output / "backup.ready").exists())

    def test_unsafe_runtime_directory_is_rejected(self):
        self.output.chmod(0o755)
        with self.assertRaises(ValueError):
            self.unlock()

    @unittest.skipUnless(age, "native Jammy CI supplies its distribution age executable")
    def test_real_age_authentication_and_tampering(self):
        # Generated encryption identity is synthetic test-only material, never a
        # server/device credential. No persistent production key is generated.
        identity = self.root / "fixture-identity"
        subprocess.run([str(Path(age).with_name("age-keygen")), "-o", str(identity)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        recipient = subprocess.check_output([str(Path(age).with_name("age-keygen")), "-y", str(identity)], text=True).strip()
        self.ciphertext.unlink()
        subprocess.run([age, "-r", recipient, "-o", str(self.ciphertext)], input=b"x" * 32, check=True)
        self.ciphertext.chmod(0o600)
        def actual(source, output):
            subprocess.run([age, "-d", "-i", str(identity)], stdin=source, stdout=output,
                           stderr=subprocess.DEVNULL, check=True, timeout=5)
        self.unlock(actual)
        for name in ["backup.ready", "backup.key"]:
            (self.output / name).unlink()  # only this test's own synthetic material
        data = bytearray(self.ciphertext.read_bytes())
        data[-1] ^= 1
        self.ciphertext.write_bytes(data)
        with self.assertRaises(subprocess.SubprocessError):
            self.unlock(actual)
        self.assertFalse((self.output / "backup.key").exists())
        self.assertFalse((self.output / "backup.ready").exists())


if __name__ == "__main__":
    unittest.main()
