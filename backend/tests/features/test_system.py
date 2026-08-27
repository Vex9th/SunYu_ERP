from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock
from typing import Any

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

    def snapshot(self) -> dict[str, object]:
        return {
            "alive": False,
            "last_error_at": None,
            "last_error_code": None,
        }


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
        "scheduler": {
            "alive": False,
            "last_error_at": None,
            "last_error_code": None,
        },
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
                "directory": "  Synology/ERP  ",
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
    assert persisted["backup_dir"] == "Synology/ERP"


def test_backup_settings_rejects_projects_child_without_file_or_state_change(
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
        before = config_path.read_bytes()
        response = client.put(
            "/api/system/backup-settings",
            json={
                "directory": "Data/Projects/Backups",
                "interval_hours": 12,
                "retention_days": 90,
            },
        )
        overview = client.get("/api/system/overview")

    assert response.status_code == 422
    assert config_path.read_bytes() == before
    assert overview.json()["backup"]["enabled"] is False


def test_concurrent_backup_updates_keep_file_and_runtime_consistent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = create_app(
        config_path=config_path,
        scheduler_factory=_noop_scheduler_factory,
    )
    original_update = system_module.update_backup_settings
    first_write_complete = Event()
    second_request_complete = Event()
    call_lock = Lock()
    call_count = 0

    def delayed_update(*args, **kwargs) -> Settings:
        nonlocal call_count
        with call_lock:
            call_index = call_count
            call_count += 1
        updated = original_update(*args, **kwargs)
        if call_index == 0:
            first_write_complete.set()
            second_request_complete.wait(timeout=0.25)
        return updated

    monkeypatch.setattr(system_module, "update_backup_settings", delayed_update)
    first_payload = {
        "directory": "Synology/First",
        "interval_hours": 12,
        "retention_days": 60,
    }
    second_payload = {
        "directory": "Synology/Second",
        "interval_hours": 48,
        "retention_days": 120,
    }

    with TestClient(application) as owner:
        _login(owner)
        cookie = owner.cookies.get("sunyu_session")
        assert cookie is not None
        first_client = TestClient(application)
        second_client = TestClient(application)
        first_client.cookies.set("sunyu_session", cookie)
        second_client.cookies.set("sunyu_session", cookie)
        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(
                first_client.put,
                "/api/system/backup-settings",
                json=first_payload,
            )
            assert first_write_complete.wait(timeout=5)
            second_response = second_client.put(
                "/api/system/backup-settings",
                json=second_payload,
            )
            second_request_complete.set()
            first_response = first_future.result(timeout=5)
        overview = owner.get("/api/system/overview")

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    runtime = overview.json()["backup"]
    assert runtime["directory"] == str(
        (config_path.parent / persisted["backup_dir"]).resolve()
    )
    assert runtime["interval_hours"] == persisted["backup_interval_hours"]
    assert runtime["retention_days"] == persisted["backup_retention_days"]


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


def test_manual_backup_returns_success_warning_when_cleanup_fails(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    secret = "secret-from-prune-failure"
    _write_config(config_path, backup_dir="Synology/Backups")

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
        backup_pruner=fail_prune,
        scheduler_factory=_noop_scheduler_factory,
    )

    with TestClient(application) as client:
        _login(client)
        response = client.post("/api/system/backups")

    assert response.status_code == 201
    assert response.json()["warning"] == "Backup created but cleanup failed"
    assert secret not in response.text
    backup_path = Path(response.json()["path"])
    assert backup_path.is_dir()
    connection = connect_database(tmp_path / "Data" / "iapm.sqlite")
    try:
        run = connection.execute(
            "SELECT status, target_path FROM backup_runs ORDER BY id DESC"
        ).fetchone()
    finally:
        connection.close()
    assert tuple(run) == ("success", str(backup_path))


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
    ) -> system_module.BackupJobResult:
        calls.append(now)
        _record_success(connection, now)
        return system_module.BackupJobResult(Path("/managed/backup"))

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
        runner=lambda connection, settings, now: (
            calls.append(now)
            or system_module.BackupJobResult(Path("/managed/backup"))
        ),
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
    ) -> system_module.BackupJobResult:
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


def test_scheduler_rechecks_due_after_cooldown_and_honors_manual_success(
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
    ) -> system_module.BackupJobResult:
        calls.append(now)
        raise RuntimeError("private creator failure")

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=fail,
        clock=clock,
    )
    assert scheduler.run_cycle() is False

    manual = connect_database(settings.data_dir / "iapm.sqlite")
    try:
        _record_success(manual, NOW + timedelta(minutes=30))
    finally:
        manual.close()
    clock.advance(timedelta(hours=1))

    assert scheduler.run_cycle() is False
    assert calls == [NOW]


def test_scheduler_snapshot_updates_and_clears_after_success(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    clock = MutableClock()
    attempts = 0

    def runner(
        connection: sqlite3.Connection,
        _: Settings,
        now: datetime,
    ) -> system_module.BackupJobResult:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("private creator failure")
        _record_success(connection, now)
        return system_module.BackupJobResult(Path("/managed/backup"))

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=runner,
        clock=clock,
    )

    assert scheduler.run_cycle() is False
    failed = scheduler.snapshot()
    assert failed["last_error_at"] == NOW.isoformat()
    assert failed["last_error_code"] == "backup:RuntimeError"
    clock.advance(timedelta(hours=1))
    assert scheduler.run_cycle() is True
    recovered = scheduler.snapshot()
    assert recovered["last_error_at"] is None
    assert recovered["last_error_code"] is None


def test_scheduler_does_not_recreate_after_cleanup_warning(
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
    ) -> system_module.BackupJobResult:
        calls.append(now)
        _record_success(connection, now)
        return system_module.BackupJobResult(
            Path("/managed/backup"),
            warning="Backup created but cleanup failed",
            cleanup_error_code="cleanup:OSError",
        )

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=fail_after_recording_success,
        clock=clock,
    )

    assert scheduler.run_cycle() is True
    clock.advance(timedelta(hours=1))
    assert scheduler.run_cycle() is False
    assert calls == [NOW]
    assert scheduler.snapshot()["last_error_code"] == "cleanup:OSError"


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
    ) -> system_module.BackupJobResult:
        seen.append(settings)
        _record_success(connection, now)
        return system_module.BackupJobResult(Path("/managed/backup"))

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
    ) -> system_module.BackupJobResult:
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


def test_scheduler_stop_is_bounded_for_blocked_runner_and_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    entered = Event()
    release = Event()

    def blocked_runner(
        _: sqlite3.Connection,
        __: Settings,
        ___: datetime,
    ) -> system_module.BackupJobResult:
        entered.set()
        release.wait(timeout=5)
        return system_module.BackupJobResult(Path("/managed/backup"))

    monkeypatch.setattr(system_module, "_SCHEDULER_STOP_TIMEOUT_SECONDS", 0.01)
    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=blocked_runner,
    )
    scheduler.start()
    assert entered.wait(timeout=5)

    with pytest.raises(RuntimeError) as raised:
        scheduler.stop()

    assert str(raised.value) == "Backup scheduler did not stop"
    release.set()
    scheduler.stop()
    scheduler.stop()
    assert scheduler.is_alive is False


def test_scheduler_stop_is_bounded_for_blocked_waiter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path, backup_enabled=False)
    connection = _database(settings)
    connection.close()
    entered = Event()
    release = Event()

    def blocked_waiter(_: Event, __: float) -> bool:
        entered.set()
        release.wait(timeout=5)
        return True

    monkeypatch.setattr(system_module, "_SCHEDULER_STOP_TIMEOUT_SECONDS", 0.01)
    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=lambda connection, current, now: system_module.BackupJobResult(
            Path("/unused")
        ),
        wait=blocked_waiter,
    )
    scheduler.start()
    assert entered.wait(timeout=5)

    with pytest.raises(RuntimeError, match="^Backup scheduler did not stop$"):
        scheduler.stop()

    release.set()
    scheduler.stop()


def test_scheduler_close_failure_is_observable_without_recreating_backup(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    connection.close()
    clock = MutableClock()
    calls: list[datetime] = []

    def connection_factory(path: str | Path) -> _CloseFailConnection:
        return _CloseFailConnection(connect_database(path))

    def runner(
        connection: sqlite3.Connection,
        _: Settings,
        now: datetime,
    ) -> system_module.BackupJobResult:
        calls.append(now)
        _record_success(connection, now)
        return system_module.BackupJobResult(Path("/managed/backup"))

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connection_factory,
        runner=runner,
        clock=clock,
    )

    assert scheduler.run_cycle() is True
    assert scheduler.snapshot()["last_error_code"] == "connection_close:OSError"
    clock.advance(timedelta(hours=1))
    assert scheduler.run_cycle() is False
    assert calls == [NOW]


def test_scheduler_waiter_failure_is_observable_without_error_text(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    settings = _settings(tmp_path, backup_enabled=False)
    connection = _database(settings)
    connection.close()
    waiter_called = Event()
    secret = "private waiter failure"

    def fail_waiter(_: Event, __: float) -> bool:
        waiter_called.set()
        raise OSError(secret)

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=lambda connection, current, now: system_module.BackupJobResult(
            Path("/unused")
        ),
        wait=fail_waiter,
    )
    scheduler.start()
    assert waiter_called.wait(timeout=5)
    scheduler.stop()

    snapshot = scheduler.snapshot()
    captured = capsys.readouterr()
    assert snapshot["last_error_code"] == "waiter:OSError"
    assert snapshot["last_error_at"] is not None
    assert secret not in captured.out
    assert secret not in captured.err


@pytest.mark.parametrize(
    "finished_at",
    [
        "not-a-timestamp",
        (NOW + timedelta(days=1)).isoformat(),
        NOW.replace(tzinfo=None).isoformat(),
    ],
)
def test_scheduler_treats_invalid_or_future_success_time_as_due(
    tmp_path: Path,
    finished_at: str,
) -> None:
    settings = _settings(tmp_path)
    connection = _database(settings)
    try:
        connection.execute(
            """
            INSERT INTO backup_runs
                (started_at, finished_at, status, target_path, error_message)
            VALUES (?, ?, 'success', '/managed/backup', NULL)
            """,
            (NOW.isoformat(), finished_at),
        )
    finally:
        connection.close()
    calls: list[datetime] = []

    def runner(
        _: sqlite3.Connection,
        __: Settings,
        now: datetime,
    ) -> system_module.BackupJobResult:
        calls.append(now)
        return system_module.BackupJobResult(Path("/managed/new-backup"))

    scheduler = system_module.BackupScheduler(
        system_module.SettingsStore(settings),
        connection_factory=connect_database,
        runner=runner,
        clock=MutableClock(),
    )

    assert scheduler.run_cycle() is True
    assert calls == [NOW]
    assert scheduler.snapshot()["last_error_code"] == "schedule:ValueError"


class _CloseFailConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def close(self) -> None:
        self._connection.close()
        raise OSError("private close failure")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)
