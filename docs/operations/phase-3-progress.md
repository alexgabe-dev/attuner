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

## M1 — local verification passed

- Added reviewed Drizzle migration 0002: profile membership/ownership and policies, scoped verified blob references, publication details, transfer/chunk records, immutable seals and append-only audit metadata. Existing history is sealed without fabricating physical blob verification.
- Added database worker with a 64-request / 32 MiB aggregate queue cap and atomic IMMEDIATE transactions. Server database work is off the request thread.
- Added TLS-only runtime with encrypted PKCS#8 keys; no plaintext private-key fallback. Actual HTTPS tests validate the project-local CA and reject an untrusted certificate.
- Fresh database, original-history upgrade, reopen, cross-profile references, sealing, rollback, queue bounds and append-only audit tests pass.
- Verification: 50 TypeScript tests; strict typecheck/lint/format checks; all package builds and the built API trusted-TLS/worker readiness smoke check pass. Full browser suite: 50 passed, six expected desktop-only skips.
- Hosted Linux exposed that its accessibility harness audited during an asynchronous navigation. The follow-up commit waits for the destination heading/title and keeps all axe rules. Hosted run 41631413087 passed on Linux, macOS and Windows Server 2022.

## Early M7 investigation — qualification pending

- Instrumented first and unchanged capture against the same 10,004-file synthetic dataset. Warm-OS-cache first/cold-CAS capture: 46.34 s. Unchanged/warm-CAS capture: 6.70 s, with zero compression/new-object checkpoints. This isolates redundant scan/verification work from first-object durability cost.
- Initial observed maximum RSS: 66,502,656 bytes. Raw profile evidence is being retained for the performance milestone; no cold-OS-cache claim is made.
- Hosted native Windows build and portable tests passed on windows-2022 (run 41630021919). This does not qualify filesystem application. Windows 11 durability and rendered UI qualification remain separate gates.

## M2 — authentication and native credential foundation

- Added Argon2id local administrator bootstrap/recovery, strict web sessions/CSRF/recent authentication, PKCE and proof-key-bound enrollment, scoped device grants, rotating credentials, revocation and explicit sign-out.
- Added migrations 0003–0005 for account/device security, proof nonce/replay tracking and encrypted idempotent enrollment/token deliveries. No plaintext credentials are persisted in SQLite or logs.
- Added framework-independent Rust HTTPS client with P-256 proofs and Keychain/Credential Manager storage; no file fallback. A failed credential write blocks further requests until reopening the durable state.
- Actual macOS Keychain round-trip and real Rust-to-Node TLS enrollment pass. Fault injection proves no device is enrolled before pending state persists, and a token rotation response lost at secure-store persistence can be recovered after reopening.
- Current local TypeScript suite: 58 tests passed, including concurrency, CSRF, cross-profile scopes and revocation at the protected transaction boundary. Formatting, lint, strict typechecks, all package builds, Clippy and 43 Rust tests passed (two subprocess entrypoints are intentionally ignored and invoked by parent recovery tests).
- Tauri command wiring/browser account screens are intentionally part of M8. Windows credential execution requires the independent hosted run; filesystem application stays disabled.
