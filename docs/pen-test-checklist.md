# Pen-test checklist — public routes

Public (tunnel-exposed) surface: `/api/portal/*`, `/api/w9-public/*`, `/api/client-portal/*`,
static SPA. Re-run before each season.

## Token handling
- [ ] Recipient/W-9/client tokens are HMAC-signed, expiring, single-scope; verify cross-scope
      reuse fails (a client token on `/api/portal/*` must 401).
- [ ] Reissued tokens invalidate the old (token_hash comparison).
- [ ] Revoked invites/deliveries reject immediately.
- [ ] Tokens never appear in logs (pino redaction) or referrer-leaking URLs beyond the entry link.
- [ ] No TIN, name, or email in any URL.

## Recipient challenge
- [ ] Last-4 lockout at 5 attempts (Redis, 1h) → E_LOCKED_OUT + staff alert + audit entry.
- [ ] Challenge success is delivery-scoped (`recip-ok:<deliveryId>`, 30 min) — one delivery's
      pass does not open another.
- [ ] PDF route requires a passed challenge (requireChallengePassed).

## Client zone
- [ ] Query-layer scoping: entries/contractors constrained to the invite's payer + tax year.
- [ ] Vault lookups return masked identity only; no full TIN echo.
- [ ] Submitted engagements refuse further writes until staff re-open.
- [ ] Form types outside the invite's scope are rejected (403).

## Rate limiting / abuse
- [ ] Per-IP fixed windows on every public router (portal 30/min, w9 30/min, client 120/min,
      login 10/5min).
- [ ] Body size limits (10 MB JSON) hold; oversized drawn-signature payloads rejected.

## Headers / transport
- [ ] helmet CSP (no inline script), frame-ancestors none, CORP same-origin.
- [ ] Cookies HttpOnly + SameSite=Lax (+ Secure behind TLS); CSRF double-submit on staff mutations.
- [ ] `trust proxy` correctness behind Caddy/Tunnel (rate limits keyed on real client IP).

## Staff zone leakage
- [ ] Staff API paths unreachable through the tunnel host (Caddy path allowlist + optional
      STAFF_IP_ALLOWLIST).
- [ ] Session fixation: sid regenerated at login (new random sid per login).
- [ ] Inactivity timeout enforced (Redis TTL, rolling).
