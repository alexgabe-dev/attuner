# Private beta readiness — not a release authorization

Attuner Phase 4 is an unsigned, synthetic-installation development candidate. No public release, updater, production deployment, real WoW access, analytics or crash-reporting SDK is enabled. A passing CI build does not clear the platform, signing or operator gates below.

## Candidate installation and onboarding

Use only artifacts from the trusted `alexgabe-dev/attuner` repository and a recorded passing run/source commit. Check the inventory/digests and candidate metadata; a checksum detects a mismatch but does not establish publisher identity. Unsigned apps may be blocked by Gatekeeper, SmartScreen or enterprise policy: report that blocker, never bypass the protection. See [distribution](desktop-distribution.md) and [Windows 11 qualification](windows-11-qualification.md).

The operator bootstraps the administrator locally; there is no default password/public registration. In the web dashboard, sign in over verified HTTPS, create a synthetic profile and approve only the device enrollment you initiated. On desktop, enter the HTTPS server address and a recognizable device name. Custom CA input accepts only public certificates and does not alter the OS trust store. Device keys/credentials stay in Keychain or Credential Manager. Do not paste private keys or disable certificate verification.

Profile owners can rename a setup in web Settings after confirming their password. Device grants and immutable history remain linked. A stale name is refused so concurrent edits are refreshed/reviewed instead of silently overwritten. Account administration stays with the local operator; no device credential gains account-management authority.

Keep the application identity `app.attuner.desktop` stable. Use the version-matched signed application once release accounts exist; do not repeatedly replace a credential-owning signed binary with unrelated unsigned identities. On an unexpected Keychain prompt, approve only Attuner's own test entry locally if its identity is expected. Never send the macOS password to an operator/chat or change global Keychain ACLs. If no prompt appears, record the credential operation/result and signing/build identity; preserve the entry and use the [safe manual upgrade verification](desktop-distribution.md). No plaintext fallback exists.

During Phase 4 all local workspaces are explicitly synthetic. Capture/compare first. Resolve every conflict deliberately; review publication and local application as separate approvals. A web proposal cannot authorize arbitrary desktop writes. If the game state is running or uncertain, local mutation fails closed. Windows full-engine filesystem operations remain disabled; its native harness is prerequisite evidence only.

For outages, preserve offline changes and the existing local baseline. Reconnect, fetch the current head, compare again, then approve. For recovery-required operations, retain all originals/stages/backups and use the existing explicit recovery workflow. Do not remove a journal, edit SQLite, reset a high-water mark or delete “orphan” objects to make an operation succeed. Server identity changes and revision regression require operator investigation/restoration of the correct history; they are not retry prompts to ignore.

## Explicit diagnostics and feedback

`Help & diagnostics` works before enrollment and while offline. Review the complete allowlisted JSON, then explicitly save/download it. It contains app/protocol/namespace versions, product safety flags, booleans and loaded-state counts; native reports add OS/CPU architecture. It excludes account/device/profile names and IDs, server origins, absolute paths, manifests/file names/content, public CAs, raw errors, logs, cookies, passwords, keys and browser storage/user agent.

The web exports exactly the reviewed JSON as a local download. Native export rebuilds the same fixed allowlist from current state and saves a new `attuner-diagnostics-*` temporary folder, then reveals it through the OS. Counts may advance between preview and save. Unix folders/files are created as 0700/0600; Windows uses the user's temporary-directory ACL and still needs physical desktop qualification. No renderer-selected path or arbitrary JSON is accepted by native export. Reports are not uploaded, copied to the clipboard or deleted automatically. OS temporary cleanup can remove them later. If reveal/download fails, the selected read-only preview can be copied manually.

Beta feedback should include candidate source/version, OS/build, synthetic scenario, expected/actual behavior, whether originals remain readable, reproduction steps and the reviewed diagnostic attachment if desired. Review screenshots for personal/server names before sharing. Use a private operator channel for a suspected security defect; do not put credentials, callbacks, Lua/WTF content, raw database/backups or personal paths into a public issue. The user chooses the recipient and performs any submission; Attuner sends no feedback messages automatically.

Attuner currently has no telemetry, analytics, remote crash collection or background synchronization. OS crash reporting is independent of Attuner and is not disabled or reconfigured. A future crash service requires a separate opt-in/privacy design: no automatic memory dumps, source files, tokens, URLs or path-rich stack metadata; local preview, explicit consent, bounded retention/access/deletion and a documented processor/region. No provider is selected or integrated here.

The self-hosted server is trusted with uploaded configuration contents. Verified TLS, encrypted operational backups and an encrypted server volume do not make synchronization end-to-end encrypted. Account/device authorization limits access, while the service operator can still read stored content; review scope/content before a future real-data upload is approved.

## Platform and resource requirements

| Surface             | Prepared target                                                               | Actual qualification boundary                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS desktop       | macOS 13+ packaging, arm64 and Intel builds                                   | Local Apple Silicon runtime/UI and hosted Intel tests; macOS 13 itself and signed upgrades remain unqualified                                      |
| Windows desktop     | Windows 11 x64, fixed local NTFS, WebView2 and required Microsoft C++ runtime | Windows Server 2022 CI/native tests; physical Windows 11/DPI/Defender/manual desktop review pending; full engine apply disabled                    |
| Web                 | Current Chromium-family browser over verified HTTPS, keyboard/touch layouts   | Automated Chromium at 390/768/1440 CSS px with accessibility checks; separate Safari/Edge/manual assistive-technology review pending               |
| Self-hosted staging | Prepared Ubuntu 24.04 LTS x86-64, Node 24.22.2, Nginx 1.30.6, systemd 255+    | Local/hosted synthetic HTTPS proxy/API/SQLite restore checks; actual VPS details, encrypted credential provisioning and service activation pending |

These are qualification targets, not a promise that all minimum OS versions have passed. Windows ARM64/x64 emulation, Wine, network/cloud/removable filesystems and antivirus bypasses are unsupported. No installer automatically acquires WebView2/system prerequisites in this candidate.

For the undeployed staging layout, budget at least 2 vCPU/4 GiB RAM for the separate API/web/proxy service limits plus OS headroom, and a local SSD with encrypted storage. This is an initial operating recommendation, not a measured sustained-load minimum; revise it after the actual VPS inventory/load drill. No GC exists: plan retained history growth, encrypted backups and disk alerts. Desktop disk capacity must cover originals, verified backups, incoming content, staged replacement/recovery material, database metadata and the configured free-space reserve; admission fails closed if budgeting fails. A nominal installation size alone is not sufficient. See [staging](staging.md), [backup/restore](server-backup-restore.md) and [performance](phase-4-performance.md).

## Release and upgrade gates

- [ ] Independent full Windows engine/journal/namespace-durability qualification, physical Windows 11 bundle/report/DPI/Defender evidence and reviewed hardware-durability scope. Keep apply closed meanwhile.
- [ ] Real Developer ID/Apple notarization and Windows signing accounts, protected CI credentials, verified signatures/staples/publisher/timestamps and signed upgrade credential reopen/rotation/revocation tests. No fake identities.
- [ ] Compatibility check of app version, protocol/namespace versions, immutable manifests and database migrations. Never downgrade a migrated live database; retain a verified pre-upgrade backup.
- [ ] Signed update metadata trust/replay/rotation/rollback qualification before activating any updater. Current offline signatures/pipeline preparation do not imply an active update service.
- [ ] Actual VPS inventory, separately approved non-production deployment, encrypted credential provisioning, least-privilege units, TLS checks, storage limits/alerts and clean-host recovery drill. No deployment has occurred.
- [ ] Full CI/native/browser/three-client recovery suite, unsigned packages, reviewed screenshots and truthful per-platform verification ledger for the exact candidate commit.
- [ ] Controlled cold-cache/geographic WAN measurements; production adoption review before enabling experimental packs. Existing recovery format remains in use.
- [ ] Private beta support owner/feedback destination, documented privacy/retention and human security review. User-approved distribution only after all public-release blockers clear.

Development versions remain `0.1.0`; no public artifacts have been released. Use semantic versioning for product releases, independent explicit versions for synchronization protocol/portable namespace/storage formats, and additive reviewed SQLite migrations. Build inventories record source/dirty provenance; they are not bit-for-bit reproducible-build attestations. Do not promote a dirty candidate as a signed release. [Local account administration](local-accounts.md) documents ordinary-user recovery after a restored backup disables captured accounts.

## Future hosted subscriptions — architecture only

Keep account authentication, profile ownership/membership, per-device scopes, immutable revisions/CAS, audit and Rust filesystem validation as the existing data/safety plane. A future hosted control plane can supply tenancy, entitlements, explicit plan quotas and billing reconciliation through separately authenticated, idempotent events. It must not publish/apply snapshots, bypass device revocation or make a paid entitlement proof sufficient for filesystem access.

Before adding billing, review tenant isolation for every object/reference/audit query, backup/restore/export/deletion semantics, regional residency, quota accounting/abuse protection, cancellation/grace periods and a tested entitlement-outage policy. Avoid coupling subscriptions to immutable content identity or changing raw file bytes. Self-hosted use remains independently operable. No payment SDK, subscription table, entitlement enforcement, hosted account provisioning or monetization infrastructure is implemented in Phase 4.
