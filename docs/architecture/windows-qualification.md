# Windows implementation and qualification

Windows Server 2022 CI independently builds Tauri, runs portable core/protocol checks, exercises Credential Manager and enrolls the Rust device over real HTTPS. Windows 11 has not been supplied or qualified. The engine's Windows filesystem mutation gate remains closed.

## Native probes started during M3/M4

`crates/sync-core/tests/windows_qualification.rs` runs only on Windows, in newly minted temporary synthetic directories. It probes local NTFS, handle file IDs and volume identity, hard-link counts, junction/reparse visibility without following, no-replace rename, sharing violations, file flush and byte preservation. These are prerequisite measurements, not a completed recovery implementation or power-loss proof. Hosted execution must pass before any claim is made about these behaviors.

## Implementation order

1. Open the app-owned synthetic workspace root using native directory handles. Verify local fixed NTFS volume; reject UNC/network/removable/unknown filesystems. Persist volume identity and root file ID.
2. Resolve each validated portable component beneath the pinned root. Use `FILE_FLAG_OPEN_REPARSE_POINT` and handle attributes, reject every reparse tag/junction, hard links, alternate data streams, case aliases, short-name aliases and cross-volume traversal. Validate parents again at the operation boundary; pathname-only checks are insufficient.
3. Implement CREATE_NEW staging and hash/size verification. Recheck preimage identity and bytes through pinned handles. Do not permit unrelated creation to be replaced.
4. Implement handle-based no-replace quarantine/install transitions, write-ahead SQLite FULL journal records and durable recovery preimages. Sharing/read-only/antivirus interference is a typed, recoverable failure. No elevation, volume flush or system configuration changes are assumed.
5. Port the process-termination recovery matrix to Windows child processes. Qualify every journal/evacuation/install/verification/commit boundary, interrupted recovery, missing/corrupt backups, preimage changes, disk exhaustion and volume identity changes.
6. Qualify a Windows 11 local NTFS VM independently: cold boot, abrupt VM reset and retained virtual disk, long paths, case-sensitive subdirectories, active antivirus, locked files, restricted ACLs, OS credential storage, Tauri/deep-link ownership and rendered UI. Preserve traces and hashes before/after each fault. Do not translate a process-exit pass into a power-loss guarantee.

## Durability boundary

Microsoft documents file-buffer flushes and the write-through move flag. Its move documentation specifically describes the flush guarantee for a copy/delete move; that statement alone does not establish Unix directory-fsync-equivalent durability for the engine's same-volume multi-step journal. The native probes therefore leave apply disabled until a reviewed native handle/journal protocol and crash/power-loss evidence close that gap. See [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) and [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

No real game files are part of any qualification. A Windows 11 VM with local NTFS, permission for synthetic reparse/ACL tests and retained-disk reset control is the remaining environment prerequisite. Signing certificates and production deployment are outside this work.
