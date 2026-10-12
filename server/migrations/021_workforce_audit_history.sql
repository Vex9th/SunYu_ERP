ALTER TABLE labor_entries RENAME TO labor_entries_legacy;

CREATE TABLE labor_entries (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    assignment_id INTEGER NOT NULL
        REFERENCES crew_assignments(id) ON DELETE RESTRICT,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
    replaces_entry_id INTEGER REFERENCES labor_entries(id) ON DELETE RESTRICT,
    work_date TEXT NOT NULL,
    attendance_status TEXT NOT NULL
        CHECK (attendance_status IN ('present', 'absent', 'leave')),
    day_fraction_milli INTEGER,
    work_minutes INTEGER,
    pay_basis TEXT NOT NULL CHECK (pay_basis IN ('daily', 'hourly')),
    rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
    cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
    work_summary TEXT CHECK (
        work_summary IS NULL OR length(trim(work_summary)) > 0
    ),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (
            attendance_status = 'present'
            AND pay_basis = 'daily'
            AND day_fraction_milli BETWEEN 1 AND 1000
            AND work_minutes IS NULL
        )
        OR
        (
            attendance_status = 'present'
            AND pay_basis = 'hourly'
            AND day_fraction_milli IS NULL
            AND work_minutes BETWEEN 1 AND 1440
        )
        OR
        (
            attendance_status IN ('absent', 'leave')
            AND day_fraction_milli IS NULL
            AND work_minutes IS NULL
            AND cost_cents = 0
        )
    ),
    CHECK (
        (status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
        OR
        (status = 'voided' AND void_reason IS NOT NULL AND voided_at IS NOT NULL)
    )
);

INSERT INTO labor_entries (
    id, project_id, assignment_id, worker_id, replaces_entry_id, work_date,
    attendance_status, day_fraction_milli, work_minutes, pay_basis, rate_cents,
    cost_cents, work_summary, notes, status, void_reason, voided_at, revision,
    created_at, updated_at
)
SELECT
    id, project_id, assignment_id, worker_id, NULL, work_date,
    attendance_status, day_fraction_milli, work_minutes, pay_basis, rate_cents,
    cost_cents, work_summary, notes, status, void_reason, voided_at, revision,
    created_at, updated_at
FROM labor_entries_legacy;

DROP TABLE labor_entries_legacy;

CREATE INDEX idx_labor_project_date
    ON labor_entries(project_id, work_date DESC, id DESC);
CREATE INDEX idx_labor_worker_date
    ON labor_entries(worker_id, work_date DESC, id DESC);
CREATE UNIQUE INDEX uq_labor_active_assignment_date
    ON labor_entries(assignment_id, work_date) WHERE status = 'active';
CREATE UNIQUE INDEX uq_labor_active_project_worker_date
    ON labor_entries(project_id, worker_id, work_date) WHERE status = 'active';

CREATE TRIGGER labor_entries_voided_no_update
BEFORE UPDATE ON labor_entries
WHEN OLD.status = 'voided'
BEGIN
    SELECT RAISE(ABORT, 'voided labor entry is immutable');
END;

CREATE TRIGGER labor_entries_voided_no_delete
BEFORE DELETE ON labor_entries
WHEN OLD.status = 'voided'
BEGIN
    SELECT RAISE(ABORT, 'voided labor entry is immutable');
END;

CREATE TRIGGER labor_entries_replacement_must_match
BEFORE INSERT ON labor_entries
WHEN NEW.replaces_entry_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM labor_entries replaced
        WHERE replaced.id = NEW.replaces_entry_id
          AND replaced.status = 'voided'
          AND replaced.project_id = NEW.project_id
          AND replaced.worker_id = NEW.worker_id
          AND replaced.work_date = NEW.work_date
    ) THEN RAISE(ABORT, 'replacement must reference matching voided labor entry') END;
END;

CREATE TRIGGER labor_entries_replacement_identity_no_update
BEFORE UPDATE OF project_id, assignment_id, worker_id, work_date, replaces_entry_id
ON labor_entries
WHEN OLD.replaces_entry_id IS NOT NULL
  AND (
      NEW.project_id IS NOT OLD.project_id
      OR NEW.assignment_id IS NOT OLD.assignment_id
      OR NEW.worker_id IS NOT OLD.worker_id
      OR NEW.work_date IS NOT OLD.work_date
      OR NEW.replaces_entry_id IS NOT OLD.replaces_entry_id
  )
BEGIN
    SELECT RAISE(ABORT, 'replacement labor identity is immutable');
END;

CREATE TRIGGER labor_entries_replacement_update_must_match
BEFORE UPDATE ON labor_entries
WHEN OLD.replaces_entry_id IS NULL AND NEW.replaces_entry_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM labor_entries replaced
        WHERE replaced.id = NEW.replaces_entry_id
          AND replaced.status = 'voided'
          AND replaced.project_id = NEW.project_id
          AND replaced.worker_id = NEW.worker_id
          AND replaced.work_date = NEW.work_date
    ) THEN RAISE(ABORT, 'replacement must reference matching voided labor entry') END;
END;

CREATE TABLE site_daily_report_versions (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    report_id INTEGER NOT NULL REFERENCES site_daily_reports(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    work_date TEXT NOT NULL,
    location TEXT,
    weather TEXT,
    work_summary TEXT,
    blockers TEXT,
    next_plan TEXT,
    notes TEXT,
    confirmed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (report_id, version_number)
);

CREATE INDEX idx_site_report_versions_report
    ON site_daily_report_versions(report_id, version_number DESC);

ALTER TABLE site_daily_report_events
    ADD COLUMN report_version_id INTEGER
        REFERENCES site_daily_report_versions(id) ON DELETE RESTRICT;

INSERT INTO site_daily_report_versions (
    project_id, report_id, version_number, work_date, location, weather,
    work_summary, blockers, next_plan, notes, confirmed_at, created_at
)
SELECT
    project_id, id,
    MAX(1, (
        SELECT COUNT(*)
        FROM site_daily_report_events event
        WHERE event.report_id = site_daily_reports.id
          AND event.to_status = 'confirmed'
    )),
    work_date, location, weather, work_summary, blockers,
    next_plan, notes, confirmed_at, updated_at
FROM site_daily_reports
WHERE status = 'confirmed';

UPDATE site_daily_report_events
SET report_version_id = (
    SELECT version.id
    FROM site_daily_report_versions version
    WHERE version.report_id = site_daily_report_events.report_id
      AND version.project_id = site_daily_report_events.project_id
)
WHERE site_daily_report_events.id = (
    SELECT MAX(latest_event.id)
    FROM site_daily_report_events latest_event
    WHERE latest_event.report_id = site_daily_report_events.report_id
      AND latest_event.project_id = site_daily_report_events.project_id
      AND latest_event.to_status = 'confirmed'
);

CREATE TRIGGER site_daily_report_versions_no_update
BEFORE UPDATE ON site_daily_report_versions
BEGIN
    SELECT RAISE(ABORT, 'report version is immutable');
END;

CREATE TRIGGER site_daily_report_versions_no_delete
BEFORE DELETE ON site_daily_report_versions
BEGIN
    SELECT RAISE(ABORT, 'report version is immutable');
END;

CREATE TRIGGER site_daily_report_events_no_update
BEFORE UPDATE ON site_daily_report_events
BEGIN
    SELECT RAISE(ABORT, 'report event is immutable');
END;

CREATE TRIGGER site_daily_report_events_no_delete
BEFORE DELETE ON site_daily_report_events
BEGIN
    SELECT RAISE(ABORT, 'report event is immutable');
END;

CREATE TRIGGER site_daily_report_events_version_required
BEFORE INSERT ON site_daily_report_events
WHEN NEW.report_version_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM site_daily_report_versions version
    WHERE version.id = NEW.report_version_id
      AND version.project_id = NEW.project_id
      AND version.report_id = NEW.report_id
)
BEGIN
    SELECT RAISE(ABORT, 'report event must reference matching report version');
END;
