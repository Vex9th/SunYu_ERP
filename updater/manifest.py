from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from updater.storage import (
    component_path,
    read_installation,
    validate_version,
    write_json,
)

MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_FILE_COUNT = 10000
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_HASH = re.compile(r"[a-fA-F0-9]{64}\Z")
_RESERVED = re.compile(
    r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?\Z", re.IGNORECASE
)


class PackageError(ValueError):
    pass


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise PackageError("Duplicate JSON key")
        value[key] = item
    return value


def parse_json(data: bytes) -> Any:
    try:
        return json.loads(data, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError) as error:
        raise PackageError("Invalid JSON manifest") from error


def safe_relative_path(value: object) -> str:
    if not isinstance(value, str) or len(value) > 240 or not value:
        raise PackageError("Invalid file path")
    for part in value.split("/"):
        if (
            not part
            or part in {".", ".."}
            or part[-1:] in {".", " "}
            or any(ord(char) < 32 or char in '\\:<>"|?*' for char in part)
            or _RESERVED.fullmatch(part)
        ):
            raise PackageError("Unsafe file path")
    return value


def validate_manifest(value: Any, installation: dict) -> dict:
    if not isinstance(value, dict):
        raise PackageError("Invalid manifest")
    if value.get("application") != "SunYu_ERP" or value.get("component") not in (
        "frontend",
        "backend",
    ):
        raise PackageError("Unknown application or component")
    for key in ("format", "api_version", "runtime_version"):
        expected = 1 if key == "format" else installation[key]
        if type(value.get(key)) is not int or value[key] != expected:
            raise PackageError("Incompatible package protocol")
    try:
        validate_version(value.get("version"))
    except ValueError as error:
        raise PackageError(str(error)) from error
    files = value.get("files")
    if not isinstance(files, dict) or not files or len(files) > MAX_FILE_COUNT:
        raise PackageError("Invalid file manifest")
    normalized = set()
    for name, digest in files.items():
        safe_relative_path(name)
        if name.casefold() == ".update-manifest.json":
            raise PackageError("Reserved update metadata path")
        if name.casefold() in normalized:
            raise PackageError("Case-insensitive path collision")
        normalized.add(name.casefold())
        if not isinstance(digest, str) or not _HASH.fullmatch(digest):
            raise PackageError("Invalid file digest")
    if value["component"] == "frontend" and "index.html" not in files:
        raise PackageError("Frontend package lacks index.html")
    if value["component"] == "backend":
        if "backend/app/main.py" not in files or not any(
            name.startswith("backend/migrations/") for name in files
        ):
            raise PackageError("Backend package lacks application or migrations")
        if any(
            not name.startswith(("backend/app/", "backend/migrations/"))
            and name != "backend/__init__.py"
            for name in files
        ):
            raise PackageError(
                "Backend package may only contain application and migrations"
            )
    return value


def stage_package(
    root: Path,
    data: bytes,
    *,
    expected_component: str | None = None,
    expected_version: str | None = None,
    reuse_verified: bool = False,
) -> dict:
    """完整校验后一次性发布不可变目录；不切换活动版本。"""
    if len(data) > MAX_ARCHIVE_BYTES:
        raise PackageError("Archive exceeds size limit")
    root = Path(root)
    scratch = None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILE_COUNT + 1:
                raise PackageError("Archive has too many entries")
            names = set()
            total = 0
            for entry in entries:
                if entry.orig_filename != entry.filename:
                    raise PackageError("Invalid null character in archive path")
                name = safe_relative_path(entry.filename)
                mode = entry.external_attr >> 16
                if (
                    entry.is_dir()
                    or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                    or entry.flag_bits & 1
                ):
                    raise PackageError(
                        "Links, directories and encrypted entries are unsupported"
                    )
                if name.casefold() in names:
                    raise PackageError("Duplicate archive entry")
                names.add(name.casefold())
                total += entry.file_size
                if total > MAX_UNPACKED_BYTES:
                    raise PackageError("Archive exceeds unpacked size limit")
            info = archive.getinfo("manifest.json")
            if info.file_size > MAX_MANIFEST_BYTES:
                raise PackageError("Manifest exceeds size limit")
            manifest = validate_manifest(
                parse_json(archive.read(info)), read_installation(root)
            )
            if (
                expected_component is not None
                and manifest["component"] != expected_component
            ) or (
                expected_version is not None and manifest["version"] != expected_version
            ):
                raise PackageError("Downloaded package identity mismatch")
            expected = {
                "manifest.json",
                *("payload/" + name for name in manifest["files"]),
            }
            if {entry.filename for entry in entries} != expected:
                raise PackageError("Undeclared or missing archive file")
            target = component_path(root, manifest["component"], manifest["version"])
            if target.exists() and not reuse_verified:
                raise PackageError("Component version already exists")
            target.parent.mkdir(parents=True, exist_ok=True)
            scratch = Path(tempfile.mkdtemp(prefix=".stage-", dir=target.parent))
            for name, digest in manifest["files"].items():
                destination = scratch / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                hashed = hashlib.sha256()
                with (
                    archive.open("payload/" + name) as source,
                    destination.open("xb") as output,
                ):
                    while chunk := source.read(1024 * 1024):
                        hashed.update(chunk)
                        output.write(chunk)
                if hashed.hexdigest() != digest.lower():
                    raise PackageError("File hash mismatch")
            # 单独保存验证清单，安装前重新校验防止暂存版本被修改。
            write_json(scratch / ".update-manifest.json", manifest)
            if target.exists():
                if (
                    verify_staged(root, manifest["component"], manifest["version"])
                    != manifest
                ):
                    raise PackageError(
                        "Component version already exists with different content"
                    )
                return manifest
            scratch.rename(target)
            scratch = None
            return manifest
    except (OSError, KeyError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
        raise PackageError(f"Invalid update archive: {error}") from error
    finally:
        if scratch is not None:
            shutil.rmtree(scratch)


def verify_staged(root: Path, component: str, version: str) -> dict:
    directory = component_path(root, component, version)
    try:
        manifest = validate_manifest(
            parse_json((directory / ".update-manifest.json").read_bytes()),
            read_installation(root),
        )
        if manifest["component"] != component or manifest["version"] != version:
            raise PackageError("Staged manifest identity mismatch")
        actual = set()
        for path in directory.rglob("*"):
            if path.is_symlink():
                raise PackageError("Staged version contains a link")
            if path.is_file():
                actual.add(path.relative_to(directory).as_posix())
        if actual != {*manifest["files"], ".update-manifest.json"}:
            raise PackageError("Staged version contains undeclared or missing files")
        for name, digest in manifest["files"].items():
            path = directory / name
            with path.open("rb") as source:
                hashed = hashlib.file_digest(source, "sha256").hexdigest()
            if hashed != digest.lower():
                raise PackageError("Staged file was modified")
        return manifest
    except OSError as error:
        raise PackageError("Staged package is unavailable") from error
