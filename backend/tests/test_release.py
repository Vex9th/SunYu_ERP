from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import release


def test_resolve_runtime_paths_uses_source_directory_for_all_roots(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "源码 目录 含中文"
    module_file = source_root / "release.py"

    paths = release.resolve_runtime_paths(
        frozen=False,
        module_file=module_file,
    )

    assert paths.resource_root == source_root.resolve()
    assert paths.writable_root == source_root.resolve()
    assert paths.config_path == source_root.resolve() / "config.json"
    assert paths.migrations_dir == source_root.resolve() / "backend" / "migrations"
    assert paths.frontend_dist == source_root.resolve() / "frontend" / "dist"


def test_resolve_runtime_paths_keeps_frozen_resources_separate_from_writes(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "安装 目录 含中文" / "SunYu_ERP.exe"
    bundle_dir = tmp_path / "临时 解包 资源"

    paths = release.resolve_runtime_paths(
        frozen=True,
        executable=executable,
        bundle_dir=bundle_dir,
    )

    assert paths.resource_root == bundle_dir.resolve()
    assert paths.writable_root == executable.parent.resolve()
    assert paths.config_path == executable.parent.resolve() / "config.json"
    assert paths.migrations_dir == bundle_dir.resolve() / "backend" / "migrations"
    assert paths.frontend_dist == bundle_dir.resolve() / "frontend" / "dist"
    assert not paths.config_path.is_relative_to(paths.resource_root)


def test_resolve_runtime_paths_requires_meipass_when_frozen(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="_MEIPASS"):
        release.resolve_runtime_paths(
            frozen=True,
            executable=tmp_path / "SunYu_ERP.exe",
            bundle_dir=None,
        )


def test_create_release_app_passes_every_path_explicitly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = release.RuntimePaths(
        resource_root=tmp_path / "resources",
        writable_root=tmp_path / "writable",
    )
    sentinel = object()
    captured: dict[str, Any] = {}

    def capture_create_app(**kwargs: object) -> object:
        captured.update(kwargs)
        return sentinel

    monkeypatch.setattr(release, "create_app", capture_create_app)

    assert release.create_release_app(paths) is sentinel
    assert captured == {
        "config_path": paths.config_path,
        "migrations_dir": paths.migrations_dir,
        "frontend_dist": paths.frontend_dist,
    }


def test_run_server_reads_host_and_port_without_starting_real_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writable_root = tmp_path / "运行 目录 含中文"
    writable_root.mkdir()
    (writable_root / "config.json").write_text(
        json.dumps(
            {
                "data_dir": "Data",
                "host": "127.0.0.1",
                "port": 9123,
                "session_secret": "test-session-secret-with-at-least-32-bytes",
            }
        ),
        encoding="utf-8",
    )
    paths = release.RuntimePaths(
        resource_root=tmp_path / "resources",
        writable_root=writable_root,
    )
    application = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(release, "create_release_app", lambda _: application)

    def capture_run(app: object, **kwargs: object) -> None:
        captured["app"] = app
        captured.update(kwargs)

    monkeypatch.setattr(release, "uvicorn", SimpleNamespace(run=capture_run))

    release.run_server(paths)

    assert captured == {
        "app": application,
        "host": "127.0.0.1",
        "port": 9123,
    }
