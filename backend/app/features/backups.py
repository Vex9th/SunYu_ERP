"""Consistent local backups for the single-process SunYu ERP runtime.

The configured backup directory is a local filesystem directory. A sync client
may read it, but application code exclusively owns writes to each
``.incomplete-*`` staging directory while a backup is running.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import IO, Any, BinaryIO, TextIO

from backend.app.core.config import Settings

_PRODUCT = "SunYu ERP"
_SCHEMA_VERSION = 1
_COPY_CHUNK_SIZE = 64 * 1024
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024
_MAX_MANIFEST_ENTRIES = 100_000
_BACKUP_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
_BACKUP_LOCK = threading.RLock()
_FileIdentity = tuple[int, int]


def create_backup(
    connection: sqlite3.Connection,
    settings: Settings,
    *,
    now: datetime | None = None,
) -> Path:
    """Create, verify, and atomically publish one application backup."""
    created_at = _require_aware_datetime(now)
    target, run_id = _prepare_backup_attempt(connection, settings, created_at)
    stage_path = target.parent / f".incomplete-{uuid.uuid4().hex}"
    stage: Path | None = None
    try:
        _require_target_available(target)
        _make_private_directory(stage_path)
        stage = stage_path
        _populate_and_verify_stage(
            connection,
            settings,
            stage_path,
            created_at,
            run_id,
        )
    except BaseException as primary:
        with _BACKUP_LOCK:
            _handle_failed_creation(
                connection,
                run_id,
                primary,
                stage,
                target,
                None,
            )
        raise
    _publish_and_record_success(connection, run_id, stage_path, target)
    return target


def _prepare_backup_attempt(
    connection: sqlite3.Connection,
    settings: Settings,
    created_at: datetime,
) -> tuple[Path, int]:
    if settings.backup_dir is None:
        raise RuntimeError("backup_dir is not configured")
    if connection.isolation_level is not None:
        raise RuntimeError("backup connection must use autocommit isolation_level=None")
    if connection.in_transaction:
        raise RuntimeError("cannot create a backup inside a database transaction")
    projects_root = (settings.data_dir / "Projects").resolve()
    backup_candidate = settings.backup_dir.resolve()
    if backup_candidate.is_relative_to(projects_root):
        raise ValueError("backup_dir must not be inside Data/Projects")

    backup_root = _prepare_backup_root(settings.backup_dir)
    target = backup_root / created_at.strftime("%Y-%m-%d_%H%M%S")
    started_at = created_at.isoformat()
    run_id = connection.execute(
        """
        INSERT INTO backup_runs (started_at, status, target_path)
        VALUES (?, 'running', ?)
        """,
        (started_at, str(target)),
    ).lastrowid
    if run_id is None:
        raise RuntimeError("backup run did not receive an id")
    return target, run_id


def _publish_and_record_success(
    connection: sqlite3.Connection,
    run_id: int,
    stage: Path,
    target: Path,
) -> None:
    with _BACKUP_LOCK:
        published_identity: _FileIdentity | None = None
        try:
            published_identity = _publish_stage(stage, target)
            stage = None
            _record_successful_run(connection, run_id)
        except BaseException as primary:
            _handle_failed_creation(
                connection,
                run_id,
                primary,
                stage,
                target,
                published_identity,
            )
            raise


def verify_backup(path: str | Path) -> dict[str, object]:
    """Validate manifest structure, file set, sizes, hashes, and symlink safety."""
    manifest, _ = _verify_backup_contents(Path(path))
    return manifest


def _verify_backup_contents(path: Path) -> tuple[dict[str, object], datetime]:
    root = Path(path)
    if root.is_symlink():
        raise ValueError("backup root must not be a symlink")
    resolved_root = root.resolve(strict=True)
    if not resolved_root.is_dir():
        raise ValueError("backup path must be a directory")

    manifest_path = resolved_root / "manifest.json"
    _require_regular_unsymlinked_file(resolved_root, manifest_path)
    manifest = _read_manifest(manifest_path)
    entries, created_at = _validate_manifest(manifest)
    if not resolved_root.name.startswith(".incomplete-"):
        expected_name = created_at.strftime("%Y-%m-%d_%H%M%S")
        if resolved_root.name != expected_name:
            raise ValueError("backup directory name does not match manifest created_at")

    actual_files = _list_backup_files(resolved_root)
    expected_paths = set(entries)
    if actual_files != expected_paths:
        missing = sorted(expected_paths - actual_files)
        unexpected = sorted(actual_files - expected_paths)
        raise ValueError(
            "backup file set mismatch; "
            f"missing_count={len(missing)}, missing_sample={missing[:10]}, "
            f"unexpected_count={len(unexpected)}, unexpected_sample={unexpected[:10]}"
        )

    for relative_path, expected in entries.items():
        file_path = resolved_root.joinpath(*PurePosixPath(relative_path).parts)
        size_bytes, sha256 = _hash_verified_file(resolved_root, file_path)
        if size_bytes != expected["size"] or sha256 != expected["sha256"]:
            raise ValueError(f"backup file integrity check failed: {relative_path}")
    return manifest, created_at


def prune_backups(
    backup_dir: str | Path,
    retention_days: int,
    *,
    now: datetime | None = None,
) -> list[Path]:
    """Delete expired valid managed backups while always retaining two newest."""
    if isinstance(retention_days, bool) or not isinstance(retention_days, int):
        raise TypeError("retention_days must be an integer")
    if not 0 <= retention_days <= 3650:
        raise ValueError("retention_days must be between 0 and 3650")
    current_time = _require_aware_datetime(now)
    root = Path(backup_dir)
    if root.is_symlink():
        raise ValueError("backup_dir must be a non-symlink directory")
    if not root.exists():
        return []
    if not root.is_dir():
        raise ValueError("backup_dir must be a non-symlink directory")

    with _BACKUP_LOCK:
        managed: list[tuple[datetime, Path]] = []
        for candidate in root.iterdir():
            if not _BACKUP_NAME.fullmatch(candidate.name):
                continue
            try:
                candidate_stat = candidate.lstat()
                if not stat.S_ISDIR(candidate_stat.st_mode):
                    continue
                _, created_at = _verify_backup_contents(candidate)
            except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                continue
            managed.append((created_at, candidate))

        managed.sort(key=lambda item: (item[0], item[1].name), reverse=True)
        cutoff = current_time - timedelta(days=retention_days)
        removed: list[Path] = []
        for timestamp, candidate in managed[2:]:
            if timestamp >= cutoff:
                continue
            shutil.rmtree(candidate)
            removed.append(candidate)
        return removed


def _require_aware_datetime(value: datetime | None) -> datetime:
    result = datetime.now(timezone.utc) if value is None else value
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("now must include timezone information")
    return result


def _prepare_backup_root(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError("backup_dir must not be a symlink")
    already_existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    if not already_existed:
        _set_private_directory_mode(path)
    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("backup_dir must be a directory")
    return resolved


def _backup_database(
    connection: sqlite3.Connection,
    target: Path,
    run_id: int,
) -> None:
    _make_private_directory(target.parent)
    destination: sqlite3.Connection | None = None
    try:
        destination = sqlite3.connect(target)
        _set_private_file_mode(target)
        connection.backup(destination)
        _normalize_database_snapshot(destination, run_id)
        destination.close()
        destination = None
        _require_single_database_file(target)
        _validate_database_snapshot(target)
        _sync_file(target)
    except BaseException as primary:
        if destination is not None:
            try:
                destination.close()
            except BaseException as close_failure:  # noqa: BLE001
                primary.add_note(f"backup database close failed: {close_failure}")
        raise


def _populate_and_verify_stage(
    connection: sqlite3.Connection,
    settings: Settings,
    stage: Path,
    created_at: datetime,
    run_id: int,
) -> None:
    _backup_database(
        connection,
        stage / "database" / "iapm.sqlite",
        run_id,
    )
    _copy_file(settings.config_path, stage / "config.json")
    _copy_projects(settings.data_dir, stage / "Projects")
    manifest = _build_manifest(stage, created_at)
    _write_manifest(stage / "manifest.json", manifest)
    verify_backup(stage)


def _normalize_database_snapshot(
    destination: sqlite3.Connection,
    run_id: int,
) -> None:
    cursor = destination.execute(
        """
        UPDATE backup_runs
        SET finished_at = ?, status = 'success', error_message = NULL
        WHERE id = ? AND status = 'running'
        """,
        (datetime.now(timezone.utc).isoformat(), run_id),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("staged backup run was not normalized to success")
    destination.commit()
    destination.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    journal_mode = destination.execute("PRAGMA journal_mode=DELETE").fetchone()
    if journal_mode is None or str(journal_mode[0]).lower() != "delete":
        raise RuntimeError("staged database did not converge to DELETE journal mode")


def _require_single_database_file(database_path: Path) -> None:
    sidecars = [
        Path(f"{database_path}{suffix}")
        for suffix in ("-wal", "-shm", "-journal")
        if Path(f"{database_path}{suffix}").exists()
    ]
    if sidecars:
        raise RuntimeError("staged database retained SQLite sidecar files")


def _validate_database_snapshot(database_path: Path) -> None:
    checker: sqlite3.Connection | None = None
    primary: BaseException | None = None
    rows: list[tuple[str]] = []
    try:
        database_uri = database_path.resolve(strict=True).as_uri()
        checker = sqlite3.connect(f"{database_uri}?mode=ro", uri=True)
        rows = checker.execute("PRAGMA quick_check").fetchall()
        if rows != [("ok",)]:
            raise RuntimeError("staged database quick_check did not return exactly ok")
    except BaseException as failure:  # noqa: BLE001
        primary = failure
    if checker is not None:
        try:
            checker.close()
        except BaseException as close_failure:  # noqa: BLE001
            if primary is None:
                primary = close_failure
            else:
                primary.add_note(f"database verifier close failed: {close_failure}")
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)


def _record_successful_run(connection: sqlite3.Connection, run_id: int) -> None:
    cursor = connection.execute(
        """
        UPDATE backup_runs
        SET finished_at = ?, status = 'success', error_message = NULL
        WHERE id = ? AND status = 'running'
        """,
        (datetime.now(timezone.utc).isoformat(), run_id),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("backup run was not updated to success")


def _handle_failed_creation(
    connection: sqlite3.Connection,
    run_id: int,
    primary: BaseException,
    stage: Path | None,
    target: Path,
    published_identity: _FileIdentity | None,
) -> None:
    status = _read_run_status(connection, run_id, primary)
    confirmed_failed = status == "failed"
    if status == "success" and published_identity is not None:
        target_is_valid = _owned_backup_is_valid(
            target,
            published_identity,
            primary,
        )
        if not target_is_valid:
            confirmed_failed = _transition_run_to_failed(
                connection,
                run_id,
                "success",
                primary,
            )
    elif status == "success":
        confirmed_failed = _transition_run_to_failed(
            connection,
            run_id,
            "success",
            primary,
        )
    elif status == "running":
        confirmed_failed = _transition_run_to_failed(
            connection,
            run_id,
            "running",
            primary,
        )
    if published_identity is not None and confirmed_failed:
        try:
            _remove_owned_backup(target, published_identity)
        except BaseException as cleanup_failure:  # noqa: BLE001
            primary.add_note(f"published backup cleanup failed: {cleanup_failure}")
    if stage is not None:
        try:
            _remove_stage(stage)
        except BaseException as cleanup_failure:  # noqa: BLE001
            primary.add_note(f"backup staging cleanup failed: {cleanup_failure}")


def _read_run_status(
    connection: sqlite3.Connection,
    run_id: int,
    primary: BaseException,
) -> str | None:
    try:
        row = connection.execute(
            "SELECT status FROM backup_runs WHERE id = ?",
            (run_id,),
        ).fetchone()
    except BaseException as read_failure:  # noqa: BLE001
        primary.add_note(f"failed to read backup run status: {read_failure}")
        return None
    if row is None:
        primary.add_note("failed to read backup run status: row is missing")
        return None
    status = str(row[0])
    if status not in {"running", "success", "failed"}:
        primary.add_note(f"failed to read backup run status: unknown status {status!r}")
        return None
    return status


def _transition_run_to_failed(
    connection: sqlite3.Connection,
    run_id: int,
    expected_status: str,
    primary: BaseException,
) -> bool:
    if not _record_failed_run(
        connection,
        run_id,
        primary,
        expected_status=expected_status,
    ):
        return False
    status = _read_run_status(connection, run_id, primary)
    if status != "failed":
        primary.add_note(
            f"failed to confirm backup compensation: status is {status!r}"
        )
        return False
    return True


def _owned_backup_is_valid(
    target: Path,
    identity: _FileIdentity,
    primary: BaseException,
) -> bool:
    if not _path_has_identity(target, identity):
        primary.add_note("published backup ownership changed before reconciliation")
        return False
    try:
        verify_backup(target)
    except BaseException as verification_failure:  # noqa: BLE001
        primary.add_note(f"published backup verification failed: {verification_failure}")
        return False
    return True


def _make_private_directory(path: Path) -> None:
    created = False
    try:
        path.mkdir(mode=0o700)
        created = True
        _set_private_directory_mode(path)
    except BaseException as primary:
        if created:
            try:
                path.rmdir()
            except BaseException as cleanup_failure:  # noqa: BLE001
                primary.add_note(f"private directory cleanup failed: {cleanup_failure}")
        raise


def _set_private_directory_mode(path: Path) -> None:
    if os.name == "posix":
        path.chmod(0o700)


def _set_private_file_mode(path: Path) -> None:
    if os.name == "posix":
        path.chmod(0o600)


def _copy_projects(data_dir: Path, target: Path) -> None:
    projects = data_dir / "Projects"
    if projects.is_symlink():
        raise ValueError("Projects must not be a symlink")
    if not projects.exists():
        _make_private_directory(target)
        return
    if not projects.is_dir():
        raise ValueError("Projects must be a directory")
    _make_private_directory(target)
    _copy_directory_contents(projects.resolve(strict=True), target)


def _copy_directory_contents(source: Path, target: Path) -> None:
    with os.scandir(source) as entries:
        for entry in entries:
            source_path = Path(entry.path)
            destination_path = target / entry.name
            if entry.is_symlink():
                raise ValueError(f"source tree contains a symlink: {source_path}")
            if entry.is_dir(follow_symlinks=False):
                _make_private_directory(destination_path)
                _copy_directory_contents(source_path, destination_path)
                continue
            if not entry.is_file(follow_symlinks=False):
                raise ValueError(f"source tree contains a non-regular file: {source_path}")
            _copy_file(source_path, destination_path)


def _copy_file(source: Path, target: Path) -> tuple[int, str]:
    source_stat = source.lstat()
    if stat.S_ISLNK(source_stat.st_mode):
        raise ValueError(f"source file must not be a symlink: {source}")
    if not stat.S_ISREG(source_stat.st_mode):
        raise ValueError(f"source must be a regular file: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)

    source_file: BinaryIO | None = None
    target_file: BinaryIO | None = None
    primary: BaseException | None = None
    size_bytes = 0
    digest = hashlib.sha256()
    try:
        source_file = source.open("rb")
        opened_stat = os.fstat(source_file.fileno())
        target_file = target.open("xb")
        _set_private_file_mode(target)
        while chunk := source_file.read(_COPY_CHUNK_SIZE):
            target_file.write(chunk)
            digest.update(chunk)
            size_bytes += len(chunk)
        target_file.flush()
        os.fsync(target_file.fileno())
        final_stat = os.fstat(source_file.fileno())
        current_stat = source.stat()
        if not all(
            _file_signature(candidate) == _file_signature(source_stat)
            for candidate in (opened_stat, final_stat, current_stat)
        ):
            raise RuntimeError(f"source changed while being copied: {source}")
    except BaseException as failure:  # noqa: BLE001
        primary = failure

    primary = _close_files(primary, source_file, target_file)
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)
    return size_bytes, digest.hexdigest()


def _file_signature(value: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _close_files(
    primary: BaseException | None,
    *files: IO[Any] | None,
) -> BaseException | None:
    for file_handle in files:
        if file_handle is None:
            continue
        try:
            file_handle.close()
        except BaseException as close_failure:  # noqa: BLE001
            if primary is None:
                primary = close_failure
            else:
                primary.add_note(f"file close failed: {close_failure}")
    return primary


def _build_manifest(stage: Path, created_at: datetime) -> dict[str, object]:
    files: list[dict[str, object]] = []
    for relative_path in sorted(_list_backup_files(stage)):
        file_path = stage.joinpath(*PurePosixPath(relative_path).parts)
        size_bytes, sha256 = _hash_verified_file(stage, file_path)
        files.append(
            {"path": relative_path, "size": size_bytes, "sha256": sha256}
        )
    return {
        "product": _PRODUCT,
        "schema_version": _SCHEMA_VERSION,
        "created_at": created_at.isoformat(),
        "files": files,
    }


def _write_manifest(path: Path, manifest: dict[str, object]) -> None:
    manifest_file: TextIO | None = None
    primary: BaseException | None = None
    try:
        manifest_file = path.open("x", encoding="utf-8", newline="\n")
        _set_private_file_mode(path)
        json.dump(manifest, manifest_file, ensure_ascii=False, indent=2)
        manifest_file.write("\n")
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    except BaseException as failure:  # noqa: BLE001
        primary = failure
    primary = _close_files(primary, manifest_file)
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)


def _read_manifest(path: Path) -> dict[str, object]:
    if path.stat().st_size > _MAX_MANIFEST_BYTES:
        raise ValueError("manifest is too large")
    manifest_file: TextIO | None = None
    primary: BaseException | None = None
    manifest: object = None
    try:
        manifest_file = path.open(encoding="utf-8")
        manifest = json.load(manifest_file)
    except BaseException as failure:  # noqa: BLE001
        primary = failure
    primary = _close_files(primary, manifest_file)
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)
    if not isinstance(manifest, dict):
        raise ValueError(  # noqa: TRY004 - malformed external backup data
            "manifest root must be an object"
        )
    return manifest


def _publish_stage(stage: Path, target: Path) -> _FileIdentity:
    stage_identity = _file_identity(stage.lstat())
    with _BACKUP_LOCK:
        _require_target_available_unlocked(target)
        try:
            os.rename(stage, target)
            _sync_directory(target.parent)
        except BaseException as primary:
            if _path_has_identity(target, stage_identity):
                try:
                    _remove_owned_backup(target, stage_identity)
                except BaseException as cleanup_failure:  # noqa: BLE001
                    primary.add_note(
                        f"partially published backup cleanup failed: {cleanup_failure}"
                    )
            raise
    return stage_identity


def _require_target_available(target: Path) -> None:
    with _BACKUP_LOCK:
        _require_target_available_unlocked(target)


def _require_target_available_unlocked(target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"backup target already exists: {target}")


def _remove_owned_backup(path: Path, identity: _FileIdentity) -> None:
    if not _path_has_identity(path, identity):
        raise RuntimeError("refusing to remove a backup no longer owned by this run")
    shutil.rmtree(path)


def _path_has_identity(path: Path, identity: _FileIdentity) -> bool:
    try:
        return _file_identity(path.lstat()) == identity
    except FileNotFoundError:
        return False


def _file_identity(value: os.stat_result) -> _FileIdentity:
    return value.st_dev, value.st_ino


def _record_failed_run(
    connection: sqlite3.Connection,
    run_id: int,
    primary: BaseException,
    *,
    expected_status: str = "running",
) -> bool:
    try:
        cursor = connection.execute(
            """
            UPDATE backup_runs
            SET finished_at = ?, status = 'failed', error_message = ?
            WHERE id = ? AND status = ?
            """,
            (
                datetime.now(timezone.utc).isoformat(),
                f"{type(primary).__name__}: backup operation failed",
                run_id,
                expected_status,
            ),
        )
        if cursor.rowcount != 1:
            primary.add_note(
                f"failed to record backup failure: expected 1 row, got {cursor.rowcount}"
            )
            return False
    except BaseException as record_failure:  # noqa: BLE001
        primary.add_note(f"failed to record backup failure: {record_failure}")
        return False
    return True


def _remove_stage(stage: Path) -> None:
    if not stage.name.startswith(".incomplete-"):
        raise ValueError("refusing to remove a non-staging directory")
    if stage.is_symlink():
        stage.unlink()
    elif stage.exists():
        shutil.rmtree(stage)


def _validate_manifest(
    manifest: object,
) -> tuple[dict[str, dict[str, object]], datetime]:
    raw_files, created_at = _validate_manifest_header(manifest)
    entries: dict[str, dict[str, object]] = {}
    for raw_entry in raw_files:
        relative_path, entry = _validate_manifest_file_entry(raw_entry)
        if relative_path in entries:
            raise ValueError("manifest contains duplicate file paths")
        entries[relative_path] = entry
    if not {"config.json", "database/iapm.sqlite"}.issubset(entries):
        raise ValueError("manifest is missing required backup files")
    return entries, created_at


def _validate_manifest_header(manifest: object) -> tuple[list[object], datetime]:
    if not isinstance(manifest, dict):
        raise ValueError(  # noqa: TRY004 - malformed external backup data
            "manifest root must be an object"
        )
    if set(manifest) != {"product", "schema_version", "created_at", "files"}:
        raise ValueError("manifest contains missing or unexpected fields")
    if not isinstance(manifest["product"], str) or manifest["product"] != _PRODUCT:
        raise ValueError("manifest product is invalid")
    if (
        type(manifest["schema_version"]) is not int
        or manifest["schema_version"] != _SCHEMA_VERSION
    ):
        raise ValueError("manifest schema_version is invalid")
    created_at = manifest["created_at"]
    if not isinstance(created_at, str):
        raise ValueError(  # noqa: TRY004 - malformed external backup data
            "manifest created_at is invalid"
        )
    try:
        parsed_created_at = datetime.fromisoformat(created_at)
    except ValueError:
        raise ValueError("manifest created_at is invalid") from None
    if parsed_created_at.tzinfo is None or parsed_created_at.utcoffset() is None:
        raise ValueError("manifest created_at must include a timezone")

    raw_files = manifest["files"]
    if not isinstance(raw_files, list):
        raise ValueError(  # noqa: TRY004 - malformed external backup data
            "manifest files must be an array"
        )
    if len(raw_files) > _MAX_MANIFEST_ENTRIES:
        raise ValueError("manifest contains too many file entries")
    return raw_files, parsed_created_at


def _validate_manifest_file_entry(
    raw_entry: object,
) -> tuple[str, dict[str, object]]:
    if not isinstance(raw_entry, dict) or set(raw_entry) != {
        "path",
        "size",
        "sha256",
    }:
        raise ValueError("manifest file entry is invalid")
    relative_path = _validate_manifest_path(raw_entry["path"])
    size_bytes = raw_entry["size"]
    sha256 = raw_entry["sha256"]
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int):
        raise ValueError(  # noqa: TRY004 - malformed external backup data
            "manifest file size is invalid"
        )
    if size_bytes < 0:
        raise ValueError("manifest file size is invalid")
    if (
        not isinstance(sha256, str)
        or len(sha256) != 64
        or any(character not in "0123456789abcdef" for character in sha256)
    ):
        raise ValueError("manifest file sha256 is invalid")
    return relative_path, {"size": size_bytes, "sha256": sha256}


def _validate_manifest_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("manifest file path is invalid")
    pure_path = PurePosixPath(value)
    if (
        pure_path.is_absolute()
        or value != pure_path.as_posix()
        or any(part in {"", ".", ".."} for part in pure_path.parts)
        or value == "manifest.json"
    ):
        raise ValueError("manifest file path escapes the backup")
    return value


def _list_backup_files(root: Path) -> set[str]:
    files: set[str] = set()

    def visit(directory: Path) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                if entry.is_symlink():
                    raise ValueError(f"backup contains a symlink: {path}")
                if entry.is_dir(follow_symlinks=False):
                    visit(path)
                elif entry.is_file(follow_symlinks=False):
                    relative = path.relative_to(root).as_posix()
                    if relative != "manifest.json":
                        _validate_manifest_path(relative)
                        files.add(relative)
                        if len(files) > _MAX_MANIFEST_ENTRIES:
                            raise ValueError("backup contains too many files")
                else:
                    raise ValueError(f"backup contains a non-regular file: {path}")

    visit(root)
    return files


def _require_regular_unsymlinked_file(root: Path, path: Path) -> None:
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        current_stat = current.lstat()
        if stat.S_ISLNK(current_stat.st_mode):
            raise ValueError(f"backup contains a symlink: {current}")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"backup entry is not a regular file: {path}")


def _hash_verified_file(root: Path, path: Path) -> tuple[int, str]:
    _require_regular_unsymlinked_file(root, path)
    initial_stat = path.stat()
    digest = hashlib.sha256()
    size_bytes = 0
    source: BinaryIO | None = None
    primary: BaseException | None = None
    try:
        source = path.open("rb")
        opened_stat = os.fstat(source.fileno())
        while chunk := source.read(_COPY_CHUNK_SIZE):
            digest.update(chunk)
            size_bytes += len(chunk)
        final_stat = os.fstat(source.fileno())
    except BaseException as failure:  # noqa: BLE001
        primary = failure
    primary = _close_files(primary, source)
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)
    current_stat = path.stat()
    if not all(
        _file_signature(candidate) == _file_signature(initial_stat)
        for candidate in (opened_stat, final_stat, current_stat)
    ):
        raise RuntimeError(f"backup file changed while being verified: {path}")
    return size_bytes, digest.hexdigest()


def _sync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    _sync_and_close_descriptor(descriptor)


def _sync_and_close_descriptor(descriptor: int) -> None:
    primary: BaseException | None = None
    try:
        os.fsync(descriptor)
    except BaseException as failure:  # noqa: BLE001
        primary = failure
    try:
        os.close(descriptor)
    except BaseException as close_failure:  # noqa: BLE001
        if primary is None:
            primary = close_failure
        else:
            primary.add_note(f"descriptor close failed: {close_failure}")
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)


def _sync_directory(path: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY)
    _sync_and_close_descriptor(descriptor)
