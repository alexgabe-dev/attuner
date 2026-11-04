# Phase 4 verification ledger

## W1 — native Windows boundary (qualification candidate)

- Created the Phase 4 branch from the clean, pushed Phase 3 baseline.
- Added an isolated Rust crate; production engine/Tauri apply gates remain unchanged.
- Synthetic-only root minting; fixed local NTFS check; pinned parent chain; single-component `NtCreateFile`; reparse/hard-link/type/read-only rejection; 128-bit file identity plus volume identity; exact-name verification; case-sensitive directories fail closed.
- Create-new staging, bounded reads/writes, explicit file flush and handle-relative no-replace rename. Sharing, access, exists and disk-full failures are typed. No permission repair, Defender changes or automatic retries.
- Added real Windows tests for traversal, identity, original bytes, no-clobber, parent rename interference, concurrent write/delete interference and detection of new hard links, case aliases, read-only/locked entries, type mismatch and a synthetic junction.
- Standalone bundle now includes these tests and requires the exact complete checksummed file inventory. Reports distinguish native handles from complete recovery/power-loss/signing/desktop gates.

Local validation passed: repository Prettier check, Rust formatter, workspace Clippy with warnings denied, macOS workspace tests (68 passed, four intentional ignored entrypoints/manual benchmark; parent-driven crash matrices ran), and Windows MSVC-target compilation/Clippy for all qualification targets. Ten new Windows handle tests await native CI; their macOS exclusion is not counted as a pass.

First native CI run [41844993531](https://github.com/alexgabe-dev/attuner/actions/runs/41844993531) passed Linux and macOS; Windows passed nine of ten new handle tests and exposed a false assumption in the concurrent-hard-link test: NTFS allows creating a hard link despite denied write/delete sharing. Revised the test to require actual alias creation followed by fail-closed read/rename refusal and original-byte preservation. Added post-I/O identity/link checks. This does not prove absence of all link-count races; staged files are newly minted, preimages are never writable, and production apply remains gated.

Pending: corrected native Windows Server CI and the physical Windows 11 bundle run. Cross-compilation is not a runtime pass. W2 full journal/recovery integration and Unicode namespace inventory remain pending; no power-loss or Defender-specific pass is claimed.

## External release gates

- Signing accounts unavailable (user confirmed). Prepare pipelines; unsigned development builds only.
- Physical Windows 11 qualification to be run locally by the user. No self-hosted runner required.
- No production/staging VPS deployment authorized; files and local tests only.

## D1 — distribution preparation (account-dependent qualification blocked)

- Added macOS app/DMG and per-user Windows NSIS configurations, retaining the application identifier/deep-link/credential service. Windows packaging does not install WebView2.
- Added a candidate-only CI workflow: unsigned by default, protected-environment signed mode, pinned action commits, no release publication permissions or deployment commands. Signed prerequisites fail closed without accounts.
- Prepared real Developer ID/hardened-runtime app signing, App Store Connect notarization, stapling, Gatekeeper assessment and separate signed/notarized DMG validation. Prepared Azure OIDC/non-exportable signing of executable, generated uninstaller and NSIS installer, publisher/timestamp verification and public receipts. These provider-dependent paths have not run without accounts.
- Added clean-source/version/identity preflight, bounded streamed SHA-256 artifact inventory, explicit development/release-gate metadata and version-bound offline updater signatures. No updater is activated. Documented trust, rotation, replay/version checks and signed-upgrade requirements.
- Native OS credential reopen/rotation/deletion test passed on macOS, using random owned test entries with no plaintext fallback. This is not signed-upgrade evidence.
- Actual unsigned macOS development build succeeded: app 55.41 MiB, DMG 13.25 MiB. Collected ZIP/DMG and generated a development manifest. Inspected the rebuilt native UI and retained `artifacts/phase-4/desktop-unsigned-onboarding.png`. UI unchanged in this milestone.
- Local checks passed: formatting, ESLint, all TypeScript checks, 82 Vitest tests including migration/security suites and four distribution-policy tests, Rust workspace Clippy, three native credential/client unit tests. Unsigned Windows installer/candidate CI and actual signed paths remain to be qualified independently.
