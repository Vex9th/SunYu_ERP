from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Event, Thread, current_thread

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app.core.database import connect_database
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.features import system
from backend.app.main import create_app
from updater.storage import write_json


def prepare_root(root: Path):
    write_json(
        root / "installation.json",
        {
            "format": 1,
            "backend": "1.3.0",
            "frontend": "1.3.0",
            "api_version": 1,
            "runtime_version": 1,
        },
    )
    write_json(
        root / "config.json",
        {
            "data_dir": "Data",
            "backup_dir": "Backups",
            "session_secret": "test-secret-with-at-least-thirty-two-bytes",
        },
    )


def test_modular_shutdown_waits_for_scheduled_and_manual_backup_threads(
    tmp_path, monkeypatch
):
    prepare_root(tmp_path)
    scheduled_entered, scheduled_release = Event(), Event()
    manual_entered, manual_release, stopped = Event(), Event(), Event()
    monkeypatch.setattr(system, "_SCHEDULER_STOP_TIMEOUT_SECONDS", 0.01)

    def creator(connection, settings, *, now):
        if current_thread().name == "sunyu-backup-scheduler":
            scheduled_entered.set()
            assert scheduled_release.wait(5)
        else:
            manual_entered.set()
            assert manual_release.wait(5)
        return settings.backup_dir / "test.zip"

    app = create_app(
        config_path=tmp_path / "config.json",
        update_root=tmp_path,
        backup_creator=creator,
        backup_pruner=lambda *args, **kwargs: [],
    )
    client = TestClient(app)
    client.__enter__()
    assert scheduled_entered.wait(2)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_session_token("test-secret-with-at-least-thirty-two-bytes"),
    )
    response = client.post("/api/system/backup-tasks")
    assert response.status_code == 202
    task_id = response.json()["task_id"]

    def shutdown():
        try:
            client.__exit__(None, None, None)
        finally:
            stopped.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(shutdown)
        try:
            assert not stopped.wait(0.05)
            scheduled_release.set()
            assert manual_entered.wait(2)
            assert not stopped.wait(0.1), (
                "shutdown returned while the manual backup thread was still running"
            )
        finally:
            scheduled_release.set()
            manual_release.set()
            future.result(timeout=5)
    with closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection:
        row = connection.execute(
            "SELECT status FROM backup_tasks WHERE id=?", (task_id,)
        ).fetchone()
        assert row["status"] == "success"


def test_maintenance_gate_rejects_backup_before_any_task_is_queued(tmp_path):
    prepare_root(tmp_path)
    # 直接调用路由依赖后的同步端点，模拟请求通过middleware后才进入维护的竞态。
    app = create_app(config_path=tmp_path / "config.json", update_root=tmp_path)
    with TestClient(app):
        (tmp_path / ".updates/maintenance").touch()
        settings = app.state.settings.get()
        routes = [
            child
            for route in app.routes
            for child in (
                route.original_router.routes
                if hasattr(route, "original_router")
                else [route]
            )
        ]
        route = next(
            route
            for route in routes
            if getattr(route, "path", None) == "/api/system/backup-tasks"
        )
        with (
            closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection,
            pytest.raises(HTTPException) as error,
        ):
            route.endpoint(connection=connection, settings=settings)
        assert getattr(error.value, "status_code", None) == 503
        with closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection:
            assert (
                connection.execute("SELECT count(*) FROM backup_tasks").fetchone()[0]
                == 0
            )


def test_maintenance_during_submission_does_not_start_worker_or_leave_running_task(
    tmp_path, monkeypatch
):
    prepare_root(tmp_path)
    config = tmp_path / "config.json"
    from updater.storage import read_json

    write_json(config, {**read_json(config), "backup_enabled": False})
    created = Event()
    app = create_app(
        config_path=config,
        update_root=tmp_path,
        backup_creator=lambda *args, **kwargs: created.set(),
    )
    with TestClient(app) as client:
        client.cookies.set(
            SESSION_COOKIE_NAME,
            create_session_token("test-secret-with-at-least-thirty-two-bytes"),
        )

        def worker_factory(*args, **kwargs):
            (tmp_path / ".updates/maintenance").touch()
            return Thread(*args, **kwargs)

        monkeypatch.setattr(system, "Thread", worker_factory)
        response = client.post("/api/system/backup-tasks")
        assert response.status_code == 503
        assert not created.is_set()
    with closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection:
        rows = connection.execute("SELECT status FROM backup_tasks").fetchall()
        assert [row["status"] for row in rows] == ["failed"]
