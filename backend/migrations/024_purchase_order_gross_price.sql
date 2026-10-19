ALTER TABLE purchase_order_lines
ADD COLUMN gross_unit_cost_cents INTEGER
    CHECK (gross_unit_cost_cents IS NULL OR (
        typeof(gross_unit_cost_cents) = 'integer' AND gross_unit_cost_cents >= 0
    ));
