# Phase 3 verification report

Scope: isolated synthetic installations and local development services only. No real WoW directory was read, modified or discovered. No production deployment occurred. The Rust engine remains the authority for file safety; the server cannot supply arbitrary local paths or bypass recovery.

## Implemented

- `sync-core`: versioned/registered synthetic workspaces, portable complete manifests, canonical remote validation, persisted bindings/highest heads/jobs/remote baselines, verified compressed content import/export, durable download stages, explicit three-way choices, transactional local application and acknowledgement outbox. M8 adds bounded, sequentially verified history summaries and single-active-job inspection.
- `sync-client`: HTTPS-only proof-bound enrollment, rotating credentials in native secure storage, scoped resumable transfer, verified immutable publication, CAS/retry recovery, foreground coordination, separate application approval, offline recovery and web-proposal validation.
- Fastify/SQLite: bootstrap administrator, secure cookie sessions, CSRF/recent authentication, device grants/revocation, immutable snapshots, scoped content-addressed storage, durable chunks, range verification, atomic head publication, append-only audit, source-device reports and retained web proposals. Migrations 0002–0008 preserve original history.
- Shared contracts: unchanged manifest wire version 1, versioned publication envelope, Unicode 17 namespace data, canonical UTF-8 ordering and Rust/TypeScript comparison vectors.
- Tauri/Next/shared UI: connected mode is the default; real profile/device management, source-state history, durable transfer counts, revision comparison/verified previews, conflicts/proposals, real local scan/review/publication/application/receipts and backup verification. The original visual demo is separately labeled and selected explicitly.

Connected services and native filesystem actions are real. All displayed installations/data in qualification are synthetic. The web qualification driver uses authenticated TypeScript protocol fixtures to populate the actual API/database/CAS; it is separate from the real three-Rust-engine integration suite. The retained `?demo=1` design scenarios remain simulated and visibly labeled. There is no automatic synchronization, automatic conflict choice, Lua execution/merge, background application or remote server deployment.

## Automated evidence

Local final checks on macOS:

| Check                                                                     | Result                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier, ESLint, all TypeScript projects including tooling/HTTPS gateway | Passed                                                                                                                                                              |
| TypeScript unit/security/protocol/database tests                          | 78 passed                                                                                                                                                           |
| Rust workspace tests                                                      | 67 passed; 4 intentional ignored entries                                                                                                                            |
| Rust formatting and workspace Clippy, all targets, warnings denied        | Passed                                                                                                                                                              |
| Fastify/Next/Vite production builds                                       | Passed                                                                                                                                                              |
| Packaged macOS Tauri debug build                                          | Passed                                                                                                                                                              |
| Existing browser/accessibility regression suite                           | 54 passed; 10 expected platform-specific skips                                                                                                                      |
| Real connected HTTPS web qualification                                    | Passed; three fixture devices, two revisions, conflict proposal, verified preview, reauthenticated revocation, all navigation, 1440/768/390 layouts and WCAG checks |

The four ignored Rust entries are three subprocess harness entrypoints exercised by parent tests and the manual large-network benchmark, which was explicitly run for M7. They are not silently omitted failure cases.

The three real Rust clients enroll independently and exercise CAS races, stale revisions, offline capture/reconnect, modification-versus-deletion conflicts, explicit group-safe decisions, web proposals validated on their source device, revocation, corrupted wire data and rollback after failed application. Lost publication-response recovery preserves later unrelated local edits. Interrupted raw transfers resume only from a durable verified prefix; corrupted prefixes are preserved until explicit quarantine. Verified existing content is neither recompressed nor uploaded again.

`sync_application_crash_matrix` exercises process exit and actual SIGKILL at eight apply boundaries (sixteen cases). Before local commit, recovery restores original L and leaves B/outbox unchanged. After commit, applied snapshot, remote baseline and outbox exist together. Existing `process_crash_boundary_matrix`, interrupted recovery, concurrent creation/changes, low-space and verification-failure tests remain enabled. Tests use owned OS-temp directories and synthetic runtime guards; none kills a game process or uses a real installation.

Hosted run [41736829897](https://github.com/alexgabe-dev/attuner/actions/runs/41736829897) independently passed Linux, macOS and Windows Server 2022 through M7. Hosted M8 run [41812187271](https://github.com/alexgabe-dev/attuner/actions/runs/41812187271) (code commit `5297663`) passed all three jobs: Linux web/API/connected UI, 67 macOS Rust tests, and 19 Windows Server 2022 Rust tests plus native build and standalone-bundle execution. Windows checks include actual NTFS identity/no-clobber/sharing/junction probes, native credentials and real HTTPS enrollment; Unix-only apply/recovery tests are correctly excluded there. The subsequent HTTPS-entry guard has the expanded local 78-unit/54-browser result above and uses the same CI pipeline on push. This does not qualify Windows 11 filesystem application.

## Rendered review

The actual packaged macOS app was operated through native UI automation: certificate-verified enrollment, browser approval and OS callback, stored-credential reopen, fixture creation, complete scan, bootstrap choice, publication approval, separate application approval, receipt delivery, local backup verification, device revocation and credential removal. Backup verification also succeeded with the API stopped and no device credential. An IPC field mismatch and overlapping initial view requests were found in rendered testing and fixed; the serialized foreground queue has regression coverage. A nested paragraph in the empty state and a development CSS dependency issue were also fixed. Final security review added an HTTP entry gate that never renders credential fields, plus request-layer enforcement of HTTPS and the same API origin; negative regressions prove no password request reaches fetch over HTTP or to another origin.

The suspected macOS Keychain prompt was not confirmed. No prompt was visible to the owner; process sampling showed no blocked Security-framework call and reconnection completed. No global permissions, ACLs, system trust or credentials were weakened. The scoped native round-trip passed. The debug app remains ad-hoc signed; signed-release identity is not qualified.

Screenshots (synthetic data):

- [Actual macOS connected desktop](../../artifacts/phase-3/desktop-connected.png)
- [Final macOS offline recovery](../../artifacts/phase-3/desktop-offline-recovery.png)
- [Actual macOS backup verification](../../artifacts/phase-3/desktop-backup-verification.png)
- [Connected web overview](../../artifacts/phase-3/web-connected-1440.png)
- [Mobile overview](../../artifacts/phase-3/web-connected-390.png)
- [Conflict proposal review](../../artifacts/phase-3/web-conflict-review.png)
- [Revision comparison and verified content](../../artifacts/phase-3/web-snapshot-comparison.png)
- [HTTP entry guard](../../artifacts/phase-3/web-https-required.png)
- [Machine-readable web qualification](../../artifacts/phase-3/web-qualification.json)

Review covered typography, restrained charcoal/violet surfaces, compact rows, alignment, focus/modal behavior, realistic empty states, responsive wrapping and absence of horizontal overflow. Windows visual review is a separate physical-PC task, not inferred from these screenshots.

## Performance

See [measurements and exact benchmark commands](phase-3-performance.md) and the retained raw artifacts. Dataset: 10,004 files, 167.06 MiB, warm OS cache.

| Operation                | Baseline | Optimized |
| ------------------------ | -------: | --------: |
| First capture, empty CAS | 45.658 s |  47.718 s |
| Unchanged capture        |  3.758 s |   2.416 s |
| One changed file         |  3.750 s |   2.640 s |
| Durable 64 MiB download  |  1.804 s |   0.413 s |

Unchanged encoding/flush count is zero. Warm verified remote reuse transfers zero payload bytes. First-capture durability flushes still dominate; no first-capture speedup is claimed. Immutable object packs are a design proposal only, with no reduction in fsync/recovery guarantees. These are local TLS-loopback/warm-cache results, not WAN or cold-OS-cache qualification.

## Remaining gates and limits

- Windows Server 2022 passed actual NTFS identity/no-clobber/sharing/junction probes, native Credential Manager, real Rust/Node TLS enrollment, protocol tests and the standalone qualification bundle. Windows 11 physical-PC results remain pending. **Windows local filesystem application is disabled** until its native journal/directory durability and controlled interruption/recovery model is implemented and qualified. This is not hidden behind a Unix test pass.
- Real game discovery, process detection/interlocking and WoW adapters remain out of scope. Synthetic “closed” runtime state is not proof a real game is closed.
- The server can read original configuration content; this is not end-to-end encryption. Same-user/root compromise, compromised OS credential services, malicious storage hardware and unsupported volumes remain outside the guarantee. Stable signed releases, operational hardening and external security review remain outstanding.
- No automatic CAS/backup GC, retention deletion or orphan adoption. Interrupted transfers reserve quota; an operational cleanup/reconciliation procedure needs review before long-lived deployment.
- UI history uses bounded pages; profile/device lists currently show at most 200 entries and addon file inspection at most 1,000 matching rows. Content previews are limited to 64 KiB, with binary/non-UTF8 content shown honestly. Large-table virtualization and richer textual diffing are future work.
- Presence/progress is the last foreground report/receipt, refreshed explicitly. It is not a live game-state assertion. A cold-start offline client can inspect/verify/recover retained history but must reconnect to establish a new remote comparison.
- The first cold-CAS snapshot remains approximately 48 seconds for 10,004 individually durable objects. No durability shortcut was introduced.

Exact local commands and secure-store troubleshooting are in [Phase 3 development](phase-3-development.md). Physical-PC instructions are in [Windows 11 qualification](windows-11-qualification.md). Recommended next scope is [Phase 4 qualification and operational hardening](../architecture/phase-4-recommendation.md).
