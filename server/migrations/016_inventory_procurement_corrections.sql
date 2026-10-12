ALTER TABLE inventory_adjustments
ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reversed'));

ALTER TABLE inventory_adjustments
ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

ALTER TABLE inventory_adjustments
ADD COLUMN reversal_reason TEXT;

ALTER TABLE inventory_adjustments
ADD COLUMN reversed_at TEXT;

ALTER TABLE inventory_adjustments
ADD COLUMN reversal_movement_id INTEGER
    REFERENCES inventory_movements(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_inventory_adjustments_reversal_movement
    ON inventory_adjustments(reversal_movement_id)
    WHERE reversal_movement_id IS NOT NULL;
