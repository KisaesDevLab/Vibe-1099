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

> **Do not enable the app's in-app tunnel on the appliance.** The compose file ships an optional
> `cloudflared` sidecar (profile `tunnel`, `INAPP_TUNNEL_ENABLED`) for *standalone* deployments that
> aren't behind the appliance Caddy. On the appliance leave `INAPP_TUNNEL_ENABLED=0` and never start
> the `tunnel` profile — Caddy above owns ingress. With it off, Settings → Public access becomes an
> informational reference (the paths to allowlist) rather than a tunnel manager.

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

## Health & readiness contract

Two probes, deliberately different in scope:

- **`/api/health`** — cheap liveness (`{ok:true}`). This is the Compose container
  healthcheck; it drives restarts. Never touches a dependency.
- **`/api/status`** — the appliance console verdict (manifest `health:`). `200 {ok:true}`
  when the app's **own bundled dependencies** are up (postgres, redis, render, queues);
  `503` when one is down, with per-dependency detail in `checks`.

  **IRIS reachability is informational only** (`checks.iris.informational: true`) and never
  flips the verdict. The IRS IRIS A2A endpoint is unreachable by default — a firm enrolls for
  its TCC months after install — and is often unreachable from a LAN/Tailscale-only appliance
  with restricted egress, on top of the IRS's own maintenance windows. If it gated health the
  console would show a healthy app as permanently down and block upgrades. Live IRIS/transmit
  problems surface through the IRIS transmission log and stall alerting, not this probe.

Neither probe is authenticated or IP-allowlisted, so the console can poll them over the
internal network before any staff session exists.

## Versioning & publishing

The app version (`0.1.8`) is single-sourced across `package.json`, `appliance/manifest.yaml`
(`version:`), and `APP_VERSION` (surfaced at `/api/about` and `/api/status`).

`.github/workflows/release.yml` verifies the commit, builds the three images, pushes them to
GHCR — `ghcr.io/kisaesdevlab/vibe1099-{app,web,render}:<version>` (plus `latest`) — and creates
the GitHub Release. Trigger it either by pushing a tag or from the Actions tab:

```bash
git tag v0.1.8 && git push origin v0.1.8      # tag push
# — or — Actions → Release → Run workflow → version = 0.1.8   (also creates the vX.Y.Z tag)
```

The appliance can either **build locally** (default) or **pull the published images**. Compose
image refs are `${VIBE1099_REGISTRY:-}vibe1099-<svc>:${VIBE1099_VERSION:-0.1.8}`, so:

- `VIBE1099_REGISTRY=` (empty, default) → builds `vibe1099-app:0.1.8` from source.
- `VIBE1099_REGISTRY=ghcr.io/kisaesdevlab/` + `VIBE1099_VERSION=0.1.8` → `docker compose pull &&
  docker compose up -d` deploys the exact published version (and the same vars pin a rollback).

## Console actions

- **install:** `docker compose up -d` (migrations auto-run)
- **upgrade:** set `VIBE1099_VERSION` (and `VIBE1099_REGISTRY` if pulling), pull images →
  `docker compose up -d` → poll `/api/status` until green
  (migration-on-upgrade smoke: `scripts/upgrade-smoke.sh`). The smoke test probes **inside the
  api container** (`docker compose exec api node -e "fetch('http://localhost:8210/…')"`), matching
  the Compose healthcheck: the api service is `expose`-only — only `web:8211` is host-published —
  so the check must not assume `8210` is reachable from the host.
- **backup:** docs/backup-restore.md (pg_dump into `vibe1099-backups`, Duplicati-compatible)
- **uninstall / data export:** `docker compose down`; export first via Settings → vault export
  (encrypted) + `pg_dump`; volumes `vibe1099-*` then removable.

## Licensing

The project is MIT-licensed (see `LICENSE`); there is no runtime license gating or activation
server. The appliance manifest's `license:` field reports `MIT`.
