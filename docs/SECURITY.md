# Security posture & audit history

Vibe 1099 handles SSNs/EINs and e-files to the IRS. This file records the security model and
the remediation history so future changes preserve these invariants.

## Invariants (do not regress)

- **TINs encrypted at rest** (AES-256-GCM envelope, per-record DEK, HKDF purpose keys). Plaintext
  TIN is never logged, never in a URL, never in an error message, and appears masked
  (`XXX-XX-1234` / `XX-XXX1234`) on all payee-facing output. Full TIN reveal is staff-only + audited.
- **`tin_hash` is keyed and domain-separated** by `firmId + tinType` (ADR-002) — no cross-tenant
  correlation from a DB dump, no SSN/EIN same-digit collision.
- **Three trust zones**, each scoped at the query layer: staff (session→firmId), client
  (magic-link→payer+year), recipient (signed token→one delivery/form + last-4 challenge bound to a
  per-browser cookie).
- **Every DB query is firm-scoped**; render/transmit re-scope parties to the firm; `getBlob`
  requires `firmId`.
- **Audit log is append-only** (DB trigger) and TIN-free.
- **Render sidecar is internal-only**, restricts resource loading to `data:` + CSS, and parses XML
  with a hardened (no-entity/no-DTD) parser.

## Audit — 2026-07-02 (initial build)

Four-dimension review (auth/trust-zones, crypto/TIN/PII, injection/SSRF/XSS, access-control/IDOR).
All findings remediated in the same session:

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| H1 | High | Unauthenticated SSRF/file-read via W-9 `signatureImage` rendered as `<img src>` | Schema restricted to base64 image data URI; WeasyPrint `url_fetcher` allows only `data:` + CSS dir |
| H2 | High | Recipient last-4 challenge success shared by `deliveryId` (any token holder rode it 30 min) | Bound to a fresh HttpOnly per-browser cookie (`recip-ok:<deliveryId>:<recipSid>`) |
| H3 | High | Password reset / deactivation didn't revoke sessions (`destroyAllUserSessions` unused) | Wired into reset-complete and user active/role change; reset burns other reset tokens |
| M1 | Med | Cross-firm TIN disclosure/transmit chain (import payer, correction recipient, render/transmit reads unscoped) | Added `firmId` predicates to all four spots |
| M2 | Med | `getBlob` had no firm-ownership check | Required `firmId` param; all callers pass it |
| M3 | Med | Queue dashboard leaked other firms' contact data + live portal tokens | Filter by `firmId`; return non-sensitive descriptor only, never raw `job.data` |
| M4 | Med | Log redaction only scrubbed top-level strings | Recursive deep-scrub of objects/arrays/Error payloads |
| M5 | Med | XXE in `/validate-xml`; sidecar host-published | Hardened lxml parser; sidecar internal-only in prod compose |
| M6 | Med | `trust proxy = 1` wrong for Tunnel+Caddy (rate-limit collapse/spoof) | `TRUST_PROXY_HOPS` env (default 2) |
| M7 | Med | TOTP codes replayable within window | Consumed-counter tracking in Redis; future step dropped |
| Low | Low | tin_hash correlation, non-unique tokens, non-constant-time compares, CSV formula injection | Domain-separated tin_hash; nonce in scoped tokens; `safeHexEqual` on token/CSRF/last-4; CSV cell guard |

### Accepted / documented (not code-changed)
- **Login lockout DoS** (per-email lockout can be targeted): the per-email lockout is the correct
  control against distributed brute force; keying it to IP would let an attacker rotate IPs to
  bypass it. It's layered with a per-IP rate limit (10/5min). Accepted; monitor lockout alerts.
- **Magic-link/portal tokens travel in URLs**: inherent to the emailed-link UX. Mitigated by short
  expiry, DB revocation, single-use W-9, and (critically) the H2 cookie binding so a leaked
  recipient URL alone cannot pass the identity challenge. Ensure the reverse proxy does not log
  `/f/*`, `/w9/*` paths.
- **Client-zone lookup is firm-wide** (crosses payer boundary within a firm, masked output only):
  by design — the vault is firm-level; no other-payer name is echoed.

Verified live after fixes: 73 unit tests pass; SSRF (`file://`/metadata) and XXE blocked at the
sidecar while `data:`/CSS still render; domain-separated tin_hash lookups work end-to-end.
