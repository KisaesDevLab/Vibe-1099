# SMTP relay & DKIM guidance

Vibe 1099 sends recipient notifications, W-9 requests, client invites, and staff alerts through
the **firm's** SMTP relay (`SMTP_*` env or appliance-inherited). Deliverability during January
volume depends on the relay's domain reputation:

1. **SPF:** the sending domain's SPF record must include the relay
   (e.g. `v=spf1 include:_spf.google.com ~all`).
2. **DKIM:** enable DKIM signing at the relay (Google Workspace / M365 / Postmark all sign when
   configured); the appliance does not sign — signing belongs to the relay that owns the domain.
3. **DMARC:** publish at least `p=none; rua=mailto:…` and move to `quarantine` once reports are
   clean.
4. **From alignment:** set `SMTP_FROM` to an address on the DKIM-signed domain
   (`"Firm Name <no-reply@firm.com>"`), not a freemail address.
5. Send volume ramps sharply in January — warm up (send W-9 campaigns in Dec/early Jan) rather
   than emitting 500 first-ever messages on Jan 30.

Bounces surface on the Deliveries screen (`bounced` badge + reason) after SMTP-level rejection;
asynchronous bounces land at the relay's postmaster and should be spot-checked in season.
