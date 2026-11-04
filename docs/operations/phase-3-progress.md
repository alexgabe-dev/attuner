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

### M2 hosted follow-up

Hosted run 41725077662 passed Linux and Windows Server 2022, including Windows Credential Manager and Rust-to-Node TLS enrollment/recovery. macOS Keychain passed, but its test certificate generation failed with OpenSSL 3.6. The isolated certificate helper now uses pinned `@peculiar/x509` with Node WebCrypto and encrypted PKCS#8 export, removing OpenSSL/CLI variability. This dependency is confined to development/test TLS generation; the normal runtime still loads externally managed TLS material. Local Node HTTPS and Rust TLS enrollment pass with the replacement. Native Windows filesystem apply and Windows 11 UI remain unqualified.

## M3 — verified resumable transfer foundation

- Added candidate sessions with independent namespace/policy/coverage validation and canonical BLAKE3 identity, stable upload IDs, immutable verified chunk receipts and explicit session cancellation.
- Added server-owned, profile-separated raw CAS storage: bounded 64 KiB hashing/assembly, no-clobber publication, file/directory sync before database receipts, exact size/hash checks and symlink/hard-link rejection. Two transfer/session bodies admitted before parsing; quota reservations and free-space reserve checks fail closed.
- Rust upload/download supports cancellation and chunk-boundary resume, rehashes resumed prefixes and verifies complete content. Profile-verified unchanged objects produce zero payload upload and do not read the source.
- Actual HTTPS evidence: 63 TypeScript tests and 44 Rust tests passed, including server reopen, lost chunk/completion receipt, corruption, range/ETag checks, revoked/read-only/cross-profile access, quota and injected disk exhaustion. Native transfer test cancels after 4 MiB, resumes without reuploading that chunk, cancels/resumes download and rejects a corrupt prefix.
- Formatting, lint/typechecks, package builds and workspace Clippy pass. No migration change was required; M1's transfer ledger is used. Publication/CAS remains disabled until M4.
- Central blob server explicitly targets Unix. Test-only Windows enrollment server does not enable blob storage; hosted Windows credential/protocol evidence is not Unix durability evidence.
- Remaining operational limits: no automatic orphan GC, scratch reconciliation or total multi-profile storage quota yet. Orphans are never verified by metadata alone, and free-space reserve checks block further writes. These are production deployment gates. See `docs/architecture/phase-3-api.md`.

## M4 — immutable publication and CAS

- Implemented exact-head CAS publication, immutable revisions/seals, deterministic added/modified/deleted records, atomic audit and session-result recovery. Migration 0006 protects staged identity, committed state and receipts.
- Added current head, snapshot manifests/history, audit history and non-regressing device acknowledgements. Browser reads require profile membership; device reads/writes intersect current grants. Backend operations never apply local files.
- Typed Rust publication client validates head envelopes, snapshot identity, complete canonical digest, namespace, policy/roots and expected publication revision. No remote path reaches filesystem operations.
- Verification: 67 TypeScript tests and 45 Rust tests passed; formatting/lint/typechecks/builds/Clippy passed. Three actual Rust HTTPS clients independently enroll: two race from one head, one wins, one gets HEAD_MOVED, and the third verifies and acknowledges the immutable winner. Audit-failure injection rolls snapshot/seal/head/result back together with no revision hole. Existing local crash/recovery matrix still passes.
- Windows-native NTFS/reparse/sharing probes were committed early and submitted to hosted CI; Windows application remains gated pending results and durability qualification.

## M5/M6 — foreground coordination and verified local application

The two milestones share the local commit boundary and were verified together before enabling any host apply command.

- Added local SQLite migration 0002: immutable binding, highest observed revision, separate remote baseline, optimistic-generation jobs, application links and durable acknowledgement outbox. Existing Phase 2 snapshots remain unchanged.
- Added persistent app-owned synthetic registry with UUID-only reopening, private permissions, pinned root identity, catalogue digest, marker/no-follow checks and no automatic adoption/deletion.
- Added foreground preparation/resume, bootstrap and group-safe conflict choices, review digests, stale-local/head checks, verified incremental transfer, lost-publication-result recovery and explicit separate local apply. No Lua merge or automatic synchronization.
- Added raw download stages with durable prefix receipts, corruption quarantine/restart, verified compressed CAS import and deterministic imported snapshot order. The local apply/baseline/outbox transaction preserves Phase 2 recovery guarantees.
- Three real HTTPS Rust engines exercise concurrent modifications, stale publication, modification/deletion review, offline edits/reconnect, revocation, adversarial wire bytes and rollback after failed application. The lost-response case proves later unrelated local edits remain untouched.
- Added sixteen process-exit/SIGKILL cases across eight apply boundaries, checking atomic B/outbox state and original-byte recovery. Existing recovery tests remain enabled.
- Local validation: 59 Rust tests passed, three intentionally ignored child entrypoints invoked by parent crash tests; 67 TypeScript tests passed. Formatting, lint, strict typechecks, package builds and workspace Clippy passed. Windows execution of these additions is submitted with the milestone commit; Windows filesystem apply is still disabled.
- Windows Server 2022 run 41727481100 independently passed NTFS/no-clobber/identity/sharing/junction probes, Credential Manager, TLS enrollment and native build. User will run the forthcoming standalone Windows 11 procedure on a physical PC; no self-hosted runner is required and unrelated work continues.

## M7 — profiling and Windows qualification tooling

- Instrumented encode, object flush, verification, complete scans and SQLite capture. First capture remains ~48 s because 10,004 object flushes dominate; an immutable-pack design is documented without changing the on-disk backup/recovery format.
- Removed a redundant capture pre-scan while retaining one new complete two-pass scan before snapshot publication. Added content-aware disk budgeting; existing objects are still verified. Paired warm capture improved 3.758 → 2.416 s; one-file-changed capture 3.750 → 2.640 s. Unchanged encoding/flush count is zero.
- Lazy backup export avoids source reads when content is already verified remotely. A real restore-to-known-content test publishes a new revision with zero encoding/export/payload upload.
- Migration 0007 adds immutable verified range metadata after complete object verification. Download work is linear in requested chunks; legacy fallback retains full verification. Real 64 MiB TLS transfer: 0.751 s cold upload, zero warm payload bytes, 0.413 s durable download (previously 1.804 s), 0.106 s verified compressed import.
- Raw benchmark artifacts and exact commands are in `docs/operations/phase-3-performance.md`. All results have a warm OS cache; no cold-OS-cache or WAN claim is made.
- Standalone Windows qualification bundle, checksums, scripts and exact physical-PC instructions are committed. Hosted run 41734870720 passed all jobs, including packaging and execution of that bundle on Server 2022. No runner/compiler/administrator installation is required for the physical-PC bundle. Windows filesystem apply remains disabled pending its native recovery/durability gate.
- Validation: 63 Rust tests, 68 TypeScript tests and the explicit release-mode network benchmark passed. Four ignored entries consist of three parent-invoked crash harnesses and the manually executed network benchmark. Broader final checks accompany the milestone commit.

## M8 — connected product interfaces

- Added migration 0008, bounded source-device reports, deterministic B/L/R conflict pages, immutable retained web proposals and auditable superseding/validation/withdrawal. Native validation is generation/head/local-content bound and never publishes or applies automatically.
- Added real connected Tauri and Next controllers using the shared charcoal/violet shell, profile/device management, immutable history, comparison/verified previews, source progress, conflict proposals, local scan/review/publication/application, durable receipts and backup verification. The visual demo is explicit `?demo=1`; unavailable services never become fake data.
- Native commands accept typed IDs/actions. OS credentials, PKCE and callbacks remain native; no generic filesystem, HTTP, opener or event-listen permission is granted. Foreground IPC is bounded/serialized, cancellation/status remain immediate, public connection preferences cannot contain private keys, and offline recovery/credential forgetting remain available without API access.
- Real packaged macOS enrollment/reopen/publication/separate apply/receipt/backup verification/revocation passed. Offline backup verification passed after stopping the API and removing the disposable credential. No Keychain ACL or system trust change was made; the suspected prompt was not confirmed and reconnection succeeded.
- Populated HTTPS web qualification uses three authenticated protocol fixtures, two revisions, modification/deletion review, proposals, content previews, password-confirmed revocation, all navigation and responsive/axe checks. It never writes passwords, cookies or callback codes to artifacts. Real three-Rust-engine qualification is separate and remains enabled.
- Local final validation: 78 TypeScript tests; 67 Rust tests plus four intentional ignored harness/benchmark entries; format/lint/typechecks/Clippy and all builds passed. The full browser regression suite passed 54 tests with ten expected platform-specific skips; connected HTTPS qualification passed. Screenshots, limits, launch commands and Phase 4 recommendations are documented in the Phase 3 verification report.
- Windows 11 qualification remains a physical-PC prerequisite task with exact standalone commands. No self-hosted runner is required. Windows file application remains disabled; hosted Server 2022 evidence is recorded separately.

M8 hosted run 41812187271 passed Linux, macOS and Windows Server 2022. The final security follow-up hides credential fields on HTTP and refuses authenticated requests without HTTPS or outside the current API origin; negative unit/browser/accessibility checks pass. Native Rust and Windows safety gates are unchanged.
