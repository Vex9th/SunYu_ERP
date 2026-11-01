from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import (
    SESSION_COOKIE_NAME,
    create_session_token,
    hash_password,
)
from backend.app.features.accounts import create_accounts_router
from backend.app.features.auth import create_auth_router, require_authenticated_session

OWNER_PASSWORD = "TestOwner123"
MEMBER_PASSWORD = "TestBuyer123"


def owner_session_token(database_path: Path, session_secret: str) -> str:
    """Upgrade legacy business fixtures through the actual local auth HTTP flow."""

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(database_path)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(create_auth_router(get_connection, lambda: session_secret))
    with TestClient(
        app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)
    ) as client:
        state = client.get("/api/auth/session").json()
        if state["bootstrap_required"]:
            response = client.post(
                "/api/auth/bootstrap",
                json={"username": "owner", "password": OWNER_PASSWORD},
            )
            assert response.status_code in {200, 409}, response.text
        response = client.post(
            "/api/auth/login", json={"username": "owner", "password": OWNER_PASSWORD}
        )
        assert response.status_code == 204, response.text
        token = client.cookies.get(SESSION_COOKIE_NAME)
        assert token is not None
        return token


def authenticate_owner(client: TestClient) -> None:
    """Authenticate an already-running full application with a revocable owner session."""
    settings = client.app.state.settings.get()
    client.cookies.set(
        SESSION_COOKIE_NAME,
        owner_session_token(settings.data_dir / "iapm.sqlite", settings.session_secret),
    )


@dataclass
class AccessHarness:
    app: FastAPI
    database_path: Path
    settings: Settings

    def client(self, host: str = "127.0.0.1") -> TestClient:
        return TestClient(self.app, base_url="http://127.0.0.1", client=(host, 50000))

    def owner_client(self) -> TestClient:
        client = self.client()
        state = client.get("/api/auth/session").json()
        if state["bootstrap_required"]:
            response = client.post(
                "/api/auth/bootstrap",
                json={
                    "username": "owner",
                    "password": OWNER_PASSWORD,
                    "display_name": "主账号",
                },
            )
            assert response.status_code == 200, response.text
        else:
            response = client.post(
                "/api/auth/login",
                json={"username": "owner", "password": OWNER_PASSWORD},
            )
            assert response.status_code == 204, response.text
        return client

    def member_client(
        self, username: str = "buyer", password: str = MEMBER_PASSWORD
    ) -> TestClient:
        client = self.client()
        response = client.post(
            "/api/auth/login", json={"username": username, "password": password}
        )
        assert response.status_code == 204, response.text
        return client

    def seed_legacy_password(self) -> str:
        password_hash = hash_password("123456")
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO auth_secret VALUES (1, ?, '2026-10-31T00:00:00+00:00')",
                (password_hash,),
            )
        return password_hash

    def client_with_legacy_cookie(self) -> TestClient:
        self.seed_legacy_password()
        client = self.client()
        client.cookies.set(
            SESSION_COOKIE_NAME, create_session_token(self.settings.session_secret)
        )
        return client

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = connect_database(self.database_path)
        try:
            yield connection
        finally:
            connection.close()


def make_access_app(tmp_path: Path) -> AccessHarness:
    database_path = tmp_path / "iapm.sqlite"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, Path(__file__).resolve().parents[1] / "migrations")
    finally:
        connection.close()
    settings = Settings(
        tmp_path / "config.json",
        tmp_path,
        None,
        24,
        30,
        "127.0.0.1",
        0,
        "synthetic-account-session-secret-at-least-32-bytes",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(database_path)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(
        create_auth_router(get_connection, lambda: settings.session_secret)
    )
    app.include_router(create_accounts_router(get_connection, lambda: settings))
    connection_dependency = Depends(get_connection)

    @app.get("/_test/principal")
    def principal(
        request: Request, connection: sqlite3.Connection = connection_dependency
    ):
        require_authenticated_session(request, settings.session_secret, connection)
        actor = request.state.principal
        return {
            "user_id": actor.user_id,
            "group_id": actor.group_id,
            "permissions": sorted(actor.permissions),
            "project_ids": sorted(actor.project_ids),
        }

    return AccessHarness(app, database_path, settings)
