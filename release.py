from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from backend.app.core.config import load_settings
from backend.app.core.update_runtime import ServiceAlreadyRunning, UpdateRuntime
from backend.app.features.updates import UpdateManager
from backend.app.main import create_app


@dataclass(frozen=True, slots=True)
class RuntimePaths:
    resource_root: Path
    writable_root: Path

    def __post_init__(self) -> None:
        object.__setattr__(self, "resource_root", self.resource_root.resolve())
        object.__setattr__(self, "writable_root", self.writable_root.resolve())

    @property
    def config_path(self) -> Path:
        return self.writable_root / "config.json"

    @property
    def migrations_dir(self) -> Path:
        return self.resource_root / "backend" / "migrations"

    @property
    def frontend_dist(self) -> Path:
        return self.resource_root / "frontend" / "dist"


def resolve_runtime_paths(
    *,
    frozen: bool | None = None,
    module_file: str | Path | None = None,
    executable: str | Path | None = None,
    bundle_dir: str | Path | None = None,
) -> RuntimePaths:
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        selected_bundle_dir = (
            getattr(sys, "_MEIPASS", None) if bundle_dir is None else bundle_dir
        )
        if selected_bundle_dir is None:
            raise RuntimeError("PyInstaller frozen runtime is missing _MEIPASS")
        selected_executable = sys.executable if executable is None else executable
        return RuntimePaths(
            resource_root=Path(selected_bundle_dir),
            writable_root=Path(selected_executable).parent,
        )

    selected_module_file = __file__ if module_file is None else module_file
    source_root = Path(selected_module_file).resolve().parent
    return RuntimePaths(resource_root=source_root, writable_root=source_root)


def create_release_app(paths: RuntimePaths) -> FastAPI:
    return create_app(
        update_manager=UpdateManager(
            paths.writable_root,
            enabled=sys.platform == "win32" and bool(getattr(sys, "frozen", False)),
        ),
        config_path=paths.config_path,
        migrations_dir=paths.migrations_dir,
        frontend_dist=paths.frontend_dist,
    )


def run_server(paths: RuntimePaths) -> None:
    application = create_release_app(paths)
    settings = load_settings(paths.config_path)
    server = uvicorn.Server(uvicorn.Config(
        application, host=settings.host, port=settings.port, proxy_headers=False,
    ))
    manager = application.state.updates
    runtime = UpdateRuntime(manager, port=settings.port,
                            shutdown=lambda: setattr(server, "should_exit", True))
    try:
        if manager.enabled:
            runtime.start()
        server.run()
    except ServiceAlreadyRunning:
        host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(settings.host, settings.host)
        if ":" in host:
            host = f"[{host}]"
        print(f"服务已在运行，请访问 http://{host}:{settings.port}；此次不会重复启动。")
    finally:
        if manager.enabled:
            runtime.close()


def main() -> None:
    run_server(resolve_runtime_paths())


if __name__ == "__main__":
    main()
