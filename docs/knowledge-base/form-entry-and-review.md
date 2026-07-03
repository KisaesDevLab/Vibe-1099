# Form entry & Client review queue

Two related screens: one for keying amounts yourself, one for approving what clients submitted.

---

## Form entry
**Sidebar:** Season → **Form entry**

**What it's for:** entering 1099 amounts directly on a grid, organized by **payer → form type → recipient rows** with an amount column per box.

**How to use it:**
1. Pick the **payer**, **tax year**, and **form type** at the top.
2. Each recipient is a row; type amounts into the box columns.
3. It's **ten-key friendly** — **Enter advances down the column** like Tab, and amounts **commit on blur/Enter**.
4. **+ Recipient row** adds a recipient inline (with vault lookup). **Rollforward** brings prior-year recipients into the current year.

**Filing actions (top bar):** advance selected records **Mark ready → Queue**, revert to **Draft**, or **Transmit queued** for this payer. These map to the [status lifecycle](overview.md#the-form-status-lifecycle).

**Good to know:**
- **Sub-threshold amounts warn but never block** — you can always file a small amount; the warning is just a heads-up against the federal threshold for that form/year.
- Amounts are stored to the cent; there's no rounding.
- Only **draft/ready** records can be deleted; once queued/transmitted, use the status buttons or [Corrections](corrections.md).

---

## Client review queue
**Sidebar:** Season → **Client review queue**

**What it's for:** approving the amounts clients entered through the [client portal](client-invites-and-portal.md) before they're filed.

**How to use it:**
- Client submissions appear here as **draft, client-submitted** records.
- Review each payer's numbers, edit if needed, then advance them into your normal flow (**ready → queued**).
- Filter/search by payer, form type, or recipient; the queue paginates for large volumes.

**Tip:** Nothing a client submits is filed automatically — it always waits here for a person to approve it.
