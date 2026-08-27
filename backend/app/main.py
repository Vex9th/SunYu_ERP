from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request

from backend.app.core.config import Settings, load_settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features.auth import create_auth_router
from backend.app.features.backups import create_backup, prune_backups
from backend.app.features.system import (
    BackupCreator,
    BackupPruner,
    BackupScheduler,
    SettingsStore,
    create_system_router,
    run_backup_job,
)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _PROJECT_ROOT / "config.json"
_MIGRATIONS_DIR = _PROJECT_ROOT / "backend" / "migrations"


def create_app(
    *,
    config_path: str | Path | None = None,
    backup_creator: BackupCreator = create_backup,
    backup_pruner: BackupPruner = prune_backups,
    scheduler_factory: Callable[..., BackupScheduler] = BackupScheduler,
) -> FastAPI:
    selected_config_path = (
        _DEFAULT_CONFIG_PATH if config_path is None else Path(config_path)
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> Iterator[None]:
        settings = load_settings(selected_config_path)
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        database_path = settings.data_dir / "iapm.sqlite"
        connection = connect_database(database_path)
        try:
            apply_migrations(connection, _MIGRATIONS_DIR)
        finally:
            connection.close()

        settings_store = SettingsStore(settings)
        application.state.settings = settings_store

        def scheduled_backup_runner(
            scheduled_connection: sqlite3.Connection,
            scheduled_settings: Settings,
            now: datetime,
        ) -> Path:
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
        scheduler.start()
        try:
            yield
        finally:
            scheduler.stop()

    application = FastAPI(title="SunYu ERP", lifespan=lifespan)

    def get_settings(request: Request) -> Settings:
        store: SettingsStore = request.app.state.settings
        return store.get()

    def replace_settings(settings: Settings) -> None:
        store: SettingsStore = application.state.settings
        store.replace(settings)

    def get_session_secret(request: Request) -> str:
        return get_settings(request).session_secret

    def get_connection(request: Request) -> Iterator[sqlite3.Connection]:
        settings = get_settings(request)
        connection = connect_database(settings.data_dir / "iapm.sqlite")
        try:
            yield connection
        finally:
            connection.close()

    application.include_router(create_auth_router(get_connection, get_session_secret))
    application.include_router(
        create_system_router(
            get_connection,
            get_settings,
            replace_settings,
            backup_creator=backup_creator,
            backup_pruner=backup_pruner,
        )
    )

    @application.get("/api/health")
    def get_health() -> dict[str, str]:
        return {"status": "ok"}

    return application


app = create_app()
