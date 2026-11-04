# Desktop distribution candidates

No signing accounts are currently available. **Developer ID, notarization, Windows signing, signed upgrade credential qualification and public release remain blocked.** The workflow prepares artifacts only: no GitHub Release, updater endpoint, VPS deployment or publication command exists. GitHub workflow artifacts are visible to repository readers; never include keys, credentials or application data in them.

## Unsigned development builds

Use the pinned project tools on macOS:

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
CI=true pnpm --filter @attuner/desktop tauri build --debug --ci --config src-tauri/release/macos.json
mkdir artifacts-release
pnpm exec tsx scripts/collect-release.ts macos debug development
pnpm exec tsx scripts/prepare-release.ts manifest artifacts-release macos development
```

`artifacts-release` must be new; manifests are never overwritten. The app and DMG are under `target/debug/bundle`; the collected ZIP, DMG and SHA-256 manifest are in `artifacts-release`. macOS may apply its required ad-hoc executable signature; that is not a Developer ID identity or a notarization pass. Do not remove quarantine attributes, alter Gatekeeper or change Keychain ACLs to launch a build.

On a Windows development machine with the documented pinned Node/pnpm/Rust MSVC toolchain already installed:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @attuner/desktop tauri build --debug --ci --config src-tauri/release/windows.json
New-Item -ItemType Directory artifacts-release
pnpm exec tsx scripts/collect-release.ts windows debug development
pnpm exec tsx scripts/prepare-release.ts manifest artifacts-release windows development
```

The NSIS installer is per-user and does not install WebView2. WebView2 is an explicit prerequisite. The standalone Windows 11 qualification bundle still requires no compiler/installers and is the preferred test entry point.

`Attuner distribution candidates` runs unsigned builds on relevant Phase 4/main pushes and supports manual `development` or `signed` mode. A signed request fails its prerequisite step if account configuration is missing; it cannot silently fall back to unsigned output. All manifests retain `publicDistributionReady: false` and `automaticUpdatesEnabled: false`. Local development manifests record dirty source; CI and signed candidates require a clean checkout. The commit/manifest identifies source, not bit-for-bit reproducibility across different SDK images.

## Protected CI configuration — owner setup required

Before enabling signed mode, create the `signing-candidates` GitHub environment with required human review, no self-approval and a deployment branch policy permitting only reviewed `main`/`phase4-beta-readiness`. Do not allow PR/fork code to consume signing credentials. The workflow itself is limited to those refs and the Attuner repository, pins action commits, disables checkout credential persistence and grants no contents-write permission. Review changes to signing scripts and lockfiles before approving the environment. `development-artifacts` requires no signing secrets.

Configure these **environment secrets**, not repository files:

| Secret                               | Purpose                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`                  | Base64 of a real, password-encrypted Developer ID Application PKCS#12 export |
| `APPLE_CERTIFICATE_PASSWORD`         | Export password                                                              |
| `APPLE_API_ISSUER`                   | App Store Connect issuer UUID                                                |
| `APPLE_API_KEY`                      | App Store Connect key ID                                                     |
| `APPLE_API_PRIVATE_KEY`              | App Store Connect `.p8` key contents                                         |
| `TAURI_SIGNING_PRIVATE_KEY`          | Separately generated, password-encrypted offline Tauri updater signing key   |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password                                                         |

Configure these **environment variables** (public identifiers/configuration):

| Variable                                                      | Purpose                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY`                                      | Exact `Developer ID Application: … (TEAMID)` identity             |
| `APPLE_TEAM_ID`                                               | Ten-character expected Apple team                                 |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Federated signing identity                                        |
| `AZURE_SIGNING_ENDPOINT`                                      | HTTPS regional `*.codesigning.azure.net` endpoint                 |
| `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`              | Validated public-trust Artifact Signing account/profile           |
| `WINDOWS_PUBLISHER`                                           | Exact expected X.509 subject, independently checked after signing |

Never paste any private material into chat, issue bodies, logs or workflow inputs. Keep encrypted offline recovery copies of signing keys and document revocation/rotation owners. Obtain real accounts before generating production keys; this project has not created substitute identities.

## macOS path

An Apple Developer Program account and Developer ID Application certificate are required. Use an App Store Connect API key with notarization permission rather than an Apple account password. Tauri imports the encrypted certificate on the ephemeral macOS CI runner. The helper writes the notarization key only to an owned mode-700 temporary directory/mode-600 file and removes it in an `always` step; no user login Keychain or global permissions are changed by project scripts. Treat runner compromise as signing-key compromise, and use protected environments accordingly.

Tauri builds with hardened runtime, signs and notarizes the app, and waits for stapling. Validation requires strict/deep code-sign verification, the exact team/bundle identifier, Developer ID authority, runtime flag, stapled ticket and Gatekeeper assessment. The DMG is separately signed, submitted to `notarytool --wait`, required to return `Accepted`, stapled and assessed. The ZIP is made from the validated app. No `--skip-stapling` release path exists. Retain the public notarization request ID and verification reports with the candidate.

## Windows path

The prepared provider is Microsoft Azure Artifact Signing with an identity-validated public-trust certificate profile. Enroll a federated workload identity for the exact GitHub subject `repo:alexgabe-dev/attuner:environment:signing-candidates`; grant only the Certificate Profile Signer role on the selected profile. No PFX/private signing key is downloaded and no Azure client secret is configured.

The pinned official Azure action establishes signing/tool availability; the Tauri custom sign command uses the same pinned `ArtifactSigning` PowerShell module (0.1.8) and Azure CLI OIDC session for **every** bundler signing invocation, including executable, generated uninstaller and installer. The helper verifies publisher/timestamp immediately and emits only public filename/hash receipts. Final validation requires Authenticode `Valid`, exact publisher, timestamp certificate, SignTool `/pa /all /tw`, and a signed-uninstaller receipt. Missing uninstaller evidence blocks the candidate. Provider timestamp requests use Microsoft's documented RFC3161 endpoint; they contain a digest, and the timestamp response is cryptographically authenticated, not a credential/configuration upload.

The provider-dependent steps are prepared and syntax-reviewed, **not executed or qualified without accounts**. Account eligibility, certificate chain/revocation access, timestamp availability and current module/SDK compatibility must be checked in the first real signing drill. No signing tools are installed on the user's PC by qualification scripts.

## Update and upgrade qualification

Signed mode additionally produces a Tauri/minisign artifact signature bound to the exact application version. It does not enable an updater. See [distribution trust](../architecture/desktop-distribution.md) before activating one. SHA-256 manifests detect changed bytes but are not an authenticated update authority by themselves; local JSON evidence is a pipeline record, not a substitute for OS verification at installation.

Keep `app.attuner.desktop`, deep-link scheme, per-user data location and the native credential service unchanged. Tests reopen the native store, rotate a random owned test secret and delete it without a file fallback. Those tests do not prove signed upgrades. For the first two genuine signed versions, enroll only a synthetic account, quit fully, install the next version over the first, reopen the same native credential, refresh/rotate it, then revoke the device and confirm access fails. Repeat independently on macOS and Windows 11. Verify unknown signing teams/publishers, unsigned/tampered candidates and version regressions are refused; preserve local snapshots/recovery metadata. Never relax Keychain or Credential Manager policy to make an upgrade pass.

Release review must also qualify installer/uninstaller behavior, deep-link ownership, long usernames/non-ASCII home paths, scaling/accessibility, WebView2 availability, protocol/namespace compatibility and pending-recovery interlocks. No public release until the independent Windows recovery and signed-upgrade gates have actual evidence.

Primary references: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/), [official Azure signing action](https://github.com/Azure/artifact-signing-action), [Microsoft signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).
