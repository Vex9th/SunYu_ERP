from __future__ import annotations

import hmac
import json
import sqlite3
import unicodedata
from collections.abc import Callable
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.app.core.access import Principal, require_principal
from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.security import hash_account_password, validate_account_password
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    idempotency_scope,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import (
    account_credentials,
    account_display_name,
    read_auth_payload,
)
from backend.app.features.permission_catalog import (
    permission_catalog,
    validate_permission_keys,
)

_ACCOUNT_FIELDS = (
    "id",
    "username",
    "display_name",
    "enabled",
    "is_owner",
    "group_id",
    "group_name",
    "revision",
    "created_at",
    "updated_at",
)
_GROUP_FIELDS = (
    "id",
    "name",
    "enabled",
    "archived",
    "revision",
    "created_at",
    "updated_at",
)


def _account(connection: sqlite3.Connection, account_id: int) -> dict[str, object]:
    row = connection.execute(
        """SELECT a.*, g.name AS group_name FROM accounts a
        LEFT JOIN workgroups g ON g.id = a.group_id WHERE a.id = ?""",
        (account_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Account not found")
    result = {key: row[key] for key in _ACCOUNT_FIELDS}
    result["enabled"], result["is_owner"] = bool(row["enabled"]), bool(row["is_owner"])
    return result


def _group(connection: sqlite3.Connection, group_id: int) -> dict[str, object]:
    row = connection.execute(
        "SELECT * FROM workgroups WHERE id = ?", (group_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Workgroup not found")
    result = {key: row[key] for key in _GROUP_FIELDS}
    result["enabled"], result["archived"] = bool(row["enabled"]), bool(row["archived"])
    result["member_count"] = connection.execute(
        "SELECT count(*) FROM accounts WHERE group_id = ?", (group_id,)
    ).fetchone()[0]
    result["permission_keys"] = [
        row[0]
        for row in connection.execute(
            "SELECT permission_key FROM workgroup_permissions WHERE group_id = ? ORDER BY permission_key",
            (group_id,),
        )
    ]
    result["project_ids"] = [
        row[0]
        for row in connection.execute(
            "SELECT project_id FROM workgroup_projects WHERE group_id = ? ORDER BY project_id",
            (group_id,),
        )
    ]
    return result


def _fields(payload: dict[str, object], required: set[str], allowed: set[str]) -> None:
    if required - payload.keys() or payload.keys() - allowed:
        raise HTTPException(422, "Invalid management input")


def _positive_integer(value: object) -> int:
    if type(value) is not int or value < 1 or value > 2**63 - 1:
        raise HTTPException(422, "Expected a positive integer")
    return value


def _revision(record: dict[str, object], expected: object) -> None:
    if _positive_integer(expected) != record["revision"]:
        raise ApiError(
            409,
            "Record has changed; refresh and try again",
            "REVISION_CONFLICT",
            current_revision=int(record["revision"]),
        )


def _enabled(value: object) -> bool:
    if type(value) is not bool:
        raise HTTPException(422, "enabled must be a boolean")
    return value


def _group_name(value: object) -> tuple[str, str]:
    if not isinstance(value, str):
        raise HTTPException(
            422, "Workgroup name must contain 1 to 100 visible characters"
        )
    name = unicodedata.normalize("NFKC", value).strip()
    if not 1 <= len(name) <= 100 or any(
        unicodedata.category(char).startswith("C") for char in name
    ):
        raise HTTPException(
            422, "Workgroup name must contain 1 to 100 visible characters"
        )
    return name, name.casefold()


def _assigned_group(connection: sqlite3.Connection, value: object) -> int | None:
    if value is None:
        return None
    group_id = _positive_integer(value)
    group = _group(connection, group_id)
    if not group["enabled"] or group["archived"]:
        raise HTTPException(409, "Workgroup is unavailable")
    return group_id


def create_accounts_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["accounts"], route_class=ApiErrorRoute)
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    payload_dependency = Depends(read_auth_payload)

    def require_owner(
        request: Request,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> Principal:
        principal = require_principal(request, connection, settings.session_secret)
        if not principal.is_owner:
            raise HTTPException(403, "Owner account required")
        return principal

    owner_dependency = Depends(require_owner)

    def mutate(
        request: Request,
        connection: sqlite3.Connection,
        settings: Settings,
        payload: dict[str, object],
        action: str,
        resource_type: str,
        summary: str,
        change: Callable[[str], tuple[dict[str, object], dict[str, object]]],
        response_status: int = 200,
    ) -> dict[str, object]:
        key = request.headers.get("Idempotency-Key")
        if key is not None:
            try:
                key = str(UUID(key))
            except (ValueError, AttributeError):
                raise HTTPException(422, "Idempotency-Key must be a UUID") from None
        # Key the request fingerprint so persisted hashes cannot be used as a password oracle.
        request_hash = hmac.digest(
            settings.session_secret.encode(),
            json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode(),
            "sha256",
        ).hex()
        try:
            with transaction_immediate(connection):
                principal = require_owner(request, connection, settings)
                scope = idempotency_scope(request)
                if key is not None:
                    restored = restore_idempotent_response(
                        connection, scope=scope, key=key, request_hash=request_hash
                    )
                    if restored is not None:
                        return restored
                timestamp = datetime.now(timezone.utc).isoformat()
                result, changes = change(timestamp)
                from backend.app.features.operation_history import (
                    append_operation_event,
                )

                append_operation_event(
                    connection,
                    principal=principal,
                    request_id=getattr(request.state, "request_id", None)
                    or key
                    or str(uuid4()),
                    action=action,
                    resource_type=resource_type,
                    resource_id=result["id"],
                    project_ids=(),
                    summary=summary,
                    reason=None,
                    changes=changes,
                    occurred_at=timestamp,
                )
                if key is not None:
                    save_idempotent_response(
                        connection,
                        scope=scope,
                        key=key,
                        request_hash=request_hash,
                        response=result,
                        response_status=response_status,
                        resource_type=resource_type,
                        resource_id=int(result["id"]),
                        created_at=timestamp,
                    )
                return result
        except sqlite3.IntegrityError as failure:
            if (
                getattr(failure, "sqlite_errorcode", None)
                == sqlite3.SQLITE_CONSTRAINT_UNIQUE
            ):
                raise HTTPException(
                    409, "Account or workgroup name already exists"
                ) from None
            raise HTTPException(
                500, "Account management could not be saved"
            ) from failure
        except sqlite3.Error as failure:
            raise HTTPException(
                500, "Account management could not be saved"
            ) from failure

    @router.get("/accounts")
    def list_accounts(
        _: Principal = owner_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ):
        return [
            _account(connection, row[0])
            for row in connection.execute(
                "SELECT id FROM accounts ORDER BY is_owner DESC, username_key, id"
            )
        ]

    @router.post("/accounts", status_code=201)
    def create_account(
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _fields(
            payload,
            {"username", "password"},
            {"username", "password", "display_name", "group_id"},
        )
        username, username_key, password = account_credentials(payload)
        display_name = account_display_name(payload.get("display_name", ""))

        def change(timestamp):
            group_id = _assigned_group(connection, payload.get("group_id"))
            cursor = connection.execute(
                """INSERT INTO accounts
                (username, username_key, display_name, password_hash, group_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    username,
                    username_key,
                    display_name,
                    hash_account_password(password),
                    group_id,
                    timestamp,
                    timestamp,
                ),
            )
            return _account(connection, cursor.lastrowid), {
                "username": username,
                "display_name": display_name,
                "group_id": group_id,
            }

        return mutate(
            request,
            connection,
            settings,
            payload,
            "accounts.create",
            "account",
            "创建账号",
            change,
            201,
        )

    @router.patch("/accounts/{account_id}")
    def update_account(
        account_id: int,
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _positive_integer(account_id)
        _fields(
            payload,
            {"expected_revision"},
            {"expected_revision", "display_name", "enabled", "group_id"},
        )
        if len(payload) == 1:
            raise HTTPException(422, "No account changes supplied")

        def change(timestamp):
            current = _account(connection, account_id)
            _revision(current, payload["expected_revision"])
            if current["is_owner"] and (
                payload.get("enabled") is False or payload.get("group_id") is not None
            ):
                raise HTTPException(
                    409, "The owner cannot be disabled or assigned to a workgroup"
                )
            changes = {}
            if "display_name" in payload:
                changes["display_name"] = account_display_name(payload["display_name"])
            if "enabled" in payload:
                changes["enabled"] = _enabled(payload["enabled"])
            if "group_id" in payload:
                changes["group_id"] = _assigned_group(connection, payload["group_id"])
            updated = {**current, **changes}
            connection.execute(
                """UPDATE accounts SET display_name = ?, enabled = ?, group_id = ?,
                revision = revision + 1, updated_at = ? WHERE id = ?""",
                (
                    updated["display_name"],
                    updated["enabled"],
                    updated["group_id"],
                    timestamp,
                    account_id,
                ),
            )
            if changes.get("enabled") is False:
                connection.execute(
                    "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
                    (timestamp, account_id),
                )
            result = _account(connection, account_id)
            if "group_id" in changes:
                changes["group_name"] = {
                    "before": current["group_name"], "after": result["group_name"]
                }
            return result, changes

        return mutate(
            request,
            connection,
            settings,
            payload,
            "accounts.update",
            "account",
            "修改账号",
            change,
        )

    @router.post("/accounts/{account_id}/reset-password")
    def reset_password(
        account_id: int,
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _positive_integer(account_id)
        _fields(
            payload,
            {"password", "expected_revision"},
            {"password", "expected_revision"},
        )
        try:
            password = validate_account_password(payload["password"])
        except (TypeError, ValueError):
            raise HTTPException(
                422, "Password must contain 8 to 128 characters"
            ) from None

        def change(timestamp):
            current = _account(connection, account_id)
            _revision(current, payload["expected_revision"])
            connection.execute(
                "UPDATE accounts SET password_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
                (hash_account_password(password), timestamp, account_id),
            )
            connection.execute(
                "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
                (timestamp, account_id),
            )
            return _account(connection, account_id), {}

        return mutate(
            request,
            connection,
            settings,
            payload,
            "accounts.reset_password",
            "account",
            "重置账号密码并撤销会话",
            change,
        )

    @router.get("/workgroups")
    def list_workgroups(
        _: Principal = owner_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ):
        return [
            _group(connection, row[0])
            for row in connection.execute(
                "SELECT id FROM workgroups ORDER BY archived, name_key, id"
            )
        ]

    @router.post("/workgroups", status_code=201)
    def create_workgroup(
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _fields(payload, {"name"}, {"name"})
        name, name_key = _group_name(payload["name"])

        def change(timestamp):
            cursor = connection.execute(
                "INSERT INTO workgroups (name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (name, name_key, timestamp, timestamp),
            )
            return _group(connection, cursor.lastrowid), {"name": name}

        return mutate(
            request,
            connection,
            settings,
            payload,
            "workgroups.create",
            "workgroup",
            "创建工作组",
            change,
            201,
        )

    @router.patch("/workgroups/{group_id}")
    def update_workgroup(
        group_id: int,
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _positive_integer(group_id)
        _fields(
            payload, {"expected_revision"}, {"name", "enabled", "expected_revision"}
        )
        if len(payload) == 1:
            raise HTTPException(422, "No workgroup changes supplied")

        def change(timestamp):
            current = _group(connection, group_id)
            _revision(current, payload["expected_revision"])
            if current["archived"]:
                raise HTTPException(409, "Archived workgroup is read-only")
            name, name_key = _group_name(payload.get("name", current["name"]))
            enabled = _enabled(payload.get("enabled", current["enabled"]))
            connection.execute(
                "UPDATE workgroups SET name = ?, name_key = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
                (name, name_key, enabled, timestamp, group_id),
            )
            return _group(connection, group_id), {
                key: value
                for key, value in {"name": name, "enabled": enabled}.items()
                if key in payload
            }

        return mutate(
            request,
            connection,
            settings,
            payload,
            "workgroups.update",
            "workgroup",
            "修改工作组",
            change,
        )

    @router.put("/workgroups/{group_id}/access")
    def update_access(
        group_id: int,
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _positive_integer(group_id)
        _fields(
            payload,
            {"permission_keys", "project_ids", "expected_revision"},
            {"permission_keys", "project_ids", "expected_revision"},
        )
        try:
            keys = validate_permission_keys(payload["permission_keys"])
        except ValueError as failure:
            raise HTTPException(422, str(failure)) from None
        project_values = payload["project_ids"]
        if not isinstance(project_values, list) or len(project_values) > 10000:
            raise HTTPException(
                422, "project_ids must be a list of up to 10000 project IDs"
            )
        projects = sorted({_positive_integer(value) for value in project_values})

        def change(timestamp):
            current = _group(connection, group_id)
            _revision(current, payload["expected_revision"])
            if current["archived"]:
                raise HTTPException(409, "Archived workgroup is read-only")
            if projects:
                found = connection.execute(
                    f"SELECT count(*) FROM projects WHERE id IN ({','.join('?' for _ in projects)})",
                    projects,
                ).fetchone()[0]
                if found != len(projects):
                    raise HTTPException(422, "One or more projects do not exist")
            connection.execute(
                "DELETE FROM workgroup_permissions WHERE group_id = ?", (group_id,)
            )
            connection.executemany(
                "INSERT INTO workgroup_permissions (group_id, permission_key) VALUES (?, ?)",
                ((group_id, key) for key in keys),
            )
            connection.execute(
                "DELETE FROM workgroup_projects WHERE group_id = ?", (group_id,)
            )
            connection.executemany(
                "INSERT INTO workgroup_projects (group_id, project_id) VALUES (?, ?)",
                ((group_id, project_id) for project_id in projects),
            )
            connection.execute(
                "UPDATE workgroups SET revision = revision + 1, updated_at = ? WHERE id = ?",
                (timestamp, group_id),
            )
            return _group(connection, group_id), {
                "permission_keys": keys,
                "project_ids": projects,
            }

        return mutate(
            request,
            connection,
            settings,
            payload,
            "workgroups.access",
            "workgroup",
            "修改工作组权限和项目范围",
            change,
        )

    @router.delete("/workgroups/{group_id}")
    def archive_workgroup(
        group_id: int,
        request: Request,
        _: Principal = owner_dependency,
        payload: dict = payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ):
        _positive_integer(group_id)
        _fields(payload, {"expected_revision"}, {"expected_revision"})

        def change(timestamp):
            current = _group(connection, group_id)
            _revision(current, payload["expected_revision"])
            if current["member_count"]:
                raise HTTPException(
                    409, "Move all members out before archiving the workgroup"
                )
            if current["archived"]:
                raise HTTPException(409, "Workgroup is already archived")
            connection.execute(
                "UPDATE workgroups SET archived = 1, enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ?",
                (timestamp, group_id),
            )
            connection.execute(
                "DELETE FROM workgroup_permissions WHERE group_id = ?", (group_id,)
            )
            connection.execute(
                "DELETE FROM workgroup_projects WHERE group_id = ?", (group_id,)
            )
            return _group(connection, group_id), {"archived": True, "enabled": False}

        return mutate(
            request,
            connection,
            settings,
            payload,
            "workgroups.archive",
            "workgroup",
            "归档工作组",
            change,
        )

    @router.get("/permissions/catalog")
    def get_permission_catalog(_: Principal = owner_dependency):
        return permission_catalog()

    return router
