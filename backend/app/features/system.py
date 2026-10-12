from __future__ import annotations

import logging
import sqlite3
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from backend.app.core.config import Settings, update_backup_settings
from backend.app.core.database import connect_database
from backend.app.features.auth import require_authenticated_session
from backend.app.features.backups import _BACKUP_LOCK, create_backup, prune_backups

_SCHEDULER_POLL_SECONDS = 60.0
_SCHEDULER_STOP_TIMEOUT_SECONDS = 5.0
_MAX_RETRY_DELAY = timedelta(hours=1)
_TASK_SUBMISSION_LOCK = Lock()
_CLEANUP_WARNING = "Backup created but cleanup failed"

BackupCreator = Callable[..., Path]
BackupPruner = Callable[..., list[Path]]
BackupRunner = Callable[[sqlite3.Connection, Settings, datetime], "BackupJobResult"]
ConnectionFactory = Callable[[str | Path], sqlite3.Connection]
Clock = Callable[[], datetime]
Waiter = Callable[[Event, float], bool]


class SettingsStore:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = Lock()

    def get(self) -> Settings:
        with self._lock:
            return self._settings

    def replace(self, settings: Settings) -> None:
        with self._lock:
            self._settings = settings

    def update_backup(
        self,
        *,
        enabled: bool | None = None,
        directory: str | None,
        interval_hours: int,
        retention_days: int,
    ) -> Settings:
        with self._lock:
            updated = update_backup_settings(
                self._settings.config_path,
                enabled=enabled,
                directory=directory,
                interval_hours=interval_hours,
                retention_days=retention_days,
            )
            self._settings = updated
            return updated


@dataclass(frozen=True, slots=True)
class BackupJobResult:
    path: Path
    warning: str | None = None
    cleanup_error_code: str | None = None


class BackupScheduler:
    def __init__(
        self,
        settings_store: SettingsStore,
        *,
        connection_factory: ConnectionFactory,
        runner: BackupRunner,
        clock: Clock | None = None,
        wait: Waiter | None = None,
    ) -> None:
        self._settings_store = settings_store
        self._connection_factory = connection_factory
        self._runner = runner
        self._clock = clock or _utc_now
        self._wait = wait or _wait_for_stop
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._lifecycle_lock = Lock()
        self._cycle_lock = Lock()
        self._status_lock = Lock()
        self._retry_not_before: datetime | None = None
        self._last_error_at: str | None = None
        self._last_error_code: str | None = None

    @property
    def is_alive(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._thread is not None:
                raise RuntimeError("backup scheduler has already been started")
            thread = Thread(
                target=self._run,
                name="sunyu-backup-scheduler",
                daemon=True,
            )
            self._thread = thread
            thread.start()

    def stop(self) -> None:
        with self._lifecycle_lock:
            thread = self._thread
            self._stop_event.set()
        if thread is not None:
            thread.join(timeout=_SCHEDULER_STOP_TIMEOUT_SECONDS)
            if thread.is_alive():
                raise RuntimeError("Backup scheduler did not stop")

    def snapshot(self) -> dict[str, object]:
        with self._status_lock:
            last_error_at = self._last_error_at
            last_error_code = self._last_error_code
        return {
            "alive": self.is_alive,
            "last_error_at": last_error_at,
            "last_error_code": last_error_code,
        }

    def run_cycle(self) -> bool:
        with self._cycle_lock:
            return self._run_cycle()

    def _run_cycle(self) -> bool:
        now: datetime | None = None
        settings: Settings | None = None
        connection: sqlite3.Connection | None = None
        result: BackupJobResult | None = None
        schedule_error_code: str | None = None
        primary_failure: BaseException | None = None
        failure_category = "connection"
        close_failure: BaseException | None = None
        ran_backup = False
        try:
            now = _require_aware_datetime(self._clock())
            settings = self._settings_store.get()
            if not settings.automatic_backup_enabled or settings.backup_dir is None:
                return False
            if self._retry_not_before is not None and now < self._retry_not_before:
                return False

            connection = self._connection_factory(
                settings.data_dir / "iapm.sqlite"
            )
            failure_category = "schedule"
            due, schedule_error_code = _backup_due_state(
                connection,
                now,
                settings.backup_interval_hours,
            )
            if not due:
                self._retry_not_before = None
            else:
                failure_category = "backup"
                result = self._runner(connection, settings, now)
                ran_backup = True
        except BaseException as failure:  # noqa: BLE001 - daemon safety boundary
            primary_failure = failure
        finally:
            if connection is not None:
                try:
                    connection.close()
                except BaseException as failure:  # noqa: BLE001 - observable below
                    close_failure = failure

        if primary_failure is not None:
            if now is not None and settings is not None:
                interval = timedelta(hours=settings.backup_interval_hours)
                self._retry_not_before = now + min(_MAX_RETRY_DELAY, interval)
            error_code = f"{failure_category}:{type(primary_failure).__name__}"
            if close_failure is not None:
                primary_failure.add_note(
                    "database connection close failed: "
                    f"{type(close_failure).__name__}"
                )
                error_code += (
                    ";connection_close:"
                    f"{type(close_failure).__name__}"
                )
            self._record_error_code(error_code, now)
            return False
        if ran_backup:
            self._retry_not_before = None
            if close_failure is not None:
                self._record_error("connection_close", close_failure, now)
            elif result is not None and result.cleanup_error_code is not None:
                self._record_error_code(result.cleanup_error_code, now)
            elif schedule_error_code is not None:
                self._record_error_code(schedule_error_code, now)
            else:
                self._clear_error()
            return True
        if close_failure is not None:
            self._record_error("connection_close", close_failure, now)
        return ran_backup

    def _run(self) -> None:
        while not self._stop_event.is_set():
            self.run_cycle()
            try:
                if self._wait(self._stop_event, _SCHEDULER_POLL_SECONDS):
                    return
            except BaseException as failure:  # noqa: BLE001 - thread boundary
                self._record_error("waiter", failure, None)
                return

    def _record_error(
        self,
        category: str,
        failure: BaseException,
        occurred_at: datetime | None,
    ) -> None:
        self._record_error_code(
            f"{category}:{type(failure).__name__}",
            occurred_at,
        )

    def _record_error_code(
        self,
        error_code: str,
        occurred_at: datetime | None,
    ) -> None:
        timestamp = _utc_now() if occurred_at is None else occurred_at
        with self._status_lock:
            self._last_error_at = timestamp.isoformat()
            self._last_error_code = error_code

    def _clear_error(self) -> None:
        with self._status_lock:
            self._last_error_at = None
            self._last_error_code = None


@dataclass(frozen=True, slots=True)
class BackupSettingsUpdate:
    enabled: bool
    directory: str | None
    interval_hours: int
    retention_days: int


def recover_interrupted_backups(connection: sqlite3.Connection) -> None:
    # 单进程启动、调度器启动之前运行；不根据目录名字猜测文件归属。
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_runs'"
    ).fetchone() is not None:
        connection.execute(
            "UPDATE backup_runs SET status='failed', finished_at=?, "
            "error_message='Backup interrupted by service restart' WHERE status='running'",
            (_utc_now().isoformat(),),
        )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS backup_tasks "
        "(id TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT NOT NULL, "
        "started_at TEXT NOT NULL, finished_at TEXT, path TEXT, warning TEXT, error_code TEXT)"
    )
    connection.execute(
        "UPDATE backup_tasks SET status='interrupted', phase='interrupted', "
        "finished_at=?, error_code='service_restart' WHERE status='running'",
        (_utc_now().isoformat(),),
    )


def run_backup_job(
    connection: sqlite3.Connection,
    settings: Settings,
    now: datetime,
    *,
    creator: BackupCreator = create_backup,
    pruner: BackupPruner = prune_backups,
    on_phase: Callable[[str], None] | None = None,
) -> BackupJobResult:
    with _BACKUP_LOCK:
        try:
            return _run_backup_job_locked(
                connection, settings, now,
                creator=creator, pruner=pruner, on_phase=on_phase,
            )
        except BaseException as failure:
            logging.getLogger(__name__).error(
                "backup stage=job error=%s errno=%s",
                type(failure).__name__, getattr(failure, "errno", None),
            )
            raise


def _run_backup_job_locked(
    connection: sqlite3.Connection,
    settings: Settings,
    now: datetime,
    *,
    creator: BackupCreator = create_backup,
    pruner: BackupPruner = prune_backups,
    on_phase: Callable[[str], None] | None = None,
) -> BackupJobResult:
    if settings.backup_dir is None:
        raise RuntimeError("backup_dir is not configured")
    if on_phase is not None:
        on_phase("creating")
    target = creator(connection, settings, now=now)
    try:
        if on_phase is not None:
            on_phase("cleaning")
        pruner(
            settings.backup_dir,
            settings.backup_retention_days,
            now=now,
        )
    except BaseException as failure:  # noqa: BLE001 - backup already succeeded
        logging.getLogger(__name__).error(
            "backup stage=cleanup error=%s errno=%s",
            type(failure).__name__, getattr(failure, "errno", None),
        )
        return BackupJobResult(
            target,
            warning=_CLEANUP_WARNING,
            cleanup_error_code=f"cleanup:{type(failure).__name__}",
        )
    return BackupJobResult(target)


def create_system_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    update_settings: Callable[..., Settings],
    get_scheduler_snapshot: Callable[..., dict[str, object]],
    *,
    backup_creator: BackupCreator = create_backup,
    backup_pruner: BackupPruner = prune_backups,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/system", tags=["system"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    scheduler_snapshot_dependency = Depends(get_scheduler_snapshot)
    payload_dependency = Depends(_read_backup_settings_update)
    now = clock or _utc_now
    live_tasks: set[str] = set()
    unrecorded_success: dict[str, dict[str, object]] = {}

    def reconcile_task(connection: sqlite3.Connection, task_id: str) -> dict[str, object] | None:
        completed = unrecorded_success.get(task_id)
        if completed is not None:
            try:
                connection.execute(
                    "UPDATE backup_tasks SET status='success',phase='finished',"
                    "finished_at=?,path=?,warning=?,error_code=NULL WHERE id=?",
                    (completed["finished_at"], completed["path"], completed["warning"], task_id),
                )
                unrecorded_success.pop(task_id, None)
            except (OSError, sqlite3.Error) as failure:
                logging.getLogger(__name__).error(
                    "backup task=%s stage=status_reconcile error=%s errno=%s",
                    task_id, type(failure).__name__, getattr(failure, "errno", None),
                )
            return completed
        if task_id not in live_tasks:
            connection.execute(
                "UPDATE backup_tasks SET status='interrupted',phase='interrupted',"
                "finished_at=?,error_code='worker_stopped' WHERE id=? AND status='running'",
                (now().isoformat(), task_id),
            )

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/overview")
    def get_overview(
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
        scheduler_snapshot: dict[str, object] = scheduler_snapshot_dependency,
    ) -> dict[str, object]:
        return _overview(connection, settings, scheduler_snapshot)

    @router.put("/backup-settings")
    def put_backup_settings(
        _: None = authentication_dependency,
        payload: BackupSettingsUpdate = payload_dependency,
    ) -> dict[str, object]:
        try:
            updated = update_settings(
                enabled=payload.enabled,
                directory=payload.directory,
                interval_hours=payload.interval_hours,
                retention_days=payload.retention_days,
            )
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Invalid backup settings",
            ) from None
        except BaseException:  # noqa: BLE001 - convert all write failures safely
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Backup settings update failed",
            ) from None
        return _backup_settings_response(updated)

    @router.post("/backups", status_code=status.HTTP_201_CREATED)
    def post_backup(
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, str]:
        if settings.backup_dir is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Backup directory is not configured",
            )
        try:
            result = run_backup_job(
                connection,
                settings,
                _require_aware_datetime(now()),
                creator=backup_creator,
                pruner=backup_pruner,
            )
            row = connection.execute(
                """
                SELECT started_at
                FROM backup_runs
                WHERE status = 'success' AND target_path = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (str(result.path),),
            ).fetchone()
            if row is None:
                raise RuntimeError("successful backup run was not recorded")
        except BaseException:  # noqa: BLE001 - prevent private failure disclosure
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Backup operation failed",
            ) from None
        response = {
            "path": str(result.path),
            "created_at": str(row["started_at"]),
        }
        if result.warning is not None:
            response["warning"] = result.warning
        return response

    @router.post("/backup-tasks", status_code=status.HTTP_202_ACCEPTED)
    def start_backup_task(
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, object]:
        if settings.backup_dir is None:
            raise HTTPException(status_code=409, detail="Backup directory is not configured")
        with _TASK_SUBMISSION_LOCK:
            active = connection.execute(
                "SELECT id FROM backup_tasks WHERE status='running' "
                "ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            if active is not None:
                if active["id"] in live_tasks:
                    return {"task_id": active["id"], "status": "running"}
                completed = reconcile_task(connection, active["id"])
                if completed is not None:
                    return {"task_id": active["id"], "status": "success"}
            task_id = uuid.uuid4().hex
            started_at = now().isoformat()
            try:
                task_connection = connect_database(settings.data_dir / "iapm.sqlite")
            except (OSError, sqlite3.Error) as failure:
                logging.getLogger(__name__).error(
                    "backup task=%s stage=connection error=%s errno=%s",
                    task_id, type(failure).__name__, getattr(failure, "errno", None),
                )
                raise HTTPException(status_code=503, detail="Backup worker connection unavailable") from None
            try:
                connection.execute(
                    "INSERT INTO backup_tasks(id,status,phase,started_at) "
                    "VALUES(?,'running','queued',?)",
                    (task_id, started_at),
                )
                live_tasks.add(task_id)
            except BaseException:
                task_connection.close()
                raise

        def execute() -> None:
            worker_connection = task_connection
            result: BackupJobResult | None = None
            try:
                with _BACKUP_LOCK:
                    def report_phase(phase: str) -> None:
                        worker_connection.execute(
                            "UPDATE backup_tasks SET phase=? WHERE id=?",
                            (phase, task_id),
                        )

                    result = run_backup_job(
                        worker_connection, settings, now(),
                        creator=backup_creator, pruner=backup_pruner,
                        on_phase=report_phase,
                    )
                    worker_connection.execute(
                        "UPDATE backup_tasks SET status='success',phase='finished',"
                        "finished_at=?,path=?,warning=? WHERE id=?",
                        (now().isoformat(), str(result.path), result.warning, task_id),
                    )
            except BaseException as failure:  # noqa: BLE001 - persist worker outcome before exit
                error_code = (
                    f"backup:{type(failure).__name__}:"
                    f"errno={getattr(failure, 'errno', None)}"
                )
                logging.getLogger(__name__).error(
                    "backup task=%s stage=%s error=%s",
                    task_id, "status" if result is not None else "worker", error_code,
                )
                if result is not None:
                    # 文件与 backup_runs 已成功；任务记录失败不能反转业务结果。
                    with _TASK_SUBMISSION_LOCK:
                        unrecorded_success[task_id] = {
                            "id": task_id, "status": "success", "phase": "finished",
                            "started_at": started_at, "finished_at": now().isoformat(),
                            "path": str(result.path), "warning": result.warning,
                            "error_code": None,
                        }
                elif worker_connection is not None:
                    try:
                        worker_connection.execute(
                            "UPDATE backup_tasks SET status='failed',phase='failed',"
                            "finished_at=?,error_code=? WHERE id=?",
                            (now().isoformat(), error_code, task_id),
                        )
                    except (OSError, sqlite3.Error) as record_failure:
                        logging.getLogger(__name__).error(
                            "backup task=%s stage=status error=%s errno=%s",
                            task_id, type(record_failure).__name__,
                            getattr(record_failure, "errno", None),
                        )
            finally:
                try:
                    worker_connection.close()
                except (OSError, sqlite3.Error) as close_failure:
                    logging.getLogger(__name__).error(
                        "backup task=%s stage=connection_close error=%s errno=%s",
                        task_id, type(close_failure).__name__,
                        getattr(close_failure, "errno", None),
                    )
                finally:
                    with _TASK_SUBMISSION_LOCK:
                        live_tasks.discard(task_id)

        worker = Thread(target=execute, name=f"backup-{task_id[:8]}", daemon=True)
        try:
            worker.start()
        except RuntimeError:
            with _TASK_SUBMISSION_LOCK:
                live_tasks.discard(task_id)
            task_connection.close()
            connection.execute(
                "UPDATE backup_tasks SET status='failed',phase='failed',"
                "finished_at=?,error_code='worker_start:RuntimeError' WHERE id=?",
                (now().isoformat(), task_id),
            )
            raise HTTPException(status_code=503, detail="Backup worker could not start") from None
        return {"task_id": task_id, "status": "running"}

    @router.get("/backup-tasks/{task_id}")
    def get_backup_task(
        task_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        with _TASK_SUBMISSION_LOCK:
            completed = reconcile_task(connection, task_id)
            if completed is not None:
                return completed
            row = connection.execute(
                "SELECT * FROM backup_tasks WHERE id=?", (task_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Backup task not found")
        return dict(row)

    return router


async def _read_backup_settings_update(request: Request) -> BackupSettingsUpdate:
    try:
        payload: Any = await request.json()
    except (UnicodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        ) from None
    required_fields = {"directory", "interval_hours", "retention_days"}
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        )
    payload_fields = set(payload)
    if payload_fields not in (required_fields, required_fields | {"enabled"}):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        )
    directory = payload["directory"]
    enabled = payload.get("enabled", directory is not None)
    interval_hours = payload["interval_hours"]
    retention_days = payload["retention_days"]
    if (
        not isinstance(enabled, bool)
        or (enabled and directory is None)
        or (
            directory is not None
            and (not isinstance(directory, str) or not directory.strip())
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        )
    if (
        isinstance(interval_hours, bool)
        or not isinstance(interval_hours, int)
        or not 1 <= interval_hours <= 8760
        or isinstance(retention_days, bool)
        or not isinstance(retention_days, int)
        or not 0 <= retention_days <= 3650
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        )
    return BackupSettingsUpdate(enabled, directory, interval_hours, retention_days)


def _overview(
    connection: sqlite3.Connection,
    settings: Settings,
    scheduler_snapshot: dict[str, object],
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT status, started_at, finished_at, target_path, error_message
        FROM backup_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    last_run = (
        None
        if row is None
        else {key: row[key] for key in row.keys()}  # noqa: SIM118 - sqlite3.Row
    )
    return {
        "data_directory": str(settings.data_dir),
        "database_path": str(settings.data_dir / "iapm.sqlite"),
        "scheduler": scheduler_snapshot,
        "backup": {
            **_backup_settings_response(settings),
            "last_run": last_run,
        },
    }


def _backup_settings_response(settings: Settings) -> dict[str, object]:
    return {
        "enabled": settings.automatic_backup_enabled,
        "directory": None if settings.backup_dir is None else str(settings.backup_dir),
        "interval_hours": settings.backup_interval_hours,
        "retention_days": settings.backup_retention_days,
    }


def _backup_due_state(
    connection: sqlite3.Connection,
    now: datetime,
    interval_hours: int,
) -> tuple[bool, str | None]:
    row = connection.execute(
        """
        SELECT finished_at
        FROM backup_runs
        WHERE status = 'success' AND finished_at IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return True, None
    try:
        finished_at = _require_aware_datetime(
            datetime.fromisoformat(row["finished_at"])
        )
    except (TypeError, ValueError):
        return True, "schedule:ValueError"
    if finished_at > now:
        return True, "schedule:ValueError"
    return now >= finished_at + timedelta(hours=interval_hours), None


def _require_aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _wait_for_stop(stop_event: Event, timeout: float) -> bool:
    return stop_event.wait(timeout)
