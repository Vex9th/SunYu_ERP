from __future__ import annotations

import json
import os
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

import pytest

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features import backups as backup_module
from backend.app.features.backups import create_backup, prune_backups, verify_backup

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 1, 10, 12, 34, 56, tzinfo=timezone.utc)


def _settings(tmp_path: Path) -> Settings:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "data_dir": "Data",
                "backup_dir": "Synology/Backups",
                "session_secret": "private-session-secret",
                "company": "测试配置内容",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return Settings(
        config_path=config_path,
        data_dir=tmp_path / "Data",
        backup_dir=tmp_path / "Synology" / "Backups",
        backup_interval_hours=24,
        backup_retention_days=30,
        host="0.0.0.0",
        port=8765,
        session_secret="private-session-secret",
    )


def _connection(settings: Settings) -> sqlite3.Connection:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    connection = connect_database(settings.data_dir / "iapm.sqlite")
    apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
    connection.execute("CREATE TABLE IF NOT EXISTS backup_probe (value TEXT NOT NULL)")
    return connection


def _create_valid_backup(tmp_path: Path, *, now: datetime = NOW) -> tuple[Path, Settings]:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    try:
        return create_backup(connection, settings, now=now), settings
    finally:
        connection.close()


def test_create_backup_copies_consistent_database_config_and_projects(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    project_file = settings.data_dir / "Projects" / "P-001" / "图纸" / "设计稿.bin"
    project_file.parent.mkdir(parents=True)
    payload = ("机械设计-" * 20_000).encode()
    project_file.write_bytes(payload)
    (settings.data_dir / "Temp").mkdir()
    (settings.data_dir / "Temp" / "ignored.tmp").write_text("ignore")
    (settings.data_dir / "Backups").mkdir()
    (settings.data_dir / "Backups" / "ignored.zip").write_text("ignore")
    connection = _connection(settings)
    try:
        connection.execute("INSERT INTO backup_probe VALUES ('WAL 中的数据')")

        backup_path = create_backup(connection, settings, now=NOW)

        assert backup_path.name == "2026-01-10_123456"
        assert backup_path.parent == settings.backup_dir
        assert (backup_path / "config.json").read_bytes() == settings.config_path.read_bytes()
        assert (backup_path / "Projects/P-001/图纸/设计稿.bin").read_bytes() == payload
        assert not (backup_path / "Temp").exists()
        assert not (backup_path / "Backups").exists()
        copied = sqlite3.connect(backup_path / "database/iapm.sqlite")
        try:
            assert copied.execute("SELECT value FROM backup_probe").fetchone()[0] == (
                "WAL 中的数据"
            )
        finally:
            copied.close()
        manifest = verify_backup(backup_path)
        assert manifest["product"] == "SunYu ERP"
        assert manifest["schema_version"] == 1
        assert {item["path"] for item in manifest["files"]} == {
            "config.json",
            "database/iapm.sqlite",
            "Projects/P-001/图纸/设计稿.bin",
        }
        assert list(settings.backup_dir.glob(".incomplete-*")) == []
        run = connection.execute(
            "SELECT status, target_path, error_message FROM backup_runs ORDER BY id DESC"
        ).fetchone()
        assert tuple(run) == ("success", str(backup_path), None)
    finally:
        connection.close()


def test_create_backup_preserves_an_empty_projects_directory(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    (settings.data_dir / "Projects").mkdir(parents=True)
    connection = _connection(settings)
    try:
        backup_path = create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert (backup_path / "Projects").is_dir()
    verify_backup(backup_path)


def test_create_backup_requires_an_enabled_backup_directory(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    settings = Settings(
        config_path=settings.config_path,
        data_dir=settings.data_dir,
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host=settings.host,
        port=settings.port,
        session_secret=settings.session_secret,
    )
    connection = _connection(settings)
    try:
        with pytest.raises(RuntimeError, match="backup_dir"):
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()


def test_backup_directory_cannot_be_inside_projects_source(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    settings = Settings(
        config_path=settings.config_path,
        data_dir=settings.data_dir,
        backup_dir=settings.data_dir / "Projects" / "Backups",
        backup_interval_hours=settings.backup_interval_hours,
        backup_retention_days=settings.backup_retention_days,
        host=settings.host,
        port=settings.port,
        session_secret=settings.session_secret,
    )
    connection = _connection(settings)
    try:
        with pytest.raises(ValueError, match="Projects"):
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()


def test_target_name_collision_fails_without_overwriting_existing_backup(
    tmp_path: Path,
) -> None:
    first, settings = _create_valid_backup(tmp_path)
    original_manifest = (first / "manifest.json").read_bytes()
    connection = _connection(settings)
    try:
        with pytest.raises(FileExistsError):
            create_backup(connection, settings, now=NOW)
        run = connection.execute(
            "SELECT status, error_message FROM backup_runs ORDER BY id DESC"
        ).fetchone()
        assert run["status"] == "failed"
        assert "private-session-secret" not in (run["error_message"] or "")
    finally:
        connection.close()

    assert (first / "manifest.json").read_bytes() == original_manifest
    assert list(settings.backup_dir.glob(".incomplete-*")) == []


def test_concurrent_same_second_creation_never_overwrites(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    seed = _connection(settings)
    seed.close()

    def create_one() -> str:
        connection = connect_database(settings.data_dir / "iapm.sqlite")
        try:
            create_backup(connection, settings, now=NOW)
        except FileExistsError:
            return "failed"
        finally:
            connection.close()
        return "success"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _: create_one(), range(2)))

    assert sorted(outcomes) == ["failed", "success"]
    assert [path.name for path in settings.backup_dir.iterdir()] == [
        "2026-01-10_123456"
    ]
    observer = connect_database(settings.data_dir / "iapm.sqlite")
    try:
        statuses = [
            row["status"]
            for row in observer.execute("SELECT status FROM backup_runs ORDER BY id")
        ]
        assert sorted(statuses) == ["failed", "success"]
    finally:
        observer.close()


@pytest.mark.parametrize("failure_type", (OSError, KeyboardInterrupt, SystemExit))
def test_base_exception_preserves_primary_and_cleans_only_own_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_type: type[BaseException],
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    settings.backup_dir.mkdir(parents=True)
    unrelated = settings.backup_dir / ".incomplete-unrelated"
    unrelated.mkdir()
    failure = failure_type("private-session-secret must not be logged")

    def fail_database_backup(*_: object) -> None:
        raise failure

    monkeypatch.setattr(backup_module, "_backup_database", fail_database_backup)
    try:
        with pytest.raises(failure_type) as raised:
            create_backup(connection, settings, now=NOW)
        assert raised.value is failure
        run = connection.execute(
            "SELECT status, error_message FROM backup_runs ORDER BY id DESC"
        ).fetchone()
        assert run["status"] == "failed"
        assert "private-session-secret" not in run["error_message"]
    finally:
        connection.close()

    assert unrelated.is_dir()
    assert list(settings.backup_dir.glob(".incomplete-*")) == [unrelated]


def test_cleanup_failure_is_not_allowed_to_mask_primary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    primary = OSError("copy failed")

    def fail_database_backup(*_: object) -> None:
        raise primary

    def fail_cleanup(_: Path) -> None:
        raise OSError("cleanup failed")

    monkeypatch.setattr(backup_module, "_backup_database", fail_database_backup)
    monkeypatch.setattr(backup_module, "_remove_stage", fail_cleanup)
    try:
        with pytest.raises(OSError) as raised:
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert raised.value is primary
    assert any("cleanup failed" in note for note in (primary.__notes__ or []))


def test_fsync_failure_is_not_masked_by_descriptor_close_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sync.bin"
    path.write_bytes(b"content")
    primary = OSError("fsync failed")
    real_close = backup_module.os.close

    def fail_fsync(_: int) -> None:
        raise primary

    def close_then_fail(descriptor: int) -> None:
        real_close(descriptor)
        raise OSError("close failed")

    monkeypatch.setattr(backup_module.os, "fsync", fail_fsync)
    monkeypatch.setattr(backup_module.os, "close", close_then_fail)

    with pytest.raises(OSError) as raised:
        backup_module._sync_file(path)

    assert raised.value is primary
    assert any("close failed" in note for note in (primary.__notes__ or []))


@pytest.mark.parametrize(
    "function_name",
    ("_copy_file", "_copy_projects", "_write_manifest", "verify_backup", "_publish_stage"),
)
def test_each_creation_stage_failure_cleans_stage_and_records_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    function_name: str,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    primary = KeyboardInterrupt(f"injected {function_name}")

    def fail_stage(*_: object) -> None:
        raise primary

    monkeypatch.setattr(backup_module, function_name, fail_stage)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            create_backup(connection, settings, now=NOW)
        run = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()
    finally:
        connection.close()

    assert raised.value is primary
    assert run["status"] == "failed"
    assert list(settings.backup_dir.glob(".incomplete-*")) == []


def test_publish_that_moves_then_raises_rolls_back_its_owned_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    primary = OSError("rename reported failure after moving")
    real_rename = backup_module.os.rename

    def move_then_fail(source: Path, target: Path) -> None:
        real_rename(source, target)
        raise primary

    monkeypatch.setattr(backup_module.os, "rename", move_then_fail)
    try:
        with pytest.raises(OSError) as raised:
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert raised.value is primary
    assert not (settings.backup_dir / "2026-01-10_123456").exists()
    assert list(settings.backup_dir.glob(".incomplete-*")) == []


class _SuccessUpdateFailingConnection:
    def __init__(self, wrapped: sqlite3.Connection, failure: BaseException) -> None:
        self.wrapped = wrapped
        self.failure = failure

    @property
    def in_transaction(self) -> bool:
        return self.wrapped.in_transaction

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        if "status = 'success'" in sql:
            raise self.failure
        return self.wrapped.execute(sql, parameters)

    def backup(self, target: sqlite3.Connection) -> None:
        self.wrapped.backup(target)


def test_success_status_failure_rolls_back_published_backup(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    primary = SystemExit("status write failed")
    proxy = cast(
        sqlite3.Connection,
        _SuccessUpdateFailingConnection(connection, primary),
    )
    try:
        with pytest.raises(SystemExit) as raised:
            create_backup(proxy, settings, now=NOW)
        run = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()
    finally:
        connection.close()

    assert raised.value is primary
    assert run["status"] == "failed"
    assert not (settings.backup_dir / "2026-01-10_123456").exists()


@pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
def test_source_project_symlink_is_rejected_and_stage_is_removed(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    project_dir = settings.data_dir / "Projects/P-001"
    project_dir.mkdir(parents=True)
    (project_dir / "escape.txt").symlink_to(outside)
    connection = _connection(settings)
    try:
        with pytest.raises(ValueError, match="symlink"):
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert list(settings.backup_dir.glob(".incomplete-*")) == []


@pytest.mark.parametrize(
    "mutation",
    ("missing", "unexpected", "tamper", "traversal", "malformed"),
)
def test_verify_backup_rejects_invalid_contents(tmp_path: Path, mutation: str) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    manifest_path = backup_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if mutation == "missing":
        (backup_path / "config.json").unlink()
    elif mutation == "unexpected":
        (backup_path / "unexpected.txt").write_text("unexpected")
    elif mutation == "tamper":
        (backup_path / "config.json").write_text("tampered")
    elif mutation == "traversal":
        manifest["files"][0]["path"] = "../outside.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    else:
        manifest_path.write_text("{broken", encoding="utf-8")

    with pytest.raises((ValueError, OSError, json.JSONDecodeError)):
        verify_backup(backup_path)


def test_verify_backup_rejects_missing_manifest(tmp_path: Path) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    (backup_path / "manifest.json").unlink()

    with pytest.raises(FileNotFoundError):
        verify_backup(backup_path)


@pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
def test_verify_backup_rejects_symlink_even_when_it_resolves_inside(
    tmp_path: Path,
) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    config_path = backup_path / "config.json"
    retained = backup_path / "retained-config.json"
    config_path.rename(retained)
    config_path.symlink_to(retained.name)

    with pytest.raises(ValueError, match="symlink"):
        verify_backup(backup_path)


def test_verify_backup_rejects_wrong_product_or_schema(tmp_path: Path) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    manifest_path = backup_path / "manifest.json"
    for key, value in (("product", "Other"), ("schema_version", 2)):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        original = manifest[key]
        manifest[key] = value
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ValueError, match=key):
            verify_backup(backup_path)
        manifest[key] = original
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


def test_verify_backup_rejects_boolean_schema_and_file_size(tmp_path: Path) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    manifest_path = backup_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schema_version"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="schema_version"):
        verify_backup(backup_path)

    manifest["schema_version"] = 1
    manifest["files"][0]["size"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="size"):
        verify_backup(backup_path)


def test_prune_deletes_only_expired_managed_backups_and_keeps_latest_two(
    tmp_path: Path,
) -> None:
    template, settings = _create_valid_backup(tmp_path)
    template.rename(settings.backup_dir / "2026-01-09_000000")
    for name in (
        "2026-01-01_000000",
        "2026-01-02_000000",
        "2026-01-03_000000",
    ):
        shutil.copytree(settings.backup_dir / "2026-01-09_000000", settings.backup_dir / name)
    unrelated = settings.backup_dir / "my-photos"
    unrelated.mkdir()
    incomplete = settings.backup_dir / ".incomplete-abandoned"
    incomplete.mkdir()
    invalid = settings.backup_dir / "2025-12-01_000000"
    invalid.mkdir()
    (invalid / "manifest.json").write_text("{}")

    removed = prune_backups(settings.backup_dir, retention_days=5, now=NOW)

    assert {path.name for path in removed} == {
        "2026-01-01_000000",
        "2026-01-02_000000",
    }
    assert {path.name for path in settings.backup_dir.iterdir()} == {
        "2026-01-03_000000",
        "2026-01-09_000000",
        "2025-12-01_000000",
        "my-photos",
        ".incomplete-abandoned",
    }


def test_prune_keeps_future_backup_and_never_reduces_valid_backups_below_two(
    tmp_path: Path,
) -> None:
    template, settings = _create_valid_backup(tmp_path)
    template.rename(settings.backup_dir / "2026-02-01_000000")
    shutil.copytree(
        settings.backup_dir / "2026-02-01_000000",
        settings.backup_dir / "2025-01-01_000000",
    )

    assert prune_backups(settings.backup_dir, retention_days=0, now=NOW) == []
    assert {path.name for path in settings.backup_dir.iterdir()} == {
        "2025-01-01_000000",
        "2026-02-01_000000",
    }


def test_prune_rejects_invalid_arguments(tmp_path: Path) -> None:
    with pytest.raises(TypeError, match="retention_days"):
        prune_backups(tmp_path, True, now=NOW)
    with pytest.raises(ValueError, match="retention_days"):
        prune_backups(tmp_path, -1, now=NOW)


@pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
def test_prune_rejects_broken_symlink_backup_root(tmp_path: Path) -> None:
    backup_dir = tmp_path / "Backups"
    backup_dir.symlink_to(tmp_path / "missing-target", target_is_directory=True)

    with pytest.raises(ValueError, match="symlink"):
        prune_backups(backup_dir, 30, now=NOW)
