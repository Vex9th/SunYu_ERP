CREATE TABLE crew_assignment_transition_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    assignment_id INTEGER NOT NULL
        REFERENCES crew_assignments(id) ON DELETE RESTRICT,
    from_status TEXT NOT NULL
        CHECK (from_status IN ('planned', 'active', 'completed', 'cancelled')),
    to_status TEXT NOT NULL
        CHECK (to_status IN ('planned', 'active', 'completed', 'cancelled')),
    effective_at TEXT NOT NULL,
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
    created_at TEXT NOT NULL,
    CHECK (from_status <> to_status)
);

CREATE INDEX idx_crew_assignment_transition_events_assignment
    ON crew_assignment_transition_events(assignment_id, effective_at, id);

CREATE INDEX idx_crew_assignment_transition_events_project
    ON crew_assignment_transition_events(project_id, effective_at, id);

CREATE TRIGGER crew_assignment_transition_events_no_update
BEFORE UPDATE ON crew_assignment_transition_events
BEGIN
    SELECT RAISE(ABORT, 'crew assignment transition events are immutable');
END;

CREATE TRIGGER crew_assignment_transition_events_no_delete
BEFORE DELETE ON crew_assignment_transition_events
BEGIN
    SELECT RAISE(ABORT, 'crew assignment transition events are immutable');
END;
