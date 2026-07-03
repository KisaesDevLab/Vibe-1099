-- §7216 disclosure acknowledgment for the Tax1099 (Zenwork) backend, plus the
-- CHECK constraints that 0003 omitted (every other enum column carries one).

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS tax1099_disclosure_ack_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax1099_disclosure_ack_by uuid;

-- Constrain the provider/environment enums so a raw insert can't smuggle an
-- unknown value that the app would silently route to the IRIS branch.
ALTER TABLE firms
  DROP CONSTRAINT IF EXISTS firms_filing_provider_ck,
  ADD CONSTRAINT firms_filing_provider_ck CHECK (filing_provider IN ('iris', 'tax1099'));
ALTER TABLE firms
  DROP CONSTRAINT IF EXISTS firms_tax1099_environment_ck,
  ADD CONSTRAINT firms_tax1099_environment_ck CHECK (tax1099_environment IN ('sandbox', 'production'));

ALTER TABLE payers
  DROP CONSTRAINT IF EXISTS payers_filing_provider_override_ck,
  ADD CONSTRAINT payers_filing_provider_override_ck
    CHECK (filing_provider_override IS NULL OR filing_provider_override IN ('iris', 'tax1099'));

ALTER TABLE transmissions
  DROP CONSTRAINT IF EXISTS transmissions_provider_ck,
  ADD CONSTRAINT transmissions_provider_ck CHECK (provider IN ('iris', 'tax1099'));

-- Append-only hardening for audit_log: the 0001 row trigger blocks UPDATE/DELETE
-- but row triggers do NOT fire on TRUNCATE. Add a statement-level guard so the
-- table can't be wiped wholesale (tamper-resistance — FTC Safeguards 314.4(c)).
CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
