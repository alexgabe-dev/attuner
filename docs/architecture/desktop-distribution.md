# Desktop distribution and update trust

Implemented in Phase 4: stable app/credential identity, platform packaging configurations, unsigned candidate builds, credential-configured signing/notarization workflows, OS validation, version-consistent artifact manifests, and offline version-bound updater signatures. **Runtime updating is deliberately inactive.** There is no updater plugin/endpoint or automatic check. Accounts, signed upgrade qualification and public-release approval are unavailable; no signed result is claimed.

## Authority boundaries

- OS signing and Apple notarization establish the application's publisher and platform policy. An ad-hoc signature is development-only. Stable `app.attuner.desktop` identity and native credential service never contain an application version.
- A separate offline updater key authenticates update payloads; a compromised Attuner synchronization server must not be able to authorize executable code. Its private key is password-encrypted and restricted to protected signing CI, independently revocable from device credentials/TLS.
- The synchronization server identity, device DPoP credentials, revision high-water marks and local recovery journal remain independent of binary distribution. Updates do not re-enroll devices, reset observed heads, rewrite snapshots or relax filesystem gates.
- Candidate SHA-256 inventories and JSON verification reports are provenance aids. They do not authenticate untrusted downloads without OS/updater cryptographic verification.

## Activation design — future gated work

Before enabling Tauri's updater, embed a reviewed real public key (no placeholder/fake identity), require HTTPS allowlisted distribution origins with redirects disabled, and require signed-version verification (`requireSignedVersion`) so an untrusted manifest cannot attach a newer version number to an old signed payload. Accept only a strictly newer compatible SemVer for the installed channel/platform/architecture; reject rollback, same-version equivocation, unknown protocol/namespace requirements and unsupported OS versions. Keep payload size/time/redirect limits and stream downloads into owned create-new staging; verify signatures/bytes before installation.

Check/download/install remain explicit user actions; no background telemetry or automatic synchronization is introduced. Installation must be blocked while a synchronization worker is active or recovery is required, and must recheck that interlock immediately before closing the app. Flush local state first. Preserve the current executable and app data until the new binary passes startup compatibility checks. A binary rollback must not downgrade a database schema; use a separately verified compatible recovery release and never erase migration history.

Release metadata includes source commit, exact version, protocol/namespace versions, target architecture, OS signature/notarization evidence, artifact digests and version-bound detached updater signature. A signed metadata-envelope/expiry and durable accepted-release high-water mark must be added and adversarially tested at activation to prevent freeze/replay and changes to compatibility/channel fields. The current candidate manifest is **not** that active update protocol.

Key rotation requires a reviewed bridge release authenticating the successor key with the existing trust root, a bounded overlap period and a tested revocation/rollback response. Never fall back to an unsigned feed when a key is unavailable. Platform certificate renewal must preserve the expected team/publisher and pass native credential upgrade tests; unexpected identity changes require explicit operator review.

## Required verification before activation

Exercise tampered/truncated/wrong-platform artifacts, signed-version mismatch, stale metadata, TLS/redirect failures, unavailable signing service, expired/revoked OS certificate, interrupted download/install, low disk space, busy/recovery state, signed version-to-version credential retention and migration compatibility independently on macOS and physical Windows 11. Keep update work separate from real game integration. No production distribution is authorized by this design.
