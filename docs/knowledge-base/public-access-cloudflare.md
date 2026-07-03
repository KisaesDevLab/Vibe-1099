# Public access (Cloudflare Tunnel)

**Sidebar:** Settings → **Public access**

**What it's for:** exposing the appliance's public pages to the internet without opening any inbound ports. The recipient portal, W-9 links, client portal, and provider webhooks reach the box only through a **Cloudflare Tunnel**; everything else (the staff app) stays on your LAN/Tailscale.

## How it works

The appliance ships a `cloudflared` sidecar container. You create a **remotely-managed tunnel** in Cloudflare and paste its **token** into **Settings → Public access**. The app stores the token encrypted, writes it to a shared volume the sidecar runs with, and reads the sidecar's metrics to show live connection status. Ingress hostnames are managed in the Cloudflare dashboard (that's how token-based tunnels work) — the app shows you exactly which paths must be reachable.

## Setup

1. In the **Cloudflare Zero Trust dashboard → Networks → Tunnels**, create a tunnel (connector type *cloudflared*) and copy its **token**.
2. Under the tunnel's **Public Hostnames**, add your hostname (e.g. `1099.yourfirm.com`) routing to the web service **`http://web:8211`**. Cloudflare creates the DNS record for you.
3. In **Settings → Public access**, paste the **token** and **public hostname**, then **Save**.
4. Restart the tunnel so it picks up the token: `docker compose restart cloudflared`.
5. Set `PORTAL_BASE_URL` and `APP_BASE_URL` in your `.env` to `https://<your-hostname>` so emailed portal links and the TaxBandits webhook URL use the public address, then restart the app.

The **Tunnel status** panel shows *connected ✓* once the sidecar has live edge connections. Use **Refresh** to re-check.

## What's exposed

Cloudflare routes the whole hostname to the web service, but only these paths serve public (non-session) traffic — everything else requires a staff session and should stay on the internal network:

| Path | Purpose |
|---|---|
| `/api/portal` | Recipient portal (Copy B, identity-challenged) |
| `/api/w9-public` | W-9 collection portal |
| `/api/client-portal` | Client (payer) portal |
| `/api/webhooks/taxbandits` | TaxBandits status webhooks |

## Security notes

- No inbound host ports are opened; the tunnel makes only outbound connections to Cloudflare's edge.
- The token is stored encrypted at rest and is never returned to the browser (the UI shows only a saved/not-saved indicator).
- Put Cloudflare Access policies in front of the staff app if you ever route it publicly; by default the staff zone is not exposed through the tunnel.
