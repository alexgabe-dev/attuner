# Phase 4 — platform qualification and beta readiness

Status: in progress. Source baseline: Phase 3 `01df292`. Development branch: `phase4-beta-readiness` (no pre-existing Phase 4 branch was present). No real installation access, deployment, telemetry or automatic application is authorized.

## Milestones and acceptance

1. **W1: Windows native boundary.** Add an isolated Rust qualification crate for handle-relative NTFS traversal, exact component identity, rejection of links/reparse points, pinned parent handles, typed interference failures and no-replace handle renames. Exercise actual Windows APIs on Windows Server 2022, distribute the same tests in the non-administrator Windows 11 bundle. Keep production Windows apply disabled. A cross-compile is a type check, never runtime qualification.
2. **W2: Windows recovery qualification.** Build a synthetic-only transaction/recovery harness around those primitives, with verified preimages, bounded streaming, flushed write-ahead records and child-process interruption tests. Prove preservation under concurrent changes, read-only/locked entries, injected short writes/space exhaustion and corrupt recovery material. Report process-crash evidence separately from hardware durability. Physical Windows 11 review and a reviewed namespace durability model are independent release gates; never reset the user's physical PC.
3. **O1: server recovery and staging.** Implement offline consistent database/CAS backup and clean-root restore with immutable reference/audit checks, resumable/interrupted maintenance evidence and native-client reconnect/regression tests. Then prepare HTTPS staging, encrypted secret delivery, least-privilege persistence, limits, disk health and operator drills. Do not deploy. No GC.
4. **D1: distribution and trust.** Prepare unsigned development packages and complete credential-configured macOS Developer ID/notarization and Windows signing pipelines, release validation, stable application/credential identity, version compatibility and authenticated update architecture. Test upgrade credential persistence/rotation where accounts/platforms permit. No signing accounts are available: signed distribution remains explicitly blocked.
5. **P1: isolated pack experiment.** Prototype immutable bounded Zstandard frames and verified indexes, retaining legacy read compatibility. Fault-test publication and corruption before comparing first/unchanged/one-file/1% captures across small/large, compressible/high-entropy fixtures. Separate warm cache, externally controlled cold cache and shaped HTTPS transfer results. Do not adopt without measured benefit and recovery evidence; do not purge system caches.
6. **U1: product and beta operations.** Refine real onboarding, progress, comparison/recovery, profile/device administration and accessibility using existing tokens/components. Add allowlisted explicit diagnostic export, basic audited user administration and beta/privacy/feedback/system requirements documentation. Inspect rendered desktop and responsive web UI and retain screenshots. No analytics.
7. **R1: real-game preparation only.** Research cited, version-specific layouts and platform interlocks; document synthetic examples and a separate Phase 5 consent/recovery proposal. Never inspect installed game directories.

Each milestone must pass relevant formatting, lint, type, protocol/migration, security and recovery checks before its commit. Run the complete suite and three-client scenarios before declaring Phase 4 complete. Record results per operating system, including unavailable tests and prerequisites.

## Windows boundary decision

The existing core is framework-independent and rejects Windows apply/recovery. Its Unix implementation assumes durable directory synchronization and cannot be enabled by substituting pathname-based Windows moves. A small `attuner-platform-windows` crate isolates native handle operations and qualification from SQLite/Tauri, allowing cross-platform type checks without cross-compiling bundled SQLite. It has no desktop command and no dependency from the production engine yet. Qualification names are deliberately restricted to an ASCII subset; full portable Unicode namespace inventory remains a prerequisite for engine integration. This restriction does not weaken the engine's current namespace validation.

Use native `NtCreateFile` with a pinned root handle and a single validated component, verify returned handle metadata and canonical name, and retain parent handles denying write/delete sharing. Use handle-based no-replace rename, never POSIX replacement/read-only overrides. Typed failures retain original material. Do not retry interference by changing permissions or disabling Defender.

Microsoft's [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [rename information](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information) and [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) specify individual operations. They do not alone prove persistence ordering for Attuner's complete multi-step transaction after power loss. Keep that claim and gate separate from process-exit tests.

## External gates

- Windows 11 is a physical PC, not a runner. Supply a self-contained bundle and commands; Windows Server CI continues independently.
- No signing accounts/certificates are available. Prepare pipelines and validation; use unsigned builds and leave public release blocked.
- No staging deployment is authorized. Supply files and test locally where possible.
- Cold-cache, geographic WAN and retained-disk abrupt-reset evidence must identify the actual environment. Emulation/process termination are useful tests but cannot be relabeled as those measurements.
