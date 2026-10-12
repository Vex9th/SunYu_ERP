from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

import pytest

from updater.supervisor import (
    InstallationLock,
    Supervisor,
    backup_installation,
    can_start_backend,
    initialize_installation,
    recover_interrupted_install,
)


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def installation(root: Path) -> dict:
    state = {"format": 1, "backend": "1.3.0", "frontend": "1.3.0",
             "api_version": 1, "runtime_version": 1}
    write(root / "installation.default.json", state)
    return state


def database(root: Path, version: str = "001_initial") -> Path:
    path = root / "Data" / "iapm.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_migrations (version TEXT)")
        connection.execute("INSERT INTO schema_migrations VALUES (?)", (version,))
        connection.execute("CREATE TABLE facts (amount INTEGER)")
        connection.execute("INSERT INTO facts VALUES (11300)")
    return path


def test_initialize_keeps_existing_selection_and_config_bytes(tmp_path):
    original = installation(tmp_path)
    config = b'{"data_dir":"MyData","session_secret":"preserve-me"}\n'
    (tmp_path / "config.json").write_bytes(config)
    assert initialize_installation(tmp_path) == original
    updated = {**original, "frontend": "1.3.1"}
    write(tmp_path / "installation.json", updated)
    assert initialize_installation(tmp_path) == updated
    assert (tmp_path / "config.json").read_bytes() == config


def test_backup_preserves_external_data_attachments_and_config(tmp_path):
    root = tmp_path / "install"
    root.mkdir()
    data = tmp_path / "old-data"
    data.mkdir()
    (data / "iapm.sqlite").write_bytes(b"test database bytes")
    (data / "Projects").mkdir()
    (data / "Projects" / "proof.txt").write_bytes(b"invoice attachment")
    config = json.dumps({"data_dir": str(data)}, indent=3).encode()
    (root / "config.json").write_bytes(config)
    backup = backup_installation(root, "attempt1")
    assert (backup / "Data" / "iapm.sqlite").read_bytes() == b"test database bytes"
    assert (backup / "Data" / "Projects" / "proof.txt").read_bytes() == b"invoice attachment"
    assert (backup / "config.json").read_bytes() == config
    assert (root / "config.json").read_bytes() == config
    assert json.loads((backup / "backup.json").read_text(encoding="utf-8"))["data_dir"] == str(data)


def test_backup_rejects_recursive_destination_without_touching_data(tmp_path):
    write(tmp_path / "config.json", {"data_dir": "."})
    with pytest.raises(ValueError, match="inside"):
        backup_installation(tmp_path, "attempt1")
    assert not (tmp_path / ".updates" / "backups" / "attempt1").exists()


def test_cannot_rollback_to_backend_missing_applied_migration(tmp_path):
    installation(tmp_path)
    database(tmp_path)
    migrations = tmp_path / "releases/backend/1.3.0/backend/migrations"
    migrations.mkdir(parents=True)
    (migrations / "001_initial.sql").write_text("-- fixture")
    assert can_start_backend(tmp_path, "1.3.0")
    with sqlite3.connect(tmp_path / "Data/iapm.sqlite") as connection:
        connection.execute("INSERT INTO schema_migrations VALUES ('002_new')")
    assert not can_start_backend(tmp_path, "1.3.0")


def test_interrupted_install_reverts_only_when_schema_compatible(tmp_path):
    previous = installation(tmp_path)
    initialize_installation(tmp_path)
    database(tmp_path)
    migrations = tmp_path / "releases/backend/1.3.0/backend/migrations"
    migrations.mkdir(parents=True)
    (migrations / "001_initial.sql").write_text("-- fixture")
    write(tmp_path / ".updates/transaction.json", {
        "previous": previous, "phase": "starting", "id": "test1",
        "version": "1.3.1", "component": "backend",
    })
    write(tmp_path / "installation.json", {**previous, "backend": "1.3.1"})
    recover_interrupted_install(tmp_path)
    assert json.loads((tmp_path / "installation.json").read_text(encoding="utf-8")) == previous
    assert json.loads((tmp_path / ".updates/job.json").read_text(encoding="utf-8"))["status"] == "failed"
    assert not (tmp_path / ".updates/transaction.json").exists()


def test_interrupted_incompatible_migration_keeps_data_and_reports_recovery(tmp_path):
    previous = installation(tmp_path)
    initialize_installation(tmp_path)
    db = database(tmp_path, "999_unknown")
    original = db.read_bytes()
    write(tmp_path / ".updates/transaction.json", {
        "previous": previous, "phase": "starting", "id": "test1",
        "version": "1.3.1", "component": "backend",
    })
    with pytest.raises(RuntimeError, match="恢复"):
        recover_interrupted_install(tmp_path)
    assert db.read_bytes() == original
    assert (tmp_path / ".updates/maintenance").exists()
    assert json.loads((tmp_path / ".updates/job.json").read_text(encoding="utf-8"))["status"] == "manual_recovery"


def test_installation_lock_prevents_second_server_and_releases(tmp_path):
    with (
        InstallationLock(tmp_path),
        pytest.raises(RuntimeError, match="运行"),
        InstallationLock(tmp_path),
    ):
        pytest.fail("a second process must not acquire the installation")
    with InstallationLock(tmp_path):
        pass


def test_shutdown_timeout_keeps_lock_until_child_really_exits(tmp_path, monkeypatch):
    installation(tmp_path)
    supervisor = Supervisor(tmp_path)
    supervisor.stopping = True

    class SlowChild:
        returncode = None
        attempts = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            self.attempts += 1
            with pytest.raises(RuntimeError, match="运行"), InstallationLock(tmp_path):
                pytest.fail("Supervisor released its lock before child exit")
            if self.attempts == 1:
                raise subprocess.TimeoutExpired("backend", timeout)
            self.returncode = 0
            return 0

    child = SlowChild()
    monkeypatch.setattr(supervisor, "start_backend", lambda: setattr(supervisor, "child", child))
    monkeypatch.setattr(supervisor, "wait_healthy", lambda: None)
    assert supervisor.run() == 0
    assert child.attempts == 2


@pytest.mark.parametrize(("host", "url"), [
    ("0.0.0.0", "http://127.0.0.1:8877/api/health"),
    ("::", "http://[::1]:8877/api/health"),
    ("::1", "http://[::1]:8877/api/health"),
    ("192.168.1.10", "http://192.168.1.10:8877/api/health"),
])
def test_health_probe_honors_configured_bind_address(tmp_path, host, url):
    from updater.supervisor import health_url
    write(tmp_path / "config.json", {"host": host, "port": 8877})
    assert health_url(tmp_path) == url


def test_existing_backend_lock_prevents_any_recovery_write(tmp_path):
    initial = installation(tmp_path)
    initialize_installation(tmp_path)
    transaction = {"previous": initial, "id": "hold", "phase": "committed"}
    write(tmp_path / ".updates/transaction.json", transaction)
    (tmp_path / ".updates/maintenance").touch()
    with (
        InstallationLock(tmp_path, "backend.lock"),
        pytest.raises(RuntimeError, match="运行"),
    ):
        Supervisor(tmp_path).run()
    assert json.loads((tmp_path / ".updates/transaction.json").read_text(encoding="utf-8")) == transaction
    assert (tmp_path / ".updates/maintenance").exists()


def test_backup_files_are_flushed_before_completion_manifest(tmp_path, monkeypatch):
    import updater.supervisor as module
    data = tmp_path / "Data"
    data.mkdir()
    (data / "iapm.sqlite").write_bytes(b"fixture")
    write(tmp_path / "config.json", {"data_dir": "Data"})
    flushed = set()
    real_sync, real_write = os.fsync, module.write_json

    def sync(descriptor):
        stat = os.fstat(descriptor)
        flushed.add((stat.st_dev, stat.st_ino))
        real_sync(descriptor)

    def completed(path, value):
        for item in path.parent.rglob("*"):
            if item.is_file() or (os.name != "nt" and item.is_dir()):
                stat = item.stat()
                assert (stat.st_dev, stat.st_ino) in flushed
        real_write(path, value)

    monkeypatch.setattr(os, "fsync", sync)
    monkeypatch.setattr(module, "write_json", completed)
    backup_installation(tmp_path, "durable")


def test_committed_recovery_consumes_pending_before_transaction(tmp_path, monkeypatch):
    initial = installation(tmp_path)
    initialize_installation(tmp_path)
    transaction = {"previous": initial, "id": "done", "phase": "committed", "version": "1.3.0"}
    write(tmp_path / ".updates/transaction.json", transaction)
    write(tmp_path / ".updates/pending.json", {"id": "done"})
    real_unlink = Path.unlink

    def checked_unlink(path, *args, **kwargs):
        if path.name == "transaction.json":
            assert not (tmp_path / ".updates/pending.json").exists()
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", checked_unlink)
    recover_interrupted_install(tmp_path)
    assert not (tmp_path / ".updates/pending.json").exists()
    assert json.loads((tmp_path / ".updates/job.json").read_text(encoding="utf-8"))["status"] == "success"
