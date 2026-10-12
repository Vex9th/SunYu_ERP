from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

_VERSION = re.compile(
    r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\Z"
)


def validate_version(value: object) -> str:
    if not isinstance(value, str) or len(value) > 100 or not _VERSION.fullmatch(value):
        raise ValueError("Invalid component version")
    return value


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, value: Any) -> None:
    """同目录写入并原子替换，避免断电留下半份状态文件。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_directory(path: Path) -> None:
    # Windows 的 Python 文件描述符不能 fsync 目录；文件内容仍逐个 FlushFileBuffers。
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_installation(root: Path) -> dict[str, Any]:
    value = read_json(Path(root) / "installation.json")
    if (
        not isinstance(value, dict)
        or type(value.get("format")) is not int
        or value["format"] != 1
    ):
        raise ValueError("Invalid installation manifest")
    for field in ("backend", "frontend"):
        validate_version(value.get(field))
    for field in ("api_version", "runtime_version"):
        if type(value.get(field)) is not int or value[field] != 1:
            raise ValueError("Unsupported installation protocol")
    return value


def component_path(root: Path, component: str, version: str) -> Path:
    if component not in {"frontend", "backend"}:
        raise ValueError("Invalid component")
    return Path(root) / "releases" / component / validate_version(version)
