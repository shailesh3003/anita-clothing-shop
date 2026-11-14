BEGIN;
-- Previous selling prices are not purchase costs. Leave historical costs unknown.
ALTER TABLE inventory_products ALTER COLUMN selling_price DROP NOT NULL;
ALTER TABLE inventory_products ADD COLUMN purchase_cost NUMERIC(18,6) CHECK (purchase_cost IS NULL OR purchase_cost >= 0);
ALTER TABLE sale_items ADD COLUMN unit_cost NUMERIC(18,6) CHECK (unit_cost IS NULL OR unit_cost >= 0);
ALTER TABLE inventory_movements
  ADD COLUMN purchase_rate NUMERIC(12,2) CHECK (purchase_rate IS NULL OR purchase_rate >= 0),
  ADD COLUMN cost_before NUMERIC(18,6),
  ADD COLUMN cost_after NUMERIC(18,6);
COMMIT;
