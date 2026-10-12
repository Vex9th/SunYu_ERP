"""安装根目录中的固定监督进程；业务进程退出后才切换后端版本。"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from updater.storage import (
    component_path,
    read_installation,
    read_json,
    sync_directory,
    write_json,
)

_LOGGER = logging.getLogger(__name__)


class InstallationLock:
    def __init__(self, root: Path, name: str = "server.lock"):
        if name not in {"server.lock", "backend.lock"}:
            raise ValueError("Unknown process lock")
        self.path = root / ".updates" / name
        self.stream = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        try:
            if os.fstat(self.stream.fileno()).st_size == 0:
                self.stream.write(b"0")
                self.stream.flush()
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            raise RuntimeError("此安装目录已有 ERP 正在运行") from exc
        return self

    def __exit__(self, *_args):
        if self.stream is not None:
            self.stream.close()


def initialize_installation(root: Path) -> dict[str, Any]:
    target = root / "installation.json"
    if not target.exists():
        default = read_json(root / "installation.default.json")
        if not isinstance(default, dict):
            raise ValueError("Missing installation.default.json")
        write_json(target, default)
    return read_installation(root)


def data_directory(root: Path) -> Path:
    config = read_json(root / "config.json", {})
    value = config.get("data_dir", "Data")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Invalid data_dir")
    path = Path(value)
    return (path if path.is_absolute() else root / path).resolve()


def health_url(root: Path) -> str:
    config = read_json(root / "config.json", {})
    host = config.get("host", "0.0.0.0")
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{config.get('port', 8765)}/api/health"


def backup_installation(root: Path, identifier: str) -> Path:
    if not identifier.isalnum():
        raise ValueError("Invalid update identifier")
    data = data_directory(root)
    target = root / ".updates" / "backups" / identifier
    if target.resolve().is_relative_to(data):
        raise ValueError("Update backup must not be inside data_dir")
    if not data.is_dir():
        raise ValueError("Data directory does not exist")
    for path in data.rglob("*"):
        if path.is_symlink():
            raise ValueError("Update backup does not follow data symlinks")
    target.mkdir(parents=True, mode=0o700)
    shutil.copytree(data, target / "Data", copy_function=_copy_durable)
    config = root / "config.json"
    if config.exists():
        _copy_durable(config, target / "config.json")
    hashes = {}
    for path in sorted(target.rglob("*")):
        if path.is_file():
            with path.open("rb") as stream:
                hashes[path.relative_to(target).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    for directory, _, _ in os.walk(target, topdown=False):
        sync_directory(Path(directory))
    sync_directory(target.parent)
    sync_directory(target.parent.parent)
    write_json(target / "backup.json", {"data_dir": str(data), "files": hashes})
    return target


def _copy_durable(source, destination):
    with Path(source).open("rb") as reader, Path(destination).open("xb") as writer:
        shutil.copyfileobj(reader, writer, length=1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())
    return str(destination)


def can_start_backend(root: Path, version: str) -> bool:
    migrations = component_path(root, "backend", version) / "backend" / "migrations"
    if not migrations.is_dir():
        return False
    database = data_directory(root) / "iapm.sqlite"
    if not database.exists():
        return True
    try:
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        try:
            applied = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
        finally:
            connection.close()
        return applied <= {path.stem for path in migrations.glob("*.sql")}
    except sqlite3.Error:
        return False


def _job(root: Path, source: dict, status: str, message: str, **extra) -> None:
    write_json(root / ".updates" / "job.json", {
        "id": source["id"], "component": source.get("component", "backend"),
        "version": source.get("version"), "status": status, "message": message, **extra,
    })


def recover_interrupted_install(root: Path) -> None:
    updates = root / ".updates"
    transaction = read_json(updates / "transaction.json")
    if transaction is None:
        return
    if transaction.get("phase") == "committed":
        _job(root, transaction, "success", "更新已完成")
    elif can_start_backend(root, transaction["previous"]["backend"]):
        write_json(root / "installation.json", transaction["previous"])
        _job(root, transaction, "failed", "上次更新被中断，已恢复原程序版本；业务数据保留")
    else:
        (updates / "maintenance").touch()
        _job(root, transaction, "manual_recovery", "升级被中断且数据库已迁移，请根据升级备份恢复；未覆盖业务数据", backup=transaction.get("backup"))
        raise RuntimeError("数据库版本需要人工恢复，请检查 .updates/job.json 和升级备份")
    for name in ("pending.json", "maintenance", "stop", "transaction.json"):
        (updates / name).unlink(missing_ok=True)


class Supervisor:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.updates = self.root / ".updates"
        self.child: subprocess.Popen | None = None
        self.stopping = False

    def start_backend(self) -> None:
        # 即使监督进程被外部结束，存活的业务子进程仍持有自己的锁。
        with InstallationLock(self.root, "backend.lock"):
            pass
        (self.updates / "stop").unlink(missing_ok=True)
        if getattr(sys, "frozen", False):
            command = [sys.executable, "--root", str(self.root), "--serve"]
        else:
            command = [sys.executable, str(Path(__file__).with_name("runtime_entry.py")), "--root", str(self.root), "--serve"]
        env = {**os.environ, "SUNYU_SUPERVISED": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        self.child = subprocess.Popen(command, cwd=self.root, env=env)

    def wait_healthy(self, timeout: float = 60) -> None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        version = read_installation(self.root)["backend"]
        end = time.monotonic() + timeout
        last = "等待服务"
        while time.monotonic() < end:
            if self.child is None or self.child.poll() is not None:
                raise RuntimeError("后端在健康检查前退出")
            try:
                with opener.open(health_url(self.root), timeout=1) as response:
                    value = json.load(response)
                if value.get("status") == "ok" and value.get("backend_version") == version and value.get("pid") == self.child.pid:
                    return
                last = "端口由其他程序占用或版本不符"
            except (OSError, ValueError, urllib.error.URLError) as exc:
                last = str(exc)
            time.sleep(0.2)
        raise RuntimeError(f"后端启动超时：{last}")

    def stop_backend(self, timeout: float = 90) -> None:
        if self.child is None or self.child.poll() is not None:
            return
        (self.updates / "stop").touch()
        try:
            self.child.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("仍有操作未结束，后端未停止，已暂停更新") from exc

    def install_backend(self, pending: dict) -> None:
        version = pending["version"]
        candidate = component_path(self.root, "backend", version)
        if not (candidate / "backend" / "app" / "main.py").is_file():
            raise ValueError("更新后端文件缺失")
        previous = read_installation(self.root)
        transaction = {**pending, "previous": previous, "phase": "stopping"}
        write_json(self.updates / "transaction.json", transaction)
        (self.updates / "maintenance").touch()
        _job(self.root, pending, "installing", "等待当前操作完成并停止后端")
        try:
            self.stop_backend()
            backup = backup_installation(self.root, pending["id"])
            transaction.update(phase="starting", backup=str(backup))
            write_json(self.updates / "transaction.json", transaction)
            _job(self.root, pending, "installing", "备份完成，正在启动新后端", backup=str(backup))
            write_json(self.root / "installation.json", {**previous, "backend": version})
            self.start_backend()
            self.wait_healthy()
            transaction["phase"] = "committed"
            write_json(self.updates / "transaction.json", transaction)
            _job(self.root, pending, "success", "后端更新完成，业务数据已保留", backup=str(backup))
            (self.updates / "maintenance").unlink(missing_ok=True)
            (self.updates / "pending.json").unlink(missing_ok=True)
            (self.updates / "transaction.json").unlink(missing_ok=True)
        except Exception as exc:
            try:
                self.stop_backend()
            except Exception as stop_error:
                _job(self.root, pending, "manual_recovery", f"{exc}；{stop_error}")
                raise
            if can_start_backend(self.root, previous["backend"]):
                write_json(self.root / "installation.json", previous)
                self.start_backend()
                self.wait_healthy()
                _job(self.root, pending, "failed", f"更新失败，已恢复原程序：{exc}", backup=transaction.get("backup"))
                (self.updates / "maintenance").unlink(missing_ok=True)
                (self.updates / "pending.json").unlink(missing_ok=True)
                (self.updates / "transaction.json").unlink(missing_ok=True)
            else:
                _job(self.root, pending, "manual_recovery", f"更新失败且数据库已迁移，需要人工恢复：{exc}", backup=transaction.get("backup"))
                raise RuntimeError("数据库需要人工恢复；原数据及升级备份均已保留") from exc
        finally:
            (self.updates / "pending.json").unlink(missing_ok=True)

    def run(self) -> int:
        with InstallationLock(self.root):
            with InstallationLock(self.root, "backend.lock"):
                pass
            initialize_installation(self.root)
            recover_interrupted_install(self.root)
            previous_job = read_json(self.updates / "job.json", {})
            if previous_job.get("status") == "manual_recovery":
                raise RuntimeError(previous_job.get("message", "需要人工恢复"))
            self.start_backend()
            try:
                self.wait_healthy()
                while not self.stopping:
                    if self.child is None or self.child.poll() is not None:
                        return self.child.returncode if self.child is not None else 1
                    pending = read_json(self.updates / "pending.json")
                    if pending:
                        try:
                            self.install_backend(pending)
                        except Exception:
                            _LOGGER.exception("更新停止")
                            return 1
                    time.sleep(0.25)
            finally:
                while self.child is not None and self.child.poll() is None:
                    try:
                        self.stop_backend()
                    except RuntimeError as error:
                        if not isinstance(error.__cause__, subprocess.TimeoutExpired):
                            raise
                        # 长任务未结束时保持父进程和安装锁，禁止另起服务写同一个库。
                        _LOGGER.warning("后端仍在结束当前操作，继续等待；安装锁保持占用")
        return 0

    def request_stop(self, _signal=None, _frame=None) -> None:
        self.stopping = True
        (self.updates / "stop").touch()


def run(root: Path) -> int:
    supervisor = Supervisor(root)
    signal.signal(signal.SIGINT, supervisor.request_stop)
    signal.signal(signal.SIGTERM, supervisor.request_stop)
    return supervisor.run()
