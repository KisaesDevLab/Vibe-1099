# Filing through TaxBandits (contingency backend)

**Sidebar:** Filing & delivery → **IRS transmissions** → *Filing backend: TaxBandits*

**What it's for:** an optional third transmission backend (alongside [IRIS A2A and Tax1099](filing-irs-and-tax1099.md)) that files under **TaxBandits' (SPAN Enterprises)** transmitter credentials. It exists mainly so a firm whose **IRS TCC application is still pending** can file on time, then migrate to direct IRIS A2A once its own TCC reaches Production. TaxBandits also offers real-time TIN matching.

TaxBandits is **never the default** and is only usable when:
1. an admin enables it for the firm and enters credentials under **Settings → E-file**, **and**
2. an admin accepts the §7216 disclosure (below).

## §7216 disclosure — one-time acknowledgment

Filing through TaxBandits transmits recipient TINs (SSNs/EINs), names, addresses, and dollar amounts to **SPAN Enterprises, Inc.** as an auxiliary service provider (Treas. Reg. §301.7216-2(d)). Before any TaxBandits filing or TIN-match call is allowed, an admin must tick the acknowledgment box under **Settings → E-file → TaxBandits**. Until then, TaxBandits filing stays disabled. The acceptance is recorded in the audit log as a disclosure event.

## Corrections stay on the original provider (affinity)

A correction or void is **always transmitted through the same provider that filed the original** — you cannot file an original via TaxBandits and correct it via IRIS (or vice versa). The app enforces this automatically: when you transmit a correction batch it resolves the provider from the original filing, and a batch that mixes originals from different providers is rejected with a message to split it. This holds even after a firm later obtains its own TCC — that tax year's corrections continue via TaxBandits.

## Credits and cost

TaxBandits bills from a **prepaid credit** balance. After each accepted submission the app records a cost-ledger row (attributed firm → payer → transmission → form) and refreshes the balance; when the balance drops below the firm's threshold you get an email alert (**Settings → TaxBandits → low-credit threshold**). Rates are contract-negotiated with TaxBandits, so top up before season.

## Delivery add-ons

Pressure-seal paper remains the primary recipient-copy channel. TaxBandits **USPS mailing** and **online access** are opt-in per firm (paid add-ons, recorded in the cost ledger) — leave them off to keep delivery on the local Z-fold path.

## Status updates (webhooks)

TaxBandits pushes e-file status and TIN-match results to the appliance webhook endpoint. Their console asks for only a **callback URL and a notification email** — authentication is automatic: TaxBandits signs every delivery with `Signature`/`TimeStamp` headers (HMAC-SHA256 of your Client ID + timestamp, keyed with your Client Secret), and the appliance verifies the signature against the credentials saved in Settings. Each event is de-duplicated and reconciled against the authoritative status endpoint — a dropped or duplicated webhook never corrupts a batch's state, and a background poller catches any submission that never receives a terminal webhook.

When you register the URL, TaxBandits **POSTs a sample payload and activates the webhook only after receiving HTTP 200** — so save your Client ID/Secret in Settings **before** registering the URL, or the validation ping can't be signature-verified.

### Troubleshooting "cannot connect" from the TaxBandits console

Work down this list — each step isolates one layer:

1. **Is the URL public?** Copy the webhook URL from **Settings → E-file → TaxBandits**. If it starts with `http://localhost` or a LAN address, `PORTAL_BASE_URL` in `.env` is not set to your public `https://` hostname — fix it and restart. TaxBandits can only reach a public HTTPS address.
2. **Is the tunnel actually up?** Open the webhook URL in a browser **from a phone on cellular** (off your network). You should get `{"ok":true,"service":"vibe1099-taxbandits-webhook",...}`. A timeout or Cloudflare error means the tunnel/DNS is the problem — check **Settings → Public access** shows *connected ✓*, and `docker compose restart cloudflared` after any token change.
3. **Are the credentials saved first?** The validation ping is verified against the Client ID/Secret in **Settings → E-file → TaxBandits**. Save them (for the right environment — sandbox creds sign sandbox webhooks) before registering the URL in their console.
4. **Read the rejection reason.** Every rejected delivery logs why: `docker compose logs api | grep "rejected TaxBandits"` shows `signature_or_timestamp_header_missing` or `signature_mismatch` (credentials in Settings don't match the account that's sending).
5. **Timing.** TaxBandits allows 5 seconds for the 200 response and retries up to 9 times in 24 hours; you'll get an email at the notification address if deliveries keep failing.

A webhook from an IP outside `TAXBANDITS_WEBHOOK_IPS` is **accepted when its signature verifies** (the HMAC is the proof of origin) and logged so you can update the allowlist. And webhooks are never critical: the appliance **polls every submission to a terminal status regardless** — webhooks only make updates faster.
