from __future__ import annotations

import json
import os
import shutil
import sqlite3
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from types import SimpleNamespace
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


def _set_manifest_time(backup_path: Path, created_at: datetime) -> None:
    manifest_path = backup_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["created_at"] = created_at.isoformat()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


def _copy_managed_backup(template: Path, target: Path, created_at: datetime) -> None:
    shutil.copytree(template, target)
    _set_manifest_time(target, created_at)


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
            copied_run = copied.execute(
                "SELECT status, finished_at FROM backup_runs ORDER BY id DESC"
            ).fetchone()
            assert copied_run[0] == "success"
            assert copied_run[1] is not None
        finally:
            copied.close()
        assert {path.name for path in (backup_path / "database").iterdir()} == {
            "iapm.sqlite"
        }
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


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission contract")
def test_created_backup_tree_uses_private_modes_without_chmod_existing_root(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    project_file = settings.data_dir / "Projects/P-001/nested/design.bin"
    project_file.parent.mkdir(parents=True)
    project_file.write_bytes(b"design")
    settings.backup_dir.mkdir(parents=True)
    settings.backup_dir.chmod(0o755)
    connection = _connection(settings)
    try:
        backup_path = create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert settings.backup_dir.stat().st_mode & 0o777 == 0o755
    directories = [backup_path, *(path for path in backup_path.rglob("*") if path.is_dir())]
    files = [path for path in backup_path.rglob("*") if path.is_file()]
    assert directories
    assert files
    assert all(path.stat().st_mode & 0o777 == 0o700 for path in directories)
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in files)


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


def test_non_autocommit_connection_fails_before_writes_or_stage_creation(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    seed = _connection(settings)
    seed.close()
    connection = sqlite3.connect(settings.data_dir / "iapm.sqlite")
    try:
        before = connection.execute("SELECT COUNT(*) FROM backup_runs").fetchone()[0]
        with pytest.raises(RuntimeError, match="autocommit"):
            create_backup(connection, settings, now=NOW)
        after = connection.execute("SELECT COUNT(*) FROM backup_runs").fetchone()[0]
    finally:
        connection.close()

    assert before == after == 0
    assert not settings.backup_dir.exists()


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


def test_stage_name_collision_never_deletes_preexisting_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    settings.backup_dir.mkdir(parents=True)
    existing_stage = settings.backup_dir / ".incomplete-fixed"
    existing_stage.mkdir()
    marker = existing_stage / "owned-by-other.txt"
    marker.write_text("keep")
    monkeypatch.setattr(
        backup_module.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="fixed"),
    )
    connection = _connection(settings)
    try:
        with pytest.raises(FileExistsError):
            create_backup(connection, settings, now=NOW)
    finally:
        connection.close()

    assert marker.read_text() == "keep"


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


def test_sync_file_opens_a_writable_binary_descriptor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sync.bin"
    opened: list[tuple[Path, int]] = []

    def record_open(opened_path: Path, flags: int) -> int:
        opened.append((opened_path, flags))
        return 42

    monkeypatch.setattr(backup_module.os, "open", record_open)
    monkeypatch.setattr(backup_module.os, "fsync", lambda _: None)
    monkeypatch.setattr(backup_module.os, "close", lambda _: None)

    backup_module._sync_file(path)

    expected_flags = os.O_RDWR | getattr(os, "O_BINARY", 0)
    assert opened == [(path, expected_flags)]


def test_windows_file_signature_ignores_unstable_change_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial = cast(
        os.stat_result,
        SimpleNamespace(
            st_dev=11,
            st_ino=22,
            st_mode=0o100600,
            st_ctime_ns=200,
            st_size=4,
            st_mtime_ns=100,
        ),
    )
    later = cast(
        os.stat_result,
        SimpleNamespace(
            st_dev=11,
            st_ino=22,
            st_mode=0o100600,
            st_ctime_ns=201,
            st_size=4,
            st_mtime_ns=100,
        ),
    )
    monkeypatch.setattr(backup_module.os, "name", "nt")

    assert backup_module._file_signature(initial) == backup_module._file_signature(later)


def test_posix_file_signature_detects_change_time_difference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial = cast(
        os.stat_result,
        SimpleNamespace(
            st_dev=11,
            st_ino=22,
            st_mode=0o100600,
            st_ctime_ns=200,
            st_size=4,
            st_mtime_ns=100,
        ),
    )
    later = cast(
        os.stat_result,
        SimpleNamespace(
            st_dev=11,
            st_ino=22,
            st_mode=0o100600,
            st_ctime_ns=201,
            st_size=4,
            st_mtime_ns=100,
        ),
    )
    monkeypatch.setattr(backup_module.os, "name", "posix")

    assert backup_module._file_signature(initial) != backup_module._file_signature(later)


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


def test_corrupt_snapshot_header_fails_quick_check_and_cleans_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    real_validate = backup_module._validate_database_snapshot

    def corrupt_then_validate(database_path: Path) -> None:
        with database_path.open("r+b") as database_file:
            database_file.write(b"not a sqlite database")
            database_file.flush()
            os.fsync(database_file.fileno())
        real_validate(database_path)

    monkeypatch.setattr(
        backup_module,
        "_validate_database_snapshot",
        corrupt_then_validate,
    )
    try:
        with pytest.raises(sqlite3.DatabaseError):
            create_backup(connection, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert status == "failed"
    assert list(settings.backup_dir.glob(".incomplete-*")) == []


def test_read_only_database_uri_encodes_question_hash_unicode_and_space(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "NAS ?# 中文 空格" / "iapm.sqlite"

    database_uri = backup_module._read_only_database_uri(database_path)

    assert database_uri.endswith("?mode=ro")
    assert "%3F" in database_uri
    assert "%23" in database_uri
    assert "%20" in database_uri
    assert "%E4%B8%AD%E6%96%87" in database_uri


def test_quick_check_uri_handles_hash_unicode_and_space_on_filesystem(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(
        _settings(tmp_path),
        backup_dir=tmp_path / "NAS # 中文 空格" / "Backups",
    )
    connection = _connection(settings)
    real_validate = backup_module._validate_database_snapshot

    def corrupt_then_validate(database_path: Path) -> None:
        with database_path.open("r+b") as database_file:
            database_file.write(b"not a sqlite database")
            database_file.flush()
            os.fsync(database_file.fileno())
        real_validate(database_path)

    monkeypatch.setattr(
        backup_module,
        "_validate_database_snapshot",
        corrupt_then_validate,
    )
    try:
        with pytest.raises(sqlite3.DatabaseError):
            create_backup(connection, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert status == "failed"
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
    def isolation_level(self) -> None:
        return None

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


@pytest.mark.parametrize("failure_type", (OSError, KeyboardInterrupt, SystemExit))
def test_success_written_then_primary_raised_preserves_owned_valid_backup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_type: type[BaseException],
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    primary = failure_type("raised after success update")
    real_record_success = backup_module._record_successful_run

    def write_success_then_fail(
        target_connection: sqlite3.Connection,
        run_id: int,
    ) -> None:
        real_record_success(target_connection, run_id)
        raise primary

    monkeypatch.setattr(
        backup_module,
        "_record_successful_run",
        write_success_then_fail,
    )
    try:
        with pytest.raises(failure_type) as raised:
            create_backup(connection, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    backup_path = settings.backup_dir / "2026-01-10_123456"
    assert raised.value is primary
    assert status == "success"
    assert verify_backup(backup_path)["product"] == "SunYu ERP"


class _NoOpUpdateConnection:
    def __init__(self, wrapped: sqlite3.Connection, marker: str) -> None:
        self.wrapped = wrapped
        self.marker = marker

    @property
    def isolation_level(self) -> None:
        return None

    @property
    def in_transaction(self) -> bool:
        return self.wrapped.in_transaction

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        if self.marker in sql:
            return self.wrapped.execute("SELECT 1")
        return self.wrapped.execute(sql, parameters)

    def backup(self, target: sqlite3.Connection) -> None:
        self.wrapped.backup(target)


class _StatusFaultConnection:
    def __init__(
        self,
        wrapped: sqlite3.Connection,
        *,
        select_mode: str = "normal",
        fail_compensation: bool = False,
    ) -> None:
        self.wrapped = wrapped
        self.select_mode = select_mode
        self.fail_compensation = fail_compensation
        self.status_reads = 0

    @property
    def isolation_level(self) -> None:
        return None

    @property
    def in_transaction(self) -> bool:
        return self.wrapped.in_transaction

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        if "SELECT status FROM backup_runs" in sql:
            self.status_reads += 1
            if self.select_mode == "always_fail":
                raise OSError("status read failed")
            if self.select_mode == "unknown":
                return self.wrapped.execute("SELECT 'unknown'")
            if self.select_mode == "missing":
                return self.wrapped.execute("SELECT 1 WHERE 0")
            if self.select_mode == "second_fail" and self.status_reads >= 2:
                raise OSError("status readback failed")
        if self.fail_compensation and "status = 'failed'" in sql:
            raise OSError("compensation update failed")
        return self.wrapped.execute(sql, parameters)

    def backup(self, target: sqlite3.Connection) -> None:
        self.wrapped.backup(target)


def _raise_after_success(
    monkeypatch: pytest.MonkeyPatch,
    primary: BaseException,
    after_success: Callable[[], None] = lambda: None,
) -> None:
    real_record_success = backup_module._record_successful_run

    def write_success_then_fail(
        connection: sqlite3.Connection,
        run_id: int,
    ) -> None:
        real_record_success(connection, run_id)
        after_success()
        raise primary

    monkeypatch.setattr(
        backup_module,
        "_record_successful_run",
        write_success_then_fail,
    )


def test_success_update_rowcount_zero_cannot_return_success(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _NoOpUpdateConnection(connection, "status = 'success'"),
    )
    try:
        with pytest.raises(RuntimeError, match="success"):
            create_backup(proxy, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert status == "failed"
    assert not (settings.backup_dir / "2026-01-10_123456").exists()


def test_failed_update_rowcount_zero_adds_note_without_masking_primary(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _NoOpUpdateConnection(connection, "status = 'failed'"),
    )
    primary = KeyboardInterrupt("original")
    try:
        backup_module._record_failed_run(proxy, 999, primary)
    finally:
        connection.close()

    assert any("row" in note for note in (primary.__notes__ or []))


def test_success_written_then_status_select_raises_preserves_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _StatusFaultConnection(connection, select_mode="always_fail"),
    )
    primary = KeyboardInterrupt("primary interrupt")
    _raise_after_success(monkeypatch, primary)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            create_backup(proxy, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    target = settings.backup_dir / "2026-01-10_123456"
    assert raised.value is primary
    assert status == "success"
    assert verify_backup(target)["product"] == "SunYu ERP"
    assert any("status read failed" in note for note in primary.__notes__)


def test_success_written_then_unknown_status_preserves_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _StatusFaultConnection(connection, select_mode="unknown"),
    )
    primary = SystemExit("primary exit")
    _raise_after_success(monkeypatch, primary)
    try:
        with pytest.raises(SystemExit) as raised:
            create_backup(proxy, settings, now=NOW)
    finally:
        connection.close()

    target = settings.backup_dir / "2026-01-10_123456"
    assert raised.value is primary
    assert target.exists()
    assert any("unknown" in note for note in primary.__notes__)


def test_success_written_then_status_row_missing_preserves_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _StatusFaultConnection(connection, select_mode="missing"),
    )
    primary = OSError("primary failure")
    _raise_after_success(monkeypatch, primary)
    try:
        with pytest.raises(OSError) as raised:
            create_backup(proxy, settings, now=NOW)
    finally:
        connection.close()

    target = settings.backup_dir / "2026-01-10_123456"
    assert raised.value is primary
    assert target.exists()
    assert any("row is missing" in note for note in primary.__notes__)


def test_success_with_damaged_target_transitions_failed_before_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    target = settings.backup_dir / "2026-01-10_123456"
    primary = OSError("primary failure")
    _raise_after_success(
        monkeypatch,
        primary,
        lambda: (target / "config.json").write_text("damaged"),
    )
    try:
        with pytest.raises(OSError) as raised:
            create_backup(connection, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert raised.value is primary
    assert status == "failed"
    assert not target.exists()


def test_compensation_update_failure_preserves_published_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _StatusFaultConnection(connection, fail_compensation=True),
    )
    target = settings.backup_dir / "2026-01-10_123456"
    primary = KeyboardInterrupt("primary interrupt")
    _raise_after_success(
        monkeypatch,
        primary,
        lambda: (target / "config.json").write_text("damaged"),
    )
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            create_backup(proxy, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert raised.value is primary
    assert status == "success"
    assert target.exists()
    assert any("compensation update failed" in note for note in primary.__notes__)


def test_compensation_readback_failure_preserves_published_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    connection = _connection(settings)
    proxy = cast(
        sqlite3.Connection,
        _StatusFaultConnection(connection, select_mode="second_fail"),
    )
    target = settings.backup_dir / "2026-01-10_123456"
    primary = SystemExit("primary exit")
    _raise_after_success(
        monkeypatch,
        primary,
        lambda: (target / "config.json").write_text("damaged"),
    )
    try:
        with pytest.raises(SystemExit) as raised:
            create_backup(proxy, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert raised.value is primary
    assert status == "failed"
    assert target.exists()
    assert any("status readback failed" in note for note in primary.__notes__)


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


def test_verify_backup_rejects_manifest_larger_than_limit(tmp_path: Path) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    manifest_path = backup_path / "manifest.json"
    with manifest_path.open("ab") as manifest_file:
        manifest_file.write(b" " * (backup_module._MAX_MANIFEST_BYTES + 1))

    with pytest.raises(ValueError, match="too large"):
        verify_backup(backup_path)


def test_manifest_entry_count_is_bounded() -> None:
    manifest = {
        "product": "SunYu ERP",
        "schema_version": 1,
        "created_at": NOW.isoformat(),
        "files": [{}] * (backup_module._MAX_MANIFEST_ENTRIES + 1),
    }

    with pytest.raises(ValueError, match="too many"):
        backup_module._validate_manifest(manifest)


def test_actual_file_count_limit_aborts_creation_and_cleans_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    project_file = settings.data_dir / "Projects/P-001/design.bin"
    project_file.parent.mkdir(parents=True)
    project_file.write_bytes(b"design")
    connection = _connection(settings)
    manifest_written = False
    real_write_manifest = backup_module._write_manifest

    def track_manifest_write(path: Path, manifest: dict[str, object]) -> None:
        nonlocal manifest_written
        manifest_written = True
        real_write_manifest(path, manifest)

    monkeypatch.setattr(backup_module, "_MAX_MANIFEST_ENTRIES", 2)
    monkeypatch.setattr(backup_module, "_write_manifest", track_manifest_write)
    try:
        with pytest.raises(ValueError, match="too many"):
            create_backup(connection, settings, now=NOW)
        status = connection.execute(
            "SELECT status FROM backup_runs ORDER BY id DESC"
        ).fetchone()[0]
    finally:
        connection.close()

    assert status == "failed"
    assert not manifest_written
    assert list(settings.backup_dir.glob(".incomplete-*")) == []


def test_actual_file_count_limit_aborts_verify_before_set_keeps_growing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    (backup_path / "unexpected.txt").write_text("unexpected")
    monkeypatch.setattr(backup_module, "_MAX_MANIFEST_ENTRIES", 2)

    with pytest.raises(ValueError, match="too many"):
        verify_backup(backup_path)


def test_file_set_mismatch_error_is_bounded(tmp_path: Path) -> None:
    backup_path, _ = _create_valid_backup(tmp_path)
    for index in range(20):
        (backup_path / f"unexpected-{index:02}.txt").write_text("unexpected")

    with pytest.raises(ValueError, match="unexpected_count=20") as raised:
        verify_backup(backup_path)

    message = str(raised.value)
    assert "unexpected-00.txt" in message
    assert "unexpected-09.txt" in message
    assert "unexpected-10.txt" not in message


def test_final_name_must_match_manifest_created_at_and_prune_keeps_mismatch(
    tmp_path: Path,
) -> None:
    template, settings = _create_valid_backup(tmp_path)
    mismatch = settings.backup_dir / "2026-01-01_000000"
    template.rename(mismatch)
    with pytest.raises(ValueError, match="name"):
        verify_backup(mismatch)

    _copy_managed_backup(
        mismatch,
        settings.backup_dir / "2026-01-09_000000",
        datetime(2026, 1, 9, tzinfo=timezone.utc),
    )
    _copy_managed_backup(
        mismatch,
        settings.backup_dir / "2026-01-08_000000",
        datetime(2026, 1, 8, tzinfo=timezone.utc),
    )

    removed = prune_backups(settings.backup_dir, retention_days=0, now=NOW)

    assert mismatch not in removed
    assert mismatch.exists()


def test_prune_deletes_only_expired_managed_backups_and_keeps_latest_two(
    tmp_path: Path,
) -> None:
    template, settings = _create_valid_backup(tmp_path)
    newest = settings.backup_dir / "2026-01-09_000000"
    template.rename(newest)
    _set_manifest_time(newest, datetime(2026, 1, 9, tzinfo=timezone.utc))
    for name in (
        "2026-01-01_000000",
        "2026-01-02_000000",
        "2026-01-03_000000",
    ):
        timestamp = datetime.strptime(name, "%Y-%m-%d_%H%M%S").replace(
            tzinfo=timezone.utc
        )
        _copy_managed_backup(newest, settings.backup_dir / name, timestamp)
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
    future = settings.backup_dir / "2026-02-01_000000"
    template.rename(future)
    _set_manifest_time(future, datetime(2026, 2, 1, tzinfo=timezone.utc))
    _copy_managed_backup(
        future,
        settings.backup_dir / "2025-01-01_000000",
        datetime(2025, 1, 1, tzinfo=timezone.utc),
    )

    assert prune_backups(settings.backup_dir, retention_days=0, now=NOW) == []
    assert {path.name for path in settings.backup_dir.iterdir()} == {
        "2025-01-01_000000",
        "2026-02-01_000000",
    }


def test_two_concurrent_prunes_do_not_race_or_report_missing_files(
    tmp_path: Path,
) -> None:
    template, settings = _create_valid_backup(tmp_path)
    newest = settings.backup_dir / "2026-01-09_000000"
    template.rename(newest)
    _set_manifest_time(newest, datetime(2026, 1, 9, tzinfo=timezone.utc))
    for day in (1, 2, 3):
        target = settings.backup_dir / f"2026-01-0{day}_000000"
        _copy_managed_backup(
            newest,
            target,
            datetime(2026, 1, day, tzinfo=timezone.utc),
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda _: prune_backups(
                    settings.backup_dir,
                    retention_days=0,
                    now=NOW,
                ),
                range(2),
            )
        )

    assert {path.name for result in results for path in result} == {
        "2026-01-01_000000",
        "2026-01-02_000000",
    }


def test_prune_waits_for_publish_and_success_recording(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    seed = _connection(settings)
    seed.close()
    success_entered = Event()
    release_success = Event()
    prune_started = Event()
    prune_inspected_final = Event()
    real_record_success = backup_module._record_successful_run
    real_verify = backup_module.verify_backup

    def pause_before_success(
        connection: sqlite3.Connection,
        run_id: int,
    ) -> None:
        success_entered.set()
        assert release_success.wait(timeout=5)
        real_record_success(connection, run_id)

    def create_one() -> Path:
        connection = connect_database(settings.data_dir / "iapm.sqlite")
        try:
            return create_backup(connection, settings, now=NOW)
        finally:
            connection.close()

    def prune_one() -> list[Path]:
        prune_started.set()
        return prune_backups(settings.backup_dir, retention_days=0, now=NOW)

    def track_final_verification(path: str | Path) -> dict[str, object]:
        if Path(path).name == "2026-01-10_123456":
            prune_inspected_final.set()
        return real_verify(path)

    monkeypatch.setattr(
        backup_module,
        "_record_successful_run",
        pause_before_success,
    )
    monkeypatch.setattr(backup_module, "verify_backup", track_final_verification)
    with ThreadPoolExecutor(max_workers=2) as executor:
        create_future = executor.submit(create_one)
        assert success_entered.wait(timeout=5)
        prune_future = executor.submit(prune_one)
        assert prune_started.wait(timeout=5)
        assert not prune_inspected_final.wait(timeout=0.1)
        assert not prune_future.done()
        release_success.set()
        backup_path = create_future.result(timeout=5)
        assert prune_future.result(timeout=5) == []

    assert backup_path.exists()
    assert verify_backup(backup_path)["product"] == "SunYu ERP"


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
