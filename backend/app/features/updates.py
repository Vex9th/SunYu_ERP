from __future__ import annotations

import ipaddress
import json
import os
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.file_lock import release_lock, try_lock
from backend.app.features.auth import require_authenticated_session
from backend.app.version import VERSION


class InstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str = Field(pattern=r"^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$")


_ACTIVE_INSTALL_PHASES = {
    "downloading", "stopping", "backing_up", "installing", "restarting",
}


def atomic_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows 杀毒/短暂读取可能延迟替换；绝不先删除现有状态文件。
        for attempt in range(5):
            try:
                os.replace(name, path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.02)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path: Path) -> dict[str, object]:
    if path.stat().st_size > 64 * 1024:
        raise ValueError("update state exceeds size limit")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise TypeError("invalid update state")
    return value


def _loopback(host: str | None) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def _local_request(request: Request, *, require_origin: bool) -> bool:
    if request.client is None or not _loopback(request.client.host):
        return False
    if any(key.lower() == "forwarded" or key.lower().startswith("x-forwarded-")
           for key in request.headers):
        return False
    try:
        target = urlsplit(str(request.url))
        if not _loopback(target.hostname) or target.username or target.password:
            return False
        if not require_origin:
            return True
        origin = urlsplit(request.headers.get("origin", ""))
        return (
            origin.scheme == target.scheme
            and origin.hostname == target.hostname
            and (origin.port or (443 if origin.scheme == "https" else 80))
            == (target.port or (443 if target.scheme == "https" else 80))
            and not origin.username and not origin.password
            and not origin.path and not origin.query and not origin.fragment
        )
    except ValueError:
        return False


class UpdateManager:
    """仅桥接独立更新器；业务程序不下载、解包或替换程序文件。"""

    def __init__(
        self, root: Path, *, enabled: bool = False,
        spawn: Callable[..., subprocess.Popen] = subprocess.Popen,
    ) -> None:
        self.root = root.resolve()
        self.enabled = enabled
        self.spawn = spawn
        self.instance_id = uuid.uuid4().hex
        self.lock = RLock()
        self._business_writes = 0
        self._process: subprocess.Popen | None = None
        self._started_job = ""
        self._started_apply = False

    @property
    def directory(self) -> Path:
        return self.root / ".updates"

    @property
    def supported(self) -> bool:
        return self.enabled and (self.root / "update.exe").is_file()

    def state(self) -> dict[str, object]:
        result: dict[str, object] = {
            "job_id": "", "phase": "idle", "message": "尚未检查更新", "progress": 0,
            "current_version": VERSION, "latest_version": "", "update_available": False,
            "busy": False, "error": "", "checked_at": "",
        }
        if not self.enabled:
            return result
        try:
            saved = read_json(self.directory / "status.json")
            for key, default in result.items():
                value = saved.get(key, default)
                if type(value) is not type(default):
                    raise ValueError("invalid update status field")
                result[key] = value
            if result["phase"] not in _ACTIVE_INSTALL_PHASES | {
                "idle", "checking", "available", "success", "failed",
            }:
                raise ValueError("invalid update phase")
            if not 0 <= result["progress"] <= 100:
                raise ValueError("invalid update progress")
        except FileNotFoundError:
            pass
        except (OSError, TypeError, ValueError):
            result.update(phase="failed", error="更新状态无法读取，请在本机运行 update.exe 查看或恢复。",
                          message="更新状态无法读取")
        # 升级成功后状态文件仍可能记着旧版本；当前进程才是当前版本来源。
        result["current_version"] = VERSION
        if self._process is not None and result["job_id"] == self._started_job:
            exit_code = self._process.poll()
            if exit_code not in {None, 0} and result["busy"]:
                result.update(phase="failed", busy=False,
                              error=f"更新器退出（{exit_code}），请查看 .updates/updater.log。",
                              message="更新器未完成")
                atomic_json(self.directory / "status.json", result)
                if self._started_apply:
                    atomic_json(self.directory / "last-install.json", result)
        if result["busy"] and not (self._process is not None and self._process.poll() is None):
            try:
                old = time.time() - (self.directory / "status.json").stat().st_mtime > 30
                if old and not self.worker_active():
                    result.update(phase="failed", busy=False,
                                  error="上次更新任务已中断，可以重新运行 update.exe 继续恢复。",
                                  message="更新任务已中断")
                    atomic_json(self.directory / "status.json", result)
            except OSError:
                pass  # 无法判定互斥状态时不解除忙碌保护。
        return result

    def worker_active(self) -> bool:
        guard = try_lock(self.directory / "updater.lock")
        if guard is None:
            return True
        release_lock(guard)
        return False

    def install_unverified(self) -> bool:
        if not self.enabled:
            return False
        try:
            return read_json(self.directory / "install.json").get("phase") != "verified"
        except FileNotFoundError:
            return False
        except (OSError, TypeError, ValueError):
            return True

    def writes_blocked(self) -> bool:
        if not self.enabled:
            return False
        if self.install_unverified():
            return True
        state = self.state()
        return bool(state["busy"] and state["phase"] in _ACTIVE_INSTALL_PHASES)

    @contextmanager
    def business_write(self) -> Iterator[None]:
        with self.lock:
            if self.writes_blocked():
                raise HTTPException(status_code=503, detail="正在升级，暂不能保存数据，请稍后重试。",
                                    headers={"Retry-After": "3"})
            self._business_writes += 1
        try:
            yield
        finally:
            with self.lock:
                self._business_writes -= 1

    def response(self, request: Request, job_id: str | None = None) -> dict[str, object]:
        state = self.state()
        if job_id and state["job_id"] != job_id:
            try:
                saved = read_json(self.directory / "last-install.json")
            except (OSError, TypeError, ValueError):
                saved = {}
            if (saved.get("job_id") == job_id and saved.get("phase") in {"success", "failed"}
                    and saved.get("busy") is False
                    and all(type(saved.get(key)) is type(value) for key, value in state.items())):
                state = {key: saved[key] for key in state}
                state["current_version"] = VERSION
            else:
                raise HTTPException(status_code=410, detail="原任务记录已被后续任务替换，或安装请求尚未被接受。")
        reason = ""
        if not self.enabled:
            reason = "仅 Windows 正式安装包支持更新，开发环境不执行安装。"
        elif not self.supported:
            reason = "缺少 update.exe，请将官方更新工具放在主程序旁。"
        elif not _local_request(request, require_origin=False):
            reason = "请在运行服务的电脑使用 http://127.0.0.1 登录后更新。"
        state.update(supported=self.supported, can_install=not reason, disabled_reason=reason,
                     recovery_required=self.install_unverified())
        return state

    def start(self, *, apply: bool, job_id: str | None = None) -> None:
        with self.lock:
            if not self.supported:
                raise HTTPException(status_code=409, detail="当前环境缺少可用的 Windows 更新工具。")
            self.directory.mkdir(parents=True, exist_ok=True)
            state = self.state()
            if job_id and state["job_id"] == job_id:
                return  # 相同请求的重传只查询原任务，不重新启动更新器。
            if job_id:
                try:
                    previous = read_json(self.directory / "last-install.json")
                except (OSError, TypeError, ValueError):
                    previous = {}
                if previous.get("job_id") == job_id:
                    return
            if state["busy"] or self.worker_active():
                raise HTTPException(status_code=409, detail="更新任务正在进行，请等待当前任务完成。")
            if not apply and self.install_unverified():
                raise HTTPException(status_code=409, detail="上次更新未完成，请先继续恢复更新。")
            if apply and self._business_writes:
                raise HTTPException(status_code=409, detail="有操作正在保存，请稍后再更新。")
            job_id = job_id or uuid.uuid4().hex
            state.update(job_id=job_id, phase="downloading" if apply else "checking",
                         message="正在启动更新器" if apply else "正在检查新版本", progress=0,
                         busy=True, error="", checked_at=datetime.now(timezone.utc).isoformat())
            atomic_json(self.directory / "status.json", state)
            args = [str(self.root / "update.exe"), "--root", str(self.root),
                    "--apply" if apply else "--check", "--job-id", job_id, "--no-pause"]
            try:
                with (self.directory / "updater.log").open("ab") as log:
                    flags = 0
                    if os.name == "nt":
                        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
                    self._process = self.spawn(
                        args, cwd=str(self.root), stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                        creationflags=flags,
                    )
                self._started_job = job_id
                self._started_apply = apply
            except OSError as error:
                state.update(phase="failed", busy=False, error=f"无法启动更新工具：{error}",
                             message="更新器启动失败")
                atomic_json(self.directory / "status.json", state)
                if apply:
                    atomic_json(self.directory / "last-install.json", state)
                raise HTTPException(status_code=503, detail=state["error"]) from error


def create_updates_router(get_settings: Callable[..., Settings], manager: UpdateManager) -> APIRouter:
    router = APIRouter(prefix="/api/system/updates", tags=["updates"])

    settings_dependency = Depends(get_settings)

    def authenticate(request: Request, settings: Settings = settings_dependency) -> None:
        require_authenticated_session(request, settings.session_secret)

    @router.get("")
    def status(request: Request, job_id: str | None = None,
               _: None = Depends(authenticate)) -> dict[str, object]:
        if job_id is not None:
            try:
                uuid.UUID(job_id)
            except ValueError:
                raise HTTPException(status_code=422, detail="更新任务ID无效") from None
        return manager.response(request, job_id)

    @router.post("/check", status_code=202)
    def check(request: Request, _: None = Depends(authenticate)) -> dict[str, object]:
        manager.start(apply=False)
        return manager.response(request)

    @router.post("/install", status_code=202)
    def install(request: Request, payload: InstallRequest | None = None,
                _: None = Depends(authenticate)) -> dict[str, object]:
        if not _local_request(request, require_origin=True):
            raise HTTPException(status_code=403, detail="仅允许本机登录后的同源网页发起安装。")
        with manager.lock:
            settings = get_settings(request)
            connection = connect_database(settings.data_dir / "iapm.sqlite")
            try:
                active = connection.execute(
                    "SELECT id FROM backup_tasks WHERE status='running' LIMIT 1"
                ).fetchone()
                if active is None:
                    active = connection.execute(
                        "SELECT id FROM backup_runs WHERE status='running' LIMIT 1"
                    ).fetchone()
                if active is not None:
                    raise HTTPException(status_code=409, detail="备份正在进行，请完成后再更新。")
                manager.start(apply=True, job_id=payload.job_id if payload else None)
            finally:
                connection.close()
        return manager.response(request, payload.job_id if payload else None)

    return router
