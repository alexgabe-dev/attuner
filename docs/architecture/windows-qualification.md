# Windows implementation and qualification

Windows Server 2022 CI independently builds Tauri, runs portable core/protocol checks, exercises Credential Manager and enrolls the Rust device over real HTTPS. Windows 11 has not been supplied or qualified. The engine's Windows filesystem mutation gate remains closed.

## Native probes started during M3/M4

`crates/sync-core/tests/windows_qualification.rs` runs only on Windows, in newly minted temporary synthetic directories. It probes local NTFS, handle file IDs and volume identity, hard-link counts, junction/reparse visibility without following, no-replace rename, sharing violations, file flush and byte preservation. These are prerequisite measurements, not a completed recovery implementation or power-loss proof. Hosted run 41727481100 passed these probes independently on Windows Server 2022. This still does not enable apply.

## Implementation order

1. Open the app-owned synthetic workspace root using native directory handles. Verify local fixed NTFS volume; reject UNC/network/removable/unknown filesystems. Persist volume identity and root file ID.
2. Resolve each validated portable component beneath the pinned root. Use `FILE_FLAG_OPEN_REPARSE_POINT` and handle attributes, reject every reparse tag/junction, hard links, alternate data streams, case aliases, short-name aliases and cross-volume traversal. Validate parents again at the operation boundary; pathname-only checks are insufficient.
3. Implement CREATE_NEW staging and hash/size verification. Recheck preimage identity and bytes through pinned handles. Do not permit unrelated creation to be replaced.
4. Implement handle-based no-replace quarantine/install transitions, write-ahead SQLite FULL journal records and durable recovery preimages. Sharing/read-only/antivirus interference is a typed, recoverable failure. No elevation, volume flush or system configuration changes are assumed.
5. Port the process-termination recovery matrix to Windows child processes. Qualify every journal/evacuation/install/verification/commit boundary, interrupted recovery, missing/corrupt backups, preimage changes, disk exhaustion and volume identity changes.
6. Qualify a Windows 11 local NTFS VM independently: cold boot, abrupt VM reset and retained virtual disk, long paths, case-sensitive subdirectories, active antivirus, locked files, restricted ACLs, OS credential storage, Tauri/deep-link ownership and rendered UI. Preserve traces and hashes before/after each fault. Do not translate a process-exit pass into a power-loss guarantee.

## Durability boundary

Microsoft documents file-buffer flushes and the write-through move flag. Its move documentation specifically describes the flush guarantee for a copy/delete move; that statement alone does not establish Unix directory-fsync-equivalent durability for the engine's same-volume multi-step journal. The native probes therefore leave apply disabled until a reviewed native handle/journal protocol and crash/power-loss evidence close that gap. See [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) and [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

No real game files are part of any qualification. The user has a physical Windows 11 PC and will run the standalone bundle described in `docs/operations/windows-11-qualification.md`; no self-hosted runner is required. Controlled retained-disk reset testing remains a separate prerequisite before filesystem apply can be qualified. Signing certificates and production deployment are outside this work.

## Phase 4 native boundary and recovery experiment

`attuner-platform-windows` is an isolated qualification crate with no production engine/Tauri dependency. It mints its own temporary NTFS root, pins ancestor handles, opens only validated ASCII fixture components relative to those handles, verifies exact names/128-bit file IDs/volume IDs, rejects reparses/hard links/case-sensitive directories and uses handle-relative no-replace renames. Native Server 2022 run [41846371470](https://github.com/alexgabe-dev/attuner/actions/runs/41846371470) passed all ten handle tests and repeated them successfully from the standalone bundle. An earlier assertion that sharing flags prevent creating hard links failed empirically; the corrected suite requires detection/refusal of newly introduced hard links and original-byte preservation. Read/write/flush/rename boundaries recheck metadata; preimages are never writable. This is not a proof that all metadata races are excluded.

The crate's **test-only** one-file recovery experiment exercises flushed, hash-chained create-new journal records, verified backup/staging, preimage evacuation, no-clobber install and explicit rollback. Child processes are actually terminated using Windows `TerminateProcess` through Rust's `Child::kill`, including interrupted rollback. Partial unreceipted journal stages are retained and never adopted. Failure injection bounds short writes without consuming a volume. The experiment does not replace the core's SQLite journal, scan/namespace/group logic or production recovery model, and cannot be called through Tauri. Its test results must be reported separately until native CI runs it.

Remaining integration gates: full Unicode/collision inventory and scan parity, core SQLite journal/backend adapter integration, complete multi-file/game-state/cancellation matrix on Windows, reviewed namespace persistence ordering, physical Windows 11/NTFS/Defender qualification and controlled non-destructive retained-disk fault evidence. Production Windows apply remains disabled. Cross-checking the isolated crate on macOS uses `--target x86_64-pc-windows-msvc --features blake3/pure` solely to avoid a cross C/assembly toolchain; runtime Windows tests use their normal native BLAKE3 implementation. Neither cross-checks nor process kills are power-loss qualification.
