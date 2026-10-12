from __future__ import annotations

import os
import sys
from collections.abc import Callable
from threading import Event, Thread
from typing import BinaryIO

from backend.app.core.file_lock import release_lock, try_lock
from backend.app.features.updates import UpdateManager, atomic_json, read_json
from backend.app.version import VERSION


class ServiceAlreadyRunning(RuntimeError):
    """同一安装目录已有实例持有服务锁。"""


class UpdateRuntime:
    def __init__(self, manager: UpdateManager, *, port: int, shutdown: Callable[[], None]) -> None:
        self.manager = manager
        self.port = port
        self.shutdown = shutdown
        self._stop = Event()
        self._thread: Thread | None = None
        self._lock: BinaryIO | None = None

    def publish(self) -> None:
        atomic_json(self.manager.directory / "runtime.json", {
            "pid": os.getpid(), "executable": sys.executable, "version": VERSION,
            "port": self.port, "instance_id": self.manager.instance_id,
        })

    def start(self) -> None:
        self.manager.directory.mkdir(parents=True, exist_ok=True)
        self._lock = try_lock(self.manager.directory / "service.lock")
        if self._lock is None:
            raise ServiceAlreadyRunning("此安装目录的服务已启动")
        self.publish()
        self._thread = Thread(target=self._watch, name="sunyu-update-runtime", daemon=True)
        self._thread.start()

    def poll_shutdown(self) -> None:
        path = self.manager.directory / "shutdown.json"
        try:
            value = read_json(path)
        except (OSError, TypeError, ValueError):
            return
        if value.get("instance_id") == self.manager.instance_id:
            path.unlink(missing_ok=True)
            self.shutdown()
            self._stop.set()

    def _watch(self) -> None:
        while not self._stop.wait(0.25):
            self.poll_shutdown()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        path = self.manager.directory / "runtime.json"
        try:
            value = read_json(path)
            if value.get("instance_id") == self.manager.instance_id:
                path.unlink(missing_ok=True)
        except (OSError, TypeError, ValueError):
            pass
        finally:
            if self._lock is not None:
                release_lock(self._lock)
                self._lock = None
