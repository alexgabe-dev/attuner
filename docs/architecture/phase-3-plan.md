# Phase 3 — approved implementation scope

Approved 3 November 2026. One central self-hosted VPS owns the Fastify API, SQLite and content-addressed storage. All desktop/server network communication uses HTTPS. No peer-to-peer traffic, real WoW installation, unattended application or production deployment is authorized.

## Architecture and milestones

The existing monorepo remains. `sync-core` owns local filesystem safety and validation; a separate framework-independent Rust `sync-client` will own transport and coordination. The Tauri host owns OS credential storage and narrow commands. React receives bounded view models. Fastify authorizes resources and serializes database mutations through a bounded worker. Next.js never opens SQLite.

| Milestone | Scope                                                                                                                     | Required evidence                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| M0        | Contracts, canonical bytes, namespace rules, threat model                                                                 | Shared Rust/TypeScript fixtures and existing regressions            |
| M1        | SQLite ownership, sealed publication, transfer ledger, TLS                                                                | Fresh/upgrade/reopen migrations, durability and isolation tests     |
| M2        | One bootstrapped administrator, no public registration; local accounts, device enrollment, scoped credentials, revocation | Replay/CSRF/authorization tests and secure-store behavior           |
| M3        | Profile-authorized, resumable verified blobs                                                                              | Corruption, interruption, quota and cross-profile tests             |
| M4        | Immutable revisions, CAS commits, idempotency and audit                                                                   | One winner under races; lost-response retries; transactional audit  |
| M5        | Three synthetic clients, persisted baseline/outbox/coordinator                                                            | Offline, reconnect, conflict and outage scenarios                   |
| M6        | Remote import and explicit local application                                                                              | Complete local recovery matrix before enabling apply                |
| M7        | Performance and native Windows qualification, started early                                                               | Distinct cold/warm measurements; Windows-native filesystem evidence |
| M8        | Real desktop/web management UI                                                                                            | Accessibility, responsive and native rendered inspection            |

Every completed milestone is tested and committed. Failing or incomplete milestones are not pushed. Windows checks and profiling start alongside M0. A test-suite pass on Unix is never Windows qualification.

## Security decisions

Use self-hosted local web accounts, one bootstrapped administrator and explicit profile memberships. No public registration or default credentials. Enrollment uses an external browser, authorization code and PKCE with device-key binding. Access and rotating refresh credentials are proof-of-possession bound, scoped and revocable. Store native secrets only through OS credential services, with no plaintext fallback. Web sessions use Secure/HttpOnly cookies, CSRF and origin checks. Never log credentials, enrollment codes, token responses or configuration contents.

All resource access checks current device/account status and profile membership. A hash alone confers no read/reuse permission. Pending uploads do not constitute verified blobs. Profile grants and snapshot/session references control blob use; cross-profile physical deduplication is deferred. TLS validation is mandatory, including synthetic integration tests. Project test CAs do not modify global trust stores.

The server can hold plaintext configuration bytes and is trusted for account authorization. The client remains responsible for namespace safety, policy, sizes, byte hashes, preimages and recovery even when the server sends malicious metadata. Valid content is not necessarily semantically safe Lua; Attuner never executes it. Same-user/root compromise and lost storage volumes are outside the current guarantee.

## Contracts

Manifest wire version 1 stays compatible with Phase 2. Publication envelope version 1 binds expected head ID/revision/digest, base snapshot, full required-root coverage, policy, namespace version and candidate digest. Canonical bytes use fixed lexicographic object-key order and file order by UTF-8 root/path; all numbers are safe unsigned integers. Hash original content bytes with BLAKE3. Limits: 1 GiB/file, 4 GiB/tree, 100,000 entries, 16 MiB encoded manifest, 4 MiB/chunk, two blob transfers per client and 200 rows/page.

Namespace version 1 pins Unicode 17 normalization and full non-Turkic folding, rejects unassigned code points, NFC violations, virtual-directory aliases, case/compatibility collisions and unsafe portable paths. Consistency groups are derived from policy, never trusted from the sender. Both languages consume the same versioned data and conformance fixtures.

Snapshot commits use a short SQLite IMMEDIATE transaction: check current authorization, matching idempotency receipt, expected head, policy and verified pins; insert/seal snapshot, advance head/revision, record session result and audit event. A stale head returns HEAD_MOVED with no forced publication. Revision values never wrap. All hashing/transfer I/O precedes the publication transaction.

Chunks are immutable by upload/index and verified by digest/length. Durable receipt follows durable storage. Matching retries return the original result; mismatched payloads fail. Completion verifies the entire original blob before exposing it. Range downloads validate ETag/offset/length and verify the complete object before import. Bound all queues, in-memory metadata, scratch storage and concurrent jobs. Published snapshots and recovery references have no automatic GC in Phase 3.

## Coordinator and recovery

Persist separate remote baseline B, fresh local manifest L, remote head R, proposed result M, highest observed revision, transfer job and acknowledgement outbox. Unknown baseline means bootstrap review, never an empty tree. Missing roots/policy changes cannot authorize deletions. Preserve every conflict variant and require explicit choices, including group conflicts and modification/deletion.

State progression: ready → capture → fetch/validate → compare → bootstrap/conflict review or plan → transfer/verify → approval → CAS publication → remote committed → explicit local apply → local committed → acknowledgement pending → complete. Offline, revoked, cancelled, failed and recovery-required are persisted branches. Lost publication responses query the original session. Local edits or changed remote head invalidate approval. Local apply, remote-baseline update and acknowledgement-outbox creation share one local transaction. Failed local application does not silently rewrite server history. Local recovery works without remote credentials.

Persistent synthetic workspaces must be minted and registered by the native host under an app-owned directory. This is a documented expansion from OS-temp-only labs, not permission for arbitrary paths. Existing temporary labs retain their original scope and history.

## Performance and platform gates

The Phase 2 48.06-second result is first capture into an empty CAS on a warm filesystem cache, using highly compressible synthetic content. Existing objects already avoid recompression. Instrument hashing, compression, verification, flush counts/time and database work before attributing the cost. Measure unchanged and changed captures separately, then fuse redundant passes where the stability proof is preserved. Metadata timestamps and watcher events alone cannot authorize skipped byte hashing. Immutable object packs require backward-compatible recovery tests before adoption; no durability reduction is permitted.

Windows starts with local NTFS and native handle/file-identity/reparse checks, no-clobber publication, durable journaling and verified preimages. Unsupported volumes remain blocked. Qualify junctions, hard links, directory aliases, sharing violations, locked/read-only files, disk exhaustion, every crash boundary and interrupted recovery on Windows. Document server-runner versus Windows 11 evidence separately. Keep apply disabled if required durability cannot be established.

## UI and completion gates

Preserve charcoal surfaces, restrained violet, local fonts, compact rows, native conventions and responsive layouts. Separate connected synthetic data from the retained demo. Expose real device management, history, progress, snapshot comparison and conflict proposals as each backend milestone completes. Published/downloaded/applied/acknowledged are distinct states. Web proposals wait for source-device validation; they cannot directly modify local files. Preview text is escaped and bounded; binary/large content receives honest limits. No generic filesystem or HTTP command is exposed to the renderer.

Final acceptance requires three independent synthetic clients plus cross-profile adversarial tests, outage/interruption/revocation/CAS/rollback scenarios, full checks, rendered desktop/web review, independent Windows evidence, cold/warm benchmark documentation, exact launch commands and a Phase 4 recommendation. Request genuinely missing infrastructure rather than declaring a gate passed.
