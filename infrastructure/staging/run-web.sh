#!/bin/sh
set -eu
test "$("$ATTUNER_NODE" --version)" = v24.22.2
export NEXT_TELEMETRY_DISABLED=1
cd /opt/attuner/current/apps/web
exec "$ATTUNER_NODE" --max-old-space-size=512 node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "${ATTUNER_WEB_PORT:-4318}"
