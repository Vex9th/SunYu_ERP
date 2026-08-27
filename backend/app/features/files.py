from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

_COPY_CHUNK_SIZE = 64 * 1024
_INVALID_WINDOWS_FILENAME_CHARACTERS = frozenset('<>:"/\\|?*')
_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
)
_VERSIONED_FILENAME = re.compile(
    r"^\d{8}T\d{12}Z_v(?P<version>\d+)_"
)
_FileIdentity = tuple[int, int]


@dataclass(frozen=True, slots=True)
class StoredFileVersion:
    path: Path
    relative_path: Path
    original_name: str
    version_number: int
    size_bytes: int
    sha256: str
    created_at: str


def store_version(
    source_path: str | Path,
    data_dir: str | Path,
    project_code: str,
    category: str,
) -> StoredFileVersion:
    _validate_path_segment(project_code, "project_code")
    _validate_path_segment(category, "category")
    source = Path(source_path)
    initial_source_stat = _require_regular_source(source)
    original_name = source.name
    sanitized_name = _sanitize_filename(original_name)

    data_root, temp_dir = _prepare_data_root(Path(data_dir))
    temporary_path, temporary_identity, size_bytes, sha256 = _stage_source(
        source,
        initial_source_stat,
        temp_dir,
    )
    try:
        category_dir = _prepare_category_directory(
            data_root,
            project_code,
            category,
        )
        created_at = datetime.now(timezone.utc)
        version_number, target_path = _publish_staged_file(
            temporary_path,
            temporary_identity,
            data_root,
            category_dir,
            sanitized_name,
            created_at,
        )
        relative_path = target_path.relative_to(data_root)
        return StoredFileVersion(
            path=target_path,
            relative_path=relative_path,
            original_name=original_name,
            version_number=version_number,
            size_bytes=size_bytes,
            sha256=sha256,
            created_at=created_at.isoformat(),
        )
    except BaseException as primary:
        _cleanup_after_failure(
            primary,
            temporary_path,
            temporary_identity,
        )
        raise


def _validate_path_segment(value: str, field: str) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if (
        not value
        or value in {".", ".."}
        or Path(value).is_absolute()
        or any(
            character in _INVALID_WINDOWS_FILENAME_CHARACTERS
            or _is_control(character)
            for character in value
        )
        or value.rstrip(". ") != value
        or value.split(".", maxsplit=1)[0].upper() in _WINDOWS_DEVICE_NAMES
    ):
        raise ValueError(f"{field} must be a safe single path segment")


def _require_regular_source(source: Path) -> os.stat_result:
    try:
        source_stat = source.stat()
    except FileNotFoundError:
        raise FileNotFoundError(f"source file does not exist: {source}") from None
    if not stat.S_ISREG(source_stat.st_mode):
        raise ValueError(f"source must be a regular file: {source}")
    return source_stat


def _prepare_data_root(data_dir: Path) -> tuple[Path, Path]:
    data_dir.mkdir(parents=True, exist_ok=True)
    data_root = data_dir.resolve(strict=True)
    if not data_root.is_dir():
        raise ValueError("data_dir must be a directory")
    temp_dir = _ensure_contained_directory(data_root, data_root / "Temp")
    projects_dir = data_root / "Projects"
    if projects_dir.exists() or projects_dir.is_symlink():
        _ensure_contained_directory(data_root, projects_dir)
    return data_root, temp_dir


def _prepare_category_directory(
    data_root: Path,
    project_code: str,
    category: str,
) -> Path:
    projects_dir = _ensure_contained_directory(data_root, data_root / "Projects")
    project_dir = _ensure_contained_directory(
        data_root,
        projects_dir / project_code,
    )
    return _ensure_contained_directory(data_root, project_dir / category)


def _stage_source(
    source: Path,
    initial_source_stat: os.stat_result,
    temp_dir: Path,
) -> tuple[Path, _FileIdentity, int, str]:
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=".upload-",
        suffix=".tmp",
        dir=temp_dir,
    )
    temporary_path = Path(temporary_name)
    try:
        temporary_identity = _file_identity(os.fstat(file_descriptor))
    except BaseException as primary:
        _cleanup_new_temporary_after_failure(
            primary,
            file_descriptor,
            temporary_path,
        )
        raise
    try:
        try:
            temporary_file = os.fdopen(file_descriptor, "wb")
        except BaseException as primary:
            _close_descriptor_after_failure(primary, file_descriptor)
            raise
        with temporary_file, source.open("rb") as source_file:
            opened_source_stat = os.fstat(source_file.fileno())
            size_bytes, sha256 = _stream_copy(source_file, temporary_file)
            _flush_and_sync(temporary_file)
            final_open_source_stat = os.fstat(source_file.fileno())

        if not _source_is_unchanged(
            source,
            initial_source_stat,
            opened_source_stat,
            final_open_source_stat,
        ):
            raise RuntimeError("source changed while it was being copied")
        return temporary_path, temporary_identity, size_bytes, sha256
    except BaseException as primary:
        _cleanup_after_failure(
            primary,
            temporary_path,
            temporary_identity,
        )
        raise


def _cleanup_new_temporary_after_failure(
    primary: BaseException,
    file_descriptor: int,
    temporary_path: Path,
) -> None:
    _close_descriptor_after_failure(primary, file_descriptor)
    try:
        temporary_path.unlink(missing_ok=True)
    except BaseException as cleanup_failure:  # noqa: BLE001 - keep primary
        primary.add_note(f"temporary file cleanup failed: {cleanup_failure}")


def _close_descriptor_after_failure(
    primary: BaseException,
    file_descriptor: int,
) -> None:
    try:
        os.close(file_descriptor)
    except BaseException as cleanup_failure:  # noqa: BLE001 - keep primary
        primary.add_note(f"descriptor close failed: {cleanup_failure}")


def _ensure_contained_directory(data_root: Path, directory: Path) -> Path:
    directory.mkdir(parents=False, exist_ok=True)
    resolved = directory.resolve(strict=True)
    if not resolved.is_dir() or not resolved.is_relative_to(data_root):
        raise ValueError(f"destination directory is outside data_dir: {directory.name}")
    return resolved


def _stream_copy(
    source_file: BinaryIO,
    destination: BinaryIO,
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size_bytes = 0
    while chunk := source_file.read(_COPY_CHUNK_SIZE):
        destination.write(chunk)
        digest.update(chunk)
        size_bytes += len(chunk)
    return size_bytes, digest.hexdigest()


def _flush_and_sync(temporary_file: BinaryIO) -> None:
    temporary_file.flush()
    os.fsync(temporary_file.fileno())


def _source_is_unchanged(
    source: Path,
    initial_path_stat: os.stat_result,
    opened_source_stat: os.stat_result,
    final_open_source_stat: os.stat_result,
) -> bool:
    try:
        final_path_stat = source.stat()
    except OSError:
        return False
    signatures = {
        _source_signature(initial_path_stat),
        _source_signature(opened_source_stat),
        _source_signature(final_open_source_stat),
        _source_signature(final_path_stat),
    }
    return len(signatures) == 1 and stat.S_ISREG(final_path_stat.st_mode)


def _source_signature(source_stat: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        source_stat.st_dev,
        source_stat.st_ino,
        source_stat.st_ctime_ns,
        source_stat.st_size,
        source_stat.st_mtime_ns,
    )


def _publish_staged_file(
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    data_root: Path,
    category_dir: Path,
    sanitized_name: str,
    created_at: datetime,
) -> tuple[int, Path]:
    category_identity = _file_identity(category_dir.stat())
    version_number = _next_published_version(category_dir)
    timestamp = created_at.strftime("%Y%m%dT%H%M%S%fZ")
    while True:
        _require_unchanged_contained_directory(
            data_root,
            category_dir,
            category_identity,
        )
        reservation = category_dir / f".version-{version_number:012d}.reserve"
        target: Path | None = None
        try:
            try:
                os.link(temporary_path, reservation)
            except FileExistsError:
                if _paths_share_owned_inode(
                    reservation,
                    temporary_path,
                    temporary_identity,
                ):
                    raise
                version_number += 1
                continue

            _require_owned_contained_link(
                data_root,
                temporary_path,
                temporary_identity,
                reservation,
            )
            _require_unchanged_contained_directory(
                data_root,
                category_dir,
                category_identity,
            )
            target = category_dir / (
                f"{timestamp}_v{version_number:06d}_{sanitized_name}"
            )
            try:
                os.link(temporary_path, target)
            except FileExistsError:
                if _paths_share_owned_inode(
                    target,
                    temporary_path,
                    temporary_identity,
                ):
                    raise
                _unlink_owned_path(
                    reservation,
                    temporary_path,
                    temporary_identity,
                )
                version_number += 1
                continue

            _require_owned_contained_link(
                data_root,
                temporary_path,
                temporary_identity,
                target,
            )
            _finalize_publication(
                temporary_path,
                temporary_identity,
                reservation,
                target,
            )
            return version_number, target
        except BaseException as primary:
            _cleanup_after_failure(
                primary,
                temporary_path,
                temporary_identity,
                reservation,
                target,
            )
            raise


def _require_unchanged_contained_directory(
    data_root: Path,
    directory: Path,
    expected_identity: _FileIdentity,
) -> None:
    resolved = directory.resolve(strict=True)
    if not resolved.is_relative_to(data_root):
        raise RuntimeError(f"destination directory is outside data_dir: {directory}")
    if _file_identity(resolved.stat()) != expected_identity:
        raise RuntimeError(f"destination directory changed during publish: {directory}")


def _require_owned_contained_link(
    data_root: Path,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    linked_path: Path,
) -> None:
    if not _paths_share_owned_inode(
        linked_path,
        temporary_path,
        temporary_identity,
    ):
        raise RuntimeError(f"linked path ownership changed: {linked_path}")
    resolved = linked_path.resolve(strict=True)
    if not resolved.is_relative_to(data_root):
        raise RuntimeError(f"linked path is outside data_dir: {linked_path}")


def _finalize_publication(
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    reservation: Path,
    target: Path,
) -> None:
    failures: list[tuple[str, BaseException]] = []
    reservation_failed = _capture_cleanup_failure(
        "reservation",
        reservation,
        temporary_path,
        temporary_identity,
        failures,
    )
    if reservation_failed:
        _capture_cleanup_failure(
            "target rollback",
            target,
            temporary_path,
            temporary_identity,
            failures,
        )

    temporary_failed = _capture_cleanup_failure(
        "temporary file",
        temporary_path,
        temporary_path,
        temporary_identity,
        failures,
    )
    if temporary_failed and not reservation_failed:
        _capture_cleanup_failure(
            "target rollback",
            target,
            temporary_path,
            temporary_identity,
            failures,
        )

    if failures:
        primary = failures[0][1]
        for label, failure in failures[1:]:
            primary.add_note(f"{label} cleanup failed: {failure}")
        raise primary


def _cleanup_after_failure(
    primary: BaseException,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    reservation: Path | None = None,
    target: Path | None = None,
) -> None:
    for label, path in (
        ("target", target),
        ("reservation", reservation),
        ("temporary file", temporary_path),
    ):
        if path is None:
            continue
        try:
            _unlink_owned_path(
                path,
                temporary_path,
                temporary_identity,
            )
        except BaseException as cleanup_failure:  # noqa: BLE001 - keep primary
            primary.add_note(f"{label} cleanup failed: {cleanup_failure}")


def _capture_cleanup_failure(
    label: str,
    path: Path,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    failures: list[tuple[str, BaseException]],
) -> bool:
    try:
        _unlink_owned_path(path, temporary_path, temporary_identity)
    except BaseException as failure:  # noqa: BLE001 - collect all cleanup failures
        failures.append((label, failure))
        return True
    return False


def _unlink_owned_path(
    path: Path,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
) -> None:
    try:
        path_stat = path.stat()
    except FileNotFoundError:
        return
    if _file_identity(path_stat) != temporary_identity:
        return
    if path != temporary_path and _path_has_identity(
        temporary_path,
        temporary_identity,
    ):
        try:
            if not path.samefile(temporary_path):
                return
        except FileNotFoundError:
            return
    path.unlink()


def _paths_share_owned_inode(
    path: Path,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
) -> bool:
    if not _path_has_identity(temporary_path, temporary_identity):
        return False
    try:
        return path.samefile(temporary_path)
    except FileNotFoundError:
        return False


def _path_has_identity(path: Path, expected_identity: _FileIdentity) -> bool:
    try:
        return _file_identity(path.stat()) == expected_identity
    except FileNotFoundError:
        return False


def _file_identity(file_stat: os.stat_result) -> _FileIdentity:
    return file_stat.st_dev, file_stat.st_ino


def _next_published_version(category_dir: Path) -> int:
    highest_version = 0
    for candidate in category_dir.iterdir():
        match = _VERSIONED_FILENAME.match(candidate.name)
        if match is not None:
            highest_version = max(highest_version, int(match.group("version")))
    return highest_version + 1


def _sanitize_filename(original_name: str) -> str:
    sanitized = "".join(
        "_"
        if character in _INVALID_WINDOWS_FILENAME_CHARACTERS
        or _is_control(character)
        else character
        for character in original_name
    ).rstrip(". ")
    if not sanitized:
        sanitized = "unnamed"
    device_name = sanitized.split(".", maxsplit=1)[0].upper()
    if device_name in _WINDOWS_DEVICE_NAMES:
        sanitized = f"_{sanitized}"
    return _truncate_filename(sanitized)


def _truncate_filename(filename: str, max_utf8_bytes: int = 120) -> str:
    encoded = filename.encode("utf-8")
    if len(encoded) <= max_utf8_bytes:
        return filename

    suffix = Path(filename).suffix
    suffix_bytes = suffix.encode("utf-8")
    if len(suffix_bytes) >= max_utf8_bytes // 2:
        suffix = ""
        suffix_bytes = b""
    available = max_utf8_bytes - len(suffix_bytes)
    stem = filename[: -len(suffix)] if suffix else filename
    while len(stem.encode("utf-8")) > available:
        stem = stem[:-1]
    return f"{stem}{suffix}" or "unnamed"


def _is_control(character: str) -> bool:
    return unicodedata.category(character) == "Cc"
