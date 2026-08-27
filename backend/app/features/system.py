from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from backend.app.core.config import Settings, update_backup_settings
from backend.app.features.auth import require_authenticated_session
from backend.app.features.backups import create_backup, prune_backups

_SCHEDULER_POLL_SECONDS = 60.0
_SCHEDULER_STOP_TIMEOUT_SECONDS = 5.0
_MAX_RETRY_DELAY = timedelta(hours=1)
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
        directory: str | None,
        interval_hours: int,
        retention_days: int,
    ) -> Settings:
        with self._lock:
            updated = update_backup_settings(
                self._settings.config_path,
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
            if settings.backup_dir is None:
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
            self._record_error(failure_category, primary_failure, now)
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
    directory: str | None
    interval_hours: int
    retention_days: int


def run_backup_job(
    connection: sqlite3.Connection,
    settings: Settings,
    now: datetime,
    *,
    creator: BackupCreator = create_backup,
    pruner: BackupPruner = prune_backups,
) -> BackupJobResult:
    if settings.backup_dir is None:
        raise RuntimeError("backup_dir is not configured")
    target = creator(connection, settings, now=now)
    try:
        pruner(
            settings.backup_dir,
            settings.backup_retention_days,
            now=now,
        )
    except BaseException as failure:  # noqa: BLE001 - backup already succeeded
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

    return router


async def _read_backup_settings_update(request: Request) -> BackupSettingsUpdate:
    try:
        payload: Any = await request.json()
    except (UnicodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        ) from None
    if not isinstance(payload, dict) or set(payload) != {
        "directory",
        "interval_hours",
        "retention_days",
    }:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid backup settings",
        )
    directory = payload["directory"]
    interval_hours = payload["interval_hours"]
    retention_days = payload["retention_days"]
    if directory is not None and (
        not isinstance(directory, str) or not directory.strip()
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
    return BackupSettingsUpdate(directory, interval_hours, retention_days)


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
        "enabled": settings.backup_dir is not None,
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
