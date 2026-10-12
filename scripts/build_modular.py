"""组装 Windows 目录包与独立更新包；不运行服务，不读取业务数据。"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = ("start.bat", "README.md", "LICENSE", "config.example.json")
FULL_PACKAGE = "SunYu_ERP-windows-x64.zip"
OFFICIAL_DOWNLOAD = "https://github.com/Vex9th/SunYu_ERP/releases/download"
EXCLUDED_PARTS = {"__pycache__", "tests", "test", "node_modules", "Data", "Backups"}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def source_files(directory: Path, suffix: str | None = None) -> list[Path]:
    if directory.is_symlink():
        raise ValueError(f"Refusing source symlink: {directory}")
    if not directory.is_dir():
        raise FileNotFoundError(directory)
    files = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if any(part.startswith(".") or part in EXCLUDED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError(f"Refusing payload symlink: {path}")
        if not path.is_file() or path.suffix in {".pyc", ".pyo", ".map"}:
            continue
        if path.name == "config.json" or path.name.startswith("test_"):
            continue
        if suffix is None or path.suffix == suffix:
            files.append(path)
    return files


def copy_file(source: Path, destination: Path) -> None:
    if source.is_symlink():
        raise ValueError(f"Refusing source symlink: {source}")
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def zip_directory(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())


def component_archive(source: Path, destination: Path, component: str, version: str) -> dict:
    files = {path.relative_to(source).as_posix(): path for path in sorted(source.rglob("*")) if path.is_file()}
    manifest = {
        "format": 1, "application": "SunYu_ERP", "component": component,
        "version": version, "api_version": 1, "runtime_version": 1,
        "files": {name: digest(path) for name, path in files.items()},
    }
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        for name, path in files.items():
            archive.write(path, "payload/" + name)
    return manifest


def build_release(*, root: Path, version: str, output: Path, runtime_dir: Path, launcher: Path) -> Path:
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("Invalid version: expected MAJOR.MINOR.PATCH without v")
    root, output = Path(root).resolve(), Path(output).resolve()
    runtime_dir, launcher = Path(runtime_dir).absolute(), Path(launcher).absolute()
    artifact_names = [
        "SunYu_ERP", FULL_PACKAGE, f"SunYu_ERP-frontend-{version}.zip",
        f"SunYu_ERP-backend-{version}.zip", "update-manifest.json", "SHA256SUMS.txt",
    ]
    for name in artifact_names:
        if (output / name).exists():
            raise FileExistsError(f"Refusing to overwrite existing output: {output / name}")

    required = [launcher, runtime_dir / "SunYuRuntime.exe", root / "backend/__init__.py",
                root / "backend/app/main.py", root / "frontend/dist/index.html",
                root / "updater/__init__.py", root / "updater/runtime_entry.py", root / "updater/supervisor.py"]
    required.extend(root / name for name in PUBLIC_FILES)
    for path in required:
        if path.is_symlink():
            raise ValueError(f"Refusing source symlink: {path}")
        if not path.is_file():
            raise FileNotFoundError(path)
    index = (root / "frontend/dist/index.html").read_text(encoding="utf-8")
    if f"/__frontend/{version}/" not in index:
        raise ValueError(f"Wrong frontend asset version; rebuild with SUNYU_VERSION={version}")

    trees = [
        (runtime_dir / "_internal", Path("runtime/_internal"), None),
        (root / "updater", Path("updater"), ".py"),
        (root / "backend/app", Path(f"releases/backend/{version}/backend/app"), ".py"),
        (root / "backend/migrations", Path(f"releases/backend/{version}/backend/migrations"), ".sql"),
        (root / "frontend/dist", Path(f"releases/frontend/{version}"), None),
    ]
    # 先检查所有输入，再建立输出，失败不会留下貌似完整的安装包。
    tree_files = [(source, target, source_files(source, suffix)) for source, target, suffix in trees]
    if not tree_files[3][2]:
        raise ValueError("Backend migrations are missing")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sunyu-build-", dir=output) as temporary:
        work = Path(temporary)
        stage = work / "SunYu_ERP"
        for source, target, files in tree_files:
            for path in files:
                copy_file(path, stage / target / path.relative_to(source))
        copy_file(launcher, stage / "SunYu_ERP.exe")
        copy_file(runtime_dir / "SunYuRuntime.exe", stage / "runtime/SunYuRuntime.exe")
        copy_file(root / "backend/__init__.py", stage / f"releases/backend/{version}/backend/__init__.py")
        for name in PUBLIC_FILES:
            copy_file(root / name, stage / name)
        write_json(stage / "installation.default.json", {
            "format": 1, "backend": version, "frontend": version,
            "api_version": 1, "runtime_version": 1,
        })

        components = {}
        for component in ("frontend", "backend"):
            archive = work / f"SunYu_ERP-{component}-{version}.zip"
            directory = stage / "releases" / component / version
            manifest = component_archive(directory, archive, component, version)
            # 完整包覆盖后也能通过同一组件包的严格校验，再由用户主动选择新版本。
            write_json(directory / ".update-manifest.json", manifest)
            components[component] = {
                "version": version, "url": f"{OFFICIAL_DOWNLOAD}/v{version}/{archive.name}",
                "sha256": digest(archive),
            }
        notes = root / "RELEASE_NOTES.md"
        write_json(work / "update-manifest.json", {
            "format": 1, "version": version,
            "notes": notes.read_text(encoding="utf-8").strip() if notes.is_file() else "",
            "components": components,
        })
        zip_directory(stage, work / FULL_PACKAGE)
        (work / "SHA256SUMS.txt").write_text(
            "".join(f"{digest(work / name)}  {name}\n" for name in artifact_names[1:-1]),
            encoding="utf-8",
        )
        for name in artifact_names:
            # 不允许覆盖用户已有安装目录或上一次已验证产物。
            if (output / name).exists():
                raise FileExistsError(output / name)
            (work / name).rename(output / name)
    return output / "SunYu_ERP"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="组件版本，例如 1.3.0")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "dist/modular")
    parser.add_argument("--runtime-dir", type=Path, default=PROJECT_ROOT / "dist/SunYuRuntime")
    parser.add_argument("--launcher", type=Path, default=PROJECT_ROOT / "dist/SunYu_ERP.exe")
    args = parser.parse_args()
    try:
        stage = build_release(root=PROJECT_ROOT, version=args.version, output=args.output,
                              runtime_dir=args.runtime_dir, launcher=args.launcher)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Build failed: {error}\n")
    print(f"Installation: {stage}\nArtifacts: {stage.parent}")


if __name__ == "__main__":
    main()
