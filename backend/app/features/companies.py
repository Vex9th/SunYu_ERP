from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction
from backend.app.features.auth import require_authenticated_session

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
    "created_at",
    "updated_at",
)
_CONTACT_FIELDS = ("name", "phone", "email", "position", "notes")
_CONTACT_RESPONSE_FIELDS = (
    "id",
    "company_id",
    *_CONTACT_FIELDS,
    "created_at",
    "updated_at",
)
_SQLITE_MAX_INTEGER = 2**63 - 1

Clock = Callable[[], datetime]
NormalizedPayload = dict[str, str | None]


def create_companies_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/companies", tags=["companies"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    company_payload_dependency = Depends(_read_company_payload)
    contact_payload_dependency = Depends(_read_contact_payload)
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
                companies.created_at,
                companies.updated_at,
                COUNT(contacts.id) AS contact_count
            FROM companies
            LEFT JOIN contacts ON contacts.company_id = companies.id
            GROUP BY companies.id
            ORDER BY companies.name COLLATE NOCASE, companies.id
            """
        ).fetchall()
        return [
            _row_response(row, (*_COMPANY_RESPONSE_FIELDS, "contact_count"))
            for row in rows
        ]

    @router.post("", status_code=status.HTTP_201_CREATED)
    def create_company(
        _: None = authentication_dependency,
        payload: NormalizedPayload = company_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
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
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Company name already exists",
                ) from None
            raise _operation_failed("Company") from None
        except sqlite3.Error:
            raise _operation_failed("Company") from None
        return response

    @router.get("/{company_id}")
    def get_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        response = _company_detail(connection, company_id)
        if response is None:
            raise _company_not_found()
        return response

    @router.put("/{company_id}")
    def replace_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        payload: NormalizedPayload = company_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
                if not _company_exists(connection, company_id):
                    raise _company_not_found()
                connection.execute(
                    """
                    UPDATE companies
                    SET name = ?, taxpayer_id = ?, registered_address = ?,
                        registered_phone = ?, bank_name = ?, bank_account = ?,
                        notes = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        *_payload_values(payload, _COMPANY_FIELDS),
                        timestamp,
                        company_id,
                    ),
                )
                response = _company_detail(connection, company_id)
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Company name already exists",
                ) from None
            raise _operation_failed("Company") from None
        except sqlite3.Error:
            raise _operation_failed("Company") from None
        return response

    @router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_company(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> Response:
        try:
            with transaction(connection):
                if not _company_exists(connection, company_id):
                    raise _company_not_found()
                referenced = connection.execute(
                    "SELECT 1 FROM projects WHERE company_id = ? LIMIT 1",
                    (company_id,),
                ).fetchone()
                if referenced is not None:
                    raise _company_referenced()
                connection.execute("DELETE FROM companies WHERE id = ?", (company_id,))
        except sqlite3.IntegrityError:
            raise _company_referenced() from None
        except sqlite3.Error:
            raise _operation_failed("Company") from None
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/{company_id}/contacts",
        status_code=status.HTTP_201_CREATED,
    )
    def create_contact(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        payload: NormalizedPayload = contact_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
                if not _company_exists(connection, company_id):
                    raise _company_not_found()
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
        except sqlite3.Error:
            raise _operation_failed("Contact") from None
        if response is None:
            raise _operation_failed("Contact")
        return response

    @router.put("/{company_id}/contacts/{contact_id}")
    def replace_contact(
        _: None = authentication_dependency,
        company_id: int = company_id_dependency,
        contact_id: int = contact_id_dependency,
        payload: NormalizedPayload = contact_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
                if not _company_exists(connection, company_id):
                    raise _contact_not_found()
                existing = _contact_response(connection, company_id, contact_id)
                if existing is None:
                    raise _contact_not_found()
                connection.execute(
                    """
                    UPDATE contacts
                    SET name = ?, phone = ?, email = ?, position = ?, notes = ?,
                        updated_at = ?
                    WHERE id = ? AND company_id = ?
                    """,
                    (
                        *_payload_values(payload, _CONTACT_FIELDS),
                        timestamp,
                        contact_id,
                        company_id,
                    ),
                )
                response = _contact_response(connection, company_id, contact_id)
        except sqlite3.Error:
            raise _operation_failed("Contact") from None
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
        connection: sqlite3.Connection = connection_dependency,
    ) -> Response:
        try:
            with transaction(connection):
                if not _company_exists(connection, company_id):
                    raise _contact_not_found()
                cursor = connection.execute(
                    "DELETE FROM contacts WHERE id = ? AND company_id = ?",
                    (contact_id, company_id),
                )
                if cursor.rowcount != 1:
                    raise _contact_not_found()
        except sqlite3.Error:
            raise _operation_failed("Contact") from None
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
    except (UnicodeError, ValueError):
        raise _invalid_payload(detail) from None
    if not isinstance(payload, dict) or set(payload) != set(fields):
        raise _invalid_payload(detail)

    name = payload["name"]
    if not isinstance(name, str) or not (normalized_name := name.strip()):
        raise _invalid_payload(detail)
    normalized: NormalizedPayload = {"name": normalized_name}
    for field in fields[1:]:
        value = payload[field]
        if value is None:
            normalized[field] = None
        elif isinstance(value, str):
            normalized[field] = value.strip() or None
        else:
            raise _invalid_payload(detail)
    return normalized


def _company_detail(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, name, taxpayer_id, registered_address, registered_phone,
            bank_name, bank_account, notes, created_at, updated_at
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
            created_at, updated_at
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
            created_at, updated_at
        FROM contacts
        WHERE id = ? AND company_id = ?
        """,
        (contact_id, company_id),
    ).fetchone()
    if row is None:
        return None
    return _row_response(row, _CONTACT_RESPONSE_FIELDS)


def _company_exists(connection: sqlite3.Connection, company_id: int) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM companies WHERE id = ?",
            (company_id,),
        ).fetchone()
        is not None
    )


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


def _invalid_payload(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=detail,
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
