-- Remove the licensing/activation feature. The project is MIT-licensed and there
-- is no runtime license gating, so the per-firm license columns are dropped.
ALTER TABLE firms DROP COLUMN IF EXISTS license_key;
ALTER TABLE firms DROP COLUMN IF EXISTS license_tier;
