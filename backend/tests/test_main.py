from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

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
    assert versions == {"001_foundation", "002_documents"}


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


class _TrackedConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self.closed = False

    def close(self) -> None:
        self._connection.close()
        self.closed = True

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)
