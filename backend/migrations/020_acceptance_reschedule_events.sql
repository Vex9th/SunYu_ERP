CREATE TABLE acceptance_reschedule_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    acceptance_id INTEGER NOT NULL REFERENCES acceptances(id) ON DELETE RESTRICT,
    previous_acceptance_type TEXT NOT NULL,
    acceptance_type TEXT NOT NULL,
    previous_scheduled_on TEXT NOT NULL,
    scheduled_on TEXT NOT NULL,
    previous_notes TEXT,
    notes TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision = expected_revision + 1),
    created_at TEXT NOT NULL,
    UNIQUE (acceptance_id, resulting_revision)
);

CREATE INDEX idx_acceptance_reschedule_events_resource
    ON acceptance_reschedule_events(acceptance_id, created_at DESC, id DESC);

CREATE TRIGGER acceptance_reschedule_events_no_update
BEFORE UPDATE ON acceptance_reschedule_events
BEGIN
    SELECT RAISE(ABORT, 'acceptance reschedule events are immutable');
END;

CREATE TRIGGER acceptance_reschedule_events_no_delete
BEFORE DELETE ON acceptance_reschedule_events
BEGIN
    SELECT RAISE(ABORT, 'acceptance reschedule events are immutable');
END;
