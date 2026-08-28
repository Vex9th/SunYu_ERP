"""Project file version storage for application-owned Data directories.

Concurrent ``store_version`` calls in this process are supported. While a call is
running, no external process may create, replace, rename, or delete entries below
``Data/Projects`` or ``Data/Temp``. Standard cross-platform filesystems do not
provide an atomic compare-inode-and-unlink operation, so cleanup ownership checks
are a best-effort guard inside that application-exclusive write boundary.
"""

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

from backend.app.core.storage_paths import normalize_project_code

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
_BOUND_DIRECTORY_SUPPORTED = hasattr(os, "O_DIRECTORY") and all(
    function in os.supports_dir_fd
    for function in (os.open, os.link, os.stat, os.unlink)
)


@dataclass(slots=True)
class _BoundDirectory:
    path: Path
    data_root: Path
    identity: _FileIdentity
    directory_fd: int | None = None
    windows_handle: int | None = None

    def require_current(self) -> None:
        resolved = self.path.resolve(strict=True)
        if not resolved.is_relative_to(self.data_root):
            raise RuntimeError(
                f"destination directory is outside data_dir: {self.path}"
            )
        if _file_identity(resolved.stat()) != self.identity:
            raise RuntimeError(
                f"destination directory changed during publish: {self.path}"
            )

    def names(self) -> list[str]:
        if self.directory_fd is not None:
            return os.listdir(self.directory_fd)
        return os.listdir(self.path)

    def link(self, source: Path, name: str) -> None:
        if self.directory_fd is not None:
            os.link(source, name, dst_dir_fd=self.directory_fd)
            return
        self.require_current()
        os.link(source, self.path / name)

    def stat(self, name: str) -> os.stat_result:
        if self.directory_fd is not None:
            return os.stat(name, dir_fd=self.directory_fd, follow_symlinks=False)
        return os.stat(self.path / name, follow_symlinks=False)

    def unlink(self, name: str) -> None:
        if self.directory_fd is not None:
            os.unlink(name, dir_fd=self.directory_fd)
            return
        os.unlink(self.path / name)

    def open_readonly(self, name: str) -> int:
        if self.directory_fd is not None:
            return os.open(name, os.O_RDONLY, dir_fd=self.directory_fd)
        return os.open(self.path / name, os.O_RDONLY)

    def close(self) -> None:
        if self.directory_fd is not None:
            directory_fd = self.directory_fd
            self.directory_fd = None
            os.close(directory_fd)
        if self.windows_handle is not None:
            windows_handle = self.windows_handle
            self.windows_handle = None
            _close_windows_directory_handle(windows_handle)


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
    """Copy one source version into an application-owned project directory.

    Calls from multiple threads in this process are safe. The caller must ensure
    external processes do not mutate ``Data/Projects`` or ``Data/Temp`` while
    versions are being stored.
    """
    project_code = normalize_project_code(project_code)
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
            size_bytes,
            sha256,
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
        source_file: BinaryIO | None = None
        operation_failure: BaseException | None = None
        try:
            source_file = source.open("rb")
            opened_source_stat = os.fstat(source_file.fileno())
            size_bytes, sha256 = _stream_copy(source_file, temporary_file)
            _flush_and_sync(temporary_file)
            final_open_source_stat = os.fstat(source_file.fileno())
        except BaseException as failure:  # noqa: BLE001 - preserve interrupts
            operation_failure = failure

        operation_failure = _close_stage_handles(
            operation_failure,
            source_file,
            temporary_file,
        )
        if operation_failure is not None:
            raise operation_failure.with_traceback(operation_failure.__traceback__)

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


def _close_stage_handles(
    primary: BaseException | None,
    source_file: BinaryIO | None,
    temporary_file: BinaryIO,
) -> BaseException | None:
    for label, file_handle in (
        ("source", source_file),
        ("temporary", temporary_file),
    ):
        if file_handle is None:
            continue
        try:
            file_handle.close()
        except BaseException as close_failure:  # noqa: BLE001 - close every handle
            if primary is None:
                primary = close_failure
            else:
                primary.add_note(f"{label} close failed: {close_failure}")
    return primary


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


def _source_signature(source_stat: os.stat_result) -> tuple[int, ...]:
    if os.name == "nt":
        return (
            source_stat.st_dev,
            source_stat.st_ino,
            source_stat.st_size,
            source_stat.st_mtime_ns,
        )
    return (
        source_stat.st_dev,
        source_stat.st_ino,
        source_stat.st_ctime_ns,
        source_stat.st_size,
        source_stat.st_mtime_ns,
    )


def _open_bound_directory(data_root: Path, category_dir: Path) -> _BoundDirectory:
    if os.name == "nt":
        windows_handle = _open_windows_directory_handle(category_dir)
        try:
            category_identity = _file_identity(category_dir.stat())
            binding = _BoundDirectory(
                category_dir,
                data_root,
                category_identity,
                windows_handle=windows_handle,
            )
        except BaseException as primary:
            try:
                _close_windows_directory_handle(windows_handle)
            except BaseException as close_failure:  # noqa: BLE001 - keep primary
                primary.add_note(f"directory binding close failed: {close_failure}")
            raise
    else:
        if not _BOUND_DIRECTORY_SUPPORTED:
            raise RuntimeError(
                "safe directory-bound file publishing is unsupported on this platform"
            )
        flags = os.O_RDONLY | os.O_DIRECTORY
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        directory_fd = os.open(category_dir, flags)
        try:
            category_identity = _file_identity(os.fstat(directory_fd))
            binding = _BoundDirectory(
                category_dir,
                data_root,
                category_identity,
                directory_fd=directory_fd,
            )
        except BaseException as primary:
            try:
                os.close(directory_fd)
            except BaseException as close_failure:  # noqa: BLE001 - keep primary
                primary.add_note(f"directory binding close failed: {close_failure}")
            raise
    try:
        binding.require_current()
    except BaseException as primary:
        try:
            binding.close()
        except BaseException as close_failure:  # noqa: BLE001 - keep primary
            primary.add_note(f"directory binding close failed: {close_failure}")
        raise
    return binding


def _open_windows_directory_handle(category_dir: Path) -> int:
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError as exc:  # pragma: no cover - Windows-only capability guard
        raise RuntimeError(
            "safe Windows directory binding is unavailable"
        ) from exc

    create_file = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    generic_read = 0x80000000
    share_read = 0x00000001
    share_write = 0x00000002
    open_existing = 3
    backup_semantics = 0x02000000
    handle = create_file(
        str(category_dir),
        generic_read,
        share_read | share_write,
        None,
        open_existing,
        backup_semantics,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle in (None, invalid_handle):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(handle)


def _close_windows_directory_handle(handle: int) -> None:
    import ctypes
    from ctypes import wintypes

    close_handle = ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    if not close_handle(wintypes.HANDLE(handle)):
        raise ctypes.WinError(ctypes.get_last_error())


def _publish_staged_file(
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    data_root: Path,
    category_dir: Path,
    sanitized_name: str,
    created_at: datetime,
    expected_size: int,
    expected_sha256: str,
) -> tuple[int, Path]:
    binding = _open_bound_directory(data_root, category_dir)
    try:
        result = _publish_in_bound_directory(
            temporary_path,
            temporary_identity,
            binding,
            sanitized_name,
            created_at,
            expected_size,
            expected_sha256,
        )
    except BaseException as primary:
        try:
            binding.close()
        except BaseException as close_failure:  # noqa: BLE001 - keep primary
            primary.add_note(f"directory binding close failed: {close_failure}")
        raise
    try:
        binding.close()
    except BaseException as close_failure:
        _cleanup_after_failure(
            close_failure,
            temporary_path,
            temporary_identity,
            target=result[1],
        )
        raise
    return result


def _publish_in_bound_directory(
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    binding: _BoundDirectory,
    sanitized_name: str,
    created_at: datetime,
    expected_size: int,
    expected_sha256: str,
) -> tuple[int, Path]:
    version_number = _next_bound_version(binding)
    timestamp = created_at.strftime("%Y%m%dT%H%M%S%fZ")
    while True:
        binding.require_current()
        reservation_name = f".version-{version_number:012d}.reserve"
        target_name: str | None = None
        try:
            try:
                binding.link(temporary_path, reservation_name)
            except FileExistsError:
                if _bound_name_has_identity(
                    binding,
                    reservation_name,
                    temporary_identity,
                ):
                    raise
                version_number += 1
                continue

            _require_bound_name_owned(
                binding,
                reservation_name,
                temporary_identity,
            )
            next_version = _next_bound_version(binding)
            if next_version > version_number:
                _unlink_bound_owned_name(
                    binding,
                    reservation_name,
                    temporary_identity,
                )
                version_number = next_version
                continue
            binding.require_current()
            target_name = (
                f"{timestamp}_v{version_number:06d}_{sanitized_name}"
            )
            try:
                binding.link(temporary_path, target_name)
            except FileExistsError:
                if _bound_name_has_identity(
                    binding,
                    target_name,
                    temporary_identity,
                ):
                    raise
                _unlink_bound_owned_name(
                    binding,
                    reservation_name,
                    temporary_identity,
                )
                version_number += 1
                continue

            _require_bound_name_owned(
                binding,
                target_name,
                temporary_identity,
            )
            binding.require_current()
            _require_final_target_integrity(
                binding,
                target_name,
                temporary_identity,
                expected_size,
                expected_sha256,
            )
            _complete_publication(
                temporary_path,
                temporary_identity,
                binding,
                reservation_name,
                target_name,
            )
            return version_number, binding.path / target_name
        except BaseException as primary:
            _cleanup_bound_after_failure(
                primary,
                binding,
                temporary_path,
                temporary_identity,
                reservation_name,
                target_name,
            )
            raise


def _require_bound_name_owned(
    binding: _BoundDirectory,
    name: str,
    temporary_identity: _FileIdentity,
) -> None:
    if not _bound_name_has_identity(binding, name, temporary_identity):
        raise RuntimeError(f"linked path ownership changed: {binding.path / name}")
    binding.require_current()


def _complete_publication(
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    binding: _BoundDirectory,
    reservation_name: str,
    target_name: str,
) -> None:
    failures: list[tuple[str, BaseException]] = []
    temporary_failed = _capture_cleanup_failure(
        "temporary file",
        temporary_path,
        temporary_path,
        temporary_identity,
        failures,
    )
    target_rollback_attempted = False
    if temporary_failed:
        _capture_bound_cleanup_failure(
            "target rollback",
            binding,
            target_name,
            temporary_identity,
            failures,
        )
        target_rollback_attempted = True
    reservation_failed = _capture_bound_cleanup_failure(
        "reservation",
        binding,
        reservation_name,
        temporary_identity,
        failures,
    )
    if reservation_failed and not target_rollback_attempted:
        _capture_bound_cleanup_failure(
            "target rollback",
            binding,
            target_name,
            temporary_identity,
            failures,
        )

    if failures:
        primary = failures[0][1]
        for label, failure in failures[1:]:
            primary.add_note(f"{label} cleanup failed: {failure}")
        raise primary


def _require_final_target_integrity(
    binding: _BoundDirectory,
    target_name: str,
    temporary_identity: _FileIdentity,
    expected_size: int,
    expected_sha256: str,
) -> None:
    if not _bound_name_has_identity(binding, target_name, temporary_identity):
        raise RuntimeError("target ownership or integrity changed before return")
    target_stat = binding.stat(target_name)
    if target_stat.st_size != expected_size:
        raise RuntimeError("target ownership or integrity changed before return")

    file_descriptor = binding.open_readonly(target_name)
    target_file: BinaryIO | None = None
    operation_failure: BaseException | None = None
    try:
        opened_stat = os.fstat(file_descriptor)
        digest = hashlib.sha256()
        target_file = os.fdopen(file_descriptor, "rb")
        file_descriptor = -1
        while chunk := target_file.read(_COPY_CHUNK_SIZE):
            digest.update(chunk)
    except BaseException as failure:  # noqa: BLE001 - preserve interrupts
        operation_failure = failure

    operation_failure = _close_target_reader(
        operation_failure,
        target_file,
        file_descriptor,
    )
    if operation_failure is not None:
        raise operation_failure.with_traceback(operation_failure.__traceback__)

    if (
        _file_identity(opened_stat) != temporary_identity
        or digest.hexdigest() != expected_sha256
        or not _bound_name_has_identity(
            binding,
            target_name,
            temporary_identity,
        )
    ):
        raise RuntimeError("target ownership or integrity changed before return")


def _close_target_reader(
    primary: BaseException | None,
    target_file: BinaryIO | None,
    file_descriptor: int,
) -> BaseException | None:
    try:
        if target_file is not None:
            target_file.close()
        elif file_descriptor >= 0:
            os.close(file_descriptor)
    except BaseException as close_failure:  # noqa: BLE001 - keep primary
        if primary is None:
            primary = close_failure
        else:
            primary.add_note(f"target close failed: {close_failure}")
    return primary


def _cleanup_bound_after_failure(
    primary: BaseException,
    binding: _BoundDirectory,
    temporary_path: Path,
    temporary_identity: _FileIdentity,
    reservation_name: str | None,
    target_name: str | None,
) -> None:
    for label, name in (
        ("target", target_name),
        ("reservation", reservation_name),
    ):
        if name is None:
            continue
        try:
            _unlink_bound_owned_name(binding, name, temporary_identity)
        except BaseException as cleanup_failure:  # noqa: BLE001 - keep primary
            primary.add_note(f"{label} cleanup failed: {cleanup_failure}")
    try:
        _unlink_owned_path(
            temporary_path,
            temporary_path,
            temporary_identity,
        )
    except BaseException as cleanup_failure:  # noqa: BLE001 - keep primary
        primary.add_note(f"temporary file cleanup failed: {cleanup_failure}")


def _capture_bound_cleanup_failure(
    label: str,
    binding: _BoundDirectory,
    name: str,
    temporary_identity: _FileIdentity,
    failures: list[tuple[str, BaseException]],
) -> bool:
    try:
        _unlink_bound_owned_name(binding, name, temporary_identity)
    except BaseException as failure:  # noqa: BLE001 - collect all cleanup failures
        failures.append((label, failure))
        return True
    return False


def _unlink_bound_owned_name(
    binding: _BoundDirectory,
    name: str,
    temporary_identity: _FileIdentity,
) -> None:
    # Data is application-exclusive while publishing. This inode check prevents
    # cooperative calls from deleting each other's entries; it is not an atomic
    # defense against an external process swapping the name before unlink.
    try:
        name_stat = binding.stat(name)
    except FileNotFoundError:
        return
    if _file_identity(name_stat) != temporary_identity:
        return
    binding.unlink(name)


def _bound_name_has_identity(
    binding: _BoundDirectory,
    name: str,
    expected_identity: _FileIdentity,
) -> bool:
    try:
        return _file_identity(binding.stat(name)) == expected_identity
    except FileNotFoundError:
        return False


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


def _path_has_identity(path: Path, expected_identity: _FileIdentity) -> bool:
    try:
        return _file_identity(path.stat()) == expected_identity
    except FileNotFoundError:
        return False


def _file_identity(file_stat: os.stat_result) -> _FileIdentity:
    return file_stat.st_dev, file_stat.st_ino


def _next_bound_version(binding: _BoundDirectory) -> int:
    highest_version = 0
    for name in binding.names():
        match = _VERSIONED_FILENAME.match(name)
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
