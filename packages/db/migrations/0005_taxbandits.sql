-- TaxBandits (SPAN Enterprises) optional filing provider: per-firm credentials +
-- §7216 acknowledgment, provider-enum extension with affinity, cost ledger,
-- provider-tagged TIN matching, and webhook event store.

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS taxbandits_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS taxbandits_client_id_encrypted text,
  ADD COLUMN IF NOT EXISTS taxbandits_client_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS taxbandits_user_token_encrypted text,
  ADD COLUMN IF NOT EXISTS taxbandits_environment text NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS taxbandits_postal_mailing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS taxbandits_online_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS taxbandits_low_credit_cents integer NOT NULL DEFAULT 2500,
  ADD COLUMN IF NOT EXISTS taxbandits_disclosure_ack_at timestamptz,
  ADD COLUMN IF NOT EXISTS taxbandits_disclosure_ack_by uuid;

-- Extend the provider enums to admit 'taxbandits' (the 0004 CHECKs allowed only
-- iris/tax1099).
ALTER TABLE firms
  DROP CONSTRAINT IF EXISTS firms_filing_provider_ck,
  ADD CONSTRAINT firms_filing_provider_ck CHECK (filing_provider IN ('iris', 'tax1099', 'taxbandits'));
ALTER TABLE firms
  DROP CONSTRAINT IF EXISTS firms_taxbandits_environment_ck,
  ADD CONSTRAINT firms_taxbandits_environment_ck CHECK (taxbandits_environment IN ('sandbox', 'production'));
ALTER TABLE payers
  DROP CONSTRAINT IF EXISTS payers_filing_provider_override_ck,
  ADD CONSTRAINT payers_filing_provider_override_ck
    CHECK (filing_provider_override IS NULL OR filing_provider_override IN ('iris', 'tax1099', 'taxbandits'));
ALTER TABLE transmissions
  DROP CONSTRAINT IF EXISTS transmissions_provider_ck,
  ADD CONSTRAINT transmissions_provider_ck CHECK (provider IN ('iris', 'tax1099', 'taxbandits'));

CREATE TABLE IF NOT EXISTS taxbandits_cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  payer_id uuid,
  transmission_id uuid,
  form_record_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('efile','correction','void','state_filing','tin_match','postal','online_access')),
  amount_cents integer NOT NULL DEFAULT 0,
  balance_after_cents integer,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tb_cost_ledger_firm_idx ON taxbandits_cost_ledger (firm_id, created_at);

CREATE TABLE IF NOT EXISTS tin_match_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  recipient_id uuid NOT NULL REFERENCES recipients(id),
  provider text NOT NULL CHECK (provider IN ('taxbandits','irs')),
  status text NOT NULL CHECK (status IN ('match','mismatch','pending','error')),
  code text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now(),
  stale boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS tin_match_recipient_idx ON tin_match_results (recipient_id, checked_at);

CREATE TABLE IF NOT EXISTS taxbandits_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  event_type text NOT NULL,
  submission_id text,
  record_id text,
  status text,
  payload jsonb,
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tb_webhook_dedupe_uq ON taxbandits_webhook_events (dedupe_key);
