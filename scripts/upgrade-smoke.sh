#!/usr/bin/env bash
# Migration-on-upgrade smoke test (appliance pipeline hook).
# Pulls new images, restarts, and verifies migrations + health.
set -euo pipefail

docker compose pull
docker compose up -d
echo "waiting for api health..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:8210/api/status >/dev/null 2>&1; then
    echo "api healthy after upgrade"
    curl -fsS http://localhost:8210/api/about
    exit 0
  fi
  sleep 2
done
echo "api did not become healthy after upgrade" >&2
docker compose logs --tail 50 api >&2
exit 1
