CREATE TABLE site_daily_report_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    report_id INTEGER NOT NULL REFERENCES site_daily_reports(id) ON DELETE RESTRICT,
    from_status TEXT NOT NULL CHECK (from_status IN ('draft', 'confirmed')),
    to_status TEXT NOT NULL CHECK (to_status IN ('draft', 'confirmed')),
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (from_status <> to_status),
    CHECK (to_status <> 'draft' OR reason IS NOT NULL)
);

CREATE INDEX idx_site_report_events_report
    ON site_daily_report_events(report_id, occurred_at, id);
