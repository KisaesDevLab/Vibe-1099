# Public access (Cloudflare Tunnel)

**Sidebar:** Settings → **Public access**

**What it's for:** exposing the appliance's public pages to the internet without opening any inbound ports. The recipient portal, W-9 links, client portal, and provider webhooks reach the box only through a **Cloudflare Tunnel**; everything else (the staff app) stays on your LAN/Tailscale.

## Two deployment modes

- **On the Vibe Appliance (default):** public ingress is handled **at the appliance level** by the shared **Caddy** reverse proxy in front of a path-restricted Cloudflare Tunnel — the app does **not** run its own tunnel. Configure it in the appliance (see `docs/appliance-integration.md`); the Settings → Public access screen shows the paths to allowlist and confirms staff stays private. `INAPP_TUNNEL_ENABLED=0`.
- **Standalone:** if you run this app's `docker-compose.yml` by itself, the app can manage its own tunnel. Set `INAPP_TUNNEL_ENABLED=1` and start with `docker compose --profile tunnel up` — then the setup below applies.

## How it works (standalone)

The compose file includes a `cloudflared` sidecar (behind the `tunnel` profile). You create a **remotely-managed tunnel** in Cloudflare and paste its **token** into **Settings → Public access**. The app stores the token encrypted, writes it to a shared volume the sidecar runs with, and reads the sidecar's metrics to show live connection status. Ingress hostnames are managed in the Cloudflare dashboard (that's how token-based tunnels work) — the app shows you exactly which paths must be reachable.

## Setup

1. In the **Cloudflare Zero Trust dashboard → Networks → Tunnels**, create a tunnel (connector type *cloudflared*) and copy its **token**.
2. Under the tunnel's **Public Hostnames**, add your hostname (e.g. `1099.yourfirm.com`) routing to the web service **`http://web:8211`**. Cloudflare creates the DNS record for you.
3. In **Settings → Public access**, paste the **token** and **public hostname**, then **Save**.
4. Restart the tunnel so it picks up the token: `docker compose restart cloudflared`.
5. Set `PORTAL_BASE_URL` and `APP_BASE_URL` in your `.env` to `https://<your-hostname>` so emailed portal links and the TaxBandits webhook URL use the public address, then restart the app.

The **Tunnel status** panel shows *connected ✓* once the sidecar has live edge connections. Use **Refresh** to re-check.

## What's exposed

Recipients and clients open the **browser pages**; each page then calls its matching `/api` route (nginx proxies `/api` to the API). Webhooks are server-to-server. Everything else — the staff app and its APIs — requires a login.

| Path | What it is |
|---|---|
| `/f/<token>` | Recipient portal — Copy B (browser page) |
| `/w9/<token>` | W-9 collection (browser page) |
| `/client` | Client (payer) portal (browser page) |
| `/api/portal`, `/api/w9-public`, `/api/client-portal` | APIs those pages call |
| `/api/webhooks/taxbandits` | TaxBandits status webhooks (server-to-server) |

**Keeping the staff app private.** Cloudflare routes the whole hostname to the web service, so the staff app (at `/`, `/payers`, …) is also reachable at this hostname behind login. To keep staff off the public internet, either add a **Cloudflare Access** policy on this hostname that bypasses only the public paths above and requires authentication for everything else, or serve the staff app on a separate, non-tunneled hostname (LAN/Tailscale).

## Security notes

- No inbound host ports are opened; the tunnel makes only outbound connections to Cloudflare's edge.
- The token is stored encrypted at rest and is never returned to the browser (the UI shows only a saved/not-saved indicator).
- Put Cloudflare Access policies in front of the staff app if you ever route it publicly; by default the staff zone is not exposed through the tunnel.
