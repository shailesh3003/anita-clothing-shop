BEGIN;
ALTER TABLE inventory_products
  ADD COLUMN removed_at TIMESTAMPTZ,
  ADD COLUMN removed_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN removal_reason TEXT,
  ADD CONSTRAINT inventory_removal_state CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL) OR
    (removed_at IS NOT NULL AND removed_by IS NOT NULL AND length(trim(removal_reason)) BETWEEN 3 AND 300 AND NOT is_active)
  );
CREATE INDEX inventory_products_removed_idx ON inventory_products (removed_at) WHERE removed_at IS NOT NULL;
COMMIT;
