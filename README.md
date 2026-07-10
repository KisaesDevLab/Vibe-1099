# Vibe 1099

Self-hosted 1099 preparation, recipient delivery, and IRS **IRIS A2A** e-filing appliance for
CPA firms. Standalone Docker appliance in the Vibe suite (Kisaes LLC).

**v1 form scope:** 1099-NEC, 1099-MISC, 1099-INT, 1099-DIV ·
**E-file:** IRIS A2A (firm's own TCC, per Pub 5718) · **State:** Missouri direct file (Pub 1220) +
CF/SF election · **Paper:** Z-fold pressure-seal Copy B with printed backer ·
**Portals:** client entry (magic link), recipient download (last-4 challenge), W-9 collection.

**License:** PolyForm Small Business 1.0.0 — see [LICENSE](LICENSE). A commercial license is
required for client-portal access (MyBooks model, three tiers).

## Architecture

| container | role | port |
|---|---|---|
| `vibe1099-web` | React SPA (staff + client portal + recipient portal, route-separated) | 8211 |
| `vibe1099-api` | Express API, Drizzle, BullMQ producers | 8210 |
| `vibe1099-worker` | BullMQ consumers (IRIS transmit/poll, PDF render, delivery, housekeeping) | — |
| `vibe1099-render` | WeasyPrint sidecar (Jinja2 + external CSS → PDF) | 8212 |
| `postgres:16`, `redis:7` | storage / queues (Redis DB index 3 per suite sharing policy) | internal |

Caddy/TLS is handled at the Vibe Appliance level — see `appliance/` (Addendum A). Staff routes
stay LAN/Tailscale-only; recipient/W-9/client portal routes are exposed via Cloudflare Tunnel
(split-exposure pattern, `docs/appliance-integration.md`).

Money is **integer cents** everywhere (ADR-001). TINs are AES-256-GCM envelope-encrypted with a
keyed `tin_hash` lookup index (ADR-002); plaintext TINs are never logged and never appear in URLs.

## Install (appliance stub)

```bash
cp .env.example .env
# set MASTER_KEY (32 bytes base64):  openssl rand -base64 32
docker compose up -d
docker compose exec api pnpm seed   # optional demo data
```

Web UI: `http://<host>:8211` · demo login (after seed): `admin@demo.firm` / `vibe1099-demo-password`.

Full appliance integration (Caddy routes, secret provisioning, backups) is documented in
`docs/appliance-integration.md`. Firm onboarding (TCC, ATS, MO) is `docs/firm-onboarding.md` —
**start IRS paperwork 2–4 months before the season.**

## Development

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis render
export DATABASE_URL=postgres://vibe1099:vibe1099@localhost:55432/vibe1099 \
       REDIS_URL=redis://localhost:56379/3 RENDER_URL=http://localhost:8212 \
       MASTER_KEY=$(openssl rand -base64 32) NODE_ENV=development
pnpm seed          # migrations + demo data
pnpm dev:api       # :8210
pnpm dev:worker
pnpm dev:web       # :8211 (proxies /api)
pnpm --filter @vibe1099/worker mock-iris   # :8299 — set IRIS_MOCK_BASE_URL=http://localhost:8299
```

Checks: `pnpm typecheck` · `pnpm test` (unit + golden-file suites) · `pnpm --filter @vibe1099/web build`.
Run a single test file: `pnpm vitest run tests/mo1220.golden.test.ts`.

## Repository map

```
apps/api          Express API (routes = trust zones: staff / client / recipient)
apps/worker       BullMQ consumers + mock IRIS server
apps/web          React SPA (staff app + public portals)
packages/shared   form-type registry, money/TIN utils, status machine, zod schemas
packages/db       Drizzle schema, SQL migrations, migration runner
packages/core     crypto, queues, blobs, audit, delivery adapters, IRIS client/XML, Pub 1220 writer
render/           WeasyPrint sidecar (templates + css + bundled-XSD validation)
docs/             ADRs, runbooks, compliance docs
appliance/        Vibe Appliance manifest fragment (Addendum A)
tests/            unit + golden-file tests
```

Companion tracking files: `PHASES.md` (checklist state), `STATE.md` (build journal),
`QUESTIONS.md` (open decisions). Compliance frame: IRC §7216/§6713, FTC Safeguards/GLBA,
Pub 4557/5708 (WISP appendix: `docs/wisp-appendix.md`), Pub 1179, Pub 5718, Pub 1220.
