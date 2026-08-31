ALTER TABLE after_sales_cases ADD COLUMN is_under_warranty INTEGER NOT NULL DEFAULT 0
    CHECK (is_under_warranty IN (0, 1));

UPDATE after_sales_cases
SET is_under_warranty = 1
WHERE EXISTS (
    SELECT 1
    FROM warranties
    WHERE warranties.project_id = after_sales_cases.project_id
      AND warranties.starts_on <= after_sales_cases.reported_on
      AND warranties.ends_on >= after_sales_cases.reported_on
);

CREATE TABLE delivery_transition_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL
        CHECK (resource_type IN ('engineering_change', 'after_sales')),
    resource_id INTEGER NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    reason TEXT,
    resolution TEXT,
    created_at TEXT NOT NULL,
    CHECK (from_status <> to_status),
    CHECK (reason IS NULL OR length(trim(reason)) > 0),
    CHECK (resolution IS NULL OR length(trim(resolution)) > 0)
);

CREATE INDEX idx_delivery_transition_events_resource
    ON delivery_transition_events(resource_type, resource_id, effective_at, id);

CREATE TRIGGER delivery_transition_events_no_update
BEFORE UPDATE ON delivery_transition_events
BEGIN
    SELECT RAISE(ABORT, 'delivery transition events are immutable');
END;

CREATE TRIGGER delivery_transition_events_no_delete
BEFORE DELETE ON delivery_transition_events
BEGIN
    SELECT RAISE(ABORT, 'delivery transition events are immutable');
END;
