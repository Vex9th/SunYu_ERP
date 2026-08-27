from __future__ import annotations

import sqlite3
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from backend.app.core.database import transaction
from backend.app.core.security import (
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    create_session_token,
    hash_password,
    is_session_token_valid,
    validate_password,
    verify_password,
)

_MAX_LOGIN_FAILURES = 5
_LOGIN_FAILURE_WINDOW_SECONDS = 5 * 60


async def _read_password(request: Request) -> str:
    try:
        payload: Any = await request.json()
    except (UnicodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Password must be exactly six ASCII digits",
        ) from None

    if not isinstance(payload, dict) or set(payload) != {"password"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Password must be exactly six ASCII digits",
        )
    try:
        return validate_password(payload["password"])
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Password must be exactly six ASCII digits",
        ) from None


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
    password_dependency = Depends(_read_password)

    @router.post("/setup", status_code=status.HTTP_204_NO_CONTENT)
    def setup_password(
        password: str = password_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> Response:
        password_hash = hash_password(password)
        try:
            with transaction(connection):
                connection.execute(
                    """
                    INSERT INTO auth_secret
                        (singleton_id, password_hash, updated_at)
                    VALUES (1, ?, ?)
                    """,
                    (
                        password_hash,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Password is already configured",
            ) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post("/login", status_code=status.HTTP_204_NO_CONTENT)
    def login(
        request: Request,
        password: str = password_dependency,
        connection: sqlite3.Connection = connection_dependency,
        session_secret: str = session_secret_dependency,
    ) -> Response:
        client_host = request.client.host if request.client is not None else "unknown"
        row = connection.execute(
            "SELECT password_hash FROM auth_secret WHERE singleton_id = 1"
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Password is not configured",
            )
        if not login_limiter.try_start_attempt(client_host):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts",
            )

        try:
            password_matches = verify_password(row["password_hash"], password)
        except BaseException:
            login_limiter.cancel_attempt(client_host)
            raise
        if not password_matches:
            login_limiter.finish_failure(client_host)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid password",
            )

        login_limiter.finish_success(client_host)
        response = Response(status_code=status.HTTP_204_NO_CONTENT)
        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=create_session_token(session_secret),
            max_age=SESSION_MAX_AGE_SECONDS,
            path="/",
            secure=False,
            httponly=True,
            samesite="lax",
        )
        return response

    @router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
    def logout() -> Response:
        response = Response(status_code=status.HTTP_204_NO_CONTENT)
        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value="",
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
        session_secret: str = session_secret_dependency,
    ) -> dict[str, bool]:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        return {
            "authenticated": is_session_token_valid(session_secret, token),
        }

    return router
