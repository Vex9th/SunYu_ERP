"""PyInstaller 入口只持有启动协议；业务和更新器从安装目录加载。"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import sys
from pathlib import Path


async def serve(root: Path) -> None:
    storage = importlib.import_module("updater.storage")
    installation = storage.read_installation(root)
    backend_root = storage.component_path(root, "backend", installation["backend"])
    sys.path.insert(0, str(backend_root))
    app_module = importlib.import_module("backend.app.main")
    config_module = importlib.import_module("backend.app.core.config")
    uvicorn = importlib.import_module("uvicorn")
    settings = config_module.load_settings(root / "config.json")
    application = app_module.create_app(
        config_path=root / "config.json",
        migrations_dir=backend_root / "backend" / "migrations",
        frontend_dist=storage.component_path(root, "frontend", installation["frontend"]),
        update_root=root,
    )
    config = uvicorn.Config(application, host=settings.host, port=settings.port,
                            proxy_headers=False, timeout_graceful_shutdown=None)
    server = uvicorn.Server(config)

    async def watch_stop():
        while not server.should_exit:
            if (root / ".updates" / "stop").exists():
                server.should_exit = True
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(watch_stop())
    try:
        await server.serve()
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="SunYu ERP modular runtime")
    parser.add_argument("--root", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--supervise", action="store_true")
    mode.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root))
    if args.serve:
        supervisor = importlib.import_module("updater.supervisor")
        with supervisor.InstallationLock(root, "backend.lock"):
            asyncio.run(serve(root))
        return 0
    return importlib.import_module("updater.supervisor").run(root)


if __name__ == "__main__":
    raise SystemExit(main())
