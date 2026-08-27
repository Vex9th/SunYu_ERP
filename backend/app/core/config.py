from __future__ import annotations

import json
import os
import secrets
import tempfile
from dataclasses import dataclass
from pathlib import Path

_ALLOWED_CONFIG_KEYS = frozenset(
    {
        "data_dir",
        "backup_dir",
        "backup_interval_hours",
        "backup_retention_days",
        "host",
        "port",
        "session_secret",
    }
)
_MISSING = object()


@dataclass(frozen=True, slots=True)
class Settings:
    config_path: Path
    data_dir: Path
    backup_dir: Path | None
    backup_interval_hours: int
    backup_retention_days: int
    host: str
    port: int
    session_secret: str


def load_settings(config_path: str | Path) -> Settings:
    resolved_config_path = Path(config_path).resolve()
    if resolved_config_path.exists():
        with resolved_config_path.open(encoding="utf-8") as config_file:
            loaded_config = json.load(config_file)
    else:
        loaded_config = {}

    raw_config = _validate_config(loaded_config)
    host = raw_config.get("host", "0.0.0.0")
    port = raw_config.get("port", 8765)
    config_dir = resolved_config_path.parent
    data_dir = _resolve_directory(
        "data_dir",
        config_dir,
        raw_config.get("data_dir", "Data"),
    )
    backup_value = raw_config.get("backup_dir")
    backup_dir = (
        _resolve_directory("backup_dir", config_dir, backup_value)
        if backup_value is not None
        else None
    )

    session_secret = raw_config.get("session_secret", _MISSING)
    if session_secret is _MISSING or (
        isinstance(session_secret, str) and not session_secret.strip()
    ):
        session_secret = secrets.token_urlsafe(32)
        raw_config["session_secret"] = session_secret
        _write_json_atomically(resolved_config_path, raw_config)

    return Settings(
        config_path=resolved_config_path,
        data_dir=data_dir,
        backup_dir=backup_dir,
        backup_interval_hours=raw_config.get("backup_interval_hours", 24),
        backup_retention_days=raw_config.get("backup_retention_days", 30),
        host=host,
        port=port,
        session_secret=session_secret,
    )


def _validate_config(loaded_config: object) -> dict[str, object]:
    if not isinstance(loaded_config, dict):
        raise TypeError("Config root must be a JSON object")

    unknown_keys = set(loaded_config) - _ALLOWED_CONFIG_KEYS
    if unknown_keys:
        unknown = ", ".join(sorted(str(key) for key in unknown_keys))
        raise ValueError(f"Unknown config key(s): {unknown}")

    host = loaded_config.get("host", "0.0.0.0")
    if not isinstance(host, str):
        raise TypeError("host must be a string")
    if not host.strip():
        raise ValueError("host must be a non-empty string")

    port = loaded_config.get("port", 8765)
    if isinstance(port, bool) or not isinstance(port, int):
        raise TypeError("port must be an integer")
    if not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")

    _validate_bounded_integer(
        loaded_config,
        "backup_interval_hours",
        default=24,
        minimum=1,
        maximum=8760,
    )
    _validate_bounded_integer(
        loaded_config,
        "backup_retention_days",
        default=30,
        minimum=0,
        maximum=3650,
    )

    session_secret = loaded_config.get("session_secret", _MISSING)
    if session_secret is not _MISSING and not isinstance(session_secret, str):
        raise TypeError("session_secret must be a string")

    return loaded_config


def _validate_bounded_integer(
    config: dict[str, object],
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> None:
    value = config.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")


def _resolve_directory(name: str, config_dir: Path, value: object) -> Path:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a path string")
    if not value.strip():
        raise ValueError(f"{name} must be a non-empty path string")
    path = Path(value)
    if not path.is_absolute():
        path = config_dir / path
    resolved_path = path.resolve()
    if resolved_path.exists() and not resolved_path.is_dir():
        raise ValueError(f"{name} must point to a directory")
    return resolved_path


def _write_json_atomically(config_path: Path, config: dict[str, object]) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=config_path.parent,
            prefix=f".{config_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            if os.name == "posix":
                temporary_path.chmod(0o600)
            json.dump(config, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, config_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
