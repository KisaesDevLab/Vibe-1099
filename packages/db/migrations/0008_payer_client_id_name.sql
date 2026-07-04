-- Payer external client ID + individual name parts (first/last). legalName stays
-- the name-of-record (derived from first+last for individual payers).
ALTER TABLE payers
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

CREATE INDEX IF NOT EXISTS payers_client_id_idx ON payers (firm_id, client_id);
