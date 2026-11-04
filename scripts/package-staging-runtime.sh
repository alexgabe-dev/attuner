#!/bin/sh
# Run only on an isolated Jammy build machine/CI, never on the shared VPS.
set -eu
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 22.04
test "$(uname -m)" = x86_64
test "$(node --version)" = v24.22.2
test -z "$(git status --porcelain --untracked-files=all)"
test -f apps/api/dist/apps/api/src/server.js
test -f apps/web/.next/BUILD_ID
test ! -e .runtime/attuner-staging-jammy-runtime.tar.gz
node -e 'const DB=require("./packages/database/node_modules/better-sqlite3"); const db=new DB(":memory:"); if(db.prepare("select 1 as ok").get().ok!==1)process.exit(1); db.close()'
mkdir -p .runtime
tar --exclude='*/.next/cache' --exclude='*/__pycache__' -czf .runtime/attuner-staging-jammy-runtime.tar.gz \
  apps/api/dist apps/api/package.json apps/api/node_modules \
  apps/web/.next apps/web/package.json apps/web/next.config.mjs apps/web/node_modules \
  packages node_modules infrastructure/staging/run-api.sh infrastructure/staging/run-web.sh \
  infrastructure/staging/run-backup.sh infrastructure/staging/run-monitor.sh \
  infrastructure/staging/run-backup-monitor.sh infrastructure/staging/unlock-credentials.py \
  package.json pnpm-lock.yaml pnpm-workspace.yaml
(cd .runtime && sha256sum attuner-staging-jammy-runtime.tar.gz > attuner-staging-jammy-runtime.tar.gz.sha256)
git rev-parse HEAD > .runtime/attuner-staging-jammy-runtime.source
