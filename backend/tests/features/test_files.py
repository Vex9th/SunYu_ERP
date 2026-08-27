from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import BinaryIO, Self

import pytest

from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features import files


def _migrations_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations"


def _assert_no_work_files(data_dir: Path) -> None:
    temp_dir = data_dir / "Temp"
    if temp_dir.exists():
        assert list(temp_dir.iterdir()) == []
    projects_dir = data_dir / "Projects"
    if projects_dir.exists():
        assert not list(projects_dir.rglob(".version-*.reserve"))


def test_documents_migration_creates_tables_and_enforces_constraints(
    tmp_path: Path,
) -> None:
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert apply_migrations(connection, _migrations_dir()) == [
            "001_foundation",
            "002_documents",
        ]
        assert {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        } >= {"documents", "document_versions"}

        connection.execute(
            """
            INSERT INTO documents
                (id, project_code, category, logical_name, created_at)
            VALUES (1, 'PRJ-001', '图纸', '电气图', '2026-08-28T00:00:00+00:00')
            """
        )
        valid_version = (
            1,
            1,
            1,
            "drawing.dwg",
            "Projects/PRJ-001/图纸/file.dwg",
            123,
            "a" * 64,
            "2026-08-28T00:00:00+00:00",
        )
        connection.execute(
            "INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            valid_version,
        )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO documents
                    (project_code, category, logical_name, created_at)
                VALUES ('PRJ-001', '图纸', '电气图', '2026-08-28T00:00:00+00:00')
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO document_versions
                    (document_id, version_number, original_filename,
                     stored_relative_path, size_bytes, sha256, created_at)
                VALUES (999, 1, 'missing.dwg', 'missing', 1, ?, 'now')
                """,
                ("b" * 64,),
            )

        connection.execute("DELETE FROM documents WHERE id = 1")
        assert connection.execute(
            "SELECT COUNT(*) FROM document_versions"
        ).fetchone()[0] == 0
        for position, (column, invalid_value) in enumerate([
            ("version_number", 0),
            ("size_bytes", -1),
            ("sha256", "A" * 64),
            ("sha256", "a" * 63),
            ("sha256", "g" * 64),
        ]):
            values = list(valid_version)
            values[0] = None
            values[2] = 10 + position
            invalid_index = {
                "version_number": 2,
                "size_bytes": 5,
                "sha256": 6,
            }[column]
            values[invalid_index] = invalid_value
            values[4] = f"unique/{column}/{invalid_value}"
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    values,
                )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO document_versions
                    (document_id, version_number, original_filename,
                     stored_relative_path, size_bytes, sha256, created_at)
                VALUES (1, 2, 'duplicate.dwg', ?, 1, ?, 'now')
                """,
                (valid_version[4], "b" * 64),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO document_versions
                    (document_id, version_number, original_filename,
                     stored_relative_path, size_bytes, sha256, created_at)
                VALUES (1, 1, 'duplicate-version.dwg', 'unique/path', 1, ?, 'now')
                """,
                ("b" * 64,),
            )

        indexes = connection.execute("PRAGMA index_list(document_versions)").fetchall()
        assert any(
            row["unique"]
            and [
                column["name"]
                for column in connection.execute(
                    f"PRAGMA index_info('{row['name']}')"
                )
            ]
            == ["document_id", "version_number"]
            for row in indexes
        )
    finally:
        connection.close()


def test_stores_two_versions_with_hash_size_and_data_relative_paths(
    tmp_path: Path,
) -> None:
    source = tmp_path / "机械图纸.dwg"
    source.write_bytes(b"first-version")
    data_dir = tmp_path / "configured-data"

    first = files.store_version(source, data_dir, "PRJ-001", "机械设计")
    source.write_bytes(b"second-version")
    second = files.store_version(source, data_dir, "PRJ-001", "机械设计")

    assert (first.version_number, second.version_number) == (1, 2)
    assert first.path != second.path
    assert first.path.read_bytes() == b"first-version"
    assert second.path.read_bytes() == b"second-version"
    assert first.size_bytes == len(b"first-version")
    assert second.sha256 == hashlib.sha256(b"second-version").hexdigest()
    assert first.original_name == "机械图纸.dwg"
    assert first.path == (data_dir / first.relative_path).resolve()
    assert first.relative_path.parts[:3] == ("Projects", "PRJ-001", "机械设计")
    assert first.created_at.endswith("+00:00")
    assert first.path.is_absolute()
    _assert_no_work_files(data_dir)


@pytest.mark.parametrize("content", [b"", b"0123456789" * 30_000])
def test_streams_empty_and_multiblock_files(tmp_path: Path, content: bytes) -> None:
    source = tmp_path / "payload.bin"
    source.write_bytes(content)

    stored = files.store_version(source, tmp_path / "Data", "P-1", "现场图")

    assert stored.size_bytes == len(content)
    assert stored.sha256 == hashlib.sha256(content).hexdigest()
    assert stored.path.read_bytes() == content


@pytest.mark.parametrize(
    ("source_name", "expected"),
    [
        ('报价<>":|?*.xlsx', "报价_______.xlsx"),
        ("CON.txt", "_CON.txt"),
        ("中文文件. ", "中文文件"),
        ("control\x00\x1fname", "control__name"),
    ],
)
def test_sanitizes_windows_names_and_preserves_chinese(
    source_name: str,
    expected: str,
) -> None:
    sanitized = files._sanitize_filename(source_name)

    assert sanitized == expected
    assert not re.search(r'[<>:"|?*\\\x00-\x1f]', sanitized)
    assert not sanitized.endswith((".", " "))


@pytest.mark.parametrize(
    "unsafe_segment",
    [
        "",
        ".",
        "..",
        "/absolute",
        "C:\\absolute",
        "a/b",
        "a\\b",
        "a:b",
        "a?b",
        "trailing. ",
        "CON",
        "nul\0x",
        "line\nbreak",
    ],
)
@pytest.mark.parametrize("field", ["project_code", "category"])
def test_rejects_unsafe_path_segments(
    tmp_path: Path,
    unsafe_segment: str,
    field: str,
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("safe", encoding="utf-8")
    arguments = {"project_code": "P-1", "category": "图纸"}
    arguments[field] = unsafe_segment

    with pytest.raises(ValueError, match=field):
        files.store_version(source, tmp_path / "Data", **arguments)

    assert not (tmp_path / "Data").exists()


@pytest.mark.parametrize("source_kind", ["missing", "directory"])
def test_requires_existing_regular_source(tmp_path: Path, source_kind: str) -> None:
    source = tmp_path / "source"
    if source_kind == "directory":
        source.mkdir()

    with pytest.raises((FileNotFoundError, ValueError), match="source"):
        files.store_version(source, tmp_path / "Data", "P-1", "图纸")


def test_stable_source_symlink_is_allowed_and_copied(tmp_path: Path) -> None:
    source_target = tmp_path / "source-target.bin"
    source_target.write_bytes(b"stable-content")
    source_link = tmp_path / "source-link.bin"
    try:
        source_link.symlink_to(source_target)
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation is not available")

    stored = files.store_version(source_link, tmp_path / "Data", "P-1", "图纸")

    assert stored.original_name == "source-link.bin"
    assert stored.path.read_bytes() == b"stable-content"
    assert source_target.read_bytes() == b"stable-content"


@pytest.mark.parametrize("escape_at", ["Projects", "project", "category"])
def test_rejects_existing_destination_symlink_escape(
    tmp_path: Path,
    escape_at: str,
) -> None:
    data_dir = tmp_path / "Data"
    outside = tmp_path / "outside"
    outside.mkdir()
    data_dir.mkdir()
    projects = data_dir / "Projects"
    try:
        if escape_at == "Projects":
            projects.symlink_to(outside, target_is_directory=True)
        else:
            projects.mkdir()
            project = projects / "P-1"
            if escape_at == "project":
                project.symlink_to(outside, target_is_directory=True)
            else:
                project.mkdir()
                (project / "图纸").symlink_to(outside, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation is not available")
    source = tmp_path / "source.txt"
    source.write_text("secret", encoding="utf-8")

    with pytest.raises(ValueError, match="outside data_dir"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert list(outside.iterdir()) == []


def test_existing_version_is_never_overwritten(tmp_path: Path) -> None:
    data_dir = tmp_path / "Data"
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    category_dir.mkdir(parents=True)
    existing = category_dir / "20260828T000000000000Z_v000001_existing.txt"
    existing.write_bytes(b"must-survive")
    source = tmp_path / "source.txt"
    source.write_bytes(b"new")

    stored = files.store_version(source, data_dir, "P-1", "图纸")

    assert stored.version_number == 2
    assert existing.read_bytes() == b"must-survive"
    assert stored.path.read_bytes() == b"new"


@pytest.mark.parametrize("link_kind", ["reservation", "target"])
@pytest.mark.parametrize("failure_type", [OSError, KeyboardInterrupt, SystemExit])
def test_link_created_then_exception_cleans_and_reuses_version_one(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    link_kind: str,
    failure_type: type[BaseException],
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    original_link = os.link
    injection_enabled = True
    primary = failure_type(f"injected {link_kind} link failure")

    def link_then_fail(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        original_link(source_path, destination_path, *args, **kwargs)
        destination = Path(destination_path)
        is_reservation = destination.name.endswith(".reserve")
        if injection_enabled and is_reservation == (link_kind == "reservation"):
            raise primary

    monkeypatch.setattr(files.os, "link", link_then_fail)

    with pytest.raises(failure_type) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    assert list((data_dir / "Temp").iterdir()) == []
    assert list(category_dir.iterdir()) == []

    injection_enabled = False
    stored = files.store_version(source, data_dir, "P-1", "图纸")
    assert stored.version_number == 1
    assert stored.path.read_bytes() == b"content"
    _assert_no_work_files(data_dir)


@pytest.mark.parametrize("link_kind", ["reservation", "target"])
def test_replaced_link_is_not_deleted_or_overwritten(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    link_kind: str,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"our-content")
    data_dir = tmp_path / "Data"
    original_link = os.link
    replacement_content = b"other-owner"

    def link_then_replace(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        original_link(source_path, destination_path, *args, **kwargs)
        destination = (
            data_dir
            / "Projects"
            / "P-1"
            / "图纸"
            / Path(destination_path).name
        )
        is_reservation = destination.name.endswith(".reserve")
        if is_reservation == (link_kind == "reservation"):
            destination.unlink()
            destination.write_bytes(replacement_content)

    monkeypatch.setattr(files.os, "link", link_then_replace)

    with pytest.raises(RuntimeError, match="ownership"):
        files.store_version(source, data_dir, "P-1", "图纸")

    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    remaining = list(category_dir.iterdir())
    assert len(remaining) == 1
    assert remaining[0].read_bytes() == replacement_content
    assert list((data_dir / "Temp").iterdir()) == []


def test_primary_exception_survives_cleanup_failures_and_all_paths_are_tried(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    original_link = os.link
    original_unlink = os.unlink
    primary = KeyboardInterrupt("primary link interruption")
    cleanup = OSError("reservation cleanup failed after unlink")
    unlink_attempts: list[str] = []

    def link_target_then_interrupt(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        original_link(source_path, destination_path, *args, **kwargs)
        if not Path(destination_path).name.endswith(".reserve"):
            raise primary

    def unlink_with_recorded_failure(
        path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        name = Path(path).name
        unlink_attempts.append(name)
        original_unlink(path, *args, **kwargs)
        if name.endswith(".reserve"):
            raise cleanup

    monkeypatch.setattr(files.os, "link", link_target_then_interrupt)
    monkeypatch.setattr(files.os, "unlink", unlink_with_recorded_failure)

    with pytest.raises(KeyboardInterrupt) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert any("reservation cleanup failed" in note for note in primary.__notes__)
    assert any(name.endswith(".reserve") for name in unlink_attempts)
    assert any(name.startswith(".upload-") for name in unlink_attempts)
    assert any("_v000001_" in name for name in unlink_attempts)
    assert list((data_dir / "Temp").iterdir()) == []
    assert list((data_dir / "Projects" / "P-1" / "图纸").iterdir()) == []


def test_success_cleanup_failure_is_failfast_and_undoes_published_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    original_unlink = Path.unlink
    cleanup = OSError("temp cleanup failed after unlink")
    injection_enabled = True

    def unlink_temp_then_fail(
        path: Path,
        *args: object,
        **kwargs: object,
    ) -> None:
        nonlocal injection_enabled
        original_unlink(path, *args, **kwargs)
        if injection_enabled and path.name.startswith(".upload-"):
            injection_enabled = False
            raise cleanup

    monkeypatch.setattr(Path, "unlink", unlink_temp_then_fail)

    with pytest.raises(OSError) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is cleanup
    assert list((data_dir / "Temp").iterdir()) == []
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    assert list(category_dir.iterdir()) == []
    stored = files.store_version(source, data_dir, "P-1", "图纸")
    assert stored.version_number == 1


def test_file_exists_does_not_delete_another_reservation(tmp_path: Path) -> None:
    data_dir = tmp_path / "Data"
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    category_dir.mkdir(parents=True)
    other_reservation = category_dir / ".version-000000000001.reserve"
    other_reservation.write_bytes(b"owned-by-another-call")
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")

    stored = files.store_version(source, data_dir, "P-1", "图纸")

    assert stored.version_number == 2
    assert other_reservation.read_bytes() == b"owned-by-another-call"
    other_reservation.unlink()
    _assert_no_work_files(data_dir)


def test_two_threads_get_continuous_unique_versions_with_correct_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_dir = tmp_path / "Data"
    left_source = tmp_path / "left" / "same.bin"
    right_source = tmp_path / "right" / "same.bin"
    left_source.parent.mkdir()
    right_source.parent.mkdir()
    left_source.write_bytes(b"left-content")
    right_source.write_bytes(b"right-content")
    barrier = Barrier(2)
    original_next_version = files._next_bound_version

    def synchronized_scan(binding: files._BoundDirectory) -> int:
        version = original_next_version(binding)
        barrier.wait(timeout=10)
        return version

    monkeypatch.setattr(files, "_next_bound_version", synchronized_scan)

    def store(source: Path) -> files.StoredFileVersion:
        return files.store_version(source, data_dir, "P-1", "设计")

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(store, [left_source, right_source]))

    assert sorted(result.version_number for result in results) == [1, 2]
    assert len({result.path for result in results}) == 2
    assert {result.path.read_bytes() for result in results} == {
        b"left-content",
        b"right-content",
    }
    assert {
        result.sha256 for result in results
    } == {
        hashlib.sha256(b"left-content").hexdigest(),
        hashlib.sha256(b"right-content").hexdigest(),
    }
    _assert_no_work_files(data_dir)


def test_copy_failure_cleans_temp_and_version_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"

    def fail_copy(source_file: BinaryIO, destination: BinaryIO) -> tuple[int, str]:
        del source_file
        destination.write(b"partial")
        raise OSError("injected copy failure")

    monkeypatch.setattr(files, "_stream_copy", fail_copy)

    with pytest.raises(OSError, match="injected copy failure"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert source.read_bytes() == b"content"
    _assert_no_work_files(data_dir)
    assert not list((data_dir / "Projects").rglob("*"))


def test_staged_fstat_failure_closes_and_removes_mkstemp_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    primary = OSError("injected staged fstat failure")

    def fail_fstat(file_descriptor: int) -> os.stat_result:
        del file_descriptor
        raise primary

    monkeypatch.setattr(files.os, "fstat", fail_fstat)

    with pytest.raises(OSError) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert list((data_dir / "Temp").iterdir()) == []


def test_fdopen_primary_survives_close_failure_and_temp_is_removed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    primary = KeyboardInterrupt("injected fdopen failure")
    cleanup = OSError("injected descriptor close failure")
    original_close = os.close

    def fail_fdopen(file_descriptor: int, mode: str) -> BinaryIO:
        del file_descriptor, mode
        raise primary

    def close_then_fail(file_descriptor: int) -> None:
        original_close(file_descriptor)
        raise cleanup

    monkeypatch.setattr(files.os, "fdopen", fail_fdopen)
    monkeypatch.setattr(files.os, "close", close_then_fail)

    with pytest.raises(KeyboardInterrupt) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert any("descriptor close failed" in note for note in primary.__notes__)
    assert list((data_dir / "Temp").iterdir()) == []


def test_copy_primary_survives_both_handle_close_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    primary = KeyboardInterrupt("copy interrupted")
    source_close_failure = OSError("source close failed")
    temporary_close_failure = SystemExit("temporary close failed")
    original_fdopen = os.fdopen
    original_path_open = Path.open
    close_attempts: list[str] = []

    class CloseFailingFile:
        def __init__(
            self,
            handle: BinaryIO,
            label: str,
            failure: BaseException,
        ) -> None:
            self._handle = handle
            self._label = label
            self._failure = failure

        def __getattr__(self, name: str) -> object:
            return getattr(self._handle, name)

        def close(self) -> None:
            close_attempts.append(self._label)
            self._handle.close()
            raise self._failure

    def wrap_temporary(file_descriptor: int, mode: str) -> CloseFailingFile:
        return CloseFailingFile(
            original_fdopen(file_descriptor, mode),
            "temporary",
            temporary_close_failure,
        )

    def wrap_source(
        path: Path,
        mode: str = "r",
        *args: object,
        **kwargs: object,
    ) -> BinaryIO | CloseFailingFile:
        handle = original_path_open(path, mode, *args, **kwargs)
        if path == source and mode == "rb":
            return CloseFailingFile(handle, "source", source_close_failure)
        return handle

    def interrupt_copy(
        source_file: BinaryIO,
        destination: BinaryIO,
    ) -> tuple[int, str]:
        del source_file, destination
        raise primary

    monkeypatch.setattr(files.os, "fdopen", wrap_temporary)
    monkeypatch.setattr(Path, "open", wrap_source)
    monkeypatch.setattr(files, "_stream_copy", interrupt_copy)

    with pytest.raises(KeyboardInterrupt) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert close_attempts == ["source", "temporary"]
    assert any("source close failed" in note for note in primary.__notes__)
    assert any("temporary close failed" in note for note in primary.__notes__)
    assert list((data_dir / "Temp").iterdir()) == []


def test_copy_interruption_cleans_temp_without_publishing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"

    def interrupt_copy(
        source_file: BinaryIO,
        destination: BinaryIO,
    ) -> tuple[int, str]:
        del source_file
        destination.write(b"partial")
        raise KeyboardInterrupt

    monkeypatch.setattr(files, "_stream_copy", interrupt_copy)

    with pytest.raises(KeyboardInterrupt):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert source.read_bytes() == b"content"
    _assert_no_work_files(data_dir)


def test_fsync_failure_cleans_temp_and_version_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"

    def fail_fsync(file_descriptor: int) -> None:
        del file_descriptor
        raise OSError("injected fsync failure")

    monkeypatch.setattr(files.os, "fsync", fail_fsync)

    with pytest.raises(OSError, match="injected fsync failure"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert source.read_bytes() == b"content"
    _assert_no_work_files(data_dir)


@pytest.mark.parametrize("failure_type", [OSError, KeyboardInterrupt, SystemExit])
def test_flush_failure_cleans_temp_without_publishing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_type: type[BaseException],
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    primary = failure_type("injected flush failure")

    def fail_flush_and_sync(temporary_file: BinaryIO) -> None:
        temporary_file.flush()
        raise primary

    monkeypatch.setattr(files, "_flush_and_sync", fail_flush_and_sync)

    with pytest.raises(failure_type) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    _assert_no_work_files(data_dir)


def test_unsupported_hard_link_is_failfast_with_zero_residue(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    primary = OSError("hard links are unsupported")

    def fail_link(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        del source_path, destination_path, args, kwargs
        raise primary

    monkeypatch.setattr(files.os, "link", fail_link)

    with pytest.raises(OSError) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert list((data_dir / "Temp").iterdir()) == []
    assert list((data_dir / "Projects" / "P-1" / "图纸").iterdir()) == []


def test_same_size_and_mtime_source_inode_replacement_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"AAAA")
    initial_stat = source.stat()
    replacement = tmp_path / "replacement.bin"
    original_stream_copy = files._stream_copy

    def copy_then_replace_source(
        source_file: BinaryIO,
        destination: BinaryIO,
    ) -> tuple[int, str]:
        result = original_stream_copy(source_file, destination)
        replacement.write_bytes(b"BBBB")
        os.utime(
            replacement,
            ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns),
        )
        try:
            os.replace(replacement, source)
        except OSError:
            pytest.skip("platform cannot replace an open source file")
        return result

    monkeypatch.setattr(files, "_stream_copy", copy_then_replace_source)

    with pytest.raises(RuntimeError, match="source changed"):
        files.store_version(source, tmp_path / "Data", "P-1", "图纸")

    _assert_no_work_files(tmp_path / "Data")
    assert not list((tmp_path / "Data" / "Projects").rglob("*"))


def test_category_swapped_to_symlink_during_publish_is_detected_and_cleaned(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    outside = tmp_path / "outside"
    outside.mkdir()
    probe = tmp_path / "symlink-probe"
    try:
        probe.symlink_to(outside, target_is_directory=True)
        probe.unlink()
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation is not available")
    original_link = os.link
    swapped = False

    def swap_category_then_link(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        nonlocal swapped
        if not swapped:
            swapped = True
            category_dir = data_dir / "Projects" / "P-1" / "图纸"
            displaced = category_dir.with_name(f"{category_dir.name}-displaced")
            category_dir.rename(displaced)
            category_dir.symlink_to(outside, target_is_directory=True)
        original_link(source_path, destination_path, *args, **kwargs)

    monkeypatch.setattr(files.os, "link", swap_category_then_link)

    with pytest.raises(RuntimeError, match="outside data_dir"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert list(outside.iterdir()) == []
    assert list((data_dir / "Temp").iterdir()) == []


def test_category_rebound_after_reservation_leaves_no_old_directory_link(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    outside = tmp_path / "outside"
    outside.mkdir()
    probe = tmp_path / "symlink-probe"
    try:
        probe.symlink_to(outside, target_is_directory=True)
        probe.unlink()
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation is not available")
    original_link = os.link
    link_count = 0
    displaced: Path | None = None

    def rebind_before_target_link(
        source_path: os.PathLike[str],
        destination_path: os.PathLike[str],
        *args: object,
        **kwargs: object,
    ) -> None:
        nonlocal displaced, link_count
        link_count += 1
        if link_count == 2:
            category_dir = data_dir / "Projects" / "P-1" / "图纸"
            displaced = category_dir.with_name("图纸-displaced")
            category_dir.rename(displaced)
            category_dir.symlink_to(outside, target_is_directory=True)
        original_link(source_path, destination_path, *args, **kwargs)

    monkeypatch.setattr(files.os, "link", rebind_before_target_link)

    with pytest.raises(RuntimeError, match="outside data_dir|changed"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert displaced is not None
    assert list(displaced.iterdir()) == []
    assert list(outside.iterdir()) == []
    assert list((data_dir / "Temp").iterdir()) == []


def test_target_replaced_after_finalize_is_not_reported_as_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"our-content")
    data_dir = tmp_path / "Data"
    other_content = b""
    original_finalize = files._finalize_publication

    def finalize_then_replace(
        temporary_path: Path,
        temporary_identity: tuple[int, int],
        binding: files._BoundDirectory,
        reservation_name: str,
        target_name: str,
    ) -> None:
        original_finalize(
            temporary_path,
            temporary_identity,
            binding,
            reservation_name,
            target_name,
        )
        target = binding.path / target_name
        target.unlink()
        target.write_bytes(other_content)

    monkeypatch.setattr(files, "_finalize_publication", finalize_then_replace)

    with pytest.raises(RuntimeError, match="target.*integrity|ownership"):
        files.store_version(source, data_dir, "P-1", "图纸")

    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    remaining = list(category_dir.iterdir())
    assert len(remaining) == 1
    assert remaining[0].read_bytes() == other_content
    assert list((data_dir / "Temp").iterdir()) == []


def test_target_replaced_during_final_directory_check_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"our-content")
    data_dir = tmp_path / "Data"
    other_content = b"other-owner"
    original_require_current = files._BoundDirectory.require_current
    replacement_done = False

    def replace_during_final_directory_check(
        binding: files._BoundDirectory,
    ) -> None:
        nonlocal replacement_done
        original_require_current(binding)
        published = [
            candidate
            for candidate in binding.path.iterdir()
            if not candidate.name.startswith(".")
        ]
        reservations = list(binding.path.glob(".version-*.reserve"))
        if published and not reservations and not replacement_done:
            replacement_done = True
            published[0].unlink()
            published[0].write_bytes(other_content)

    monkeypatch.setattr(
        files._BoundDirectory,
        "require_current",
        replace_during_final_directory_check,
    )

    with pytest.raises(RuntimeError, match="target.*integrity|ownership"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert replacement_done
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    remaining = list(category_dir.iterdir())
    assert len(remaining) == 1
    assert remaining[0].read_bytes() == other_content
    assert list((data_dir / "Temp").iterdir()) == []


def test_target_read_primary_survives_close_failure_and_rolls_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"our-content")
    data_dir = tmp_path / "Data"
    primary = KeyboardInterrupt("target read interrupted")
    close_failure = SystemExit("target close failed")
    original_fdopen = os.fdopen
    target_close_attempted = False

    class ReadAndCloseFailingFile:
        def __init__(self, handle: BinaryIO) -> None:
            self._handle = handle

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *args: object) -> None:
            del args
            self.close()

        def read(self, size: int = -1) -> bytes:
            del size
            raise primary

        def close(self) -> None:
            nonlocal target_close_attempted
            target_close_attempted = True
            self._handle.close()
            raise close_failure

    def wrap_target_reader(
        file_descriptor: int,
        mode: str,
    ) -> BinaryIO | ReadAndCloseFailingFile:
        handle = original_fdopen(file_descriptor, mode)
        if mode == "rb":
            return ReadAndCloseFailingFile(handle)
        return handle

    monkeypatch.setattr(files.os, "fdopen", wrap_target_reader)

    with pytest.raises(KeyboardInterrupt) as caught:
        files.store_version(source, data_dir, "P-1", "图纸")

    assert caught.value is primary
    assert target_close_attempted
    assert any("target close failed" in note for note in primary.__notes__)
    assert list((data_dir / "Temp").iterdir()) == []
    assert list((data_dir / "Projects" / "P-1" / "图纸").iterdir()) == []


def test_source_change_during_copy_fails_without_publishing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"
    monkeypatch.setattr(files, "_source_is_unchanged", lambda *args: False)

    with pytest.raises(RuntimeError, match="source changed"):
        files.store_version(source, data_dir, "P-1", "图纸")

    _assert_no_work_files(data_dir)
    assert not list((data_dir / "Projects").rglob("*"))
