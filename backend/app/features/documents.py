from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import stat
import tempfile
import unicodedata
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.datastructures import FormData, UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException
from starlette.types import Message, Receive

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features import files
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    idempotency_storage_key,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session
from backend.app.features.business_attachments import document_managed_filename

logger = logging.getLogger(__name__)

_CATEGORIES = frozenset(
    {
        "planning_minutes",
        "site_survey",
        "quotation",
        "technical_agreement",
        "contract",
        "mechanical_design",
        "electrical_design",
        "procurement_list",
        "procurement_contract",
        "mechanical_signoff",
        "electrical_signoff",
        "construction",
        "commissioning",
        "acceptance",
        "invoice",
        "warranty",
        "after_sales",
        "other",
    }
)
_MAX_PAGE_SIZE = 200
_MAX_SEARCH_LENGTH = 200
_TEXT_SEARCH_FILE_LIMIT_BYTES = 5 * 1024 * 1024
_SQLITE_MAX_INTEGER = 2**63 - 1
_COPY_CHUNK_SIZE = 64 * 1024
_MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024
_MULTIPART_TOO_LARGE_MESSAGE = "multipart body exceeded the configured limit"
_DOCUMENT_SUMMARY_FIELDS = (
    "id",
    "project_code",
    "category",
    "title",
    "notes",
    "latest_version_number",
    "archived_at",
    "revision",
    "created_at",
    "updated_at",
)
_VERSION_FIELDS = (
    "id",
    "version_number",
    "original_filename",
    "managed_filename",
    "content_type",
    "size_bytes",
    "sha256",
    "notes",
    "created_at",
)
_DOCUMENT_SUMMARY_SELECT = """
    SELECT
        documents.id,
        documents.project_code,
        documents.category,
        documents.logical_name AS title,
        documents.notes,
        COALESCE(
            (
                SELECT MAX(document_versions.version_number)
                FROM document_versions
                WHERE document_versions.document_id = documents.id
            ),
            0
        ) AS latest_version_number,
        documents.archived_at,
        documents.revision,
        documents.created_at,
        documents.updated_at
    FROM documents
"""

Clock = Callable[[], datetime]


@dataclass(frozen=True, slots=True)
class _StagedUpload:
    path: Path
    original_filename: str
    content_type: str
    size_bytes: int
    sha256: str


class _MultipartBodyTooLarge(MultiPartException):
    def __init__(self, max_file_size_bytes: int) -> None:
        super().__init__(_MULTIPART_TOO_LARGE_MESSAGE)
        self.max_file_size_bytes = max_file_size_bytes


class DocumentsRoute(ApiErrorRoute):
    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Any:
            try:
                return await original(request)
            except (OSError, sqlite3.Error) as failure:
                logger.exception(
                    "Document operation failed (%s)",
                    type(failure).__name__,
                )
                return JSONResponse(
                    {
                        "detail": "Document operation failed",
                        "error_code": "DOCUMENT_OPERATION_FAILED",
                        "field_errors": {},
                        "current_revision": None,
                    },
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        return handler


def create_documents_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/projects",
        route_class=DocumentsRoute,
        tags=["documents"],
    )
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/{project_code}/documents")
    def list_documents(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, object]:
        project = _require_project(connection, project_code)
        category = _read_category_filter(request)
        archive_filter = _read_archive_filter(request)
        search = _read_search_filter(request)
        page, page_size = _read_pagination(request)
        clauses = ["documents.project_code = ? COLLATE NOCASE"]
        parameters: list[object] = [project["project_code"]]
        if category is not None:
            clauses.append("documents.category = ?")
            parameters.append(category)
        if archive_filter == "active":
            clauses.append("documents.archived_at IS NULL")
        elif archive_filter == "archived":
            clauses.append("documents.archived_at IS NOT NULL")
        search_matches: dict[int, str | None] = {}
        if search is not None:
            search_matches = _document_search_matches(
                connection,
                settings,
                project_code=str(project["project_code"]),
                search=search,
                category=category,
                archive_filter=archive_filter,
            )
            if not search_matches:
                return {
                    "items": [],
                    "total": 0,
                    "page": page,
                    "page_size": page_size,
                }
            placeholders = ", ".join("?" for _ in search_matches)
            clauses.append(f"documents.id IN ({placeholders})")
            parameters.extend(search_matches)
        where_clause = " AND ".join(clauses)
        total = int(
            connection.execute(
                f"SELECT COUNT(*) FROM documents WHERE {where_clause}",
                parameters,
            ).fetchone()[0]
        )
        rows = connection.execute(
            f"""
            {_DOCUMENT_SUMMARY_SELECT}
            WHERE {where_clause}
            ORDER BY documents.created_at DESC, documents.id DESC
            LIMIT ? OFFSET ?
            """,
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [
                _document_list_item(
                    row,
                    search_excerpt=search_matches.get(int(row["id"])),
                    include_excerpt=search is not None,
                )
                for row in rows
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.get("/{project_code}/document-version-options")
    def list_document_version_options(
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> list[dict[str, object]]:
        project = _require_project(connection, project_code)
        rows = connection.execute(
            """
            SELECT
                document_versions.id,
                document_versions.version_number,
                document_versions.original_filename,
                document_versions.managed_filename,
                documents.logical_name AS title
            FROM document_versions
            JOIN documents ON documents.id = document_versions.document_id
            WHERE documents.project_code = ? COLLATE NOCASE
                AND documents.archived_at IS NULL
            ORDER BY
                documents.created_at DESC,
                documents.id DESC,
                document_versions.version_number DESC,
                document_versions.id DESC
            """,
            (project["project_code"],),
        ).fetchall()
        return [
            {
                "value": int(row["id"]),
                "label": _document_version_option_label(row),
            }
            for row in rows
        ]

    @router.post(
        "/{project_code}/documents",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_document(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, object]:
        key = _read_idempotency_key(request)
        max_file_size_bytes = settings.max_document_upload_mb * 1024 * 1024
        category, title, notes, upload = await _read_create_form(
            request,
            max_file_size_bytes=max_file_size_bytes,
        )
        try:
            staged = _stage_upload(upload, max_size_bytes=max_file_size_bytes)
        except BaseException:
            await upload.close()
            raise
        prepared: files.StagedFileVersion | None = None
        stored: files.StoredFileVersion | None = None
        try:
            prepared = files.stage_version(
                staged.path,
                settings.data_dir,
                original_name=staged.original_filename,
            )
            timestamp = _timestamp(now)
            request_hash = _request_hash(
                {
                    "category": category,
                    "title": title,
                    "notes": notes,
                    "filename": staged.original_filename,
                    "content_type": staged.content_type,
                    "size_bytes": staged.size_bytes,
                    "sha256": staged.sha256,
                }
            )
            try:
                with transaction_immediate(connection):
                    project = _require_project(connection, project_code)
                    scope = _document_scope(
                        request,
                        str(project["project_code"]),
                        "documents",
                    )
                    storage_key = idempotency_storage_key(scope, key)
                    replay = restore_idempotent_response(
                        connection,
                        scope=scope,
                        key=storage_key,
                        request_hash=request_hash,
                    )
                    if replay is not None:
                        return replay
                    _require_active_project_record(project)
                    cursor = connection.execute(
                        """
                        INSERT INTO documents
                            (project_code, category, logical_name, notes,
                             revision, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 1, ?, ?)
                        """,
                        (
                            project["project_code"],
                            category,
                            title,
                            notes,
                            timestamp,
                            timestamp,
                        ),
                    )
                    document_id = _last_insert_id(cursor)
                    managed_filename = document_managed_filename(
                        project_code=str(project["project_code"]),
                        category=category,
                        title=title,
                        business_date=_managed_business_date(timestamp),
                        version_number=1,
                        original_filename=staged.original_filename,
                    )
                    files.reconcile_document_versions(
                        settings.data_dir,
                        str(project["project_code"]),
                        category,
                        document_id,
                        [],
                    )
                    stored = files.publish_staged_version(
                        prepared,
                        str(project["project_code"]),
                        category,
                        document_id=document_id,
                        verify_content=False,
                        managed_name=managed_filename,
                        version_number=1,
                    )
                    if stored.version_number != 1:
                        raise sqlite3.DatabaseError(
                            "new document storage did not start at version one"
                        )
                    connection.execute(
                        """
                        INSERT INTO document_versions
                            (document_id, version_number, original_filename,
                             managed_filename, content_type, stored_relative_path,
                             size_bytes, sha256, notes, created_at)
                        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            document_id,
                            staged.original_filename,
                            managed_filename,
                            staged.content_type,
                            str(stored.relative_path),
                            stored.size_bytes,
                            stored.sha256,
                            notes,
                            timestamp,
                        ),
                    )
                    response = _require_document_detail(
                        connection,
                        str(project["project_code"]),
                        document_id,
                    )
                    save_idempotent_response(
                        connection,
                        scope=scope,
                        key=storage_key,
                        request_hash=request_hash,
                        response=response,
                        response_status=status.HTTP_201_CREATED,
                        resource_type="document",
                        resource_id=document_id,
                        created_at=timestamp,
                    )
                    return response
            except sqlite3.IntegrityError as failure:
                _cleanup_stored_after_failure(failure, stored, settings.data_dir)
                if _is_document_title_conflict(failure):
                    raise _conflict(
                        "Document title already exists",
                        "DOCUMENT_TITLE_EXISTS",
                    ) from None
                raise
            except BaseException as failure:
                _cleanup_stored_after_failure(failure, stored, settings.data_dir)
                raise
        finally:
            if prepared is not None:
                files.discard_staged_version(prepared)
            _discard_staged_upload(staged)
            await upload.close()

    @router.get("/{project_code}/documents/{document_id}")
    def get_document(
        project_code: str,
        document_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _path_identifier(document_id, "document_id")
        project = _require_project(connection, project_code)
        return _require_document_detail(
            connection,
            str(project["project_code"]),
            identifier,
        )

    @router.put("/{project_code}/documents/{document_id}")
    async def update_document(
        project_code: str,
        document_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _path_identifier(document_id, "document_id")
        title, notes, expected_revision = await _read_update_payload(request)
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                project = _require_active_project(connection, project_code)
                current = _require_document_record(
                    connection,
                    str(project["project_code"]),
                    identifier,
                )
                _require_editable_document(current)
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    """
                    UPDATE documents
                    SET logical_name = ?, notes = ?, revision = revision + 1,
                        updated_at = ?
                    WHERE id = ? AND project_code = ? COLLATE NOCASE
                        AND revision = ? AND archived_at IS NULL
                    """,
                    (
                        title,
                        notes,
                        timestamp,
                        identifier,
                        project["project_code"],
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    refreshed = _require_document_record(
                        connection,
                        str(project["project_code"]),
                        identifier,
                    )
                    _require_revision(refreshed, expected_revision)
                    raise sqlite3.DatabaseError("document disappeared during update")
                return _require_document_detail(
                    connection,
                    str(project["project_code"]),
                    identifier,
                )
        except sqlite3.IntegrityError as failure:
            if _is_document_title_conflict(failure):
                raise _conflict(
                    "Document title already exists",
                    "DOCUMENT_TITLE_EXISTS",
                ) from None
            raise

    @router.post(
        "/{project_code}/documents/{document_id}/versions",
        status_code=status.HTTP_201_CREATED,
    )
    async def add_document_version(
        project_code: str,
        document_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, object]:
        identifier = _path_identifier(document_id, "document_id")
        key = _read_idempotency_key(request)
        max_file_size_bytes = settings.max_document_upload_mb * 1024 * 1024
        notes, expected_revision, upload = await _read_version_form(
            request,
            max_file_size_bytes=max_file_size_bytes,
        )
        try:
            staged = _stage_upload(upload, max_size_bytes=max_file_size_bytes)
        except BaseException:
            await upload.close()
            raise
        prepared: files.StagedFileVersion | None = None
        stored: files.StoredFileVersion | None = None
        try:
            prepared = files.stage_version(
                staged.path,
                settings.data_dir,
                original_name=staged.original_filename,
            )
            timestamp = _timestamp(now)
            request_hash = _request_hash(
                {
                    "notes": notes,
                    "expected_revision": expected_revision,
                    "filename": staged.original_filename,
                    "content_type": staged.content_type,
                    "size_bytes": staged.size_bytes,
                    "sha256": staged.sha256,
                }
            )
            try:
                with transaction_immediate(connection):
                    project = _require_project(connection, project_code)
                    scope = _document_scope(
                        request,
                        str(project["project_code"]),
                        f"documents/{identifier}/versions",
                    )
                    storage_key = idempotency_storage_key(scope, key)
                    replay = restore_idempotent_response(
                        connection,
                        scope=scope,
                        key=storage_key,
                        request_hash=request_hash,
                    )
                    if replay is not None:
                        return replay
                    _require_active_project_record(project)
                    current = _require_document_record(
                        connection,
                        str(project["project_code"]),
                        identifier,
                    )
                    _require_editable_document(current)
                    _require_revision(current, expected_revision)
                    next_version = int(current["latest_version_number"]) + 1
                    managed_filename = document_managed_filename(
                        project_code=str(project["project_code"]),
                        category=str(current["category"]),
                        title=str(current["title"]),
                        business_date=_managed_business_date(timestamp),
                        version_number=next_version,
                        original_filename=staged.original_filename,
                    )
                    files.reconcile_document_versions(
                        settings.data_dir,
                        str(project["project_code"]),
                        str(current["category"]),
                        identifier,
                        _document_stored_paths(connection, identifier),
                    )
                    stored = files.publish_staged_version(
                        prepared,
                        str(project["project_code"]),
                        str(current["category"]),
                        document_id=identifier,
                        verify_content=False,
                        managed_name=managed_filename,
                        version_number=next_version,
                    )
                    if stored.version_number != next_version:
                        raise sqlite3.DatabaseError(
                            "physical and database document versions diverged"
                        )
                    cursor = connection.execute(
                        """
                        INSERT INTO document_versions
                            (document_id, version_number, original_filename,
                             managed_filename, content_type, stored_relative_path,
                             size_bytes, sha256, notes, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            identifier,
                            next_version,
                            staged.original_filename,
                            managed_filename,
                            staged.content_type,
                            str(stored.relative_path),
                            stored.size_bytes,
                            stored.sha256,
                            notes,
                            timestamp,
                        ),
                    )
                    version_id = _last_insert_id(cursor)
                    updated = connection.execute(
                        """
                        UPDATE documents
                        SET revision = revision + 1, updated_at = ?
                        WHERE id = ? AND project_code = ? COLLATE NOCASE
                            AND revision = ? AND archived_at IS NULL
                        """,
                        (
                            timestamp,
                            identifier,
                            project["project_code"],
                            expected_revision,
                        ),
                    )
                    if updated.rowcount != 1:
                        refreshed = _require_document_record(
                            connection,
                            str(project["project_code"]),
                            identifier,
                        )
                        _require_revision(refreshed, expected_revision)
                        raise sqlite3.DatabaseError("document disappeared during update")
                    response = _require_version(connection, identifier, version_id)
                    save_idempotent_response(
                        connection,
                        scope=scope,
                        key=storage_key,
                        request_hash=request_hash,
                        response=response,
                        response_status=status.HTTP_201_CREATED,
                        resource_type="document_version",
                        resource_id=version_id,
                        created_at=timestamp,
                    )
                    return response
            except BaseException as failure:
                _cleanup_stored_after_failure(failure, stored, settings.data_dir)
                raise
        finally:
            if prepared is not None:
                files.discard_staged_version(prepared)
            _discard_staged_upload(staged)
            await upload.close()

    @router.get(
        "/{project_code}/documents/{document_id}/versions/{version_id}/download"
    )
    def download_document_version(
        project_code: str,
        document_id: str,
        version_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> StreamingResponse:
        document_identifier = _path_identifier(document_id, "document_id")
        version_identifier = _path_identifier(version_id, "version_id")
        project = _require_project(connection, project_code)
        row = connection.execute(
            """
            SELECT
                document_versions.document_id,
                document_versions.managed_filename,
                document_versions.content_type,
                document_versions.stored_relative_path,
                document_versions.size_bytes,
                documents.category
            FROM document_versions
            JOIN documents ON documents.id = document_versions.document_id
            WHERE documents.id = ?
                AND documents.project_code = ? COLLATE NOCASE
                AND document_versions.id = ?
            """,
            (document_identifier, project["project_code"], version_identifier),
        ).fetchone()
        if row is None:
            raise _not_found("Document version not found", "DOCUMENT_VERSION_NOT_FOUND")
        return _document_download_response(
            settings,
            project_code=str(project["project_code"]),
            row=row,
        )

    @router.get("/{project_code}/document-versions/{version_id}/download")
    def download_document_version_by_id(
        project_code: str,
        version_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> StreamingResponse:
        version_identifier = _path_identifier(version_id, "version_id")
        project = _require_project(connection, project_code)
        row = connection.execute(
            """
            SELECT
                document_versions.document_id,
                document_versions.managed_filename,
                document_versions.content_type,
                document_versions.stored_relative_path,
                document_versions.size_bytes,
                documents.category
            FROM document_versions
            JOIN documents ON documents.id = document_versions.document_id
            WHERE documents.project_code = ? COLLATE NOCASE
                AND document_versions.id = ?
            """,
            (project["project_code"], version_identifier),
        ).fetchone()
        if row is None:
            raise _not_found("Document version not found", "DOCUMENT_VERSION_NOT_FOUND")
        return _document_download_response(
            settings,
            project_code=str(project["project_code"]),
            row=row,
        )

    @router.post("/{project_code}/documents/{document_id}/archive")
    async def archive_document(
        project_code: str,
        document_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _path_identifier(document_id, "document_id")
        key = _read_idempotency_key(request)
        reason, expected_revision = await _read_archive_payload(request)
        timestamp = _timestamp(now)
        request_hash = _request_hash(
            {"reason": reason, "expected_revision": expected_revision}
        )
        with transaction_immediate(connection):
            project = _require_project(connection, project_code)
            scope = _document_scope(
                request,
                str(project["project_code"]),
                f"documents/{identifier}/archive",
            )
            storage_key = idempotency_storage_key(scope, key)
            replay = restore_idempotent_response(
                connection,
                scope=scope,
                key=storage_key,
                request_hash=request_hash,
            )
            if replay is not None:
                return replay
            _require_active_project_record(project)
            current = _require_document_record(
                connection,
                str(project["project_code"]),
                identifier,
            )
            _require_editable_document(current)
            _require_revision(current, expected_revision)
            cursor = connection.execute(
                """
                UPDATE documents
                SET archive_reason = ?, archived_at = ?, revision = revision + 1,
                    updated_at = ?
                WHERE id = ? AND project_code = ? COLLATE NOCASE
                    AND revision = ? AND archived_at IS NULL
                """,
                (
                    reason,
                    timestamp,
                    timestamp,
                    identifier,
                    project["project_code"],
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                refreshed = _require_document_record(
                    connection,
                    str(project["project_code"]),
                    identifier,
                )
                _require_revision(refreshed, expected_revision)
                raise sqlite3.DatabaseError("document disappeared during archive")
            response = _require_document_detail(
                connection,
                str(project["project_code"]),
                identifier,
            )
            save_idempotent_response(
                connection,
                scope=scope,
                key=storage_key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_200_OK,
                resource_type="document",
                resource_id=identifier,
                created_at=timestamp,
            )
            return response

    return router


async def _read_create_form(
    request: Request,
    *,
    max_file_size_bytes: int,
) -> tuple[str, str, str | None, UploadFile]:
    form = await _read_form(request, max_file_size_bytes=max_file_size_bytes)
    try:
        _require_form_shape(
            form,
            required={"category", "title", "file"},
            optional={"notes"},
        )
        category = _normalize_category(_form_text(form, "category"))
        title = _required_text(_form_text(form, "title"), "title")
        notes = _optional_text(_form_text(form, "notes", required=False), "notes")
        return category, title, notes, _form_upload(form, "file")
    except BaseException:
        await form.close()
        raise


async def _read_version_form(
    request: Request,
    *,
    max_file_size_bytes: int,
) -> tuple[str | None, int, UploadFile]:
    form = await _read_form(request, max_file_size_bytes=max_file_size_bytes)
    try:
        _require_form_shape(
            form,
            required={"expected_revision", "file"},
            optional={"notes"},
        )
        notes = _optional_text(_form_text(form, "notes", required=False), "notes")
        expected_revision = _positive_integer(
            _form_text(form, "expected_revision"),
            "expected_revision",
        )
        return notes, expected_revision, _form_upload(form, "file")
    except BaseException:
        await form.close()
        raise


async def _read_form(
    request: Request,
    *,
    max_file_size_bytes: int,
) -> FormData:
    max_body_size_bytes = max_file_size_bytes + _MAX_MULTIPART_OVERHEAD_BYTES
    content_lengths = request.headers.getlist("content-length")
    if (
        len(content_lengths) == 1
        and content_lengths[0].isascii()
        and content_lengths[0].isdecimal()
        and int(content_lengths[0]) > max_body_size_bytes
    ):
        raise _file_too_large(max_file_size_bytes)
    original_receive = request._receive
    request._receive = _bounded_receive(
        original_receive,
        max_body_size_bytes=max_body_size_bytes,
        max_file_size_bytes=max_file_size_bytes,
    )
    try:
        return await request.form()
    except _MultipartBodyTooLarge as failure:
        raise _file_too_large(failure.max_file_size_bytes) from None
    except StarletteHTTPException as failure:
        if failure.detail == _MULTIPART_TOO_LARGE_MESSAGE:
            raise _file_too_large(max_file_size_bytes) from None
        raise _validation_error("body", "must be valid multipart data") from None
    except MultiPartException:
        raise _validation_error("body", "must be valid multipart data") from None
    finally:
        request._receive = original_receive


def _bounded_receive(
    receive: Receive,
    *,
    max_body_size_bytes: int,
    max_file_size_bytes: int,
) -> Receive:
    received_bytes = 0

    async def bounded() -> Message:
        nonlocal received_bytes
        message = await receive()
        if message["type"] == "http.request":
            received_bytes += len(message.get("body", b""))
            if received_bytes > max_body_size_bytes:
                raise _MultipartBodyTooLarge(max_file_size_bytes)
        return message

    return bounded


async def _read_update_payload(request: Request) -> tuple[str, str | None, int]:
    payload = await _read_json_object(
        request,
        {"title", "notes", "expected_revision"},
    )
    return (
        _required_text(payload["title"], "title"),
        _optional_text(payload["notes"], "notes"),
        _positive_integer(payload["expected_revision"], "expected_revision"),
    )


async def _read_archive_payload(request: Request) -> tuple[str, int]:
    payload = await _read_json_object(request, {"reason", "expected_revision"})
    return (
        _required_text(payload["reason"], "reason"),
        _positive_integer(payload["expected_revision"], "expected_revision"),
    )


async def _read_json_object(
    request: Request,
    fields: set[str],
) -> dict[str, object]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _validation_error("body", "must be valid JSON") from None
    if not isinstance(payload, dict) or set(payload) != fields:
        raise _validation_error("body", "has invalid fields")
    return payload


def _require_form_shape(
    form: FormData,
    *,
    required: set[str],
    optional: set[str],
) -> None:
    keys = set(form.keys())
    if not required <= keys or not keys <= required | optional:
        raise _validation_error("body", "has invalid multipart fields")
    if any(len(form.getlist(key)) != 1 for key in keys):
        raise _validation_error("body", "has duplicate multipart fields")


def _form_text(form: FormData, field: str, *, required: bool = True) -> object:
    value = form.get(field)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _validation_error(field, "must be text")
    return value


def _form_upload(form: FormData, field: str) -> UploadFile:
    value = form.get(field)
    if not isinstance(value, UploadFile):
        raise _validation_error(field, "must be a file")
    return value


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise _validation_error(field, "must be text")
    normalized = value.strip()
    if not normalized or "\x00" in normalized:
        raise _validation_error(field, "must not be blank")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _validation_error(field, "must be valid UTF-8") from None
    return normalized


def _optional_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _validation_error(field, "must be text or null")
    normalized = value.strip()
    if not normalized:
        return None
    if "\x00" in normalized:
        raise _validation_error(field, "contains invalid characters")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _validation_error(field, "must be valid UTF-8") from None
    return normalized


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise _validation_error(field, "must be a positive integer")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        parsed = int(value)
    else:
        raise _validation_error(field, "must be a positive integer")
    if not 1 <= parsed <= _SQLITE_MAX_INTEGER:
        raise _validation_error(field, "is out of range")
    return parsed


def _path_identifier(value: str, field: str) -> int:
    return _positive_integer(value, field)


def _normalize_category(value: object) -> str:
    if not isinstance(value, str) or value not in _CATEGORIES:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Invalid document category",
            "INVALID_DOCUMENT_CATEGORY",
            field_errors={"category": ["must be a supported category"]},
        )
    return value


def _read_category_filter(request: Request) -> str | None:
    values = request.query_params.getlist("category")
    if not values:
        return None
    if len(values) != 1:
        raise _validation_error("category", "must occur once")
    if not values[0]:
        return None
    return _normalize_category(values[0])


def _read_archive_filter(request: Request) -> str:
    values = request.query_params.getlist("archived")
    if not values:
        return "active"
    if len(values) != 1:
        raise _validation_error("archived", "must occur once")
    if values[0] not in {"active", "archived", "all"}:
        raise _validation_error("archived", "must be active, archived, or all")
    return values[0]


def _read_search_filter(request: Request) -> str | None:
    values = request.query_params.getlist("search")
    if not values:
        return None
    if len(values) != 1:
        raise _validation_error("search", "must occur once")
    search = values[0].strip()
    if not search:
        return None
    if len(search) > _MAX_SEARCH_LENGTH:
        raise _validation_error(
            "search",
            f"must not exceed {_MAX_SEARCH_LENGTH} characters",
        )
    if any(unicodedata.category(character) == "Cc" for character in search):
        raise _validation_error("search", "contains invalid characters")
    return search


def _read_pagination(request: Request) -> tuple[int, int]:
    page = _read_query_integer(
        request,
        "page",
        default=1,
        maximum=_SQLITE_MAX_INTEGER,
    )
    page_size = _read_query_integer(
        request,
        "page_size",
        default=50,
        maximum=_MAX_PAGE_SIZE,
    )
    if page - 1 > _SQLITE_MAX_INTEGER // page_size:
        raise _validation_error("page", "is out of range")
    return page, page_size


def _read_query_integer(
    request: Request,
    field: str,
    *,
    default: int,
    maximum: int,
) -> int:
    values = request.query_params.getlist(field)
    if not values:
        return default
    if (
        len(values) != 1
        or not values[0].isascii()
        or not values[0].isdecimal()
    ):
        raise _validation_error(field, "must be a positive integer")
    value = int(values[0])
    if not 1 <= value <= maximum:
        raise _validation_error(field, "is out of range")
    return value


def _read_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("Idempotency-Key")
    if len(values) != 1:
        raise _validation_error("Idempotency-Key", "must occur once")
    try:
        return str(UUID(values[0]))
    except (AttributeError, ValueError):
        raise _validation_error("Idempotency-Key", "must be a UUID") from None


def _stage_upload(upload: UploadFile, *, max_size_bytes: int) -> _StagedUpload:
    original_filename = _normalize_upload_filename(upload.filename)
    content_type = _normalize_content_type(upload.content_type)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="sunyu-document-",
        suffix=".upload",
    )
    temporary_path = Path(temporary_name)
    digest = hashlib.sha256()
    size_bytes = 0
    try:
        with os.fdopen(descriptor, "wb") as destination:
            upload.file.seek(0)
            while chunk := upload.file.read(_COPY_CHUNK_SIZE):
                if size_bytes + len(chunk) > max_size_bytes:
                    raise _file_too_large(max_size_bytes)
                destination.write(chunk)
                digest.update(chunk)
                size_bytes += len(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        return _StagedUpload(
            path=temporary_path,
            original_filename=original_filename,
            content_type=content_type,
            size_bytes=size_bytes,
            sha256=digest.hexdigest(),
        )
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _file_too_large(max_size_bytes: int) -> ApiError:
    return ApiError(
        status.HTTP_413_CONTENT_TOO_LARGE,
        "Document file is too large",
        "DOCUMENT_FILE_TOO_LARGE",
        field_errors={
            "file": [f"must not exceed {max_size_bytes // (1024 * 1024)} MB"]
        },
    )


def _normalize_upload_filename(filename: str | None) -> str:
    if not isinstance(filename, str):
        raise _validation_error("file", "must have a filename")
    normalized = filename.replace("\\", "/").rsplit("/", maxsplit=1)[-1].strip()
    if (
        not normalized
        or normalized in {".", ".."}
        or any(unicodedata.category(character) == "Cc" for character in normalized)
    ):
        raise _validation_error("file", "has an invalid filename")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _validation_error("file", "filename must be valid UTF-8") from None
    return normalized


def _normalize_content_type(content_type: str | None) -> str:
    if not content_type:
        return "application/octet-stream"
    if len(content_type) > 255 or any(
        ord(character) < 32 or ord(character) > 126 for character in content_type
    ):
        return "application/octet-stream"
    return content_type


def _discard_staged_upload(staged: _StagedUpload) -> None:
    staged.path.unlink(missing_ok=True)


def _cleanup_stored_after_failure(
    primary: BaseException,
    stored: files.StoredFileVersion | None,
    data_dir: Path,
) -> None:
    if stored is None:
        return
    try:
        files.delete_stored_version(stored, data_dir)
    except BaseException as cleanup_failure:  # noqa: BLE001 - preserve primary
        primary.add_note(
            f"published document file cleanup failed: {cleanup_failure}"
        )


def _require_project(
    connection: sqlite3.Connection,
    project_code: str,
) -> sqlite3.Row:
    try:
        normalized = normalize_project_code(project_code)
        identity = project_code_identity(normalized)
    except (TypeError, UnicodeError, ValueError):
        raise _validation_error("project_code", "is invalid") from None
    row = connection.execute(
        "SELECT id, project_code, status FROM projects WHERE project_code_key = ?",
        (identity,),
    ).fetchone()
    if row is None:
        raise _not_found("Project not found", "PROJECT_NOT_FOUND")
    return row


def _require_active_project(
    connection: sqlite3.Connection,
    project_code: str,
) -> sqlite3.Row:
    project = _require_project(connection, project_code)
    _require_active_project_record(project)
    return project


def _require_active_project_record(project: sqlite3.Row) -> None:
    if project["status"] != "active":
        raise _conflict("Project is archived", "PROJECT_ARCHIVED")


def _document_scope(request: Request, project_code: str, suffix: str) -> str:
    return f"{request.method.upper()}:/api/projects/{project_code}/{suffix}"


def _require_document_record(
    connection: sqlite3.Connection,
    project_code: str,
    document_id: int,
) -> sqlite3.Row:
    row = connection.execute(
        f"""
        {_DOCUMENT_SUMMARY_SELECT}
        WHERE documents.id = ?
            AND documents.project_code = ? COLLATE NOCASE
        """,
        (document_id, project_code),
    ).fetchone()
    if row is None:
        raise _not_found("Document not found", "DOCUMENT_NOT_FOUND")
    return row


def _require_document_detail(
    connection: sqlite3.Connection,
    project_code: str,
    document_id: int,
) -> dict[str, object]:
    document = _document_summary(
        _require_document_record(connection, project_code, document_id)
    )
    rows = connection.execute(
        """
        SELECT
            id, version_number, original_filename, managed_filename,
            content_type, size_bytes, sha256, notes, created_at
        FROM document_versions
        WHERE document_id = ?
        ORDER BY version_number, id
        """,
        (document_id,),
    ).fetchall()
    document["versions"] = [_version_response(row) for row in rows]
    return document


def _require_version(
    connection: sqlite3.Connection,
    document_id: int,
    version_id: int,
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT
            id, version_number, original_filename, managed_filename,
            content_type, size_bytes, sha256, notes, created_at
        FROM document_versions
        WHERE document_id = ? AND id = ?
        """,
        (document_id, version_id),
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("saved document version is missing")
    return _version_response(row)


def _document_stored_paths(
    connection: sqlite3.Connection,
    document_id: int,
) -> list[str]:
    rows = connection.execute(
        """
        SELECT stored_relative_path
        FROM document_versions
        WHERE document_id = ?
        """,
        (document_id,),
    ).fetchall()
    return [str(row["stored_relative_path"]) for row in rows]


def _document_summary(row: sqlite3.Row) -> dict[str, object]:
    return {field: row[field] for field in _DOCUMENT_SUMMARY_FIELDS}


def _document_list_item(
    row: sqlite3.Row,
    *,
    search_excerpt: str | None,
    include_excerpt: bool,
) -> dict[str, object]:
    item = _document_summary(row)
    if include_excerpt:
        item["search_excerpt"] = search_excerpt
    return item


def _document_search_matches(
    connection: sqlite3.Connection,
    settings: Settings,
    *,
    project_code: str,
    search: str,
    category: str | None,
    archive_filter: str,
) -> dict[int, str | None]:
    rows = _document_search_rows(
        connection,
        project_code=project_code,
        category=category,
        archive_filter=archive_filter,
    )
    needle = search.casefold()
    matches: dict[int, str | None] = {}
    content_matches: set[int] = set()
    for row in rows:
        document_id = int(row["id"])
        metadata_match, metadata_excerpt = _metadata_search_match(row, search)
        if metadata_match:
            matches.setdefault(document_id, metadata_excerpt)
        if document_id in content_matches or not _is_searchable_minutes_version(row):
            continue
        content = _read_minutes_search_text(
            row,
            settings,
            project_code=project_code,
            document_id=document_id,
        )
        if content is not None and needle in content.casefold():
            matches[document_id] = _search_excerpt(content, search)
            content_matches.add(document_id)
    return matches


def _document_search_rows(
    connection: sqlite3.Connection,
    *,
    project_code: str,
    category: str | None,
    archive_filter: str,
) -> list[sqlite3.Row]:
    clauses = ["documents.project_code = ? COLLATE NOCASE"]
    parameters: list[object] = [project_code]
    if category is not None:
        clauses.append("documents.category = ?")
        parameters.append(category)
    if archive_filter == "active":
        clauses.append("documents.archived_at IS NULL")
    elif archive_filter == "archived":
        clauses.append("documents.archived_at IS NOT NULL")
    rows = connection.execute(
        f"""
        SELECT
            documents.id,
            documents.category,
            documents.logical_name,
            documents.notes AS document_notes,
            document_versions.original_filename,
            document_versions.managed_filename,
            document_versions.content_type,
            document_versions.stored_relative_path,
            document_versions.size_bytes,
            document_versions.notes AS version_notes
        FROM documents
        LEFT JOIN document_versions
            ON document_versions.document_id = documents.id
        WHERE {' AND '.join(clauses)}
        ORDER BY
            documents.created_at DESC,
            documents.id DESC,
            document_versions.version_number DESC,
            document_versions.id DESC
        """,
        parameters,
    ).fetchall()
    return list(rows)


def _metadata_search_match(
    row: sqlite3.Row,
    search: str,
) -> tuple[bool, str | None]:
    needle = search.casefold()
    if needle in str(row["logical_name"]).casefold():
        return True, None
    for prefix, value in (
        ("", row["document_notes"]),
        ("文件：", row["managed_filename"]),
        ("原文件名：", row["original_filename"]),
        ("版本说明：", row["version_notes"]),
    ):
        if value is not None and needle in str(value).casefold():
            return True, f"{prefix}{_search_excerpt(str(value), search)}"
    return False, None


def _is_searchable_minutes_version(row: sqlite3.Row) -> bool:
    return (
        row["category"] == "planning_minutes"
        and row["stored_relative_path"] is not None
        and row["content_type"] == "text/plain"
        and int(row["size_bytes"]) <= _TEXT_SEARCH_FILE_LIMIT_BYTES
    )


def _read_minutes_search_text(
    row: sqlite3.Row,
    settings: Settings,
    *,
    project_code: str,
    document_id: int,
) -> str | None:
    try:
        with _open_download_file(
            settings.data_dir,
            project_code,
            "planning_minutes",
            document_id,
            str(row["stored_relative_path"]),
            int(row["size_bytes"]),
        ) as file_handle:
            return file_handle.read(_TEXT_SEARCH_FILE_LIMIT_BYTES).decode(
                "utf-8",
                errors="replace",
            )
    except (ApiError, OSError):
        logger.warning(
            "Skipping unavailable meeting-minutes file during search (document_id=%s)",
            document_id,
        )
        return None


def _search_excerpt(value: str, search: str) -> str:
    normalized = " ".join(value.split())
    position = normalized.casefold().find(search.casefold())
    if position < 0:
        return normalized[:120]
    start = max(position - 36, 0)
    end = min(position + len(search) + 64, len(normalized))
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(normalized) else ""
    return f"{prefix}{normalized[start:end]}{suffix}"


def _document_version_option_label(row: sqlite3.Row) -> str:
    original_filename = str(row["original_filename"])
    managed_filename = str(row["managed_filename"] or "").strip()
    filename = managed_filename or original_filename
    if filename != original_filename:
        filename = f"{filename}（原文件名：{original_filename}）"
    return (
        f"{row['title']} V{int(row['version_number'])} · {filename}"
    )


def _version_response(row: sqlite3.Row) -> dict[str, object]:
    return {field: row[field] for field in _VERSION_FIELDS}


def _require_editable_document(row: sqlite3.Row) -> None:
    if row["archived_at"] is not None:
        raise _conflict("Document is archived", "DOCUMENT_ARCHIVED")


def _require_revision(row: sqlite3.Row, expected_revision: int) -> None:
    current_revision = int(row["revision"])
    if current_revision != expected_revision:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "Resource was modified",
            "REVISION_CONFLICT",
            current_revision=current_revision,
        )


def _open_download_file(
    data_dir: Path,
    project_code: str,
    category: str,
    document_id: int,
    stored_relative_path: str,
    expected_size: int,
) -> BinaryIO:
    data_root = data_dir.resolve(strict=True)
    relative_path = Path(stored_relative_path)
    expected_prefix = ("Projects", project_code, category, str(document_id))
    if (
        relative_path.is_absolute()
        or ".." in relative_path.parts
        or relative_path.parts[:4] != expected_prefix
        or len(relative_path.parts) != 5
    ):
        raise _not_found("Document file not found", "DOCUMENT_FILE_NOT_FOUND")
    candidate = data_root / relative_path
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        raise _not_found("Document file not found", "DOCUMENT_FILE_NOT_FOUND") from None
    if not resolved.is_relative_to(data_root) or resolved != candidate.absolute():
        raise _not_found("Document file not found", "DOCUMENT_FILE_NOT_FOUND")
    try:
        file_handle = resolved.open("rb")
        file_stat = os.fstat(file_handle.fileno())
    except OSError:
        raise _not_found("Document file not found", "DOCUMENT_FILE_NOT_FOUND") from None
    if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size != expected_size:
        file_handle.close()
        raise _not_found("Document file not found", "DOCUMENT_FILE_NOT_FOUND")
    return file_handle


def _document_download_response(
    settings: Settings,
    *,
    project_code: str,
    row: sqlite3.Row,
) -> StreamingResponse:
    file_handle = _open_download_file(
        settings.data_dir,
        project_code,
        str(row["category"]),
        int(row["document_id"]),
        str(row["stored_relative_path"]),
        int(row["size_bytes"]),
    )
    return StreamingResponse(
        _stream_file(file_handle),
        media_type=str(row["content_type"]),
        headers={
            "Content-Disposition": _content_disposition(
                str(row["managed_filename"])
            ),
            "Content-Length": str(row["size_bytes"]),
        },
    )


def _stream_file(file_handle: BinaryIO) -> Iterator[bytes]:
    try:
        while chunk := file_handle.read(_COPY_CHUNK_SIZE):
            yield chunk
    finally:
        file_handle.close()


def _content_disposition(original_filename: str) -> str:
    safe_name = "".join(
        "_"
        if character in {'"', "\\", "/"}
        or unicodedata.category(character) == "Cc"
        else character
        for character in original_filename
    ).strip(". ")
    if not safe_name:
        safe_name = "download"
    ascii_fallback = "".join(
        character if 32 <= ord(character) <= 126 else "_"
        for character in safe_name
    )
    encoded = quote(safe_name, safe="!#$&+-.^_`|~")
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{encoded}"
    )


def _request_hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not return an identifier")
    return int(cursor.lastrowid)


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _managed_business_date(timestamp: str) -> str:
    return (
        datetime.fromisoformat(timestamp)
        .astimezone(ZoneInfo("Asia/Shanghai"))
        .strftime("%Y%m%d")
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_document_title_conflict(failure: sqlite3.IntegrityError) -> bool:
    return (
        getattr(failure, "sqlite_errorcode", None)
        == sqlite3.SQLITE_CONSTRAINT_UNIQUE
        and "documents.project_code, documents.category, documents.logical_name"
        in str(failure)
    )


def _validation_error(field: str, message: str) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "Invalid document payload",
        "INVALID_DOCUMENT_PAYLOAD",
        field_errors={field: [message]},
    )


def _not_found(detail: str, error_code: str) -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, detail, error_code)


def _conflict(detail: str, error_code: str) -> ApiError:
    return ApiError(
        status.HTTP_409_CONFLICT,
        detail,
        error_code,
        headers={"X-Error-Code": error_code},
    )
