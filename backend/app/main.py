from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from backend.app.core.config import Settings, load_settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features import files
from backend.app.features.auth import create_auth_router
from backend.app.features.backups import create_backup, prune_backups
from backend.app.features.commercial import create_commercial_router
from backend.app.features.companies import create_companies_router
from backend.app.features.dashboards import create_dashboards_router
from backend.app.features.delivery import create_delivery_router
from backend.app.features.documents import create_documents_router
from backend.app.features.inventory import create_inventory_router
from backend.app.features.procurement import create_procurement_router
from backend.app.features.procurement_extensions import (
    create_procurement_extensions_router,
)
from backend.app.features.project_stages import create_project_stages_router
from backend.app.features.projects import create_projects_router
from backend.app.features.site_operations import create_site_operations_router
from backend.app.features.system import (
    BackupCreator,
    BackupJobResult,
    BackupPruner,
    BackupScheduler,
    SettingsStore,
    create_system_router,
    run_backup_job,
)
from backend.app.features.workforce import create_workforce_router

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _PROJECT_ROOT / "config.json"
_MIGRATIONS_DIR = _PROJECT_ROOT / "backend" / "migrations"


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as error:
            if error.status_code != 404 or not _is_frontend_navigation(path, scope):
                raise
        else:
            if response.status_code != 404 or not _is_frontend_navigation(path, scope):
                return response
        return await super().get_response("index.html", scope)


def _is_frontend_navigation(path: str, scope: Scope) -> bool:
    if scope.get("method") not in {"GET", "HEAD"}:
        return False
    headers = {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }
    return "text/html" in headers.get("accept", "") and path.startswith("projects/")


def create_app(
    *,
    config_path: str | Path | None = None,
    migrations_dir: str | Path | None = None,
    frontend_dist: str | Path | None = None,
    backup_creator: BackupCreator = create_backup,
    backup_pruner: BackupPruner = prune_backups,
    scheduler_factory: Callable[..., BackupScheduler] = BackupScheduler,
) -> FastAPI:
    selected_config_path = (
        _DEFAULT_CONFIG_PATH if config_path is None else Path(config_path)
    )
    selected_migrations_dir = (
        _MIGRATIONS_DIR if migrations_dir is None else Path(migrations_dir)
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> Iterator[None]:
        settings = load_settings(selected_config_path)
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        files.cleanup_stale_staged_versions(settings.data_dir)
        database_path = settings.data_dir / "iapm.sqlite"
        connection = connect_database(database_path)
        migration_failure: BaseException | None = None
        try:
            apply_migrations(connection, selected_migrations_dir)
        except BaseException as failure:
            migration_failure = failure
            raise
        finally:
            _cleanup_preserving_primary(
                connection.close,
                primary=migration_failure,
                label="database connection close",
            )

        settings_store = SettingsStore(settings)
        application.state.settings = settings_store

        def scheduled_backup_runner(
            scheduled_connection: sqlite3.Connection,
            scheduled_settings: Settings,
            now: datetime,
        ) -> BackupJobResult:
            return run_backup_job(
                scheduled_connection,
                scheduled_settings,
                now,
                creator=backup_creator,
                pruner=backup_pruner,
            )

        scheduler = scheduler_factory(
            settings_store=settings_store,
            connection_factory=connect_database,
            runner=scheduled_backup_runner,
        )
        application.state.backup_scheduler = scheduler
        lifespan_failure: BaseException | None = None
        try:
            scheduler.start()
            yield
        except BaseException as failure:
            lifespan_failure = failure
            raise
        finally:
            _cleanup_preserving_primary(
                scheduler.stop,
                primary=lifespan_failure,
                label="backup scheduler stop",
            )

    application = FastAPI(title="SunYu ERP", lifespan=lifespan)

    def get_settings(request: Request) -> Settings:
        store: SettingsStore = request.app.state.settings
        return store.get()

    def update_settings(
        *,
        directory: str | None,
        interval_hours: int,
        retention_days: int,
    ) -> Settings:
        store: SettingsStore = application.state.settings
        return store.update_backup(
            directory=directory,
            interval_hours=interval_hours,
            retention_days=retention_days,
        )

    def get_scheduler_snapshot(request: Request) -> dict[str, object]:
        scheduler: BackupScheduler = request.app.state.backup_scheduler
        return scheduler.snapshot()

    def get_session_secret(request: Request) -> str:
        return get_settings(request).session_secret

    def get_connection(request: Request) -> Iterator[sqlite3.Connection]:
        settings = get_settings(request)
        connection = connect_database(settings.data_dir / "iapm.sqlite")
        request_failure: BaseException | None = None
        try:
            yield connection
        except BaseException as failure:
            request_failure = failure
            raise
        finally:
            _cleanup_preserving_primary(
                connection.close,
                primary=request_failure,
                label="database connection close",
            )

    application.include_router(create_auth_router(get_connection, get_session_secret))
    application.include_router(create_companies_router(get_connection, get_settings))
    application.include_router(create_projects_router(get_connection, get_settings))
    application.include_router(create_documents_router(get_connection, get_settings))
    application.include_router(create_commercial_router(get_connection, get_settings))
    application.include_router(
        create_project_stages_router(get_connection, get_settings)
    )
    application.include_router(create_procurement_router(get_connection, get_settings))
    application.include_router(
        create_procurement_extensions_router(get_connection, get_settings)
    )
    application.include_router(create_inventory_router(get_connection, get_settings))
    application.include_router(create_workforce_router(get_connection, get_settings))
    application.include_router(
        create_site_operations_router(get_connection, get_settings)
    )
    application.include_router(create_delivery_router(get_connection, get_settings))
    application.include_router(create_dashboards_router(get_connection, get_settings))
    application.include_router(
        create_system_router(
            get_connection,
            get_settings,
            update_settings,
            get_scheduler_snapshot,
            backup_creator=backup_creator,
            backup_pruner=backup_pruner,
        )
    )

    @application.get("/api/health")
    def get_health() -> dict[str, str]:
        return {"status": "ok"}

    if frontend_dist is not None:
        application.mount(
            "/",
            FrontendStaticFiles(directory=Path(frontend_dist), html=True),
            name="frontend",
        )

    return application


def _cleanup_preserving_primary(
    cleanup: Callable[[], None],
    *,
    primary: BaseException | None,
    label: str,
) -> None:
    try:
        cleanup()
    except BaseException as failure:
        if primary is None:
            raise
        primary.add_note(f"{label} failed: {type(failure).__name__}")


app = create_app()
