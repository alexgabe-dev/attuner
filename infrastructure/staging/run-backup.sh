#!/bin/sh
set -eu
test "$("$ATTUNER_NODE" --version)" = v24.22.2
test -n "${CREDENTIALS_DIRECTORY:-}"
case "${1:-}" in ''|*[!A-Za-z0-9_-]*) exit 2;; esac
cd /opt/attuner/current/apps/api
exec "$ATTUNER_NODE" --max-old-space-size=512 dist/apps/api/src/maintenance.js backup "/srv/attuner-staging/backups/$1" --key-fd 3 3< "$CREDENTIALS_DIRECTORY/backup.key"
