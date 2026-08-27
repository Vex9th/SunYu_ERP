from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import BinaryIO

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
    original_next_version = files._next_published_version

    def synchronized_scan(category_dir: Path) -> int:
        version = original_next_version(category_dir)
        barrier.wait(timeout=10)
        return version

    monkeypatch.setattr(files, "_next_published_version", synchronized_scan)

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


def test_replace_failure_cleans_temp_target_and_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"content")
    data_dir = tmp_path / "Data"

    def fail_replace(source_path: os.PathLike[str], target_path: os.PathLike[str]) -> None:
        del source_path, target_path
        raise OSError("injected replace failure")

    monkeypatch.setattr(files.os, "replace", fail_replace)

    with pytest.raises(OSError, match="injected replace failure"):
        files.store_version(source, data_dir, "P-1", "图纸")

    assert source.read_bytes() == b"content"
    _assert_no_work_files(data_dir)
    category_dir = data_dir / "Projects" / "P-1" / "图纸"
    assert list(category_dir.iterdir()) == []


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
