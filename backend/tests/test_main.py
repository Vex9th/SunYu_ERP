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

PROJECT_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


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


def _write_frontend_dist(frontend_dist: Path) -> None:
    (frontend_dist / "assets").mkdir(parents=True)
    (frontend_dist / "api").mkdir()
    (frontend_dist / "index.html").write_text(
        '<!doctype html><div id="app">SunYu ERP Release</div>',
        encoding="utf-8",
    )
    (frontend_dist / "assets" / "app.js").write_text(
        'console.log("release asset")',
        encoding="utf-8",
    )
    (frontend_dist / "api" / "health").write_text(
        "static content must not shadow API",
        encoding="utf-8",
    )


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


def test_lifespan_cleans_stale_document_stage_before_serving_requests(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    temp_dir = tmp_path / "Data" / "Temp"
    temp_dir.mkdir(parents=True)
    stale = temp_dir / ".upload-crashed.tmp"
    unrelated = temp_dir / "keep-me.txt"
    stale.write_bytes(b"stale-upload")
    unrelated.write_bytes(b"unrelated")
    application = main_module.create_app(config_path=config_path)

    with TestClient(application) as client:
        assert client.get("/api/health").status_code == 200
        assert not stale.exists()
        assert unrelated.read_bytes() == b"unrelated"


def test_create_app_only_serves_frontend_when_dist_is_explicit(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    application = main_module.create_app(
        config_path=config_path,
        migrations_dir=PROJECT_MIGRATIONS_DIR,
    )

    with TestClient(application) as client:
        assert client.get("/").status_code == 404
        assert client.get("/api/health").json() == {"status": "ok"}


def test_create_app_registers_first_business_vertical_slice_routes() -> None:
    application = main_module.create_app()
    paths = application.openapi()["paths"]

    expected_paths = {
        "/api/projects/{project_code}/stages",
        "/api/projects/{project_code}/stages/{stage_code}",
        "/api/projects/{project_code}/stages/{stage_code}/transition",
        "/api/procurement/import-template.xlsx",
        "/api/projects/{project_code}/procurement-lists",
        "/api/projects/{project_code}/purchase-orders",
        "/api/projects/{project_code}/procurement-overview",
        "/api/projects/{project_code}/procurement-imports/preview",
        "/api/projects/{project_code}/procurement-imports/{import_id}/confirm",
        "/api/projects/{project_code}/purchase-orders/{order_id}/supplier-payments",
        "/api/projects/{project_code}/purchase-orders/{order_id}/supplier-invoices",
        "/api/projects/{project_code}/goods-receipts/{receipt_id}/reverse",
        "/api/projects/{project_code}/procurement-lists/{list_id}/quote-exports",
        "/api/projects/{project_code}/quote-exports/{export_id}/download",
        "/api/inventory/items",
        "/api/inventory/adjustments",
        "/api/projects/{project_code}/inventory-issues",
        "/api/workers",
        "/api/workers/{worker_id}",
        "/api/projects/{project_code}/crew-assignments",
        "/api/projects/{project_code}/labor-entries",
        "/api/projects/{project_code}/labor-entries/batch",
        "/api/projects/{project_code}/site-daily-reports",
        "/api/projects/{project_code}/site-daily-reports/{work_date}",
        "/api/projects/{project_code}/site-daily-reports/{work_date}/confirm",
        "/api/projects/{project_code}/site-daily-reports/{work_date}/reopen",
        "/api/projects/{project_code}/material-advances",
        "/api/projects/{project_code}/material-advances/{advance_id}",
        "/api/projects/{project_code}/material-advances/{advance_id}/reimbursements",
        "/api/projects/{project_code}/material-advances/{advance_id}/void",
        "/api/projects/{project_code}/documents",
        "/api/projects/{project_code}/quotes",
        "/api/projects/{project_code}/quotes/{quote_id}",
        "/api/projects/{project_code}/quotes/{quote_id}/transition",
        "/api/projects/{project_code}/contracts",
        "/api/projects/{project_code}/contracts/{contract_id}",
        "/api/projects/{project_code}/contracts/{contract_id}/transition",
        "/api/projects/{project_code}/payments",
        "/api/projects/{project_code}/payment-terms/{milestone}",
        "/api/projects/{project_code}/receipts",
        "/api/projects/{project_code}/receipts/{receipt_id}",
        "/api/projects/{project_code}/receipts/{receipt_id}/void",
        "/api/dashboard",
        "/api/projects/{project_code}/drawing-signoffs",
        "/api/projects/{project_code}/commissioning-sessions",
        "/api/projects/{project_code}/engineering-changes",
        "/api/projects/{project_code}/acceptances",
        "/api/projects/{project_code}/warranty",
        "/api/projects/{project_code}/invoices",
        "/api/projects/{project_code}/after-sales",
        "/api/projects/{project_code}/delivery-summary",
    }

    assert expected_paths <= paths.keys()


def test_create_app_serves_release_home_assets_and_keeps_api_priority(
    tmp_path: Path,
) -> None:
    release_root = tmp_path / "发布 包 含中文"
    frontend_dist = release_root / "只读资源" / "frontend" / "dist"
    _write_frontend_dist(frontend_dist)
    application = main_module.create_app(
        config_path=release_root / "可写目录" / "config.json",
        migrations_dir=PROJECT_MIGRATIONS_DIR,
        frontend_dist=frontend_dist,
    )

    with TestClient(application) as client:
        home = client.get("/")
        asset = client.get("/assets/app.js")
        health = client.get("/api/health")
        session = client.get("/api/auth/session")

    assert home.status_code == 200
    assert "SunYu ERP Release" in home.text
    assert asset.status_code == 200
    assert asset.text == 'console.log("release asset")'
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert session.status_code == 200
    assert session.json() == {
        "authenticated": False,
        "password_configured": False,
    }


def test_release_app_restart_preserves_config_database_and_login(
    tmp_path: Path,
) -> None:
    release_root = tmp_path / "SunYu ERP 中文目录"
    frontend_dist = release_root / "resources" / "frontend" / "dist"
    _write_frontend_dist(frontend_dist)
    config_path = release_root / "writable" / "config.json"

    first_application = main_module.create_app(
        config_path=config_path,
        migrations_dir=PROJECT_MIGRATIONS_DIR,
        frontend_dist=frontend_dist,
    )
    with TestClient(first_application) as client:
        assert client.post(
            "/api/auth/setup",
            json={"password": "654321"},
        ).status_code == 204

    first_config = config_path.read_text(encoding="utf-8")
    database_path = config_path.parent / "Data" / "iapm.sqlite"
    assert database_path.is_file()

    second_application = main_module.create_app(
        config_path=config_path,
        migrations_dir=PROJECT_MIGRATIONS_DIR,
        frontend_dist=frontend_dist,
    )
    with TestClient(second_application) as client:
        assert client.post(
            "/api/auth/login",
            json={"password": "654321"},
        ).status_code == 204
        assert client.get("/").status_code == 200

    assert config_path.read_text(encoding="utf-8") == first_config


def test_create_app_passes_explicit_migrations_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrations_dir = tmp_path / "只读 迁移资源"
    captured: list[Path] = []

    def capture_migrations(
        connection: sqlite3.Connection,
        selected_dir: str | Path,
    ) -> list[str]:
        captured.append(Path(selected_dir))
        return []

    monkeypatch.setattr(main_module, "apply_migrations", capture_migrations)
    application = main_module.create_app(
        config_path=tmp_path / "可写 根" / "config.json",
        migrations_dir=migrations_dir,
        scheduler_factory=lambda **_: _LifecycleProbeScheduler(),
    )

    with TestClient(application) as client:
        assert client.get("/api/health").status_code == 200

    assert captured == [migrations_dir]


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
        "004_project_code_identity",
        "005_project_workflow_documents",
        "006_commercial_finance",
        "007_dashboard_indexes",
        "008_procurement_inventory",
        "009_workforce_delivery",
        "010_site_report_events",
        "011_procurement_audit",
        "012_delivery_events",
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


def test_create_app_mounts_authenticated_projects_router(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    _write_config(config_path)
    application = main_module.create_app(config_path=config_path)

    with TestClient(application) as client:
        unauthenticated = client.get("/api/projects")
        _login(client)
        authenticated = client.get("/api/projects")

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
