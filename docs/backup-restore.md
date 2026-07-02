# Backup & restore runbook

## What must be backed up

1. **Postgres** — all filing data, encrypted TINs, blobs (PDFs, XML, MO files, W-9s).
2. **`MASTER_KEY`** — without it the database's encrypted columns are unrecoverable.
   Keep it in the appliance secret store's sealed backup, never alongside the dumps.
3. Redis is disposable (sessions + queues); do not back up.

## Nightly dump (Duplicati-compatible volume layout — Vibe-Linux-Setup convention)

Cron on the host (or appliance scheduler):

```bash
docker compose exec -T postgres pg_dump -U vibe1099 -Fc vibe1099 \
  > /var/lib/docker/volumes/vibe1099_vibe1099-backups/_data/vibe1099-$(date +%F).dump
# prune: keep 30 days
find /var/lib/docker/volumes/vibe1099_vibe1099-backups/_data -name '*.dump' -mtime +30 -delete
```

Duplicati backs up the `vibe1099-backups` volume path off-site (per firm policy — data retention
default 4 years minimum, Settings → data_retention_years).

## Restore

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U vibe1099 -d vibe1099 --clean --if-exists \
  < vibe1099-YYYY-MM-DD.dump
# restore MASTER_KEY into .env / secret store (MUST match the dump's key)
docker compose up -d
curl -fsS http://localhost:8210/api/status   # verify all checks green
```

## Restore test (quarterly)

`scripts/restore-test.sh` spins up a throwaway postgres container, restores the newest dump,
runs migrations against it, and asserts row counts on firms/recipients/form_records. Run it
quarterly and before every season.
