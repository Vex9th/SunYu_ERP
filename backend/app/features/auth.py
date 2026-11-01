from __future__ import annotations

import ipaddress
import secrets
import sqlite3
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime, timezone
from functools import lru_cache
from hashlib import sha256
from threading import Lock
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from backend.app.core.access import Principal, principal_from_account, require_principal
from backend.app.core.database import transaction_immediate
from backend.app.core.security import (
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    create_account_session_token,
    hash_account_password,
    normalize_username,
    read_account_session_token,
    validate_account_password,
    validate_password,
    verify_account_password,
    verify_password,
)

_MAX_LOGIN_FAILURES = 5
_LOGIN_FAILURE_WINDOW_SECONDS = 5 * 60


def require_authenticated_session(
    request: Request,
    session_secret: str,
    connection: sqlite3.Connection | None = None,
) -> Principal:
    if connection is not None:
        return require_principal(request, connection, session_secret)
    principal = getattr(request.state, "principal", None)
    if not isinstance(principal, Principal):
        raise HTTPException(401, "Authentication required")
    return principal


async def read_auth_payload(request: Request) -> dict[str, object]:
    try:
        payload = await request.json()
    except (UnicodeError, ValueError):
        raise HTTPException(422, "Invalid account input") from None
    if not isinstance(payload, dict):
        raise HTTPException(422, "Invalid account input")
    return payload


def account_credentials(payload: dict[str, object]) -> tuple[str, str, str]:
    try:
        username, key = normalize_username(payload.get("username"))
        password = validate_account_password(payload.get("password"))
    except (TypeError, ValueError):
        raise HTTPException(
            422, "Username and an 8 to 128 character password are required"
        ) from None
    return username, key, password


def account_display_name(value: object) -> str:
    if not isinstance(value, str) or len(value) > 100:
        raise HTTPException(422, "Display name must contain at most 100 characters")
    return value.strip()


def _local_bootstrap(request: Request) -> bool:
    def loopback(host: str | None) -> bool:
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host or "").is_loopback
        except ValueError:
            return False

    if request.client is None or not loopback(request.client.host):
        return False
    if any(
        key.lower() == "forwarded" or key.lower().startswith("x-forwarded-")
        for key in request.headers
    ):
        return False
    try:
        target = urlsplit(str(request.url))
        if not loopback(target.hostname) or target.username or target.password:
            return False
        origin_text = request.headers.get("origin")
        if origin_text is None:
            return True
        origin = urlsplit(origin_text)
        return (
            origin.scheme == target.scheme
            and origin.netloc == target.netloc
            and not origin.path
            and not origin.query
            and not origin.fragment
        )
    except ValueError:
        return False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_MAX_AGE_SECONDS,
        path="/",
        secure=False,
        httponly=True,
        samesite="lax",
    )


def _new_session(
    connection: sqlite3.Connection, session_secret: str, user_id: int
) -> str:
    sid = secrets.token_hex(32)
    connection.execute(
        """
        INSERT INTO account_sessions (sid_hash, account_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
    """,
        (
            sha256(sid.encode()).hexdigest(),
            user_id,
            _now(),
            int(time.time()) + SESSION_MAX_AGE_SECONDS,
        ),
    )
    return create_account_session_token(session_secret, user_id, sid)


def session_state(
    connection: sqlite3.Connection, principal: Principal | None
) -> dict[str, object]:
    owner_exists = (
        connection.execute("SELECT 1 FROM accounts WHERE is_owner = 1").fetchone()
        is not None
    )
    old_password = (
        connection.execute(
            "SELECT 1 FROM auth_secret WHERE singleton_id = 1"
        ).fetchone()
        is not None
    )
    user = None
    if principal is not None:
        revision = connection.execute(
            "SELECT revision FROM accounts WHERE id = ?", (principal.user_id,)
        ).fetchone()[0]
        user = {
            "id": principal.user_id,
            "username": principal.username,
            "display_name": principal.display_name,
            "is_owner": principal.is_owner,
            "group_id": principal.group_id,
            "group_name": principal.group_name,
            "revision": revision,
        }
    return {
        "authenticated": principal is not None,
        "password_configured": old_password or owner_exists,
        "bootstrap_required": not owner_exists,
        "user": user,
        "access_revision": principal.access_revision if principal else 0,
        "permissions": sorted(principal.permissions) if principal else [],
        "project_ids": None
        if principal and principal.is_owner
        else sorted(principal.project_ids)
        if principal
        else [],
    }


@lru_cache(maxsize=1)
def _dummy_password_hash() -> str:
    return hash_account_password("dummy-account-password-for-timing")


class FailedLoginLimiter:
    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._failures: dict[str, deque[float]] = {}
        self._in_flight: dict[str, int] = {}
        self._lock = Lock()

    def try_start_attempt(self, client_host: str) -> bool:
        with self._lock:
            failures = self._active_failures(client_host, self._clock())
            failure_count = len(failures) if failures is not None else 0
            in_flight_count = self._in_flight.get(client_host, 0)
            if failure_count + in_flight_count >= _MAX_LOGIN_FAILURES:
                return False
            self._in_flight[client_host] = in_flight_count + 1
            return True

    def finish_failure(self, client_host: str) -> None:
        with self._lock:
            now = self._clock()
            self._release_attempt(client_host)
            failures = self._active_failures(client_host, now)
            if failures is None:
                failures = deque()
                self._failures[client_host] = failures
            failures.append(now)

    def finish_success(self, client_host: str) -> None:
        with self._lock:
            self._release_attempt(client_host)
            self._failures.pop(client_host, None)

    def cancel_attempt(self, client_host: str) -> None:
        with self._lock:
            self._release_attempt(client_host)

    def _active_failures(
        self,
        client_host: str,
        now: float,
    ) -> deque[float] | None:
        failures = self._failures.get(client_host)
        if failures is None:
            return None
        cutoff = now - _LOGIN_FAILURE_WINDOW_SECONDS
        while failures and failures[0] <= cutoff:
            failures.popleft()
        if not failures:
            self._failures.pop(client_host, None)
            return None
        return failures

    def _release_attempt(self, client_host: str) -> None:
        in_flight_count = self._in_flight.get(client_host, 0)
        if in_flight_count <= 0:
            raise RuntimeError("cannot finish a login attempt that was not started")
        if in_flight_count == 1:
            self._in_flight.pop(client_host)
        else:
            self._in_flight[client_host] = in_flight_count - 1


def create_auth_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_session_secret: Callable[..., str],
    limiter: FailedLoginLimiter | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/auth", tags=["auth"])
    login_limiter = limiter or FailedLoginLimiter()
    connection_dependency = Depends(get_connection)
    session_secret_dependency = Depends(get_session_secret)
    payload_dependency = Depends(read_auth_payload)

    def reserve(keys: tuple[str, ...]) -> None:
        reserved: list[str] = []
        for key in keys:
            if not login_limiter.try_start_attempt(key):
                for previous in reserved:
                    login_limiter.cancel_attempt(previous)
                raise HTTPException(429, "Too many login attempts")
            reserved.append(key)

    @router.post("/setup")
    def retired_setup() -> None:
        raise HTTPException(410, "Use local account bootstrap")

    @router.post("/bootstrap")
    def bootstrap(
        request: Request,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        session_secret: str = session_secret_dependency,
    ) -> Response:
        if not _local_bootstrap(request):
            raise HTTPException(
                403, "Bootstrap must be performed directly on the server computer"
            )
        if set(payload) - {"username", "password", "display_name", "legacy_password"}:
            raise HTTPException(422, "Invalid account input")
        username, username_key, password = account_credentials(payload)
        display_name = account_display_name(payload.get("display_name", ""))
        key = f"bootstrap:{request.client.host}"
        reserve((key,))
        try:
            with transaction_immediate(connection):
                if connection.execute(
                    "SELECT 1 FROM accounts WHERE is_owner = 1"
                ).fetchone():
                    raise HTTPException(409, "Owner account is already configured")
                old_secret = connection.execute(
                    "SELECT password_hash FROM auth_secret WHERE singleton_id = 1"
                ).fetchone()
                if old_secret is not None:
                    try:
                        legacy_password = validate_password(
                            payload.get("legacy_password")
                        )
                    except (TypeError, ValueError):
                        raise HTTPException(401, "Invalid legacy password") from None
                    if not verify_password(
                        old_secret["password_hash"], legacy_password
                    ):
                        raise HTTPException(401, "Invalid legacy password")
                timestamp = _now()
                cursor = connection.execute(
                    """
                    INSERT INTO accounts (username, username_key, display_name, password_hash, is_owner, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                    (
                        username,
                        username_key,
                        display_name,
                        hash_account_password(password),
                        timestamp,
                        timestamp,
                    ),
                )
                user_id = cursor.lastrowid
                row = connection.execute(
                    "SELECT * FROM accounts WHERE id = ?", (user_id,)
                ).fetchone()
                principal = principal_from_account(connection, row)
                from backend.app.features.operation_history import (
                    append_operation_event,
                )

                append_operation_event(
                    connection,
                    principal=principal,
                    request_id=getattr(request.state, "request_id", ""),
                    action="accounts.bootstrap",
                    resource_type="account",
                    resource_id=user_id,
                    project_ids=(),
                    summary="初始化主账号",
                    reason=None,
                    changes={"username": username, "display_name": display_name},
                    occurred_at=timestamp,
                )
                token = _new_session(connection, session_secret, user_id)
                state = session_state(connection, principal)
        except BaseException as failure:
            if isinstance(failure, HTTPException) and failure.status_code == 401:
                login_limiter.finish_failure(key)
            else:
                login_limiter.cancel_attempt(key)
            raise
        login_limiter.finish_success(key)
        response = JSONResponse(state)
        _set_session_cookie(response, token)
        return response

    @router.post("/login", status_code=204)
    def login(
        request: Request,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        session_secret: str = session_secret_dependency,
    ) -> Response:
        if set(payload) != {"username", "password"}:
            raise HTTPException(422, "Username and password are required")
        _, username_key, password = account_credentials(payload)
        if not connection.execute(
            "SELECT 1 FROM accounts WHERE is_owner = 1"
        ).fetchone():
            raise HTTPException(409, "Owner account is not configured")
        host = request.client.host if request.client else "unknown"
        keys = (f"host:{host}", f"account:{username_key}")
        reserve(keys)
        try:
            row = connection.execute(
                "SELECT * FROM accounts WHERE username_key = ?", (username_key,)
            ).fetchone()
            matches = verify_account_password(
                row["password_hash"] if row else _dummy_password_hash(), password
            )
            if not matches or row is None or not row["enabled"]:
                raise HTTPException(401, "Invalid username or password")
            with transaction_immediate(connection):
                # Recheck after the expensive verifier: a concurrent reset/disable must win.
                current = connection.execute(
                    "SELECT * FROM accounts WHERE id = ?", (row["id"],)
                ).fetchone()
                if (
                    current is None
                    or not current["enabled"]
                    or current["password_hash"] != row["password_hash"]
                ):
                    raise HTTPException(401, "Invalid username or password")
                token = _new_session(connection, session_secret, row["id"])
        except BaseException as failure:
            for key in keys:
                if isinstance(failure, HTTPException) and failure.status_code == 401:
                    login_limiter.finish_failure(key)
                else:
                    login_limiter.cancel_attempt(key)
            raise
        for key in keys:
            login_limiter.finish_success(key)
        response = Response(status_code=204)
        _set_session_cookie(response, token)
        return response

    @router.post("/logout", status_code=204)
    def logout(
        request: Request,
        connection: sqlite3.Connection = connection_dependency,
        session_secret: str = session_secret_dependency,
    ) -> Response:
        identity = read_account_session_token(
            session_secret, request.cookies.get(SESSION_COOKIE_NAME)
        )
        if identity is not None:
            user_id, sid = identity
            with transaction_immediate(connection):
                connection.execute(
                    "UPDATE account_sessions SET revoked_at = ? WHERE sid_hash = ? AND account_id = ? AND revoked_at IS NULL",
                    (_now(), sha256(sid.encode()).hexdigest(), user_id),
                )
        response = Response(status_code=204)
        response.set_cookie(
            SESSION_COOKIE_NAME,
            "",
            max_age=0,
            path="/",
            secure=False,
            httponly=True,
            samesite="lax",
        )
        return response

    @router.get("/session")
    def get_session(
        request: Request,
        connection: sqlite3.Connection = connection_dependency,
        session_secret: str = session_secret_dependency,
    ) -> dict[str, object]:
        try:
            principal = require_principal(request, connection, session_secret)
        except HTTPException as failure:
            if failure.status_code != 401:
                raise
            principal = None
        return session_state(connection, principal)

    return router
