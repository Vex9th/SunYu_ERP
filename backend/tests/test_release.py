from __future__ import annotations

import json
import re
import runpy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import release


def test_packaged_executable_includes_pinyin_runtime_dictionaries(monkeypatch) -> None:
    from PyInstaller.utils import hooks

    captured = {}

    def capture_analysis(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(pure=[], scripts=[], binaries=[], datas=kwargs["datas"])

    monkeypatch.setattr(hooks, "collect_submodules", lambda _name: [])
    root = Path(__file__).resolve().parents[2]
    runpy.run_path(str(root / "SunYu_ERP.spec"), init_globals={
        "SPECPATH": str(root), "Analysis": capture_analysis,
        "PYZ": lambda *_args: None, "EXE": lambda *_args, **_kwargs: None,
    })
    bundled = {Path(source).name for source, destination in captured["datas"]
               if destination == "pypinyin" and Path(source).is_file()}
    assert {"pinyin_dict.json", "phrases_dict.json"} <= bundled


def test_windows_runtime_declares_iana_timezone_database() -> None:
    requirements = (
        Path(__file__).resolve().parents[2] / "requirements.txt"
    ).read_text(encoding="utf-8")

    assert re.search(
        r"(?m)^tzdata[^;]*;\s*sys_platform\s*==\s*['\"]win32['\"]\s*$",
        requirements,
    )


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
    updates = captured.pop("update_manager")
    assert updates.root == paths.writable_root
    assert not updates.enabled
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
    application = SimpleNamespace(state=SimpleNamespace(updates=SimpleNamespace(enabled=False)))
    captured: dict[str, object] = {}

    monkeypatch.setattr(release, "create_release_app", lambda _: application)

    def capture_config(app: object, **kwargs: object) -> object:
        captured["app"] = app
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(release, "uvicorn", SimpleNamespace(
        Config=capture_config, Server=lambda _: SimpleNamespace(run=lambda: None),
    ))

    release.run_server(paths)

    assert captured == {
        "app": application,
        "host": "127.0.0.1",
        "port": 9123,
        "proxy_headers": False,
    }


def test_duplicate_server_exits_cleanly_and_keeps_original_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture,
) -> None:
    from backend.app.core.update_runtime import UpdateRuntime
    from backend.app.features.updates import UpdateManager

    paths = release.RuntimePaths(resource_root=tmp_path, writable_root=tmp_path)
    original_manager = UpdateManager(tmp_path, enabled=True)
    original = UpdateRuntime(original_manager, port=9123, shutdown=lambda: None)
    duplicate_manager = UpdateManager(tmp_path, enabled=True)
    application = SimpleNamespace(state=SimpleNamespace(updates=duplicate_manager))
    runs = []
    monkeypatch.setattr(release, "create_release_app", lambda _: application)
    monkeypatch.setattr(release, "load_settings", lambda _: SimpleNamespace(
        host="0.0.0.0", port=9123,
    ))
    monkeypatch.setattr(release, "uvicorn", SimpleNamespace(
        Config=lambda *_args, **_kwargs: None,
        Server=lambda _: SimpleNamespace(run=lambda: runs.append(True)),
    ))
    original.start()
    try:
        before = (original_manager.directory / "runtime.json").read_bytes()
        release.run_server(paths)
        assert runs == []
        assert (original_manager.directory / "runtime.json").read_bytes() == before
        assert "http://127.0.0.1:9123" in capsys.readouterr().out
    finally:
        original.close()


def test_runtime_start_failure_is_not_hidden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = SimpleNamespace(enabled=True)
    monkeypatch.setattr(release, "create_release_app", lambda _: SimpleNamespace(
        state=SimpleNamespace(updates=manager),
    ))
    monkeypatch.setattr(release, "load_settings", lambda _: SimpleNamespace(
        host="127.0.0.1", port=9123,
    ))
    monkeypatch.setattr(release, "uvicorn", SimpleNamespace(
        Config=lambda *_args, **_kwargs: None, Server=lambda _: None,
    ))

    class BrokenRuntime:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            raise OSError("cannot write runtime state")

        def close(self):
            pass

    monkeypatch.setattr(release, "UpdateRuntime", BrokenRuntime)
    with pytest.raises(OSError, match="cannot write runtime state"):
        release.run_server(release.RuntimePaths(tmp_path, tmp_path))
