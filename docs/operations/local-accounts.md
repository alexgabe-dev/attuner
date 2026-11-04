# Local account administration

Attuner has one explicitly bootstrapped administrator and no public registration. User administration is a **local operator CLI**, not an HTTP endpoint. Run it only as the dedicated service operator with access to the private Attuner data directory. Do not paste passwords into shell commands, files, environment variables, logs or chat.

Development commands run from the repository root after `source scripts/env.sh`. Set `ATTUNER_DATA_DIR` to the intended synthetic/non-production service data directory if it differs from `.runtime`; the API package's default resolves to the repository `.runtime` directory. For installed staging, use the pinned Node binary and built `apps/api/dist/apps/api/src/admin.js`, with the explicit service data directory and dedicated operator account; no privileged shell or deployment is performed by these commands.

```sh
pnpm --filter @attuner/api admin bootstrap owner
pnpm --filter @attuner/api admin users
pnpm --filter @attuner/api admin user-create beta.user
pnpm --filter @attuner/api admin user-disable beta.user
pnpm --filter @attuner/api admin user-reset beta.user
pnpm --filter @attuner/api admin reset owner
```

Password-taking commands require an interactive terminal with hidden input (12–1,024 UTF-8 bytes). Only Argon2id verifiers are persisted. Creation grants the ordinary `user` role and **no existing profiles/device scopes**; the user can sign in over verified HTTPS and create their own profiles. No CLI command grants administrator status, transfers ownership, deletes profiles or silently adds membership. Existing per-profile quotas and all authorization checks remain in force.

`users` returns at most 200 usernames, roles, disabled timestamps and creation timestamps; no password hashes, device keys or session tokens. If `nextAfter` is present, use `admin users <nextAfter>` to read the next page. Usernames normalize to lowercase and accept only 3–64 ASCII letters/digits/dot/underscore/hyphen.

Disabling atomically blocks the account, advances its web-session epoch, revokes owned devices/credentials, denies outstanding approved enrollments and appends an operator audit event. Snapshots, memberships, revisions, recovery material and audit history are preserved. Password recovery re-enables only the selected account with a new password while keeping old sessions/devices/approval codes revoked; fresh explicit enrollment is required. A failed audit write rolls the entire account change back.

Ordinary-user commands refuse every administrator target, so they cannot disable/demote the bootstrapped owner. Creating/recovering users requires an active administrator in the same SQLite transaction. After disaster recovery disables all captured accounts, recover the chosen administrator first with `admin reset owner`, review each ordinary account, then recover only approved users with new passwords. Administrator recovery now also denies pre-reset approved enrollment codes; a copied outstanding callback cannot enroll after recovery.

Audit events distinguish `operator` authority with a null interactive account ID and explicit target UUID. OS audit/service access controls identify the human operator; Attuner does not invent an authenticated username for a local maintenance command. There is no public reset, invitation email or automatic provisioning flow. Securely communicate initial passwords outside Attuner using your organization's approved secret-delivery method; these tools send no messages.

Tests exercise profile isolation, role protection, disabled sessions/DPoP credentials, post-reset approval rejection, retained memberships, hashing, no-bootstrap refusal and real SQL-trigger audit failure rollback. These are synthetic fixtures only.
