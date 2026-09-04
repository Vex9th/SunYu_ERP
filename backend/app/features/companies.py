from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    idempotency_scope,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

_COMPANY_FIELDS = (
    "name",
    "taxpayer_id",
    "registered_address",
    "registered_phone",
    "bank_name",
    "bank_account",
    "notes",
)
_COMPANY_RESPONSE_FIELDS = (
    "id",
    *_COMPANY_FIELDS,
    "revision",
    "created_at",
    "updated_at",
)
_CONTACT_FIELDS = ("name", "phone", "email", "position", "notes")
_CONTACT_RESPONSE_FIELDS = (
    "id",
    "company_id",
    *_CONTACT_FIELDS,
    "revision",
    "created_at",
    "updated_at",
)
_SQLITE_MAX_INTEGER = 2**63 - 1

Clock = Callable[[], datetime]
NormalizedPayload = dict[str, str | None]
NormalizedUpdatePayload = dict[str, str | int | None]


def create_companies_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/companies",
        tags=["companies"],
        route_class=ApiErrorRoute,
    )
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    company_payload_dependency = Depends(_read_company_payload)
    contact_payload_dependency = Depends(_read_contact_payload)
    company_update_payload_dependency = Depends(_read_company_update_payload)
    contact_update_payload_dependency = Depends(_read_contact_update_payload)
    revision_payload_dependency = Depends(_read_revision_payload)
    company_id_dependency = Depends(_read_company_id)
    contact_id_dependency = Depends(_read_contact_id)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("")
    def list_companies(
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> list[dict[str, object]]:
        try:
            rows = connection.execute(
                """
                SELECT
                    companies.id,
                    companies.name,
                    companies.taxpayer_id,
                    companies.registered_address,
                    companies.registered_phone,
                    companies.bank_name,
                    companies.bank_account,
                    companies.notes,
                    companies.revision,
                    companies.created_at,
                    companies.updated_at,
                    COUNT(contacts.id) AS contact_count
                FROM companies
                LEFT JOIN contacts ON contacts.company_id = companies.id
                GROUP BY companies.id
                ORDER BY companies.name COLLATE NOCASE, companies.id
                """
            ).fetchall()
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Company", exc) from None
        return [
            _row_response(row, (*_COMPANY_RESPONSE_FIELDS, "contact_count"))
            for row in rows
        ]

    @router.post("", status_code=status.HTTP_201_CREATED)
    def create_company(
        request: Request,
        _: None = authentication_dependency,
        payload: NormalizedPayload = company_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _read_optional_idempotency_key(request)
        request_hash = _request_hash(payload)
        scope = idempotency_scope(request)
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                if key is not None:
                    restored = restore_idempotent_response(
                        connection,
                        scope=scope,
                        key=key,
                        request_hash=request_hash,
                    )
                    if restored is not None:
                        return restored
                cursor = connection.execute(
                    """
                    INSERT INTO companies
                        (name, taxpayer_id, registered_address,
                         registered_phone, bank_name, bank_account, notes,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (*_payload_values(payload, _COMPANY_FIELDS), timestamp, timestamp),
                )
                company_id = _last_insert_id(cursor)
                response = _company_detail(connection, company_id)
                if response is None:
                    raise sqlite3.DatabaseError("created company is missing")
                if key is not None:
                    save_idempotent_response(
                        connection,
                        scope=scope,
                        key=key,
                        request_hash=request_hash,
                        response=response,
                        response_status=status.HTTP_201_CREATED,
                        resource_type="company",
                        resource_id=company_id,
                        created_at=timestamp,
                    )
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Company name already exists",
                ) from None
            raise _unexpected_database_failure("Company", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Company", exc) from None
        return response

    @router.get("/{company_id}")
    def get_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        try:
            response = _company_detail(connection, company_id)
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Company", exc) from None
        if response is None:
            raise _company_not_found()
        return response

    @router.put("/{company_id}")
    def replace_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        payload: NormalizedUpdatePayload = company_update_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                current = _company_revision_row(connection, company_id)
                if current is None:
                    raise _company_not_found()
                expected_revision = int(payload["expected_revision"])
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    """
                    UPDATE companies
                    SET name = ?, taxpayer_id = ?, registered_address = ?,
                        registered_phone = ?, bank_name = ?, bank_account = ?,
                        notes = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (
                        *_payload_values(payload, _COMPANY_FIELDS),
                        timestamp,
                        company_id,
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    _raise_company_write_miss(connection, company_id)
                response = _company_detail(connection, company_id)
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Company name already exists",
                ) from None
            raise _unexpected_database_failure("Company", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Company", exc) from None
        return response

    @router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        expected_revision: int = revision_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> Response:
        try:
            with transaction_immediate(connection):
                current = _company_revision_row(connection, company_id)
                if current is None:
                    raise _company_not_found()
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    "DELETE FROM companies WHERE id = ? AND revision = ?",
                    (company_id, expected_revision),
                )
                if cursor.rowcount != 1:
                    _raise_company_write_miss(connection, company_id)
        except sqlite3.IntegrityError as exc:
            try:
                is_project_reference = _is_project_reference_failure(
                    connection,
                    company_id,
                    exc,
                )
            except sqlite3.Error as confirmation_exc:
                raise _unexpected_database_failure(
                    "Company",
                    confirmation_exc,
                ) from None
            if is_project_reference:
                raise _company_referenced() from None
            raise _unexpected_database_failure("Company", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Company", exc) from None
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/{company_id}/contacts",
        status_code=status.HTTP_201_CREATED,
    )
    def create_contact(
        request: Request,
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        payload: NormalizedPayload = contact_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _read_optional_idempotency_key(request)
        request_hash = _request_hash(payload)
        scope = idempotency_scope(request)
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                if key is not None:
                    restored = restore_idempotent_response(
                        connection,
                        scope=scope,
                        key=key,
                        request_hash=request_hash,
                    )
                    if restored is not None:
                        return restored
                cursor = connection.execute(
                    """
                    INSERT INTO contacts
                        (company_id, name, phone, email, position, notes,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        company_id,
                        *_payload_values(payload, _CONTACT_FIELDS),
                        timestamp,
                        timestamp,
                    ),
                )
                contact_id = _last_insert_id(cursor)
                response = _contact_response(connection, company_id, contact_id)
                if response is None:
                    raise sqlite3.DatabaseError("created contact is missing")
                if key is not None:
                    save_idempotent_response(
                        connection,
                        scope=scope,
                        key=key,
                        request_hash=request_hash,
                        response=response,
                        response_status=status.HTTP_201_CREATED,
                        resource_type="contact",
                        resource_id=contact_id,
                        created_at=timestamp,
                    )
        except sqlite3.IntegrityError as exc:
            if _is_foreign_key_constraint(exc):
                raise _company_not_found() from None
            raise _unexpected_database_failure("Contact", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Contact", exc) from None
        return response

    @router.put("/{company_id}/contacts/{contact_id}")
    def replace_contact(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        contact_id: int = contact_id_dependency,
        payload: NormalizedUpdatePayload = contact_update_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                current = _contact_revision_row(connection, company_id, contact_id)
                if current is None:
                    raise _contact_not_found()
                expected_revision = int(payload["expected_revision"])
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    """
                    UPDATE contacts
                    SET name = ?, phone = ?, email = ?, position = ?, notes = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE id = ? AND company_id = ? AND revision = ?
                    """,
                    (
                        *_payload_values(payload, _CONTACT_FIELDS),
                        timestamp,
                        contact_id,
                        company_id,
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    _raise_contact_write_miss(connection, company_id, contact_id)
                response = _contact_response(connection, company_id, contact_id)
        except sqlite3.IntegrityError as exc:
            raise _unexpected_database_failure("Contact", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Contact", exc) from None
        if response is None:
            raise _operation_failed("Contact")
        return response

    @router.delete(
        "/{company_id}/contacts/{contact_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_contact(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        contact_id: int = contact_id_dependency,
        expected_revision: int = revision_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> Response:
        try:
            with transaction_immediate(connection):
                current = _contact_revision_row(connection, company_id, contact_id)
                if current is None:
                    raise _contact_not_found()
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    """
                    DELETE FROM contacts
                    WHERE id = ? AND company_id = ? AND revision = ?
                    """,
                    (contact_id, company_id, expected_revision),
                )
                if cursor.rowcount != 1:
                    _raise_contact_write_miss(connection, company_id, contact_id)
        except sqlite3.IntegrityError as exc:
            raise _unexpected_database_failure("Contact", exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure("Contact", exc) from None
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


async def _read_company_payload(request: Request) -> NormalizedPayload:
    return await _read_payload(
        request,
        fields=_COMPANY_FIELDS,
        detail="Invalid company payload",
    )


async def _read_contact_payload(request: Request) -> NormalizedPayload:
    return await _read_payload(
        request,
        fields=_CONTACT_FIELDS,
        detail="Invalid contact payload",
    )


async def _read_company_update_payload(request: Request) -> NormalizedUpdatePayload:
    return await _read_update_payload(
        request,
        fields=_COMPANY_FIELDS,
        detail="Invalid company payload",
    )


async def _read_contact_update_payload(request: Request) -> NormalizedUpdatePayload:
    return await _read_update_payload(
        request,
        fields=_CONTACT_FIELDS,
        detail="Invalid contact payload",
    )


async def _read_update_payload(
    request: Request,
    *,
    fields: tuple[str, ...],
    detail: str,
) -> NormalizedUpdatePayload:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None
    if not isinstance(payload, dict):
        raise _invalid_payload(detail)
    if set(payload) == set(fields):
        raise _invalid_structured_payload(detail)
    if set(payload) != {*fields, "expected_revision"}:
        raise _invalid_payload(detail)
    normalized = _normalize_payload(payload, fields=fields, detail=detail)
    return {
        **normalized,
        "expected_revision": _positive_integer(payload["expected_revision"], detail),
    }


async def _read_revision_payload(request: Request) -> int:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_structured_payload("Invalid revision payload") from None
    if not isinstance(payload, dict) or set(payload) != {"expected_revision"}:
        raise _invalid_structured_payload("Invalid revision payload")
    return _positive_integer(payload["expected_revision"], "Invalid revision payload")


def _read_company_id(company_id: str) -> int:
    return _parse_identifier(company_id)


def _read_contact_id(contact_id: str) -> int:
    return _parse_identifier(contact_id)


def _parse_identifier(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid_identifier()
    try:
        identifier = int(value)
    except ValueError:
        raise _invalid_identifier() from None
    if not 1 <= identifier <= _SQLITE_MAX_INTEGER:
        raise _invalid_identifier()
    return identifier


def _invalid_identifier() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="Invalid identifier",
    )


async def _read_payload(
    request: Request,
    *,
    fields: tuple[str, ...],
    detail: str,
) -> NormalizedPayload:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None
    if not isinstance(payload, dict) or set(payload) != set(fields):
        raise _invalid_payload(detail)

    return _normalize_payload(payload, fields=fields, detail=detail)


def _normalize_payload(
    payload: dict[str, object],
    *,
    fields: tuple[str, ...],
    detail: str,
) -> NormalizedPayload:
    normalized_name = _normalize_text(payload["name"], required=True, detail=detail)
    normalized: NormalizedPayload = {"name": normalized_name}
    for field in fields[1:]:
        value = payload[field]
        if value is None:
            normalized[field] = None
        else:
            normalized[field] = _normalize_text(value, required=False, detail=detail)
    return normalized


def _positive_integer(value: object, detail: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= _SQLITE_MAX_INTEGER
    ):
        raise _invalid_structured_payload(detail)
    return value


def _normalize_text(
    value: object,
    *,
    required: bool,
    detail: str,
) -> str | None:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    normalized = value.strip()
    if not normalized:
        if required:
            raise _invalid_payload(detail)
        return None
    if "\x00" in normalized:
        raise _invalid_payload(detail)
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid_payload(detail) from None
    return normalized


def _company_detail(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, name, taxpayer_id, registered_address, registered_phone,
            bank_name, bank_account, notes, revision, created_at, updated_at
        FROM companies
        WHERE id = ?
        """,
        (company_id,),
    ).fetchone()
    if row is None:
        return None
    contacts = connection.execute(
        """
        SELECT
            id, company_id, name, phone, email, position, notes,
            revision, created_at, updated_at
        FROM contacts
        WHERE company_id = ?
        ORDER BY id
        """,
        (company_id,),
    ).fetchall()
    return {
        **_row_response(row, _COMPANY_RESPONSE_FIELDS),
        "contacts": [
            _row_response(contact, _CONTACT_RESPONSE_FIELDS) for contact in contacts
        ],
    }


def _contact_response(
    connection: sqlite3.Connection,
    company_id: int,
    contact_id: int,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, company_id, name, phone, email, position, notes,
            revision, created_at, updated_at
        FROM contacts
        WHERE id = ? AND company_id = ?
        """,
        (contact_id, company_id),
    ).fetchone()
    if row is None:
        return None
    return _row_response(row, _CONTACT_RESPONSE_FIELDS)


def _company_revision_row(
    connection: sqlite3.Connection,
    company_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT revision FROM companies WHERE id = ?",
        (company_id,),
    ).fetchone()


def _contact_revision_row(
    connection: sqlite3.Connection,
    company_id: int,
    contact_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT revision FROM contacts
        WHERE id = ? AND company_id = ?
        """,
        (contact_id, company_id),
    ).fetchone()


def _raise_company_write_miss(
    connection: sqlite3.Connection,
    company_id: int,
) -> None:
    current = _company_revision_row(connection, company_id)
    if current is None:
        raise _company_not_found()
    _raise_revision_conflict(int(current["revision"]))


def _raise_contact_write_miss(
    connection: sqlite3.Connection,
    company_id: int,
    contact_id: int,
) -> None:
    current = _contact_revision_row(connection, company_id, contact_id)
    if current is None:
        raise _contact_not_found()
    _raise_revision_conflict(int(current["revision"]))


def _row_response(
    row: sqlite3.Row,
    fields: tuple[str, ...],
) -> dict[str, object]:
    return {field: row[field] for field in fields}


def _payload_values(
    payload: NormalizedPayload,
    fields: tuple[str, ...],
) -> tuple[str | None, ...]:
    return tuple(payload[field] for field in fields)


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    identifier = cursor.lastrowid
    if identifier is None:
        raise sqlite3.DatabaseError("insert did not produce an identifier")
    return identifier


def _read_optional_idempotency_key(request: Request) -> str | None:
    values = request.headers.getlist("Idempotency-Key")
    if not values:
        return None
    if len(values) != 1:
        raise _invalid_structured_payload("Invalid Idempotency-Key")
    try:
        parsed = UUID(values[0])
    except (AttributeError, ValueError):
        raise _invalid_structured_payload("Invalid Idempotency-Key") from None
    canonical = str(parsed)
    if values[0].lower() != canonical:
        raise _invalid_structured_payload("Invalid Idempotency-Key")
    return canonical


def _request_hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _require_revision(row: sqlite3.Row, expected_revision: int) -> None:
    current_revision = int(row["revision"])
    if current_revision != expected_revision:
        _raise_revision_conflict(current_revision)


def _raise_revision_conflict(current_revision: int) -> None:
    raise ApiError(
        status.HTTP_409_CONFLICT,
        "Resource was modified",
        "REVISION_CONFLICT",
        current_revision=current_revision,
        headers={
            "X-Error-Code": "REVISION_CONFLICT",
            "X-Current-Revision": str(current_revision),
        },
    )


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_unique_constraint(failure: sqlite3.IntegrityError) -> bool:
    return (
        getattr(failure, "sqlite_errorcode", None) == sqlite3.SQLITE_CONSTRAINT_UNIQUE
    )


def _is_foreign_key_constraint(failure: sqlite3.IntegrityError) -> bool:
    return (
        getattr(failure, "sqlite_errorcode", None)
        == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
    )


def _is_project_reference_failure(
    connection: sqlite3.Connection,
    company_id: int,
    failure: sqlite3.IntegrityError,
) -> bool:
    if _is_foreign_key_constraint(failure):
        return True
    if getattr(failure, "sqlite_errorcode", None) != sqlite3.SQLITE_CONSTRAINT_TRIGGER:
        return False
    return (
        connection.execute(
            "SELECT 1 FROM projects WHERE company_id = ? LIMIT 1",
            (company_id,),
        ).fetchone()
        is not None
    )


def _invalid_payload(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=detail,
    )


def _invalid_structured_payload(detail: str) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail,
        "VALIDATION_ERROR",
        headers={"X-Error-Code": "VALIDATION_ERROR"},
    )


def _company_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Company not found",
    )


def _contact_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Contact not found",
    )


def _company_referenced() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Company is referenced by projects",
    )


def _operation_failed(subject: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{subject} operation failed",
    )


def _unexpected_database_failure(
    subject: str,
    failure: sqlite3.Error,
) -> HTTPException:
    logger.exception(
        "%s database operation failed (sqlite_errorcode=%s, sqlite_errorname=%s)",
        subject,
        getattr(failure, "sqlite_errorcode", None),
        getattr(failure, "sqlite_errorname", None),
    )
    return _operation_failed(subject)
