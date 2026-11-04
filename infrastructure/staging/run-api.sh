#!/bin/sh
set -eu
test "$("$ATTUNER_NODE" --version)" = v24.22.2
test -n "${CREDENTIALS_DIRECTORY:-}"
cd /opt/attuner/current/apps/api
exec "$ATTUNER_NODE" --max-old-space-size=512 dist/apps/api/src/server.js
