-- Tax1099 filing-provider support: per-firm/per-payer backend selection + the
-- provider that owns each transmission. IRIS remains the default everywhere.

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS filing_provider text NOT NULL DEFAULT 'iris',
  ADD COLUMN IF NOT EXISTS tax1099_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS tax1099_environment text NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS tax1099_mailing boolean NOT NULL DEFAULT false;

ALTER TABLE payers
  ADD COLUMN IF NOT EXISTS filing_provider_override text;

ALTER TABLE transmissions
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'iris';
