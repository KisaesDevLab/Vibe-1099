#!/usr/bin/env bash
# Migration-on-upgrade smoke test (appliance pipeline hook).
# Pulls new images, restarts, and verifies migrations ran + the app reports healthy.
#
# The readiness/version probes run INSIDE the api container (docker compose exec)
# using Node's fetch, mirroring the compose healthcheck. This is deliberate: the
# api service is `expose`-only — only web:8211 is published to the host — so
# `curl localhost:8210` from the host would never connect. Probing on the Docker
# network works regardless of host port mapping.
set -euo pipefail

compose() { docker compose "$@"; }

compose pull
compose up -d

echo "waiting for api health (migrations + bundled dependencies)..."
for _ in $(seq 1 60); do
  # /api/status is the appliance health verdict: postgres + redis + render +
  # queues. It stays green even before IRIS enrollment (IRIS is informational).
  if compose exec -T api node -e \
    "fetch('http://localhost:8210/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    2>/dev/null; then
    echo "api healthy after upgrade"
    compose exec -T api node -e \
      "fetch('http://localhost:8210/api/about').then(r=>r.text()).then(t=>{process.stdout.write(t);process.exit(0)}).catch(()=>process.exit(1))"
    echo
    exit 0
  fi
  sleep 2
done

echo "api did not become healthy after upgrade" >&2
compose logs --tail 50 api >&2
exit 1
