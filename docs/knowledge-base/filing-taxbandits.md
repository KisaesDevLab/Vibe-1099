# Filing through TaxBandits (contingency backend)

**Sidebar:** Filing & delivery → **IRS transmissions** → *Filing backend: TaxBandits*

**What it's for:** an optional third transmission backend (alongside [IRIS A2A and Tax1099](filing-irs-and-tax1099.md)) that files under **TaxBandits' (SPAN Enterprises)** transmitter credentials. It exists mainly so a firm whose **IRS TCC application is still pending** can file on time, then migrate to direct IRIS A2A once its own TCC reaches Production. TaxBandits also offers real-time TIN matching.

TaxBandits is **never the default** and is only available when:
1. the appliance operator sets `TAXBANDITS_ENABLED=1`, **and**
2. an admin enables it for the firm and enters credentials under **Settings → E-file**, **and**
3. an admin accepts the §7216 disclosure (below).

## §7216 disclosure — one-time acknowledgment

Filing through TaxBandits transmits recipient TINs (SSNs/EINs), names, addresses, and dollar amounts to **SPAN Enterprises, Inc.** as an auxiliary service provider (Treas. Reg. §301.7216-2(d)). Before any TaxBandits filing or TIN-match call is allowed, an admin must tick the acknowledgment box under **Settings → E-file → TaxBandits**. Until then, TaxBandits filing stays disabled. The acceptance is recorded in the audit log as a disclosure event.

## Corrections stay on the original provider (affinity)

A correction or void is **always transmitted through the same provider that filed the original** — you cannot file an original via TaxBandits and correct it via IRIS (or vice versa). The app enforces this automatically: when you transmit a correction batch it resolves the provider from the original filing, and a batch that mixes originals from different providers is rejected with a message to split it. This holds even after a firm later obtains its own TCC — that tax year's corrections continue via TaxBandits.

## Credits and cost

TaxBandits bills from a **prepaid credit** balance. After each accepted submission the app records a cost-ledger row (attributed firm → payer → transmission → form) and refreshes the balance; when the balance drops below the firm's threshold you get an email alert (**Settings → TaxBandits → low-credit threshold**). Rates are contract-negotiated with TaxBandits, so top up before season.

## Delivery add-ons

Pressure-seal paper remains the primary recipient-copy channel. TaxBandits **USPS mailing** and **online access** are opt-in per firm (paid add-ons, recorded in the cost ledger) — leave them off to keep delivery on the local Z-fold path.

## Status updates (webhooks)

TaxBandits pushes e-file status and TIN-match results to the appliance webhook endpoint. The app verifies each webhook (source IP + shared secret), de-duplicates it, and reconciles the transmission against the authoritative status endpoint — so a dropped or duplicated webhook never corrupts a batch's state. A background poller catches any submission that never receives a terminal webhook.
