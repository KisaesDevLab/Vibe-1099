-- Assigned preparer: the staff user responsible for a payer. Nullable
-- (unassigned); list views across the app can filter by it.
ALTER TABLE payers ADD COLUMN IF NOT EXISTS preparer_id uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS payers_preparer_idx ON payers (firm_id, preparer_id);
