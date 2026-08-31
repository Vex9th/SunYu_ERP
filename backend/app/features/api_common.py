from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        detail: str,
        error_code: str,
        *,
        field_errors: dict[str, object] | None = None,
        current_revision: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.error_code = error_code
        self.field_errors = field_errors or {}
        self.current_revision = current_revision
        self.headers = headers or {}

    def body(self) -> dict[str, object]:
        return {
            "detail": self.detail,
            "error_code": self.error_code,
            "field_errors": self.field_errors,
            "current_revision": self.current_revision,
        }


class ApiErrorRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Any:
            try:
                return await original(request)
            except ApiError as failure:
                return JSONResponse(
                    failure.body(),
                    status_code=failure.status_code,
                    headers=failure.headers,
                )

        return handler


def idempotency_scope(request: Request) -> str:
    return f"{request.method.upper()}:{request.url.path}"


def idempotency_storage_key(scope: str, key: str) -> str:
    return hashlib.sha256(f"{scope}\0{key}".encode()).hexdigest()


def restore_idempotent_response(
    connection: sqlite3.Connection,
    *,
    scope: str,
    key: str,
    request_hash: str,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT request_sha256, response_json
        FROM idempotency_requests
        WHERE scope = ? AND idempotency_key = ?
        """,
        (scope, key),
    ).fetchone()
    if row is None:
        return None
    if row["request_sha256"] != request_hash:
        raise ApiError(
            409,
            "Idempotency key reused",
            "IDEMPOTENCY_KEY_REUSED",
            headers={"X-Error-Code": "IDEMPOTENCY_KEY_REUSED"},
        )
    restored = json.loads(row["response_json"])
    if not isinstance(restored, dict):
        raise sqlite3.DatabaseError("idempotency response is not an object")
    return restored


def save_idempotent_response(
    connection: sqlite3.Connection,
    *,
    scope: str,
    key: str,
    request_hash: str,
    response: dict[str, object],
    response_status: int,
    resource_type: str,
    resource_id: int,
    created_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO idempotency_requests
            (scope, idempotency_key, request_sha256, response_status,
             response_json, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            scope,
            key,
            request_hash,
            response_status,
            json.dumps(response, ensure_ascii=False, sort_keys=True),
            resource_type,
            resource_id,
            created_at,
        ),
    )
