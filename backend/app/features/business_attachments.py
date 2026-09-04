from __future__ import annotations

import json
import sqlite3
import unicodedata
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Self

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import FormData, UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from backend.app.features import files
from backend.app.features.api_common import ApiError

_MAX_PAYLOAD_BYTES = 1024 * 1024
_MAX_FILES = 20
_MULTIPART_OVERHEAD_BYTES = 1024 * 1024
_CATEGORY_NAMES = {
    "planning_minutes": "项目纪要",
    "site_survey": "现场勘察",
    "quotation": "项目报价",
    "technical_agreement": "技术协议",
    "contract": "项目合同",
    "mechanical_design": "机械设计",
    "electrical_design": "电气设计",
    "procurement_list": "采购清单",
    "procurement_contract": "采购合同",
    "mechanical_signoff": "机械会签",
    "electrical_signoff": "电气会签",
    "construction": "施工资料",
    "commissioning": "调试资料",
    "acceptance": "验收资料",
    "invoice": "项目发票",
    "warranty": "质保资料",
    "after_sales": "售后资料",
    "other": "其他资料",
}

InvalidFactory = Callable[[str, str], ApiError]
TooLargeFactory = Callable[[int], ApiError]


@dataclass(frozen=True, slots=True)
class StagedAttachment:
    staged: files.StagedFileVersion
    original_filename: str
    content_type: str

    @property
    def size_bytes(self) -> int:
        return self.staged.size_bytes

    @property
    def sha256(self) -> str:
        return self.staged.sha256

    def fingerprint(self) -> dict[str, object]:
        return {
            "original_filename": self.original_filename,
            "content_type": self.content_type,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class ManagedDocument:
    title: str
    managed_filename: str


class AttachmentBatch:
    def __init__(self, attachments: Sequence[StagedAttachment], data_dir: Path) -> None:
        self.attachments = tuple(attachments)
        self.data_dir = data_dir
        self._published: list[files.StoredFileVersion] = []

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: object,
    ) -> bool:
        if exception is not None:
            for stored in reversed(self._published):
                try:
                    files.delete_stored_version(stored, self.data_dir)
                except BaseException as cleanup_failure:  # noqa: BLE001
                    exception.add_note(
                        f"published attachment cleanup failed: {cleanup_failure}"
                    )
        cleanup_failure_to_raise: BaseException | None = None
        for attachment in self.attachments:
            try:
                files.discard_staged_version(attachment.staged)
            except BaseException as cleanup_failure:  # noqa: BLE001 - clean all stages
                if exception is not None:
                    exception.add_note(
                        f"staged attachment cleanup failed: {cleanup_failure}"
                    )
                elif cleanup_failure_to_raise is None:
                    cleanup_failure_to_raise = cleanup_failure
                else:
                    cleanup_failure_to_raise.add_note(
                        f"staged attachment cleanup failed: {cleanup_failure}"
                    )
        if cleanup_failure_to_raise is not None:
            raise cleanup_failure_to_raise
        return False

    def hash_payload(self, payload: dict[str, object]) -> dict[str, object]:
        if not self.attachments:
            return payload
        return {
            "payload": payload,
            "files": [attachment.fingerprint() for attachment in self.attachments],
        }

    def publish_documents(
        self,
        connection: sqlite3.Connection,
        *,
        project_code: str,
        category: str,
        documents: Sequence[ManagedDocument],
        notes: str | None,
        timestamp: str,
    ) -> list[int]:
        if len(documents) != len(self.attachments):
            raise ValueError("managed document count does not match uploads")
        version_ids: list[int] = []
        for attachment, managed in zip(self.attachments, documents, strict=True):
            cursor = connection.execute(
                """
                INSERT INTO documents
                    (project_code, category, logical_name, notes,
                     revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                (project_code, category, managed.title, notes, timestamp, timestamp),
            )
            document_id = _last_insert_id(cursor)
            files.reconcile_document_versions(
                self.data_dir,
                project_code,
                category,
                document_id,
                [],
            )
            stored = files.publish_staged_version(
                attachment.staged,
                project_code,
                category,
                document_id=document_id,
                verify_content=False,
                managed_name=managed.managed_filename,
                version_number=1,
            )
            self._published.append(stored)
            if stored.version_number != 1:
                raise sqlite3.DatabaseError(
                    "new attachment document storage did not start at version one"
                )
            version_cursor = connection.execute(
                """
                INSERT INTO document_versions
                    (document_id, version_number, original_filename,
                     managed_filename, content_type, stored_relative_path,
                     size_bytes, sha256, notes, created_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    attachment.original_filename,
                    managed.managed_filename,
                    attachment.content_type,
                    str(stored.relative_path),
                    stored.size_bytes,
                    stored.sha256,
                    notes,
                    timestamp,
                ),
            )
            version_ids.append(_last_insert_id(version_cursor))
        return version_ids


class _FileTooLarge(MultiPartException):
    pass


class _BatchTooLarge(MultiPartException):
    pass


class _LimitedMultipartParser(MultiPartParser):
    def __init__(self, *args: Any, max_file_size_bytes: int, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._max_file_size_bytes = max_file_size_bytes
        self._current_file_bytes = 0
        self._total_file_bytes = 0

    def on_headers_finished(self) -> None:
        try:
            super().on_headers_finished()
        except MultiPartException:
            if self._current_files > self.max_files:
                raise _BatchTooLarge(
                    f"uploaded file count exceeded {_MAX_FILES}"
                ) from None
            raise

    def on_part_begin(self) -> None:
        super().on_part_begin()
        self._current_file_bytes = 0

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._current_part.file is not None:
            chunk_size = end - start
            self._current_file_bytes += chunk_size
            if self._current_file_bytes > self._max_file_size_bytes:
                raise _FileTooLarge("uploaded file exceeded configured limit")
            self._total_file_bytes += chunk_size
            if self._total_file_bytes > self._max_file_size_bytes:
                raise _BatchTooLarge(
                    "combined uploaded files exceeded configured limit"
                )
        super().on_part_data(data, start, end)


def is_multipart_request(request: Request) -> bool:
    return request.headers.get("content-type", "").casefold().startswith(
        "multipart/form-data"
    )


async def read_multipart_batch(
    request: Request,
    *,
    data_dir: Path,
    max_file_size_bytes: int,
    invalid: InvalidFactory,
    too_large: TooLargeFactory,
    batch_too_large: TooLargeFactory,
) -> tuple[dict[str, object], AttachmentBatch]:
    form: FormData | None = None
    staged: list[StagedAttachment] = []
    primary: BaseException | None = None
    parsing = True
    try:
        parser = _LimitedMultipartParser(
            request.headers,
            _limited_request_stream(
                request,
                max_received_bytes=(
                    max_file_size_bytes + _MULTIPART_OVERHEAD_BYTES
                ),
            ),
            max_files=_MAX_FILES,
            max_fields=1,
            max_part_size=_MAX_PAYLOAD_BYTES,
            max_file_size_bytes=max_file_size_bytes,
        )
        form = await parser.parse()
        parsing = False
        payload_text, uploads = _multipart_parts(form, invalid)
        payload = _payload_object(payload_text, invalid)
        for upload in uploads:
            original_filename = normalize_upload_filename(
                upload.filename,
                invalid=invalid,
            )
            try:
                prepared = await run_in_threadpool(
                    files.stage_stream,
                    upload.file,
                    data_dir,
                    original_name=original_filename,
                    max_size_bytes=max_file_size_bytes,
                )
            except files.StagedFileTooLarge:
                raise too_large(max_file_size_bytes) from None
            if prepared.size_bytes == 0:
                files.discard_staged_version(prepared)
                raise invalid("files", "must not contain empty files")
            staged.append(
                StagedAttachment(
                    staged=prepared,
                    original_filename=original_filename,
                    content_type=normalize_content_type(upload.content_type),
                )
            )
        return payload, AttachmentBatch(staged, data_dir)
    except _BatchTooLarge:
        primary = batch_too_large(max_file_size_bytes)
        raise primary from None
    except _FileTooLarge:
        primary = too_large(max_file_size_bytes)
        raise primary from None
    except ApiError as failure:
        primary = failure
        raise
    except (
        KeyError,
        MultiPartException,
        RuntimeError,
        TypeError,
        ValueError,
    ) as failure:
        if parsing:
            primary = invalid("body", "must be valid multipart data")
            raise primary from None
        primary = failure
        raise
    except BaseException as failure:
        primary = failure
        raise
    finally:
        if primary is not None:
            for attachment in staged:
                try:
                    files.discard_staged_version(attachment.staged)
                except BaseException as cleanup_failure:  # noqa: BLE001
                    primary.add_note(
                        f"staged attachment cleanup failed: {cleanup_failure}"
                    )
        if form is not None:
            try:
                await form.close()
            except BaseException as cleanup_failure:
                if primary is None:
                    for attachment in staged:
                        try:
                            files.discard_staged_version(attachment.staged)
                        except BaseException as staged_cleanup_failure:  # noqa: BLE001
                            cleanup_failure.add_note(
                                "staged attachment cleanup failed: "
                                f"{staged_cleanup_failure}"
                            )
                    raise
                primary.add_note(f"multipart close failed: {cleanup_failure}")


async def _limited_request_stream(
    request: Request,
    *,
    max_received_bytes: int,
) -> AsyncIterator[bytes]:
    content_lengths = request.headers.getlist("Content-Length")
    if len(content_lengths) == 1:
        declared = content_lengths[0]
        if (
            declared.isascii()
            and declared.isdecimal()
            and int(declared) > max_received_bytes
        ):
            raise _BatchTooLarge("declared multipart body exceeded batch limit")
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_received_bytes:
            raise _BatchTooLarge("received multipart body exceeded batch limit")
        yield chunk


def normalize_upload_filename(
    filename: str | None,
    *,
    invalid: InvalidFactory,
) -> str:
    if not isinstance(filename, str):
        raise invalid("files", "must have a filename")
    normalized = filename.replace("\\", "/").rsplit("/", maxsplit=1)[-1].strip()
    if (
        not normalized
        or normalized in {".", ".."}
        or any(unicodedata.category(character) == "Cc" for character in normalized)
    ):
        raise invalid("files", "has an invalid filename")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise invalid("files", "filename must be valid UTF-8") from None
    return normalized


def normalize_content_type(content_type: str | None) -> str:
    if not content_type:
        return "application/octet-stream"
    if len(content_type) > 255 or any(
        ord(character) < 32 or ord(character) > 126 for character in content_type
    ):
        return "application/octet-stream"
    return content_type


def compact_iso_date(value: str) -> str:
    if (
        len(value) == 10
        and value[4] == "-"
        and value[7] == "-"
    ):
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            return value
        if parsed.isoformat() == value:
            return parsed.strftime("%Y%m%d")
    return value


def managed_filename(
    *parts: object,
    original_filename: str,
    preserve_last_parts: int = 1,
) -> str:
    suffix = Path(original_filename).suffix
    raw = "_".join(str(part) for part in parts) + suffix
    preserved_tail = ""
    if preserve_last_parts > 0:
        preserved_tail = "_" + "_".join(
            str(part) for part in parts[-preserve_last_parts:]
        )
    return files.sanitize_filename(
        raw,
        preserve_stem_tail=preserved_tail,
    )


def document_managed_filename(
    *,
    project_code: str,
    category: str,
    title: str,
    business_date: str,
    version_number: int,
    original_filename: str,
) -> str:
    category_name = _CATEGORY_NAMES.get(category, category)
    return managed_filename(
        project_code,
        category_name,
        title,
        business_date,
        f"V{version_number}",
        original_filename=original_filename,
        preserve_last_parts=2,
    )


def _multipart_parts(
    form: FormData,
    invalid: InvalidFactory,
) -> tuple[str, list[UploadFile]]:
    payload_values: list[str] = []
    uploads: list[UploadFile] = []
    for field, value in form.multi_items():
        if field == "payload" and isinstance(value, str):
            payload_values.append(value)
        elif field == "files" and isinstance(value, UploadFile):
            uploads.append(value)
        else:
            raise invalid("body", "has invalid multipart fields")
    if len(payload_values) != 1:
        raise invalid("payload", "must occur once as text")
    return payload_values[0], uploads


def _payload_object(value: str, invalid: InvalidFactory) -> dict[str, object]:
    try:
        payload = json.loads(value)
    except (RecursionError, UnicodeError, ValueError):
        raise invalid("payload", "must be valid JSON") from None
    if not isinstance(payload, dict):
        raise invalid("payload", "must be a JSON object")
    return payload


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not return an identifier")
    return int(cursor.lastrowid)
