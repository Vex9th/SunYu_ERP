from __future__ import annotations

import shutil
import sqlite3
from contextlib import closing
from pathlib import Path
from threading import Event, Thread
from time import sleep

import pytest
from fastapi.testclient import TestClient

from backend.app.core.access import Principal
from backend.app.core.database import connect_database
from backend.app.features import backups
from backend.app.features.operation_history import SystemActor, bind_backup_actor
from backend.app.main import create_app
from backend.tests.features.test_backups import NOW, _connection, _settings
from backend.tests.features.test_system import (
    _login,
    _noop_scheduler_factory,
    _write_config,
)


@pytest.mark.parametrize(
    "actor",
    [
        Principal(
            7,
            "owner",
            "合成备份操作人",
            True,
            3,
            "合成工作组",
            frozenset(),
            frozenset(),
            1,
        ),
        SystemActor(),
    ],
)
def test_snapshot_preserves_actor_and_finishes_only_current_backup(tmp_path, actor):
    settings = _settings(tmp_path)
    connection = _connection(settings)
    try:
        bind_backup_actor(connection, SystemActor("先前任务"), "earlier-job")
        connection.execute(
            "INSERT INTO backup_runs(id,started_at,status,target_path) "
            "VALUES(1,?,'running','earlier-path')",
            (NOW.isoformat(),),
        )
        earlier_event = tuple(
            connection.execute("SELECT * FROM operation_events").fetchone()
        )
        bind_backup_actor(connection, actor, "current-job")
        backup = backups.create_backup(connection, settings, now=NOW)
    finally:
        connection.close()
    with closing(sqlite3.connect(backup / "database/iapm.sqlite")) as snapshot:
        snapshot.row_factory = sqlite3.Row
        assert (
            snapshot.execute("SELECT status FROM backup_runs WHERE id=1").fetchone()[0]
            == "running"
        )
        assert (
            tuple(
                snapshot.execute(
                    "SELECT * FROM operation_events WHERE request_id='earlier-job'"
                ).fetchone()
            )
            == earlier_event
        )
        events = snapshot.execute(
            "SELECT * FROM operation_events WHERE request_id='current-job' ORDER BY id"
        ).fetchall()
        assert [event["action"] for event in events] == [
            "system.backup.running",
            "system.backup.success",
        ]
        expected = (
            ("user", 7, "合成备份操作人", 3, "合成工作组")
            if isinstance(actor, Principal)
            else ("system", None, "系统自动", None, None)
        )
        assert (
            tuple(
                events[1][key]
                for key in (
                    "actor_kind",
                    "actor_id",
                    "actor_name",
                    "group_id",
                    "group_name",
                )
            )
            == expected
        )
        assert (
            events[1]["occurred_at"]
            == snapshot.execute(
                "SELECT finished_at FROM backup_runs WHERE id=2"
            ).fetchone()[0]
        )


def test_restored_snapshot_retains_successful_manual_task(tmp_path):
    config = tmp_path / "config.json"
    _write_config(config, backup_dir="Backups", backup_enabled=False)

    def create_with_other_task(connection, settings, *, now):
        connection.execute(
            "INSERT INTO backup_tasks(id,status,phase,started_at) VALUES('other-task','running','queued',?)",
            (now.isoformat(),),
        )
        return backups.create_backup(connection, settings, now=now)

    app = create_app(
        config_path=config,
        scheduler_factory=_noop_scheduler_factory,
        backup_creator=create_with_other_task,
    )
    with TestClient(app) as client:
        _login(client)
        response = client.post("/api/system/backup-tasks")
        assert response.status_code == 202, response.text
        task_id = response.json()["task_id"]
        for _ in range(100):
            task = client.get(f"/api/system/backup-tasks/{task_id}").json()
            if task["status"] != "running":
                break
            sleep(0.01)
        assert task["status"] == "success", task
    backup = Path(task["path"])
    with closing(sqlite3.connect(backup / "database/iapm.sqlite")) as snapshot:
        assert (
            snapshot.execute(
                "SELECT status FROM backup_tasks WHERE id='other-task'"
            ).fetchone()[0]
            == "running"
        )
        assert (
            snapshot.execute(
                "SELECT status FROM backup_tasks WHERE id=?", (task_id,)
            ).fetchone()[0]
            == "success"
        )
    restored = tmp_path / "restored"
    (restored / "Data").mkdir(parents=True)
    shutil.copy2(backup / "database/iapm.sqlite", restored / "Data/iapm.sqlite")
    shutil.copy2(backup / "config.json", restored / "config.json")
    with TestClient(
        create_app(
            config_path=restored / "config.json",
            scheduler_factory=_noop_scheduler_factory,
        )
    ) as client:
        _login(client)
        restored_task = client.get(f"/api/system/backup-tasks/{task_id}").json()
        assert restored_task["status"] == "success"
        assert restored_task["phase"] == "finished"
        assert restored_task["path"] == str(backup)
        assert restored_task["error_code"] is None


@pytest.mark.parametrize("fail_copy", [False, True])
def test_shutdown_waits_for_manual_backup_to_finish(tmp_path, monkeypatch, fail_copy):
    config = tmp_path / "config.json"
    _write_config(config, backup_dir="Backups", backup_enabled=False)
    entered, release, exiting, exited = Event(), Event(), Event(), Event()
    original_copy = backups._copy_projects

    def pause_copy(data_dir, target):
        entered.set()
        assert release.wait(5)
        if fail_copy:
            raise OSError("synthetic project copy failure")
        original_copy(data_dir, target)

    monkeypatch.setattr(backups, "_copy_projects", pause_copy)
    app = create_app(config_path=config, scheduler_factory=_noop_scheduler_factory)
    failures = []

    def run_application():
        try:
            with TestClient(app) as client:
                _login(client)
                response = client.post("/api/system/backup-tasks")
                assert response.status_code == 202, response.text
                assert entered.wait(2)
                exiting.set()
        except BaseException as failure:  # noqa: BLE001 - report thread failures to the test
            failures.append(failure)
        finally:
            exited.set()

    application_thread = Thread(target=run_application, daemon=True)
    application_thread.start()
    try:
        assert entered.wait(3)
        assert exiting.wait(2)
        assert not exited.wait(0.1), (
            "shutdown returned before its active manual backup completed"
        )
    finally:
        release.set()
        application_thread.join(timeout=5)
    assert not application_thread.is_alive()
    assert not failures
    with closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection:
        task = connection.execute("SELECT * FROM backup_tasks").fetchone()
        if fail_copy:
            assert task["status"] == "failed"
            assert "OSError" in task["error_code"]
            assert task["path"] is None
        else:
            assert task["status"] == "success"
            backups.verify_backup(task["path"])
    assert list((tmp_path / "Backups").glob(".incomplete-*")) == []
