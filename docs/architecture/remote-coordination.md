# Foreground remote coordination and local commit

`sync-client` owns HTTPS, enrollment, transfer and explicit foreground coordination. `sync-core` owns manifests, namespace/policy checks, backups, local jobs, filesystem application and recovery. Neither core nor client imports Tauri, React or the API implementation. There is no timer, watcher, unattended transfer or automatic apply.

## Persisted identities

Local migration 0002 adds an immutable server/origin/profile/policy binding, highest observed remote head, a separate remote baseline, optimistic-generation jobs, application links and an acknowledgement outbox. Existing Phase 2 history and its local restore baseline are retained unchanged. A newly minted bound fixture uses the selected profile UUID from its first scan; an existing fixture cannot be rebound by rewriting history.

The remote baseline B is the immutable manifest last committed locally, paired with the corresponding remote identity. It is distinct from local restore points and the highest observed server revision. L is a fresh complete local capture. R is a fully validated remote head/manifest. M is the explicit proposed result. Unknown B always enters bootstrap review; it is never substituted with an empty manifest. A known zero server head proves an empty R, while still requiring bootstrap review.

Current-head responses reject revision rollback and same-revision identity changes. A recovered historical publication fact can raise, but never lower, the highest observed revision. Lost responses query the original session before deciding whether another publication is permitted.

## Review and publication

Preparation captures original local bytes before fetching remote data. It persists offline state if the server is unavailable and can resume after reopening. Three-way comparison uses the existing Rust engine. Modification/deletion and competing addon groups require explicit choices. All disputed members of one addon group must choose the same side. No Lua is parsed, executed or merged.

The review digest binds job ID, baseline identity, canonical L digest, R identity and canonical M digest. Publication requires the exact digest supplied through the review action, a fresh complete L scan and an unchanged R. Both checks run again after transfers. A stale proposal fails and preserves local edits. A published result equal to existing R reuses that immutable snapshot instead of allocating another revision.

A commit reply lost after server publication leaves a persisted publishing job. Reopening queries the original session, verifies its result against the original candidate/revision and records the fact. This remains safe if local edits occurred after publication: the later explicit apply still refuses to overwrite those edits.

## Download and local application

Local application is a separate explicit action. It validates current published head, fresh L and the original review digest. Missing content downloads to host-owned staging streams only. Four-MiB checkpoints sync data before publishing a bounded prefix receipt. Resume verifies that prefix; only unreceipted disposable transfer tails may be truncated. A corrupt prefix is retained until an explicit restart quarantines it. Complete original BLAKE3/size verification precedes compressed CAS import. Untrusted paths never become ambient paths.

Verified remote snapshot metadata is stored in deterministic file order. It does not change the local tree or remote baseline. Application then uses Phase 2's staging, verified preimages, no-clobber install, durable journal and rollback protocol.

The prepare transaction links the operation to the reviewed job before any destructive step. The final SQLite transaction creates the applied restore point, advances the local restore baseline, advances B, inserts the acknowledgement outbox and marks the operation/job committed together. Thus no acknowledged state can exist without a durable local commit. A failure leaves recovery required with B/outbox unchanged. Explicit recovery works without remote credentials and invalidates the interrupted proposal after rollback. Server publication remains immutable throughout.

Acknowledgement is a foreground retry. An outage after local commit leaves the outbox durable across reopening. It reports a past verified local commit; it does not claim the user has made no subsequent edits.

## Host-owned persistent fixtures

`FixtureRegistry` mints at most 64 synthetic workspaces under the host's fixed app-data directory. Renderers receive UUIDs only. A private registry marker, checked catalogue/digest, root file identity, no-follow opens and per-workspace marker constrain reopening to registered IDs. Root replacement, symlinks, unknown IDs and catalogue tampering fail closed. Unregistered/orphan directories are retained and are not automatically adopted or deleted. Temporary Phase 2 labs keep their original path restriction.

Windows mutation remains gated. The central blob service targets Unix; Windows-native NTFS/credential prerequisites have their own CI evidence. Windows 11 qualification is a separate local procedure, not proof inherited from macOS or Server 2022.

## Verification evidence

The native HTTPS suite uses independent proof keys, credential stores, local SQLite databases and synthetic workspaces. It covers three-client modification and modification/deletion conflicts, offline edits/reconnect, stale proposals, revoked credentials, corrupt wire bytes with unchanged ETag/length, explicit quarantine/retry, failed local application and rollback. A lost-publication-reply test preserves a later unrelated local edit.

The additional local synchronization crash matrix terminates or SIGKILLs a child at Prepared, Intent, Evacuated, Installed, StepDurable, BeforeVerification, BeforeCommit and Committed: sixteen independent interrupted operations. Before commit, recovery restores L with no B/outbox advancement. After commit, B and outbox reopen together. Existing Phase 2 interruption/recovery matrices remain enabled. Test-only private stdio controls are absent from production routes.

Live native/web controllers and server-side review proposals are the remaining M8 integration work. These Rust capabilities do not imply that the existing demo screens are connected yet.
