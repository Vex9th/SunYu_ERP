CREATE TABLE operation_events (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','system')),
    actor_id INTEGER,
    actor_name TEXT NOT NULL,
    group_id INTEGER,
    group_name TEXT,
    summary TEXT NOT NULL,
    reason TEXT,
    changes_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    UNIQUE(request_id,action,resource_type,resource_id)
);
CREATE TABLE operation_event_projects (
    event_id INTEGER NOT NULL REFERENCES operation_events(id),
    project_id INTEGER NOT NULL,
    PRIMARY KEY(event_id,project_id)
);
CREATE INDEX idx_operation_events_resource ON operation_events(resource_type,resource_id,id DESC);
CREATE INDEX idx_operation_events_request ON operation_events(request_id);
CREATE INDEX idx_operation_event_projects_project ON operation_event_projects(project_id,event_id);
CREATE TRIGGER operation_events_immutable_update BEFORE UPDATE ON operation_events
BEGIN SELECT RAISE(ABORT,'operation history is immutable'); END;
CREATE TRIGGER operation_events_immutable_delete BEFORE DELETE ON operation_events
BEGIN SELECT RAISE(ABORT,'operation history is immutable'); END;
CREATE TRIGGER operation_event_projects_immutable_update BEFORE UPDATE ON operation_event_projects
BEGIN SELECT RAISE(ABORT,'operation history is immutable'); END;
CREATE TRIGGER operation_event_projects_immutable_delete BEFORE DELETE ON operation_event_projects
BEGIN SELECT RAISE(ABORT,'operation history is immutable'); END;
