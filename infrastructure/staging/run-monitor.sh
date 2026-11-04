#!/bin/sh
set -eu
test "$("$ATTUNER_NODE" --version)" = v24.22.2
cd /opt/attuner/current/apps/api
exec "$ATTUNER_NODE" --max-old-space-size=64 dist/apps/api/src/monitor.js
