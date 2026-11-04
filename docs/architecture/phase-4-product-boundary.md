# Phase 4 product and diagnostic boundary

## Profile names

Additive web-management endpoint: `POST /api/v1/profiles/:profileId/renames` with a UUID `Idempotency-Key` and shared `profileRenameSchema` body `{name, expectedName}`. Both are trimmed 1–80-character display names, never filesystem paths. A valid HTTPS user session, origin/CSRF, recent password authentication and current **owner** membership are required. Device tokens, readers/writers and unrelated accounts cannot rename a profile.

One transaction rechecks the session epoch/expiry, owner membership and expected current name, changes only the display name, stores the idempotency receipt and writes `profile.renamed` audit. Stale names return `409 PROFILE_CHANGED` with refresh guidance. Identical concurrent retries return the recorded result; mismatched payload/key reuse is refused. Audit failure rolls back the name/receipt. No root mapping, ownership, device scope, revision, snapshot, manifest or content identity changes. Existing protocol/namespace versions and database schema remain unchanged; older clients can continue reading profiles.

The web owner's Settings panel exposes the real rename flow. Desktop devices retain device-scoped authority; account-level management stays in the authenticated web dashboard. No native generic HTTP-write command was added.

## Diagnostic allowlist

The UI exposes a reviewed report through `Help & diagnostics`, including offline/pre-enrollment states. Web serialization copies only explicit booleans and bounded numeric loaded-row counts, version fields and fixed safety flags. Native preview uses compiled version/platform and a read-only projection of cached booleans/registered-synthetic-workspace count. Neither implementation serializes arbitrary state objects or error strings. Names/UUIDs, server origins, CAs, paths, file bytes, logs and credentials are excluded; this is not a log scrubber that might miss a new secret field.

Two narrowly granted Tauri commands take **no arguments**: `diagnostics_preview` returns the bounded metadata report; `diagnostics_export` independently reconstructs the allowlist, writes a new private temporary report, and reveals that one native-derived location. The renderer cannot supply content or a destination. No filesystem, clipboard, URL or opener plugin capability is granted to renderer JavaScript. Native export has an 8 KiB cap, create-new output, Unix 0700 directory/0600 file at creation and file flush. Windows inherits the user's temporary-directory ACL; manual desktop/ACL qualification remains a beta gate. Diagnostics are not recovery material, and no hardware durability guarantee is made.

The web creates a local JSON download from the exact reviewed value and revokes the temporary Blob URL. Native state counts can change before export, but the fixed privacy schema cannot widen. Nothing is uploaded/sent automatically. Tests include injected secret-bearing unknown fields, invalid counts, actual browser download equality, native file permissions, responsive modal accessibility and keyboard focus restoration. Reports contain no persistent installation/user identifier and no timestamp by default.

The desktop shell keeps navigation/header/footer fixed and scrolls only the main workspace; the web retains normal responsive document flow. Warning state uses the established amber token, and all synthetic labels and separate publication/application approvals remain visible. The optional interface demo remains explicitly simulated.

See [beta readiness/privacy](../operations/beta-readiness.md), [operator accounts](../operations/local-accounts.md) and the per-platform [verification ledger](../operations/phase-4-progress.md).
