CREATE TABLE schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE auth_secret (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    target_path TEXT NOT NULL,
    error_message TEXT
);
