# SMS opt-out (STOP) handling

The send layer honors `recipients.sms_opt_out` — an opted-out recipient never receives SMS and
falls back to email or paper-only.

Inbound **STOP** processing is provider-side:

- **Twilio:** enable Advanced Opt-Out on the messaging service (Twilio suppresses automatically);
  optionally point the inbound webhook at a future `/api/webhooks/twilio` to sync the vault flag.
- **TextLink:** configure the account's STOP handling; sync manually via Recipients → edit →
  SMS opt-out until webhook support ships.

Staff can always set the opt-out flag manually on a recipient. Compliance note: transactional
tax-document notifications still require honoring STOP under CTIA guidelines — do not bypass the
flag for "important" messages; use paper (which is always mailed anyway — delivery policy b).
