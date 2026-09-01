from __future__ import annotations

import json
import os
from dataclasses import FrozenInstanceError, fields
from pathlib import Path

import pytest

from backend.app.core import config as config_module
from backend.app.core.config import Settings, load_settings

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def write_config(config_path: Path, **values: object) -> None:
    config_path.write_text(
        json.dumps(values, ensure_ascii=False),
        encoding="utf-8",
    )


def test_settings_has_only_the_declared_frozen_fields(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    settings = load_settings(config_path)

    assert isinstance(settings, Settings)
    assert [field.name for field in fields(settings)] == [
        "config_path",
        "data_dir",
        "backup_dir",
        "backup_interval_hours",
        "backup_retention_days",
        "host",
        "port",
        "session_secret",
        "max_document_upload_mb",
    ]
    with pytest.raises(FrozenInstanceError):
        settings.port = 9000  # type: ignore[misc]


def test_missing_config_uses_relative_data_default_and_persists_secret(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "settings" / "config.json"

    first = load_settings(config_path)
    second = load_settings(config_path)

    assert first.config_path == config_path.resolve()
    assert first.data_dir == (config_path.parent / "Data").resolve()
    assert first.backup_dir is None
    assert first.backup_interval_hours == 24
    assert first.backup_retention_days == 30
    assert first.host == "0.0.0.0"
    assert first.port == 8765
    assert first.max_document_upload_mb == 4096
    assert len(first.session_secret) >= 32
    assert second.session_secret == first.session_secret
    assert config_path.is_file()
    assert not first.data_dir.exists()


def test_relative_paths_resolve_from_config_directory(tmp_path: Path) -> None:
    config_path = tmp_path / "settings" / "config.json"
    config_path.parent.mkdir()
    write_config(
        config_path,
        data_dir="runtime/data",
        backup_dir="runtime/backups",
        session_secret="test-secret",
    )

    settings = load_settings(config_path)

    assert settings.data_dir == (config_path.parent / "runtime/data").resolve()
    assert settings.backup_dir == (
        config_path.parent / "runtime/backups"
    ).resolve()


def test_absolute_backup_path_is_preserved(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    backup_dir = tmp_path / "external-backups"
    write_config(
        config_path,
        backup_dir=str(backup_dir),
        session_secret="test-secret",
    )

    settings = load_settings(config_path)

    assert settings.backup_dir == backup_dir.resolve()


def test_existing_config_without_secret_gets_one_persisted(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, host="127.0.0.1")

    first = load_settings(config_path)
    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    second = load_settings(config_path)

    assert persisted["host"] == "127.0.0.1"
    assert persisted["session_secret"] == first.session_secret
    assert second.session_secret == first.session_secret


def test_existing_config_with_blank_secret_gets_one_persisted(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, session_secret="  ")

    settings = load_settings(config_path)

    assert settings.session_secret.strip()
    assert json.loads(config_path.read_text(encoding="utf-8"))[
        "session_secret"
    ] == settings.session_secret


def test_secret_write_failure_keeps_original_and_removes_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, host="127.0.0.1")
    original_config = config_path.read_bytes()
    failure = OSError("injected fsync failure")

    def fail_fsync(_: int) -> None:
        raise failure

    monkeypatch.setattr("backend.app.core.config.os.fsync", fail_fsync)

    with pytest.raises(OSError) as raised:
        load_settings(config_path)

    assert raised.value is failure
    assert config_path.read_bytes() == original_config
    assert list(tmp_path.glob(f".{config_path.name}.*.tmp")) == []


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission contract")
def test_generated_secret_restricts_existing_config_to_owner_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, host="127.0.0.1")
    config_path.chmod(0o640)
    original_named_temporary_file = config_module.tempfile.NamedTemporaryFile

    def group_readable_named_temporary_file(*args, **kwargs):
        temporary_file = original_named_temporary_file(*args, **kwargs)
        os.chmod(temporary_file.name, 0o640)
        return temporary_file

    monkeypatch.setattr(
        config_module.tempfile,
        "NamedTemporaryFile",
        group_readable_named_temporary_file,
    )

    settings = load_settings(config_path)

    assert settings.session_secret
    assert config_path.stat().st_mode & 0o777 == 0o600


def test_invalid_json_fails_fast(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{invalid", encoding="utf-8")

    with pytest.raises(json.JSONDecodeError):
        load_settings(config_path)


@pytest.mark.parametrize("invalid_config", ([], "config", 42, None))
def test_non_object_config_fails_fast(
    tmp_path: Path,
    invalid_config: object,
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(invalid_config), encoding="utf-8")

    with pytest.raises(TypeError, match="JSON object"):
        load_settings(config_path)


def test_unknown_config_key_fails_fast(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, session_secret="test-secret", typo_port=8765)

    with pytest.raises(ValueError, match="Unknown config key.*typo_port"):
        load_settings(config_path)


@pytest.mark.parametrize("invalid_port", (True, False, 8765.0, "8765"))
def test_non_integer_port_fails_fast(tmp_path: Path, invalid_port: object) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        port=invalid_port,
        session_secret="test-secret",
    )

    with pytest.raises(TypeError, match="port"):
        load_settings(config_path)


@pytest.mark.parametrize(
    ("key", "invalid_value"),
    (
        ("backup_interval_hours", True),
        ("backup_interval_hours", 24.0),
        ("backup_interval_hours", "24"),
        ("backup_retention_days", False),
        ("backup_retention_days", 30.0),
        ("backup_retention_days", "30"),
    ),
)
def test_backup_periods_require_strict_integers(
    tmp_path: Path,
    key: str,
    invalid_value: object,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        **{key: invalid_value, "session_secret": "test-secret"},
    )

    with pytest.raises(TypeError, match=key):
        load_settings(config_path)


@pytest.mark.parametrize(
    ("key", "invalid_value"),
    (
        ("backup_interval_hours", 0),
        ("backup_interval_hours", 8761),
        ("backup_retention_days", -1),
        ("backup_retention_days", 3651),
    ),
)
def test_backup_periods_reject_out_of_range_values(
    tmp_path: Path,
    key: str,
    invalid_value: int,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        **{key: invalid_value, "session_secret": "test-secret"},
    )

    with pytest.raises(ValueError, match=key):
        load_settings(config_path)


def test_configured_backup_periods_are_loaded(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        backup_interval_hours=12,
        backup_retention_days=90,
        session_secret="test-secret",
    )

    settings = load_settings(config_path)

    assert settings.backup_interval_hours == 12
    assert settings.backup_retention_days == 90


def test_document_upload_limit_is_configurable_and_strict(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        max_document_upload_mb=512,
        session_secret="test-secret",
    )

    assert load_settings(config_path).max_document_upload_mb == 512

    for invalid in (False, 1.5, "512"):
        write_config(
            config_path,
            max_document_upload_mb=invalid,
            session_secret="test-secret",
        )
        with pytest.raises(TypeError, match="max_document_upload_mb"):
            load_settings(config_path)

    for invalid in (0, 16385):
        write_config(
            config_path,
            max_document_upload_mb=invalid,
            session_secret="test-secret",
        )
        with pytest.raises(ValueError, match="max_document_upload_mb"):
            load_settings(config_path)


def test_backup_settings_update_is_atomic_and_preserves_runtime_keys(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        data_dir="RuntimeData",
        host="127.0.0.1",
        port=9000,
        session_secret="secret-that-must-be-preserved",
    )

    settings = config_module.update_backup_settings(
        config_path,
        directory="Synology/ERP",
        interval_hours=12,
        retention_days=90,
    )

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted == {
        "data_dir": "RuntimeData",
        "host": "127.0.0.1",
        "port": 9000,
        "session_secret": "secret-that-must-be-preserved",
        "backup_dir": "Synology/ERP",
        "backup_interval_hours": 12,
        "backup_retention_days": 90,
    }
    assert settings.backup_dir == (tmp_path / "Synology/ERP").resolve()
    assert settings.session_secret == "secret-that-must-be-preserved"


def test_backup_settings_update_can_disable_directory(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        backup_dir="old-backups",
        session_secret="secret-that-must-be-preserved",
    )

    settings = config_module.update_backup_settings(
        config_path,
        directory=None,
        interval_hours=24,
        retention_days=30,
    )

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["backup_dir"] is None
    assert settings.backup_dir is None
    assert settings.session_secret == "secret-that-must-be-preserved"


def test_backup_settings_update_failure_preserves_original_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        backup_dir="old-backups",
        session_secret="secret-that-must-be-preserved",
    )
    original = config_path.read_bytes()
    failure = OSError("injected config fsync failure")

    def fail_fsync(_: int) -> None:
        raise failure

    monkeypatch.setattr(config_module.os, "fsync", fail_fsync)

    with pytest.raises(OSError) as raised:
        config_module.update_backup_settings(
            config_path,
            directory="new-backups",
            interval_hours=12,
            retention_days=60,
        )

    assert raised.value is failure
    assert config_path.read_bytes() == original
    assert list(tmp_path.glob(f".{config_path.name}.*.tmp")) == []


def test_backup_settings_update_strips_directory_before_persisting(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, session_secret="test-secret")

    settings = config_module.update_backup_settings(
        config_path,
        directory="  Synology/ERP  ",
        interval_hours=12,
        retention_days=60,
    )

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["backup_dir"] == "Synology/ERP"
    assert settings.backup_dir == (tmp_path / "Synology/ERP").resolve()


def test_load_rejects_backup_directory_inside_projects(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        data_dir="Data",
        backup_dir="Data/Projects/Backups",
        session_secret="test-secret",
    )

    with pytest.raises(ValueError, match="Data/Projects"):
        load_settings(config_path)


def test_update_rejects_backup_directory_inside_projects_without_writing(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        data_dir="Data",
        session_secret="test-secret",
    )
    original = config_path.read_bytes()

    with pytest.raises(ValueError, match="Data/Projects"):
        config_module.update_backup_settings(
            config_path,
            directory="Data/Projects/Backups",
            interval_hours=12,
            retention_days=60,
        )

    assert config_path.read_bytes() == original


@pytest.mark.parametrize("invalid_port", (0, 65536))
def test_out_of_range_port_fails_fast(
    tmp_path: Path,
    invalid_port: int,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        port=invalid_port,
        session_secret="test-secret",
    )

    with pytest.raises(ValueError, match="port"):
        load_settings(config_path)


@pytest.mark.parametrize("invalid_host", ("", "   "))
def test_empty_host_fails_fast(tmp_path: Path, invalid_host: str) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        host=invalid_host,
        session_secret="test-secret",
    )

    with pytest.raises(ValueError, match="host"):
        load_settings(config_path)


@pytest.mark.parametrize("invalid_host", (None, 123))
def test_non_string_host_fails_fast(
    tmp_path: Path,
    invalid_host: object,
) -> None:
    config_path = tmp_path / "config.json"
    write_config(
        config_path,
        host=invalid_host,
        session_secret="test-secret",
    )

    with pytest.raises(TypeError, match="host"):
        load_settings(config_path)


def test_non_string_session_secret_fails_fast(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config(config_path, session_secret=123)

    with pytest.raises(TypeError, match="session_secret"):
        load_settings(config_path)


@pytest.mark.parametrize("directory_key", ("data_dir", "backup_dir"))
def test_configured_directory_cannot_point_to_file(
    tmp_path: Path,
    directory_key: str,
) -> None:
    config_path = tmp_path / "config.json"
    regular_file = tmp_path / "not-a-directory"
    regular_file.write_text("file", encoding="utf-8")
    write_config(
        config_path,
        **{directory_key: regular_file.name, "session_secret": "test-secret"},
    )

    with pytest.raises(ValueError, match=directory_key):
        load_settings(config_path)


def test_example_config_contains_no_secret_or_private_absolute_path() -> None:
    example_path = PROJECT_ROOT / "config.example.json"
    raw_config = example_path.read_text(encoding="utf-8")
    example = json.loads(raw_config)

    assert "session_secret" not in example
    assert all(
        not Path(value).is_absolute()
        for key, value in example.items()
        if key in {"data_dir", "backup_dir"} and value is not None
    )
