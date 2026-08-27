from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features import system as system_module
from backend.app.main import create_app

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 28, 8, 30, tzinfo=timezone.utc)


@dataclass
class MutableClock:
    value: datetime = NOW

    def __call__(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta) -> None:
        self.value += delta


class NoopScheduler:
    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


def _noop_scheduler_factory(**_: object) -> NoopScheduler:
    return NoopScheduler()


def _write_config(config_path: Path, **overrides: object) -> None:
    payload = {
        "data_dir": "Data",
        "session_secret": "test-session-secret-with-at-least-32-bytes",
        **overrides,
    }
    config_path.write_text(json.dumps(payload), encoding="utf-8")


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/setup", json={"password": "123456"}).status_code == 204
    assert client.post("/api/auth/login", json={"password": "123456"}).status_code == 204


def _settings(tmp_path: Path, *, backup_enabled: bool = True) -> Settings:
    return Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path / "Data",
        backup_dir=(tmp_path / "Synology") if backup_enabled else None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="0.0.0.0",
        port=8765,
        session_secret="test-session-secret-with-at-least-32-bytes",
    )


def _database(settings: Settings) -> sqlite3.Connection:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    connection = connect_database(settings.data_dir / "iapm.sqlite")
    apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
    return connection


def _record_success(
    connection: sqlite3.Connection,
    finished_at: datetime,
) -> None:
    connection.execute(
        """
        INSERT INTO backup_runs
            (started_at, finished_at, status, target_path, error_message)
        VALUES (?, ?, 'success', ?, NULL)
        """,
        (
            (finished_at - timedelta(seconds=1)).isoformat(),
            finished_at.isoformat(),
            "/managed/backup",
        ),
    )


def test_overview_returns_paths_backup_settings_and_latest_run(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        first = client.get("/api/system/overview")
        connection = connect_database(tmp_path / "Data" / "iapm.sqlite")
        try:
            connection.execute(
                """
                INSERT INTO backup_runs
                    (started_at, finished_at, status, target_path, error_message)
                VALUES (?, ?, 'failed', ?, ?)
                """,
                (
                    "2026-08-28T08:00:00+00:00",
                    "2026-08-28T08:00:01+00:00",
                    "/failed/target",
                    "copy failed",
                ),
            )
        finally:
            connection.close()
        second = client.get("/api/system/overview")

    assert first.json() == {
        "data_directory": str((tmp_path / "Data").resolve()),
        "database_path": str((tmp_path / "Data" / "iapm.sqlite").resolve()),
        "backup": {
            "enabled": False,
            "directory": None,
            "interval_hours": 24,
            "retention_days": 30,
            "last_run": None,
        },
    }
    assert second.json()["backup"]["last_run"] == {
        "status": "failed",
        "started_at": "2026-08-28T08:00:00+00:00",
        "finished_at": "2026-08-28T08:00:01+00:00",
        "target_path": "/failed/target",
        "error_message": "copy failed",
    }


def test_backup_settings_endpoint_updates_file_and_runtime_atomically(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path, host="127.0.0.1", port=9000)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        response = client.put(
            "/api/system/backup-settings",
            json={
                "directory": "Synology/ERP",
                "interval_hours": 12,
                "retention_days": 90,
            },
        )
        overview = client.get("/api/system/overview")

    expected_directory = str((tmp_path / "Synology/ERP").resolve())
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "directory": expected_directory,
        "interval_hours": 12,
        "retention_days": 90,
    }
    assert overview.json()["backup"] == {
        **response.json(),
        "last_run": None,
    }
    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["session_secret"] == (
        "test-session-secret-with-at-least-32-bytes"
    )
    assert persisted["host"] == "127.0.0.1"
    assert persisted["port"] == 9000


def test_every_system_endpoint_requires_authentication_before_body_validation(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        overview = client.get("/api/system/overview")
        update = client.put("/api/system/backup-settings", json={})
        backup = client.post("/api/system/backups")

    assert overview.status_code == 401
    assert update.status_code == 401
    assert backup.status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"directory": None, "interval_hours": 24},
        {
            "directory": None,
            "interval_hours": 24,
            "retention_days": 30,
            "extra": True,
        },
        {"directory": "", "interval_hours": 24, "retention_days": 30},
        {"directory": "   ", "interval_hours": 24, "retention_days": 30},
        {"directory": 42, "interval_hours": 24, "retention_days": 30},
        {"directory": None, "interval_hours": True, "retention_days": 30},
        {"directory": None, "interval_hours": 0, "retention_days": 30},
        {"directory": None, "interval_hours": 8761, "retention_days": 30},
        {"directory": None, "interval_hours": 24, "retention_days": False},
        {"directory": None, "interval_hours": 24, "retention_days": -1},
        {"directory": None, "interval_hours": 24, "retention_days": 3651},
        [],
    ],
)
def test_backup_settings_endpoint_rejects_non_contract_payload_without_writing(
    tmp_path: Path,
    payload: object,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    original = config_path.read_bytes()
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        response = client.put("/api/system/backup-settings", json=payload)

    assert response.status_code == 422
    assert config_path.read_bytes() == original


def test_manual_backup_requires_configured_directory(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        response = client.post("/api/system/backups")

    assert response.status_code == 409


def test_manual_backup_creates_verified_backup_and_returns_database_time(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        assert client.put(
            "/api/system/backup-settings",
            json={
                "directory": "Synology/Backups",
                "interval_hours": 24,
                "retention_days": 30,
            },
        ).status_code == 200
        response = client.post("/api/system/backups")

    assert response.status_code == 201
    body = response.json()
    backup_path = Path(body["path"])
    assert backup_path.is_dir()
    assert body["created_at"]
    connection = connect_database(tmp_path / "Data" / "iapm.sqlite")
    try:
        row = connection.execute(
            "SELECT started_at, status, target_path FROM backup_runs ORDER BY id DESC"
        ).fetchone()
    finally:
        connection.close()
    assert row["status"] == "success"
    assert row["target_path"] == str(backup_path)
    assert body["created_at"] == row["started_at"]


@pytest.mark.parametrize("failure_type", [RuntimeError, SystemExit, KeyboardInterrupt])
def test_manual_backup_failure_is_fixed_and_does_not_leak_internal_error(
    tmp_path: Path,
    failure_type: type[BaseException],
) -> None:
    config_path = tmp_path / "config.json"
    secret = "secret-from-inner-backup-failure"
    _write_config(config_path, backup_dir="Synology/Backups")

    def fail_backup(
        _: sqlite3.Connection,
        __: Settings,
        *,
        now: datetime | None = None,
    ) -> Path:
        del now
        raise failure_type(secret)

    application = create_app(
        config_path=config_path,
        backup_creator=fail_backup,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application, raise_server_exceptions=False) as client:
        _login(client)
        response = client.post("/api/system/backups")

    assert response.status_code == 503
    assert response.json() == {"detail": "Backup operation failed"}
    assert secret not in response.text


def test_manual_backup_reports_cleanup_failure_instead_of_false_success(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    secret = "secret-from-prune-failure"
    _write_config(config_path, backup_dir="Synology/Backups")

    def fake_create(
        _: sqlite3.Connection,
        settings: Settings,
        *,
        now: datetime | None = None,
    ) -> Path:
        del now
        assert settings.backup_dir is not None
        return settings.backup_dir / "2026-08-28_083000"

    def fail_prune(
        _: str | Path,
        __: int,
        *,
        now: datetime | None = None,
    ) -> list[Path]:
        del now
        raise OSError(secret)

    application = create_app(
        config_path=config_path,
        backup_creator=fake_create,
        backup_pruner=fail_prune,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        response = client.post("/api/system/backups")

    assert response.status_code == 503
    assert response.json() == {"detail": "Backup operation failed"}
    assert secret not in response.text


def test_scheduler_runs_when_never_successful_then_waits_for_interval(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    store = system_module.SettingsStore(settings)
    clock = MutableClock()
    calls: list[datetime] = []

    def runner(
        connection: sqlite3.Connection,
        _: Settings,
        now: datetime,
    ) -> Path:
        calls.append(now)
        _record_success(connection, now)
        return Path("/managed/backup")

    scheduler = system_module.BackupScheduler(
        store,
        connection_factory=connect_database,
        runner=runner,
        clock=clock,
    )

    assert scheduler.run_cycle() is True
    clock.advance(timedelta(hours=23, minutes=59))
    assert scheduler.run_cycle() is False
    clock.advance(timedelta(minutes=1))
    assert scheduler.run_cycle() is True
    assert calls == [NOW, NOW + timedelta(hours=24)]


def test_scheduler_uses_latest_success_and_ignores_newer_failure(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    try:
        _record_success(connection, NOW - timedelta(hours=2))
        connection.execute(
            """
            INSERT INTO backup_runs
                (started_at, finished_at, status, target_path, error_message)
            VALUES (?, ?, 'failed', '/failed', 'failed')
            """,
            (
                (NOW - timedelta(minutes=1)).isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()
    calls: list[datetime] = []
    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=lambda connection, settings, now: calls.append(now) or Path("/backup"),
        clock=MutableClock(),
    )

    assert scheduler.run_cycle() is False
    assert calls == []


def test_scheduler_failure_retries_only_after_bounded_cooldown(
    tmp_path: Path,
) -> None:
    settings = replace(_settings(tmp_path), backup_interval_hours=3)
    connection = _database(settings)
    connection.close()
    clock = MutableClock()
    calls: list[datetime] = []

    def fail(
        _: sqlite3.Connection,
        __: Settings,
        now: datetime,
    ) -> Path:
        calls.append(now)
        raise RuntimeError("private failure text")

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=fail,
        clock=clock,
    )

    assert scheduler.run_cycle() is False
    clock.advance(timedelta(minutes=59, seconds=59))
    assert scheduler.run_cycle() is False
    clock.advance(timedelta(seconds=1))
    assert scheduler.run_cycle() is False
    assert calls == [NOW, NOW + timedelta(hours=1)]


def test_scheduler_retries_full_job_after_prune_failure_even_with_new_success(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    clock = MutableClock()
    calls: list[datetime] = []

    def fail_after_recording_success(
        connection: sqlite3.Connection,
        _: Settings,
        now: datetime,
    ) -> Path:
        calls.append(now)
        _record_success(connection, now)
        raise OSError("prune failed")

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=fail_after_recording_success,
        clock=clock,
    )

    assert scheduler.run_cycle() is False
    clock.advance(timedelta(hours=1))
    assert scheduler.run_cycle() is False
    assert calls == [NOW, NOW + timedelta(hours=1)]


def test_scheduler_reads_refreshed_settings_on_each_cycle(tmp_path: Path) -> None:
    disabled = _settings(tmp_path, backup_enabled=False)
    connection = _database(disabled)
    connection.close()
    store = system_module.SettingsStore(disabled)
    seen: list[Settings] = []

    def runner(
        connection: sqlite3.Connection,
        settings: Settings,
        now: datetime,
    ) -> Path:
        seen.append(settings)
        _record_success(connection, now)
        return Path("/managed/backup")

    scheduler = system_module.BackupScheduler(
        store,
        connection_factory=connect_database,
        runner=runner,
        clock=MutableClock(),
    )

    assert scheduler.run_cycle() is False
    store.replace(replace(disabled, backup_dir=tmp_path / "new-backups"))
    assert scheduler.run_cycle() is True
    assert seen[0].backup_dir == tmp_path / "new-backups"


def test_scheduler_thread_survives_base_exception_and_stops_without_leak(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    called = Event()
    secret = "secret-from-scheduler-failure"

    def fail(
        _: sqlite3.Connection,
        __: Settings,
        ___: datetime,
    ) -> Path:
        called.set()
        raise SystemExit(secret)

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=fail,
    )

    scheduler.start()
    assert called.wait(timeout=5)
    scheduler.stop()

    captured = capsys.readouterr()
    assert scheduler.is_alive is False
    assert secret not in captured.out
    assert secret not in captured.err
