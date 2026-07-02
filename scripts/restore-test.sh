#!/usr/bin/env bash
# Quarterly restore drill: restore the newest dump into a throwaway postgres and sanity-check.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/lib/docker/volumes/vibe1099_vibe1099-backups/_data}
DUMP=$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echo "no dumps found in $BACKUP_DIR"; exit 1; }
echo "testing restore of $DUMP"

docker run -d --name vibe1099-restore-test -e POSTGRES_PASSWORD=t -e POSTGRES_DB=vibe1099 -e POSTGRES_USER=vibe1099 postgres:16
trap 'docker rm -f vibe1099-restore-test >/dev/null' EXIT
until docker exec vibe1099-restore-test pg_isready -U vibe1099 >/dev/null 2>&1; do sleep 1; done

docker exec -i vibe1099-restore-test pg_restore -U vibe1099 -d vibe1099 < "$DUMP"

for t in firms recipients form_records transmissions; do
  n=$(docker exec vibe1099-restore-test psql -U vibe1099 -d vibe1099 -tAc "SELECT count(*) FROM $t")
  echo "  $t: $n rows"
done
echo "restore test OK"
