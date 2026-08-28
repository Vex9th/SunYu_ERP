from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app import main as main_module
from backend.app.core.database import connect_database


def _write_config(config_path: Path, **overrides: object) -> None:
    config = {
        "data_dir": "Data",
        "session_secret": "test-session-secret-with-at-least-32-bytes",
        **overrides,
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/setup", json={"password": "123456"}).status_code == 204
    assert client.post("/api/auth/login", json={"password": "123456"}).status_code == 204


def test_create_app_defers_config_and_database_writes_until_lifespan(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    application = main_module.create_app(config_path=config_path)

    assert not config_path.exists()
    assert not (tmp_path / "Data").exists()

    with TestClient(application) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert config_path.is_file()
    assert (tmp_path / "Data" / "iapm.sqlite").is_file()


def test_lifespan_applies_migrations_and_closes_every_owned_connection(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    tracked: list[_TrackedConnection] = []

    def tracked_connect(path: str | Path) -> _TrackedConnection:
        connection = _TrackedConnection(connect_database(path))
        tracked.append(connection)
        return connection

    monkeypatch.setattr(main_module, "connect_database", tracked_connect)
    application = main_module.create_app(config_path=config_path)

    with TestClient(application) as client:
        _login(client)
        response = client.get("/api/system/overview")

    assert response.status_code == 200
    assert tracked
    assert all(connection.closed for connection in tracked)

    verifier = connect_database(tmp_path / "Data" / "iapm.sqlite")
    try:
        versions = {
            row[0]
            for row in verifier.execute("SELECT version FROM schema_migrations")
        }
    finally:
        verifier.close()
    assert versions == {
        "001_foundation",
        "002_documents",
        "003_companies_projects",
    }


def test_authentication_flow_guards_system_routes_and_reports_setup_state(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = main_module.create_app(config_path=config_path)

    with TestClient(application) as client:
        before_setup = client.get("/api/auth/session")
        unauthenticated = client.get("/api/system/overview")
        setup = client.post("/api/auth/setup", json={"password": "123456"})
        after_setup = client.get("/api/auth/session")
        login = client.post("/api/auth/login", json={"password": "123456"})
        authenticated = client.get("/api/auth/session")
        overview = client.get("/api/system/overview")
        logout = client.post("/api/auth/logout")
        after_logout = client.get("/api/system/overview")

    assert before_setup.json() == {
        "authenticated": False,
        "password_configured": False,
    }
    assert unauthenticated.status_code == 401
    assert setup.status_code == 204
    assert after_setup.json() == {
        "authenticated": False,
        "password_configured": True,
    }
    assert login.status_code == 204
    assert authenticated.json() == {
        "authenticated": True,
        "password_configured": True,
    }
    assert overview.status_code == 200
    assert logout.status_code == 204
    assert after_logout.status_code == 401


def test_create_app_mounts_authenticated_companies_router(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = main_module.create_app(config_path=config_path)

    with TestClient(application) as client:
        unauthenticated = client.get("/api/companies")
        _login(client)
        authenticated = client.get("/api/companies")

    assert unauthenticated.status_code == 401
    assert unauthenticated.json() == {"detail": "Authentication required"}
    assert authenticated.status_code == 200
    assert authenticated.json() == []


def test_partially_started_scheduler_is_stopped_without_masking_start_failure(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    start_failure = SystemExit("private start failure")
    scheduler = _LifecycleProbeScheduler(
        start_failure=start_failure,
        stop_failure=RuntimeError("private stop failure"),
    )
    application = main_module.create_app(
        config_path=config_path,
        scheduler_factory=lambda **_: scheduler,
    )

    async def start_lifespan() -> None:
        async with application.router.lifespan_context(application):
            pass

    with pytest.raises(SystemExit) as raised:
        asyncio.run(start_lifespan())

    assert raised.value is start_failure
    assert scheduler.start_calls == 1
    assert scheduler.stop_calls == 1
    assert start_failure.__notes__ == [
        "backup scheduler stop failed: RuntimeError"
    ]


def test_lifespan_primary_failure_survives_scheduler_stop_failure(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    scheduler = _LifecycleProbeScheduler(
        stop_failure=RuntimeError("private stop failure")
    )
    application = main_module.create_app(
        config_path=config_path,
        scheduler_factory=lambda **_: scheduler,
    )
    primary = KeyboardInterrupt("private lifespan failure")

    async def exercise_lifespan() -> None:
        async with application.router.lifespan_context(application):
            raise primary

    with pytest.raises(KeyboardInterrupt) as raised:
        asyncio.run(exercise_lifespan())

    assert raised.value is primary
    assert scheduler.stop_calls == 1
    assert primary.__notes__ == ["backup scheduler stop failed: RuntimeError"]


def test_migration_primary_failure_survives_connection_close_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    primary = SystemExit("private migration failure")
    tracked: list[_CloseFailTrackedConnection] = []

    def tracked_connect(path: str | Path) -> _CloseFailTrackedConnection:
        connection = _CloseFailTrackedConnection(connect_database(path))
        tracked.append(connection)
        return connection

    def fail_migrations(*_: object) -> None:
        raise primary

    monkeypatch.setattr(main_module, "connect_database", tracked_connect)
    monkeypatch.setattr(main_module, "apply_migrations", fail_migrations)
    application = main_module.create_app(config_path=config_path)

    async def start_lifespan() -> None:
        async with application.router.lifespan_context(application):
            pass

    with pytest.raises(SystemExit) as raised:
        asyncio.run(start_lifespan())

    assert raised.value is primary
    assert tracked[0].close_calls == 1
    assert primary.__notes__ == ["database connection close failed: OSError"]


class _TrackedConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self.closed = False

    def close(self) -> None:
        self._connection.close()
        self.closed = True

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _CloseFailTrackedConnection(_TrackedConnection):
    def __init__(self, connection: sqlite3.Connection) -> None:
        super().__init__(connection)
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        self._connection.close()
        raise OSError("private close failure")


class _LifecycleProbeScheduler:
    def __init__(
        self,
        *,
        start_failure: BaseException | None = None,
        stop_failure: BaseException | None = None,
    ) -> None:
        self.start_failure = start_failure
        self.stop_failure = stop_failure
        self.start_calls = 0
        self.stop_calls = 0

    def start(self) -> None:
        self.start_calls += 1
        if self.start_failure is not None:
            raise self.start_failure

    def stop(self) -> None:
        self.stop_calls += 1
        if self.stop_failure is not None:
            raise self.stop_failure

    def snapshot(self) -> dict[str, object]:
        return {
            "alive": False,
            "last_error_at": None,
            "last_error_code": None,
        }
