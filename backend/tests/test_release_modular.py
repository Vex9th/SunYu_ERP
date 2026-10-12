from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT_ROOT / "scripts" / "build_modular.py"


@pytest.fixture
def builder():
    assert SCRIPT.is_file(), "模块化构建脚本尚未实现"
    spec = importlib.util.spec_from_file_location("build_modular", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def build_tree(tmp_path: Path):
    root = tmp_path / "源码 空间"
    files = {
        "backend/__init__.py": "",
        "backend/app/__init__.py": "",
        "backend/app/main.py": "def create_app(): pass\n",
        "backend/migrations/001_foundation.sql": "CREATE TABLE example(id INTEGER);",
        "backend/tests/test_private.py": "private test fixture",
        "backend/app/__pycache__/main.pyc": "private cache",
        "backend/app/.env": "private environment",
        "frontend/dist/index.html": '<script src="/__frontend/1.3.0/assets/app.js"></script>',
        "frontend/dist/assets/app.js": "console.log('release');",
        "frontend/dist/templates/import.xlsx": "public template",
        "frontend/dist/.env": "private frontend environment",
        "frontend/dist/assets/app.js.map": "private source map",
        "updater/__init__.py": "",
        "updater/runtime_entry.py": "print('runtime')\n",
        "updater/supervisor.py": "print('supervisor')\n",
        "updater/__pycache__/runtime_entry.pyc": "private cache",
        "Data/private.sqlite": "private customer data",
        "config.json": "private settings",
        "installation.json": '{"backend":"9.9.9"}',
        "start.bat": "SunYu_ERP.exe\n",
        "README.md": "public readme",
        "LICENSE": "public license",
        "config.example.json": "{}",
        "RELEASE_NOTES.md": "模块化更新。",
        "dist/SunYuRuntime/SunYuRuntime.exe": "runtime executable",
        "dist/SunYuRuntime/_internal/python313.dll": "python runtime",
        "dist/SunYuRuntime/Data/private.sqlite": "private runtime data",
        "dist/SunYu_ERP.exe": "launcher executable",
    }
    for name, content in files.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
    return root


def build(builder, root: Path, output: Path):
    return builder.build_release(
        root=root,
        version="1.3.0",
        output=output,
        runtime_dir=root / "dist" / "SunYuRuntime",
        launcher=root / "dist" / "SunYu_ERP.exe",
    )


def test_complete_package_keeps_business_and_bootstrap_external_without_private_files(
    builder, build_tree: Path, tmp_path: Path,
) -> None:
    output = tmp_path / "发布 中文"
    build(builder, build_tree, output)
    expected = {
        "SunYu_ERP.exe", "start.bat", "README.md", "LICENSE", "config.example.json",
        "installation.default.json", "runtime/SunYuRuntime.exe",
        "runtime/_internal/python313.dll", "updater/__init__.py",
        "updater/runtime_entry.py", "updater/supervisor.py",
        "releases/backend/1.3.0/backend/__init__.py",
        "releases/backend/1.3.0/backend/app/__init__.py",
        "releases/backend/1.3.0/backend/app/main.py",
        "releases/backend/1.3.0/backend/migrations/001_foundation.sql",
        "releases/frontend/1.3.0/index.html", "releases/frontend/1.3.0/assets/app.js",
        "releases/frontend/1.3.0/templates/import.xlsx",
    }
    stage = output / "SunYu_ERP"
    assert {p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()} == expected
    assert json.loads((stage / "installation.default.json").read_text(encoding="utf-8")) == {
        "format": 1, "backend": "1.3.0", "frontend": "1.3.0",
        "api_version": 1, "runtime_version": 1,
    }
    with zipfile.ZipFile(output / "SunYu_ERP-windows-x64.zip") as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == expected
        for name in expected:
            assert archive.read(name) == (stage / name).read_bytes()


@pytest.mark.parametrize("component", ["frontend", "backend"])
def test_component_manifest_declares_every_payload_hash_and_official_catalog(
    builder, build_tree: Path, tmp_path: Path, component: str,
) -> None:
    output = tmp_path / "publish"
    build(builder, build_tree, output)
    zip_name = f"SunYu_ERP-{component}-1.3.0.zip"
    with zipfile.ZipFile(output / zip_name) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert {k: v for k, v in manifest.items() if k != "files"} == {
            "format": 1, "application": "SunYu_ERP", "component": component,
            "version": "1.3.0", "api_version": 1, "runtime_version": 1,
        }
        assert manifest["files"]
        assert set(archive.namelist()) == {"manifest.json"} | {
            "payload/" + name for name in manifest["files"]
        }
        for name, digest in manifest["files"].items():
            assert hashlib.sha256(archive.read("payload/" + name)).hexdigest() == digest
    catalog = json.loads((output / "update-manifest.json").read_text(encoding="utf-8"))
    assert catalog["format"] == 1
    assert catalog["version"] == "1.3.0"
    assert catalog["notes"] == "模块化更新。"
    assert catalog["components"][component] == {
        "version": "1.3.0",
        "url": f"https://github.com/Vex9th/SunYu_ERP/releases/download/v1.3.0/{zip_name}",
        "sha256": hashlib.sha256((output / zip_name).read_bytes()).hexdigest(),
    }
    hashes = dict(line.split("  ", 1)[::-1] for line in (output / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines())
    assert set(hashes) == {
        "SunYu_ERP-windows-x64.zip", "SunYu_ERP-frontend-1.3.0.zip",
        "SunYu_ERP-backend-1.3.0.zip", "update-manifest.json",
    }
    for name, digest in hashes.items():
        assert hashlib.sha256((output / name).read_bytes()).hexdigest() == digest


def test_build_refuses_to_overwrite_an_existing_installation(builder, build_tree, tmp_path):
    output = tmp_path / "existing"
    installed = output / "SunYu_ERP"
    installed.mkdir(parents=True)
    original = installed / "installation.json"
    original.write_text("user active versions", encoding="utf-8")
    with pytest.raises(FileExistsError):
        build(builder, build_tree, output)
    assert original.read_text(encoding="utf-8") == "user active versions"
    assert list(output.iterdir()) == [installed]


@pytest.mark.parametrize("version", ["../1.3.0", "1.3.0/other", "v1.3.0", "1.3"])
def test_invalid_version_cannot_escape_output(builder, build_tree, tmp_path, version):
    with pytest.raises(ValueError, match="version"):
        builder.build_release(
            root=build_tree, version=version, output=tmp_path / "invalid",
            runtime_dir=build_tree / "dist/SunYuRuntime", launcher=build_tree / "dist/SunYu_ERP.exe",
        )
    assert not (tmp_path / "invalid").exists()


def test_wrong_frontend_build_version_is_rejected(builder, build_tree, tmp_path):
    (build_tree / "frontend/dist/index.html").write_text('<script src="/assets/app.js"></script>')
    with pytest.raises(ValueError, match="frontend"):
        build(builder, build_tree, tmp_path / "invalid")


def test_missing_runtime_is_rejected_before_creating_release(builder, build_tree, tmp_path):
    (build_tree / "dist/SunYuRuntime/SunYuRuntime.exe").unlink()
    with pytest.raises(FileNotFoundError):
        build(builder, build_tree, tmp_path / "invalid")
    assert not (tmp_path / "invalid").exists()


def test_build_does_not_follow_payload_symlinks(builder, build_tree, tmp_path):
    target = build_tree / "frontend/dist/private.js"
    try:
        target.symlink_to(build_tree / "config.json")
    except OSError:
        pytest.skip("Symlink creation requires developer mode on Windows")
    with pytest.raises(ValueError, match="symlink"):
        build(builder, build_tree, tmp_path / "invalid")


def test_cli_reports_missing_inputs_with_nonzero_exit(tmp_path):
    assert SCRIPT.is_file(), "模块化构建脚本尚未实现"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--version", "1.3.0", "--output", str(tmp_path / "output"),
         "--runtime-dir", str(tmp_path / "missing"), "--launcher", str(tmp_path / "missing.exe")],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode != 0
    assert "missing" in result.stderr
    assert not (tmp_path / "output").exists()
