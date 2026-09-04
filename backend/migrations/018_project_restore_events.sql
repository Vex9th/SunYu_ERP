CREATE TABLE project_restore_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE RESTRICT,
    from_closure_type TEXT
        CHECK (
            from_closure_type IS NULL
            OR from_closure_type IN ('cancelled', 'completed')
        ),
    from_archive_reason TEXT,
    from_archived_at TEXT NOT NULL,
    restore_reason TEXT NOT NULL CHECK (length(trim(restore_reason)) > 0),
    expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
    resulting_revision INTEGER NOT NULL CHECK (
        resulting_revision = expected_revision + 1
    ),
    created_at TEXT NOT NULL,
    UNIQUE (project_id, resulting_revision)
);

CREATE INDEX idx_project_restore_events_project_created
    ON project_restore_events(project_id, created_at DESC, id DESC);

CREATE TRIGGER project_restore_events_immutable_update
BEFORE UPDATE ON project_restore_events
BEGIN
    SELECT RAISE(ABORT, 'project restore events are immutable');
END;

CREATE TRIGGER project_restore_events_immutable_delete
BEFORE DELETE ON project_restore_events
BEGIN
    SELECT RAISE(ABORT, 'project restore events are immutable');
END;
