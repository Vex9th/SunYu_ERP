CREATE TRIGGER project_stage_events_require_unblock_reason
BEFORE INSERT ON project_stage_events
WHEN NEW.from_status = 'blocked'
    AND NEW.to_status = 'in_progress'
    AND (
        NEW.reason IS NULL
        OR length(trim(NEW.reason)) = 0
    )
BEGIN
    SELECT RAISE(ABORT, 'blocked stage reopen reason is required');
END;

CREATE TRIGGER project_stage_events_no_update
BEFORE UPDATE ON project_stage_events
BEGIN
    SELECT RAISE(ABORT, 'project stage events are immutable');
END;

CREATE TRIGGER project_stage_events_no_delete
BEFORE DELETE ON project_stage_events
BEGIN
    SELECT RAISE(ABORT, 'project stage events are immutable');
END;
