# Deliveries & the recipient portal

Online **courtesy copies**: a secure link a recipient can use to view and download their own 1099. This is in addition to the paper Copy B, which is always mailed.

---

## Deliveries (staff)
**Sidebar:** Filing & delivery → **Deliveries**

**What it's for:** composing and tracking the portal links sent to recipients for **accepted** forms.

**Key actions:**
- Pick the **tax year** and the **payers** (search-and-add, or **Undelivered** / **All with accepted forms** quick-adds).
- **Send portal links** — email is preferred, SMS is the fallback. Recipients with no email/mobile are reported as **paper-only** (they still get the mailed Copy B).
- Track each delivery's state: pending, sent, viewed, downloaded, bounced, revoked.
- **Resend** with a fresh link (the old one is revoked) or **Revoke** a link.

**Note:** links carry **opaque tokens only** — never a name or a tax ID.

---

## The recipient portal (what the recipient sees)
**URL:** `/f/:token` (from the delivery)

1. The recipient opens their link and passes a **last-4 of TIN challenge** to prove identity.
2. They can then **view and download their own 1099 PDF** — and only theirs.
3. Corrected forms are clearly marked **CORRECTED**.

The challenge success is bound to that specific browser session, so simply having the link isn't enough to see the form.

---

## Delivery policy
- **Paper Copy B is always mailed** (see [Paper batches](paper-batches.md)).
- Portal links are a **courtesy** copy; there's no online-only consent flow.
- If your firm files through **Tax1099**, you can alternatively have **Tax1099 USPS-mail** the recipient copies (Settings → E-file).
