ALTER TABLE acceptances ADD COLUMN cancel_reason TEXT
    CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) > 0);

ALTER TABLE acceptances ADD COLUMN cancelled_at TEXT;

UPDATE acceptances
SET cancel_reason = '历史取消记录（原因未记录）',
    cancelled_at = performed_on
WHERE status = 'cancelled';

CREATE TABLE acceptance_transition_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    acceptance_id INTEGER NOT NULL REFERENCES acceptances(id) ON DELETE RESTRICT,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at TEXT NOT NULL,
    CHECK (from_status <> to_status)
);

CREATE INDEX idx_acceptance_transition_events_resource
    ON acceptance_transition_events(acceptance_id, effective_on, id);

CREATE TRIGGER acceptance_transition_events_no_update
BEFORE UPDATE ON acceptance_transition_events
BEGIN
    SELECT RAISE(ABORT, 'acceptance transition events are immutable');
END;

CREATE TRIGGER acceptance_transition_events_no_delete
BEFORE DELETE ON acceptance_transition_events
BEGIN
    SELECT RAISE(ABORT, 'acceptance transition events are immutable');
END;
