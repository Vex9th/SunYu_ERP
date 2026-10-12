import ast
import importlib.util
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


project_root = Path(SPECPATH)


def external_dependencies():
    """分析外置源码的 import，避免把业务代码塞进固定运行环境。"""
    modules = set()
    for source_root in (project_root / "backend" / "app", project_root / "updater"):
        for source in source_root.rglob("*.py"):
            for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"), filename=str(source))):
                if isinstance(node, ast.Import):
                    modules.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                    if node.module.split(".")[0] in {"backend", "updater", "__future__"}:
                        continue
                    modules.add(node.module)
                    # from xml.etree import ElementTree 等子模块不会仅靠父包自动收集。
                    for alias in node.names:
                        candidate = f"{node.module}.{alias.name}"
                        try:
                            if importlib.util.find_spec(candidate) is not None:
                                modules.add(candidate)
                        except (ModuleNotFoundError, AttributeError, ValueError):
                            pass
    return {name for name in modules if name.split(".")[0] not in {"backend", "updater", "__future__"}}


hidden_imports = external_dependencies()
# Uvicorn 通过字符串加载服务实现；其余库的动态模块由收集和官方 hook 处理。
for package in ("uvicorn", "fastapi", "starlette", "argon2", "itsdangerous", "python_multipart", "openpyxl", "pypinyin"):
    hidden_imports.update(
        name for name in collect_submodules(package)
        if not any(part in {"tests", "test"} for part in name.split("."))
    )
runtime_data = collect_data_files("pypinyin", includes=["*.json"])
if importlib.util.find_spec("tzdata") is not None:
    hidden_imports.add("tzdata")
    runtime_data.extend(collect_data_files("tzdata"))

analysis = Analysis(
    [str(project_root / "updater" / "runtime_entry.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=runtime_data,
    hiddenimports=sorted(hidden_imports),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["backend", "updater"],
    noarchive=False,
    optimize=0,
)

python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="SunYuRuntime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="SunYuRuntime",
)
