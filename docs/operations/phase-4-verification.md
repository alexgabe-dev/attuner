# Phase 4 qualification report

Status: substantial implementation and qualification evidence complete; **public beta and full Windows filesystem application remain blocked**. No real WoW installation access, production/VPS deployment, telemetry, automatic apply or signing-security bypass occurred. This is not a declaration that all Phase 4 release gates passed.

Product source: `a5dc4f2`; operational correction: `336864b`; unsigned desktop candidate source: `9908355`. Later report-only commits do not change those measured sources. The [milestone ledger](phase-4-progress.md) preserves prior failures/corrections and per-run boundaries.

## Implemented

- Windows-native pinned-handle primitives and an isolated original-byte recovery harness, real process-termination matrices and a standalone native qualification driver. No PowerShell execution-policy bypass, elevation/Defender repair or arbitrary filesystem command. Production Windows mutation gate stays closed.
- macOS app/DMG and Windows executable/NSIS development candidates; protected real signing/notarization/provider configuration and validation; stable app/credential identity and inactive signed-update architecture. No fake identities or public publication.
- Encrypted consistent SQLite/CAS backup and clean-root restore, reference/schema/audit/content verification, interrupted-operation receipts, identity/regression checks, forced account/session/device revocation on restore and three real Rust client reconnection drills. No GC.
- Undeployed HTTPS staging renderer/units with least-privilege credential delivery, limits/storage reserves, sanitized structured logs, readiness/outage/backup monitors and operator procedures. Root-owned systemd ACL delivery is now tested independently using a non-secret marker.
- Isolated verified object-pack prototype and paired cold-CAS/warm-CAS workloads; bounded userspace shaped HTTPS transfer with actual protocol/auth/storage. Neither experiment changes the engine's production format or claims geographic WAN/cache-cold qualification.
- Audited local user administration, owner-only profile rename, real native/web diagnostic export, refined native scrolling/onboarding/status/accessibility and preserved responsive visual identity. [Beta privacy/release guidance](beta-readiness.md) and a separately gated [Phase 5 proposal](../architecture/phase-5-real-installations-proposal.md).

## What is real versus experimental

API authentication, device scopes/revocation, immutable revisions, file hashes/transfers, explicit Rust comparison/application/recovery, local snapshot history/backup verification and web management use real implementation. **All installations/content used here are synthetic.** Connected web qualification uses TypeScript protocol fixture devices; separate Rust tests use actual native engines/clients. No simulated report is presented as a real machine/game-presence signal.

The retained `?demo=1` interface is explicitly simulated. The Windows one-file harness is a qualification experiment, not the full core SQLite backend. Packs are laboratory-only. The TCP relay emulates propagation/bandwidth; it is not an Internet/VPS result. Signing and encrypted VPS credential provisioning are prepared, not provider/host qualified. No updater or telemetry service is active.

## Actual verification

| Environment/source                | Results                                                                                                                                                                                                                                                               | Boundary                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local macOS 26.6.2 / arm64        | 113 TypeScript tests; 78 Rust tests; 54 browser tests; formatter, lint, typecheck, Clippy, migrations, production builds, full `pnpm verify`, real HTTPS connected UI and local Nginx staging checks passed                                                           | Five Rust ignored functions are parent-invoked child entries/manual benchmarks; ten browser skips are expected platform-specific cases. Parent crash matrices ran. Latest server ACL changes also passed targeted/full TypeScript tests and API build |
| Linux / `336864b`                 | [Job passed](https://github.com/alexgabe-dev/attuner/actions/runs/41902279830/job/126827589200): 113 TypeScript tests, builds, 54 browser checks, connected HTTPS, digest-pinned read-only Nginx container and actual systemd 255.4 root-owned service-user ACL probe | Transient non-networked public marker only; no Attuner service deployment, real secret decryption or VPS activation                                                                                                                                   |
| macOS arm64 + Intel / `a5dc4f2`   | [Both native jobs passed](https://github.com/alexgabe-dev/attuner/actions/runs/41899944829), including full Rust tests and desktop builds                                                                                                                             | Separate actual architecture evidence. Some earlier ARM jobs had no runner; those cancellations are not passes                                                                                                                                        |
| Windows Server 2022 / `a5dc4f2`   | Same full successful run; standalone five executables all exited 0, no timeouts, containment verified; native handle/recovery/NTFS/protocol/Credential Manager tests passed                                                                                           | Report records **elevated**, `allowServer: true`, `windows11: false`; normal-user Windows 11, complete engine, Defender-specific and hardware durability gates remain open                                                                            |
| Unsigned distribution / `9908355` | [Both packaging jobs passed](https://github.com/alexgabe-dev/attuner/actions/runs/41900810267); clean source and matching versions; independent downloaded archive/inventory hash verification                                                                        | Development artifacts only, no Developer ID/notarization/Authenticode/signed-upgrade pass                                                                                                                                                             |

O3's later native Windows Server 2022 and Apple Silicon jobs also passed. Its Intel macOS job remains in progress at report preparation; that pending result does not replace the completed per-platform product evidence above. There are no known failing local checks.

Recovery evidence includes eight actual server-maintenance SIGKILL boundaries, existing local application/rollback crash matrices, three real Rust clients reconnecting after encrypted restore/re-enrollment and refusing regressed or changed server identity, ten pack-publication SIGKILL boundaries and 23 terminated Windows native-harness children (repeated through the standalone bundle). Corrupt/missing/truncated material, real failed SQL audit inserts, injected short writes/ENOSPC, failed verification and concurrent edits/creations are tested. Process termination is not hardware power-loss proof; no disk was deliberately filled or physical machine reset.

## Performance

Paired **laboratory** observations, warm OS cache; 10,001 files / 175,177,728 bytes:

| Operation                         | Individual objects |   Packs |
| --------------------------------- | -----------------: | ------: |
| Compressible first / cold CAS     |           46.725 s | 1.589 s |
| Compressible unchanged / warm CAS |            0.938 s | 0.789 s |
| Compressible one changed file     |            0.947 s | 0.802 s |
| Compressible 100 changed files    |            1.373 s | 0.835 s |
| High-entropy first / cold CAS     |           50.026 s | 1.448 s |

First-capture durable file flushes fall from 10,001 to 10/14; unchanged content is not recompressed. Large-only high-entropy cases expose pack regressions, so no universal or shipped-engine speedup is claimed. Peak laboratory process RSS: 19.80 MiB. Shaped 4 MiB+17-byte HTTPS uploads with durable reconnect/resume took about 7.95 s at emulated 80 ms/5 Mbps upload and 19.08 s at 160 ms/2 Mbps; warm verified reuse transferred zero blob payload bytes. See [raw evidence, limits and commands](phase-4-performance.md). Actual OS-cache-cold/geographic WAN remain unmeasured; packs are not adopted.

## Screenshots and candidate artifacts

- [Native onboarding](../../artifacts/phase-4/desktop-onboarding.png), [actual offline backup verification](../../artifacts/phase-4/desktop-offline-verification.png), [native diagnostics](../../artifacts/phase-4/desktop-diagnostics.png).
- [Web overview](../../artifacts/phase-4/web-connected-1440.png), [mobile overview](../../artifacts/phase-4/web-connected-390.png), [profile management](../../artifacts/phase-4/web-profile-settings-1440.png), [mobile diagnostics](../../artifacts/phase-4/web-diagnostics-390.png), [snapshot comparison](../../artifacts/phase-4/web-snapshot-comparison.png).
- [Unsigned macOS ZIP/DMG](https://github.com/alexgabe-dev/attuner/actions/runs/41900810267/artifacts/13358207703), [unsigned Windows executable/NSIS](https://github.com/alexgabe-dev/attuner/actions/runs/41900810267/artifacts/13358096290), [standalone Windows qualification bundle](https://github.com/alexgabe-dev/attuner/actions/runs/41899944829/artifacts/13359090749).
- Public copied manifests/report and independent digest receipts are retained under `artifacts/phase-4`; downloaded archives remain ignored under `.runtime/phase4-evidence`. Artifacts expire after 14 days. No downloaded Windows executable/installer/app was executed during read-only inventory validation.

Actual native review exercised offline inspection/verification, report save/reveal, Tab/focus containment and Escape focus restoration. Web tests check 390/768/1440 layouts, real password-confirmed rename with preserved snapshots, conflict proposals, revision comparison, revocation, actual diagnostic download equality/privacy and automated accessibility/runtime errors. Windows desktop visual/DPI/manual assistive-technology review remains the physical-PC procedure.

## Local launch

From the repository root, in separate terminals (source the project environment in each):

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
ATTUNER_PUBLIC_ORIGIN=https://127.0.0.1:4318 pnpm --filter @attuner/api dev:fixture
```

```sh
source scripts/env.sh
pnpm --filter @attuner/api admin bootstrap owner
```

Bootstrap once using hidden input; existing accounts keep their password. No default/public account exists.

```sh
source scripts/env.sh
pnpm --filter @attuner/web dev:connected
```

```sh
source scripts/env.sh
pnpm dev:desktop
```

Open `https://127.0.0.1:4318`, create a synthetic profile and explicitly enroll the desktop. Paste only `.runtime/dashboard-ca.pem` into the native custom-public-CA field. Development certificates regenerate on service restart; no tool installs a trusted root. OS/browser security blocks require a local owner decision, not an automated bypass. [Detailed certificate/Keychain launch guide](phase-3-development.md) and [local account commands](local-accounts.md).

For physical Windows 11, use the exact extraction/normal-user commands in [the standalone procedure](windows-11-qualification.md), then `Start-Process .\Attuner.exe`. No Rust/Node/runner/admin shell is required. Never use `--allow-server`, execution-policy changes, antivirus exclusions or elevation to manufacture a pass. The optional SSH connection uses only an existing private tunnel and public CA; no host/firewall service is enabled automatically.

## Remaining gates and next scope

1. **Remaining engineering:** integrate the native Windows boundary with the full core SQLite journal, multi-file/Unicode namespace, game-state and cancellation matrices. The one-file harness is not that implementation. A reviewed namespace-persistence protocol, normal-user Windows 11/NTFS/Defender tests and a safe disposable retained-disk fault environment are still necessary. Windows apply remains disabled.
2. **External accounts:** real macOS/Windows signing/notarization and signed-upgrade credential qualification. Missing-account preflights correctly refuse; no public distribution or updater activation.
3. **Operator environment:** actual VPS OS/version/architecture/dedicated hostname are awaited. The clean example staging bundle is undeployed. Real encrypted secret provisioning, service activation, operator restore/monitor response and geographic WAN tests require a separately authorized target/drill.
4. **Optimization:** complete production migration/rollback/retention/platform qualification and cold-cache measurements before pack adoption. No automated cleanup/GC.
5. **Beta review:** physical desktop/accessibility/support/privacy and exact release-checklist signoff. No crash collection/analytics/hosted billing implemented.
6. **Phase 5:** review the [separate proposal](../architecture/phase-5-real-installations-proposal.md), first resolving exact Forever build/layout evidence and real-game launch-race/interlock assumptions. Then qualify generated/copied read-only fixtures; real-root read/upload/apply require separate consent and applicable platform recovery gates. No real game integration begins from this report.
