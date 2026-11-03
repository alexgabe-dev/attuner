# Phase 3 milestone ledger

Work is on `phase3-secure-sync`. No real installation or production deployment is permitted.

## M0 — local verification passed

- Publication canonicalization, BLAKE3 identity, policy/group checks and bounded request contracts.
- Shared pinned Unicode 17 namespace data, source digests and Unicode license; Rust normalization pinned to matching Unicode 17.
- Existing wire-format fixtures retained unchanged.
- Early CI investigation found Windows installation failed before tests because node-gyp could not recognize VS 18. Select the VS 2022 runner (`windows-2022`) for initial independent NTFS/core checks; this is not Windows 11 qualification.
- Linux CI found a missing-title race while streamed route metadata caught up. Disable metadata streaming so interactive routes have their document title.
- Verification: 44 TypeScript tests, 41 Rust tests (plus two child harness entrypoints), strict typechecks, Clippy, formatting/lint and four responsive explorer accessibility checks passed.
- Windows apply remains fail-closed. Hosted runner evidence and native qualification still pending.
