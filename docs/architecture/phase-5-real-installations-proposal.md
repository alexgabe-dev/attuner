# Phase 5 proposal — consented real-installation integration

**Proposal only, not approved or implemented.** Researched 2026-11-04. Phase 4 accesses no real installation and keeps the production adapter allowlist synthetic-only. This document does not authorize discovery, file access, process inspection of a user's game, deployment or real application. Each later permission boundary requires separate explicit approval.

## Evidence and uncertainty

Blizzard's current [Forever starter guide](https://news.blizzard.com/en-us/article/24315280/new-players-starter-guide-welcome-to-world-of-warcraft-forever) identifies the Battle.net-selected game edition and Windows/Mac availability. It does **not** establish a stable on-disk root name, executable identity, account-directory encoding or configuration schema. Consequently `_retail_`, `_classic_beta_`, `_forever_`, Program Files and `/Applications` must not be hardcoded as authoritative Forever layouts. No such path was inspected here.

The publisher's [UI-reset support article](https://us.support.blizzard.com/en/help/article/7549) redirected to login during this research and could not be verified directly. Community copies are not substituted for an official versioned layout specification. Search results also contain unrelated launchers/private-server projects with similar names; none establishes the user's intended distribution. Before an adapter is qualified, record the intended publisher/edition/channel/build and trustworthy source evidence. Never run a third-party installer, updater, background “fix,” console command or reset procedure discovered during research.

Primary code illustrates why addon code and saved configuration must be distinct. The WeakAuras maintainers' [TBC manifest](https://raw.githubusercontent.com/WeakAuras/WeakAuras2/main/WeakAuras/WeakAuras_TBC.toc) declares a SavedVariables global separately from its Lua/XML source list and targets a specific game flavor. This proves that example's declaration, **not Forever compatibility**. The extracted Blizzard [Forever AddOnList manifest](https://raw.githubusercontent.com/Gethe/wow-ui-source/eac30af597e5aaa43a60f6675ef5fdcea100375f/Interface/AddOns/Blizzard_AddOnList/Blizzard_AddOnList.toc) also declares machine-scoped saved state. That is a pinned mirror of publisher-authored code, not publisher certification of an installation layout. Machine-scoped values must not be silently promoted into portable account settings.

No authoritative Forever filesystem/layout or exact save-timing contract was established from those sources. Proposed paths/save points below are **synthetic test requirements and hypotheses to validate**, not claims that every current Forever build behaves identically. Do not infer client compatibility from a `.toc` interface number alone.

## Versioned adapter and discovery boundary

Preserve Rust as the sole filesystem authority. Introduce an explicit `wow-forever` adapter only after qualifying one exact publisher/channel/build interval per OS. Record adapter version, root identity/volume, local executable/bundle identity, native local mappings, portable policy version and consent scope in local SQLite. Keep absolute locations/account mappings out of remote manifests. Unknown builds/layouts/channels produce an unsupported state; they never fall back to retail or widen a root.

Stage consent: (1) synthetic-only parser/identity tests; (2) separately approved local **read-only** survey of one user-selected copied installation with the game confirmed closed; (3) optional explicitly approved read-only real-root binding; (4) independent separately approved manual apply after native recovery/interlock gates pass. No drive-wide walk, registry-wide search, Spotlight sweep, launcher-database scraping, registry/launcher edits or background probing. A native picker grants only the exact selected root; the renderer receives an opaque binding ID, never an arbitrary-path operation. Selected descendants/metadata must still pass native capability/no-link validation.

Candidate discovery can use an approved user's launcher “reveal” selection and bounded, version-specific markers. Treat installation metadata as untrusted bounded input: never execute the game/launcher or load libraries to identify it. Show the edition/build, exact local destination and intended account/character scope for user review. Multiple installations/channels, moved roots, updates and changed file identities require explicit rebinding/requalification. Registry/known-location hints, if added later, are opt-in candidates only and confer no mutation authority.

## Configuration relationships and synthetic examples

Use a fresh synthetic research tree, not copied personal files, to validate the proposed relationships. Example names/bytes are invented; this tree is not a registered adapter or a statement about the current Forever directory name:

```text
SYNTHETIC_FOREVER_BUILD/
  Interface/AddOns/ExampleAddon/
    ExampleAddon.toc                 # invented metadata, no downloaded addon
    ExampleAddon.lua                 # inert generated fixture bytes
  WTF/
    Config.wtf                      # machine-local; excluded by default
    Account/SYNTHETIC_ACCOUNT_01/
      SavedVariables/ExampleAddon.lua
      SYNTHETIC_REALM_01/Synthetic-Character/
        AddOns.txt
        bindings-cache.wtf
        SavedVariables/ExampleAddon.lua
```

Proposed inert content is `ExampleAddonDB = { fixture = true }` with explicit CRLF/LF/NUL/non-UTF-8 variants for byte-preservation tests. Do not execute or parse/evaluate Lua to synchronize it. Distinguish account-wide saved data, character-specific data, addon code/metadata, game-managed caches/backups and machine-specific graphics/audio/connectivity settings. Real client persistence points (login/logout, reload, exit, crash) and account/realm/character identifiers need controlled copied-fixture observation after separate approval; no save-timing assumption authorizes a write.

Start Phase 5 with an allowlisted **settings-only** scope. Keep `Interface/AddOns` code, executables, launcher files, cache/log/crash/screenshots, credentials and root `Config.wtf` excluded. Preserve excluded original bytes; do not redact/rewrite settings to make them portable. Do not use game-owned `.bak` files as Attuner's recovery guarantee or delete them. Before any optional addon-code transfer, review supply-chain trust, flavor/version dependencies and separate user approval: Lua preserved as bytes can still execute later when the game loads it. Attuner's refusal to evaluate Lua is not a guarantee that remote content is safe to run.

Bind one explicit account first. Add character mappings only when the user selects both local and remote identities; never guess across renamed characters, numeric/text realm IDs, ambiguous duplicate names or localized names. An account-level addon profile can refer to several characters; treat its related files as a consistency group, not independent automatic merges. Moving between scopes requires a reviewed mapping/policy change. Build a new profile/policy for a changed root set rather than interpreting uncovered roots as deletions. The current synthetic profile API fixes account/addons coverage; settings-only real bindings need an explicitly reviewed policy/API extension and compatibility tests before implementation.

The server sees authorized logical roots and validated portable paths only. Paths remain untrusted on every device. Existing Unicode/case collision, reserved names, traversal, stream/device syntax, symlink/junction/reparse/hard-link/type/identity and complete-scan requirements remain unchanged. Microsoft's [naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) document case/alias/reserved-name differences; changing the user's filesystem settings or normalizing original bytes is not a solution. Unsupported names/layouts stop the complete scan and cannot generate deletions.

## Game-running and interference interlock

Replace the fixture runtime with a separately qualified native `Closed / Running / Unknown` provider before real-root operations. Process-name matching, an unlocked file, a user checkbox, a stale process list, a watcher event or a timed sleep cannot independently prove closure.

Windows candidates: bounded Toolhelp process inventory, least-privilege process handles and executable identity comparison against the approved binding. Microsoft documents [process snapshots](https://learn.microsoft.com/en-us/windows/win32/toolhelp/taking-a-snapshot-and-viewing-processes) and [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew), including limited-query access. Access denied, PID reuse, incomplete inventory, a matching alternate copy, unknown helper/updater or unrecognized identity yields Unknown. Never elevate, inject, suspend/kill the game or disable protection to establish closure.

macOS candidates: native running-application/bundle/executable identity and launch/termination notifications, supplemented only by reviewed least-privilege process evidence. Apple's [NSRunningApplication documentation](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc) notes time-varying/race-prone properties and run-loop behavior; [PID documentation](https://developer.apple.com/documentation/appkit/nsrunningapplication/processidentifier?language=objc) warns against PID-only process comparison. Notifications/polling are hints, not exclusive launch barriers. No Accessibility, Automation, Screen Recording, Full Disk Access or Keychain permission broadening is justified by discovery.

Revalidate interlock evidence at admission and each scan/capture/stage/mutation/recovery boundary. Any uncertainty stops new managed-root I/O and preserves journal/material for later explicit recovery once closure is re-established. Antivirus/Defender, another addon manager and filesystem writers are independent interferers. Microsoft's [CreateFile sharing behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) is an interference signal, not proof that the game is closed. Never clear read-only bits, repair ACLs, retry by broadening sharing, disable antivirus or claim a backup permits overwriting unrelated changes.

**Unresolved safety gate:** repeated process checks cannot exclude a game launching between checks, and Unix advisory locks do not make an unmodified game cooperate. The fixture's exclusive runtime lease cannot simply be relabeled a real-game guarantee. Define/review a defensible launch-race/admission model and test its limits before enabling real apply. If the strict no-I/O-while-running invariant cannot be established for a platform, keep real operations gated there; do not substitute user confirmation or “no process found” for the missing proof. No game injection/driver/launch interception is proposed in this phase.

## Rollback, privacy and consent

All approved future mutation still uses the engine's verified backups/preimages, stable complete scans, durable intent, no-clobber staging/application, post-application verification and retained rollback. Recheck fresh local bytes before each destructive step. On unexpected edits, locks, low space, process transitions, partial inventory or verification failure, stop/refuse and preserve both versions. An incomplete scan never means deletion. Recovery itself is subject to closure/identity checks and may remain paused until safe; do not automatically launch the game to test a restore.

A consent screen should name the selected local account/root, allowed/excluded scopes, destination device/profile, changes/deletions/conflicts, verified recovery snapshot, disk estimate and revocation mechanism. Separate read-only binding, upload/publication and local application approvals. Warn that paths/content can expose account/character names or embedded addon data before upload; choose mappings/exclusions explicitly rather than silently editing bytes. Diagnostic exports remain the Phase 4 metadata allowlist. No real inventory, account name or client data is included in this proposal.

## Milestones and acceptance

| Milestone                                       | Dependency                                                                                   | Acceptance before progressing                                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0: product/build evidence and interlock review | Separate Phase 5 approval; Phase 4 blockers understood                                       | Publisher/distribution, exact build/OS layout evidence, process identity/save behavior and launch-race model documented; unknowns remain gated                                                                                          |
| G1: synthetic real-layout adapter tests         | G0 policy design                                                                             | Generated account/realm/character variants; unknown/moved/updated roots, Unicode/case collisions, links/unsupported entries, partial scans and excluded scopes refuse safely; no real access                                            |
| G2: copied-fixture read-only survey             | Separate scoped file consent                                                                 | Native picker/opaque binding, least privilege, bounded identity checks, running/unknown/refused paths, no contents logged/uploaded                                                                                                      |
| G3: read-only real binding candidate            | Explicit real-root consent; G2                                                               | Per-OS evidence with game closed; no automatic discovery/writes/uploads; moved root/build invalidation; revoked bindings cannot reopen                                                                                                  |
| G4: settings-only manual synchronization        | Full native recovery + interlock/policy compatibility qualification; separate apply approval | Three isolated clients, conflict/deletion/offline/revocation/rollback cases, locked/readonly/low-space/interrupted writes, launch transitions and originals verified; Windows remains disabled until its independent engine gate clears |
| G5: limited private-beta evaluation             | Real signing/upgrade and operator/recovery/support gates                                     | User-approved settings-only scope, reviewed diagnostics/feedback, explicit publication/application, no silent merges, no production deployment                                                                                          |

Recommended order is evidence/interlock review, synthetic adapters, copied read-only survey, then separately consented real read-only binding. Pack adoption, addon code distribution, automatic background sync, GC, macOS/Windows minimum-version claims and production deployment remain separate decisions. Unknown Forever root/build and the launch-race guarantee are substantive open prerequisites, not details to guess during implementation.
