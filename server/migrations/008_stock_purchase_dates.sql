BEGIN;
-- Recording time is not evidence of the actual purchase date for old stock.
ALTER TABLE inventory_movements ADD COLUMN purchase_date DATE;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movement_purchase_date CHECK (
  purchase_date IS NULL OR (kind IN ('OPENING','RECEIPT') AND quantity_delta>0 AND purchase_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
CREATE INDEX inventory_movements_purchase_date_idx ON inventory_movements(product_id,purchase_date DESC)
  WHERE purchase_date IS NOT NULL;
COMMIT;
