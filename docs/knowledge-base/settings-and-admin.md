# Settings & admin

**Sidebar:** Admin → **Settings** *(admin role for most sections)*

Settings is organized into tabs. Any staff can read the firm profile; changing configuration requires the **admin** role.

## Firm
Legal name, EIN, address, phone — these appear on forms and as the return address on mailed Copy B. Also here: the **MO withholding ID** and the **pressure-seal imposition offsets** (±1/16″) used to calibrate paper batches.

## E-file
Your filing backends (see [IRS transmissions](filing-irs-and-tax1099.md) for the full walkthrough):
- **Filing backend** — the firm default: **IRIS** or **Tax1099**. Payers can override this individually.
- **Tax1099** — API key (stored encrypted), sandbox/production, and an option to let Tax1099 USPS-mail recipient copies.
- **IRIS A2A** — TCC, API Client ID, environment (ATS/Production), and JWK signing key tooling (generate/rotate, export the public key).
- **Federal filing thresholds** — warn-only amounts, editable **per form type and per enabled year**. Blank uses the registry default (TY2026+ NEC/MISC = $2,000 per OBBBA; earlier years $600).

All provider secrets (Tax1099 key, SMTP/EmailIt, SMS) are entered here in the UI and stored **encrypted** — you don't edit server config files.

## Delivery
- **Email provider** — **EmailIt.com** (API key + from address) or an **SMTP relay** (host/port/user/password/TLS). Choose "use appliance env config" to fall back to server defaults, or "disabled."
- **SMS provider** — **TextLink** or **Twilio** (credentials encrypted), for portal/W-9 links when a recipient has no email.
- **Message templates** — edit the wording of the emails/texts. Links always carry opaque tokens, never a name or TIN.

## Users
- **Add** a user (name, email, role, password).
- **Edit** name/email/role.
- **Reset password** — set a new password for a user; their active sessions are dropped.
- **Deactivate / reactivate** — a deactivated user's sessions end immediately.
- Users manage their own **two-factor (TOTP)** from here.

## Advanced
- **Filing years** — enable the current year and **roll over** to the next one. See [Tax-year rollover](tax-year-rollover.md).
- **Reviewer gate** — require a reviewer to approve records before they can be queued.
- **W-9 reminders**, token/invite expiry windows, portal availability, and **data retention** settings.
- **Audit log** — a searchable, append-only record of every mutation; export to CSV.
- **Queues** and **system status** — background-job health and dependency checks.
- **Licensing** — license tier/flag (where applicable).
