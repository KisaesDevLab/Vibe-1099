# Addendum A — Vibe Appliance integration

## Manifest

`appliance/manifest.yaml` is the manifest fragment for the appliance console. Summary:

- **App id:** `vibe-1099` · **Images:** `vibe1099-app` (api+worker), `vibe1099-web`, `vibe1099-render`
- **Ports (suite table):** api **8210**, web **8211**, render **8212**
- **Volumes:** `vibe1099-pgdata`, `vibe1099-redisdata`, `vibe1099-backups`
- **Env schema:** see `.env.example` (validated fail-fast at boot)
- **Redis sharing policy:** dedicated DB index **3** when sharing the appliance Redis; the
  bundled compose runs a dedicated instance.
- **Postgres:** major version 16 pinned; migrations run automatically on boot (advisory-locked,
  safe for api+worker concurrent start).

## Caddy routing — split exposure

Staff/client app: `1099.{firm-domain}` on the LAN/Tailscale-only Caddy listener.

Recipient portal (`/f/*`), W-9 (`/w9/*`), and client entry (`/client*`) require public exposure
via **Cloudflare Tunnel**. Route only these paths (plus their `/api/portal/`, `/api/w9-public/`,
`/api/client-portal/` backends) through the tunnel; everything else stays private:

```caddy
1099.example.com {            # LAN / Tailscale listener
  reverse_proxy vibe1099-web:8211
}
# Tunnel ingress (public) — path-restricted
1099-portal.example.com {
  @public path /f/* /w9/* /client* /api/portal/* /api/w9-public/* /api/client-portal/* /assets/* /api/health
  handle @public {
    reverse_proxy vibe1099-web:8211
  }
  respond 404
}
```

Belt-and-braces: set `STAFF_IP_ALLOWLIST` so staff APIs refuse tunnel-origin traffic even if a
route leaks.

## Resource footprint (compatibility addendum)

| service | idle RAM | season peak | notes |
|---|---|---|---|
| api | ~120 MB | ~300 MB | Node 24 |
| worker | ~120 MB | ~400 MB | render chunks of 50 |
| render | ~150 MB | ~500 MB | WeasyPrint; 2 gunicorn workers |
| postgres | ~80 MB | ~500 MB | blobs stored as bytea |
| redis | ~10 MB | ~50 MB | queues + sessions |

500-form batch renders in well under the 60s target on 2 vCPU (chunked ×4 concurrency).

## Secrets

`MASTER_KEY` (32 bytes base64) is provisioned by the appliance secret store into the env of api
and worker. It derives all purpose keys (docs/key-rotation.md). Loss of the key = loss of every
encrypted TIN, JWK, and W-9 PDF — it must be in the appliance's sealed backup.

SMTP/SMS config inherits from appliance-level env where present (same variable names).

## Console actions

- **install:** `docker compose up -d` (migrations auto-run)
- **upgrade:** pull images → `docker compose up -d` → hit `/api/status` until green
  (migration-on-upgrade smoke: `scripts/upgrade-smoke.sh`)
- **backup:** docs/backup-restore.md (pg_dump into `vibe1099-backups`, Duplicati-compatible)
- **uninstall / data export:** `docker compose down`; export first via Settings → vault export
  (encrypted) + `pg_dump`; volumes `vibe1099-*` then removable.

## Licensing

`LICENSE_REQUIRED=0` ships default (licensing.kisaes.com is later-phase). Usage metering
(payer count, client-portal seats) is live at Settings → License for tier enforcement later.
