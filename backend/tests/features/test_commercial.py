from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from starlette import formparsers

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity
from backend.app.features import business_attachments, commercial, files

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 31, 9, 30, tzinfo=timezone.utc)
PROJECT_CODE = "SY-2026-001"
SECOND_PROJECT_CODE = "SY-2026-002"


@dataclass(frozen=True)
class CommercialHarness:
    app: FastAPI
    database_path: Path
    settings: Settings
    customer_company_id: int
    second_company_id: int
    document_version_id: int
    second_document_version_id: int

    @contextmanager
    def client(
        self,
        *,
        authenticated: bool = True,
        raise_server_exceptions: bool = True,
    ) -> Iterator[TestClient]:
        with TestClient(
            self.app, raise_server_exceptions=raise_server_exceptions
        ) as client:
            if authenticated:
                client.cookies.set(
                    SESSION_COOKIE_NAME,
                    create_session_token(self.settings.session_secret),
                )
            yield client


def _build_harness(
    tmp_path: Path,
    *,
    max_document_upload_mb: int = 4096,
) -> CommercialHarness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        customer_id = _insert_company(connection, "客户公司")
        second_company_id = _insert_company(connection, "第二客户")
        _insert_project(connection, customer_id, PROJECT_CODE)
        _insert_project(connection, second_company_id, SECOND_PROJECT_CODE)
        document_id = _insert_document(connection, PROJECT_CODE, "主合同")
        second_document_id = _insert_document(
            connection,
            SECOND_PROJECT_CODE,
            "跨项目附件",
        )
    finally:
        connection.close()

    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="commercial-test-session-secret-32-bytes",
        max_document_upload_mb=max_document_upload_mb,
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        owned = connect_database(database_path)
        try:
            yield owned
        finally:
            owned.close()

    def get_settings() -> Settings:
        return settings

    app = FastAPI()
    app.include_router(
        commercial.create_commercial_router(
            get_connection,
            get_settings,
            clock=lambda: NOW,
        )
    )
    return CommercialHarness(
        app,
        database_path,
        settings,
        customer_id,
        second_company_id,
        document_id,
        second_document_id,
    )


@pytest.fixture
def harness(tmp_path: Path) -> CommercialHarness:
    return _build_harness(tmp_path)


def _insert_company(connection: sqlite3.Connection, name: str) -> int:
    cursor = connection.execute(
        """
        INSERT INTO companies
            (name, taxpayer_id, registered_address, registered_phone,
             bank_name, bank_account, notes, created_at, updated_at)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        """,
        (name, NOW.isoformat(), NOW.isoformat()),
    )
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid)


def _insert_project(
    connection: sqlite3.Connection,
    company_id: int,
    project_code: str,
) -> None:
    connection.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
        """,
        (
            project_code,
            project_code_identity(project_code),
            company_id,
            f"{project_code} 项目",
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    )


def _insert_document(
    connection: sqlite3.Connection,
    project_code: str,
    title: str,
) -> int:
    document = connection.execute(
        """
        INSERT INTO documents
            (project_code, category, logical_name, notes, archive_reason,
             archived_at, revision, created_at, updated_at)
        VALUES (?, 'contract', ?, NULL, NULL, NULL, 1, ?, ?)
        """,
        (project_code, title, NOW.isoformat(), NOW.isoformat()),
    )
    assert document.lastrowid is not None
    version = connection.execute(
        """
        INSERT INTO document_versions
            (document_id, version_number, original_filename, content_type,
             stored_relative_path, size_bytes, sha256, notes, created_at)
        VALUES (?, 1, 'contract.pdf', 'application/pdf', ?, 10, ?, NULL, ?)
        """,
        (
            int(document.lastrowid),
            f"{project_code}/{document.lastrowid}/contract.pdf",
            "0" * 64,
            NOW.isoformat(),
        ),
    )
    assert version.lastrowid is not None
    return int(version.lastrowid)


def _quote_payload(
    harness: CommercialHarness,
    *,
    amount_cents: object = 1_280_000,
    document_version_ids: object | None = None,
) -> dict[str, object]:
    return {
        "quote_date": "2026-08-31",
        "amount_cents": amount_cents,
        "valid_until": "2026-09-30",
        "notes": " 第一版报价 ",
        "document_version_ids": (
            [harness.document_version_id]
            if document_version_ids is None
            else document_version_ids
        ),
    }


def _contract_payload(
    harness: CommercialHarness,
    *,
    contract_no: str = "HT-2026-001",
    total_amount_cents: object = 1_280_000,
    signed_on: object = None,
    final_delivery_on: object = None,
    allocations: object | None = None,
    document_version_ids: object | None = None,
) -> dict[str, object]:
    return {
        "contract_no": contract_no,
        "title": " 自动化改造合同 ",
        "customer_company_id": harness.customer_company_id,
        "signed_on": signed_on,
        "total_amount_cents": total_amount_cents,
        "final_delivery_on": final_delivery_on,
        "allocations": (
            [{"project_code": PROJECT_CODE, "amount_cents": 1_280_000}]
            if allocations is None
            else allocations
        ),
        "notes": " 主合同 ",
        "document_version_ids": (
            [harness.document_version_id]
            if document_version_ids is None
            else document_version_ids
        ),
    }


def _assert_validation_error(response: Response) -> None:
    assert response.status_code == 422
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_commercial_router_requires_authentication(harness: CommercialHarness) -> None:
    with harness.client(authenticated=False) as client:
        assert client.get(f"/api/projects/{PROJECT_CODE}/quotes").status_code == 401
        assert client.get(f"/api/projects/{PROJECT_CODE}/contracts").status_code == 401
        assert client.get(f"/api/projects/{PROJECT_CODE}/payments").status_code == 401


def test_quotes_create_continuous_versions_list_and_detail(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness),
        )
        second = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json={**_quote_payload(harness), "amount_cents": 1_350_000},
        )
        listing = client.get(
            f"/api/projects/{PROJECT_CODE}/quotes?page=1&page_size=1"
        )
        detail = client.get(
            f"/api/projects/{PROJECT_CODE}/quotes/{first.json()['id']}"
        )

    assert first.status_code == second.status_code == 201
    assert first.json() == {
        "id": first.json()["id"],
        "project_code": PROJECT_CODE,
        "version_number": 1,
        "status": "draft",
        "quote_date": "2026-08-31",
        "amount_cents": 1_280_000,
        "valid_until": "2026-09-30",
        "notes": "第一版报价",
        "document_version_ids": [harness.document_version_id],
        "revision": 1,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }
    assert second.json()["version_number"] == 2
    assert listing.json()["total"] == 2
    assert listing.json()["items"][0]["version_number"] == 2
    assert detail.json() == first.json()


def test_quote_multipart_creates_independent_managed_documents_and_is_idempotent(
    harness: CommercialHarness,
) -> None:
    key = "71000000-0000-4000-8000-000000000001"
    payload = _quote_payload(harness)
    files = [
        ("files", ("客户原始报价.pdf", b"quote-pdf", "application/pdf")),
        ("files", ("附件无扩展名", b"quote-image", "image/png")),
    ]
    with harness.client() as client:
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=files,
        )
        replay = client.post(
            f"/api/projects/{PROJECT_CODE.lower()}/quotes",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=files,
        )
        conflict = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=[
                ("files", ("客户原始报价.pdf", b"changed", "application/pdf")),
                ("files", ("附件无扩展名", b"quote-image", "image/png")),
            ],
        )

    assert first.status_code == replay.status_code == 201, first.text
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    assert first.json()["document_version_ids"][:1] == [
        harness.document_version_id
    ]
    new_version_ids = first.json()["document_version_ids"][1:]
    assert len(new_version_ids) == 2
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT versions.id, versions.original_filename,
                   versions.managed_filename, versions.stored_relative_path,
                   documents.category, documents.logical_name
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id IN (?, ?)
            ORDER BY versions.id
            """,
            new_version_ids,
        ).fetchall()
        assert connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0] == 1
    finally:
        connection.close()
    assert [row["original_filename"] for row in rows] == [
        "客户原始报价.pdf",
        "附件无扩展名",
    ]
    assert [row["managed_filename"] for row in rows] == [
        f"{PROJECT_CODE}_报价_20260831_V1_01.pdf",
        f"{PROJECT_CODE}_报价_20260831_V1_02",
    ]
    assert [row["category"] for row in rows] == ["quotation", "quotation"]
    assert len({row["logical_name"] for row in rows}) == 2
    for row in rows:
        stored = harness.settings.data_dir / row["stored_relative_path"]
        assert stored.is_file()
        assert stored.name == row["managed_filename"]


def test_quote_multipart_rejects_bad_shape_empty_invalid_and_oversized_files(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    payload = _quote_payload(harness, document_version_ids=[])
    with harness.client() as client:
        missing_payload = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000001"
            },
            files={"files": ("quote.pdf", b"quote", "application/pdf")},
        )
        empty_file = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000002"
            },
            data={"payload": json.dumps(payload)},
            files={"files": ("empty.pdf", b"", "application/pdf")},
        )
        invalid_filename = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000003"
            },
            data={"payload": json.dumps(payload)},
            files={"files": ("", b"quote", "application/pdf")},
        )
        too_large = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000004"
            },
            data={"payload": json.dumps(payload)},
            files={
                "files": (
                    "large.pdf",
                    b"x" * (1024 * 1024 + 1),
                    "application/pdf",
                )
            },
        )
        invalid_payload = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000005"
            },
            data={"payload": json.dumps(payload | {"amount_cents": -1})},
            files={"files": ("valid.pdf", b"valid", "application/pdf")},
        )

    assert missing_payload.status_code == 422
    assert empty_file.status_code == 422
    assert invalid_filename.status_code == 422
    assert too_large.status_code == 413
    assert invalid_payload.status_code == 422
    assert too_large.json()["error_code"] == "DOCUMENT_FILE_TOO_LARGE"
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_quote_multipart_rejects_more_than_twenty_files_and_closes_spools(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    payload = _quote_payload(harness, document_version_ids=[])
    created_spools: list[object] = []
    original_spooled_file = formparsers.SpooledTemporaryFile

    def tracked_spooled_file(*args: object, **kwargs: object):
        spool = original_spooled_file(*args, **kwargs)
        created_spools.append(spool)
        return spool

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", tracked_spooled_file)
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000006"
            },
            data={"payload": json.dumps(payload)},
            files=[
                ("files", (f"file-{index}.txt", b"x", "text/plain"))
                for index in range(21)
            ],
        )

    assert response.status_code == 413
    assert response.json()["error_code"] == "DOCUMENT_BATCH_TOO_LARGE"
    assert created_spools
    assert all(spool.closed for spool in created_spools)  # type: ignore[attr-defined]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_quote_multipart_rejects_files_whose_combined_size_exceeds_limit(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    payload = _quote_payload(harness, document_version_ids=[])
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000007"
            },
            data={"payload": json.dumps(payload)},
            files=[
                ("files", ("first.bin", b"a" * 600_000, "application/octet-stream")),
                ("files", ("second.bin", b"b" * 600_000, "application/octet-stream")),
            ],
        )

    assert response.status_code == 413
    assert response.json()["error_code"] == "DOCUMENT_BATCH_TOO_LARGE"
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


@pytest.mark.parametrize("content_length", ["1", None], ids=["forged", "missing"])
def test_quote_multipart_actual_stream_limit_is_authoritative(
    tmp_path: Path,
    content_length: str | None,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    boundary = "actual-stream-limit"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="payload"\r\n\r\n'
    ).encode() + b"x" * (2 * 1024 * 1024 + 256 * 1024) + (
        f"\r\n--{boundary}--\r\n"
    ).encode()
    headers: list[tuple[str, str]] = [
        ("Idempotency-Key", "71100000-0000-4000-8000-000000000008"),
        ("Content-Type", f"multipart/form-data; boundary={boundary}"),
    ]
    if content_length is not None:
        headers.append(("Content-Length", content_length))
        content: object = body
    else:
        content = iter([body])

    with harness.client() as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers=headers,
            content=content,
        )

    assert response.status_code == 413
    assert response.json()["error_code"] == "DOCUMENT_BATCH_TOO_LARGE"
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_quote_stages_each_file_through_threadpool(
    harness: CommercialHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    async def tracked_threadpool(function: object, *args: object, **kwargs: object):
        calls.append(function)
        return function(*args, **kwargs)  # type: ignore[operator]

    monkeypatch.setattr(
        business_attachments,
        "run_in_threadpool",
        tracked_threadpool,
        raising=False,
    )
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000009"
            },
            data={
                "payload": json.dumps(
                    _quote_payload(harness, document_version_ids=[])
                )
            },
            files={"files": ("quote.pdf", b"quote", "application/pdf")},
        )

    assert response.status_code == 201, response.text
    assert files.stage_stream in calls


@pytest.mark.parametrize("failure_type", [RuntimeError, OSError])
def test_quote_storage_integrity_failure_stays_500_and_cleans_staged_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_type: type[Exception],
) -> None:
    harness = _build_harness(tmp_path)
    original_stage = files.stage_stream
    calls = 0

    def fail_second_stage(*args: object, **kwargs: object):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise failure_type("injected storage integrity failure")
        return original_stage(*args, **kwargs)

    monkeypatch.setattr(files, "stage_stream", fail_second_stage)
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71100000-0000-4000-8000-000000000010"
            },
            data={
                "payload": json.dumps(
                    _quote_payload(harness, document_version_ids=[])
                )
            },
            files=[
                ("files", ("first.pdf", b"first", "application/pdf")),
                ("files", ("second.pdf", b"second", "application/pdf")),
            ],
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0] == 0
    finally:
        connection.close()
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_quote_json_and_zero_file_multipart_share_idempotency_hash(
    harness: CommercialHarness,
) -> None:
    key = "71400000-0000-4000-8000-000000000001"
    payload = _quote_payload(harness, document_version_ids=[])
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            f"/api/projects/{PROJECT_CODE.lower()}/quotes",
            headers={"Idempotency-Key": key},
            files={
                "payload": (
                    None,
                    json.dumps(payload, ensure_ascii=False),
                    "application/json",
                )
            },
        )

    assert created.status_code == replay.status_code == 201, replay.text
    assert replay.json() == created.json()
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0] == 1
    finally:
        connection.close()


def test_quote_multipart_database_failure_rolls_back_records_and_files(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_business_attachment_version
            BEFORE INSERT ON document_versions
            BEGIN
                SELECT RAISE(ABORT, 'injected attachment database failure');
            END
            """
        )
    finally:
        connection.close()
    payload = _quote_payload(harness, document_version_ids=[])
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71200000-0000-4000-8000-000000000001"
            },
            data={"payload": json.dumps(payload)},
            files={"files": ("quote.pdf", b"quote", "application/pdf")},
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM document_versions"
        ).fetchone()[0] == 2
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_quote_multipart_publish_failure_cleans_previously_published_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path)
    original_publish = files.publish_staged_version
    calls = 0

    def fail_second_publish(*args: object, **kwargs: object):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected publish failure")
        return original_publish(*args, **kwargs)

    monkeypatch.setattr(files, "publish_staged_version", fail_second_publish)
    payload = _quote_payload(harness, document_version_ids=[])
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            headers={
                "Idempotency-Key": "71300000-0000-4000-8000-000000000001"
            },
            data={"payload": json.dumps(payload)},
            files=[
                ("files", ("first.pdf", b"first", "application/pdf")),
                ("files", ("second.pdf", b"second", "application/pdf")),
            ],
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


@pytest.mark.parametrize(
    "documents",
    [
        lambda harness: [harness.document_version_id, harness.document_version_id],
        lambda harness: [harness.second_document_version_id],
        lambda _harness: [999_999],
    ],
)
def test_quote_rejects_duplicate_cross_project_or_missing_documents(
    harness: CommercialHarness,
    documents: object,
) -> None:
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness, document_version_ids=documents(harness)),
        )
    _assert_validation_error(response)


def test_quote_rejects_archived_document_and_invalid_amount_types(
    harness: CommercialHarness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            "UPDATE documents SET archived_at = ?, archive_reason = 'obsolete'",
            (NOW.isoformat(),),
        )
    finally:
        connection.close()

    with harness.client() as client:
        archived = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness),
        )
        floating = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness, amount_cents=12.8),
        )
        boolean = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness, amount_cents=True),
        )
    _assert_validation_error(archived)
    _assert_validation_error(floating)
    _assert_validation_error(boolean)


def test_quote_update_is_draft_only_and_revision_controlled(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json=_quote_payload(harness),
        ).json()
        update_payload = {
            **_quote_payload(harness),
            "amount_cents": 1_300_000,
            "expected_revision": created["revision"],
        }
        updated = client.put(
            f"/api/projects/{PROJECT_CODE}/quotes/{created['id']}",
            json=update_payload,
        )
        stale = client.put(
            f"/api/projects/{PROJECT_CODE}/quotes/{created['id']}",
            json=update_payload,
        )
        sent = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{created['id']}/transition",
            json={
                "to_status": "sent",
                "occurred_at": "2026-08-31T10:00:00+08:00",
                "reason": None,
                "expected_revision": updated.json()["revision"],
            },
        )
        immutable = client.put(
            f"/api/projects/{PROJECT_CODE}/quotes/{created['id']}",
            json={**update_payload, "expected_revision": sent.json()["revision"]},
        )

    assert updated.status_code == 200
    assert updated.json()["amount_cents"] == 1_300_000
    assert updated.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["current_revision"] == 2
    assert immutable.status_code == 409
    assert immutable.json()["error_code"] == "QUOTE_NOT_EDITABLE"


def test_quote_transitions_are_legal_accepted_is_unique_and_rejection_does_not_archive(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes", json=_quote_payload(harness)
        ).json()
        invalid = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{first['id']}/transition",
            json={
                "to_status": "accepted",
                "occurred_at": "2026-08-31T10:00:00+08:00",
                "reason": None,
                "expected_revision": first["revision"],
            },
        )
        sent = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{first['id']}/transition",
            json={
                "to_status": "sent",
                "occurred_at": "2026-08-31T10:00:00+08:00",
                "reason": None,
                "expected_revision": first["revision"],
            },
        ).json()
        accepted = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{first['id']}/transition",
            json={
                "to_status": "accepted",
                "occurred_at": "2026-08-31T10:05:00+08:00",
                "reason": "客户确认",
                "expected_revision": sent["revision"],
            },
        )
        second = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json={**_quote_payload(harness), "amount_cents": 1_400_000},
        ).json()
        second_sent = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{second['id']}/transition",
            json={
                "to_status": "sent",
                "occurred_at": "2026-08-31T10:10:00+08:00",
                "reason": None,
                "expected_revision": second["revision"],
            },
        ).json()
        duplicate_accept = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes/{second['id']}/transition",
            json={
                "to_status": "accepted",
                "occurred_at": "2026-08-31T10:15:00+08:00",
                "reason": None,
                "expected_revision": second_sent["revision"],
            },
        )
        rejected_quote = client.post(
            f"/api/projects/{SECOND_PROJECT_CODE}/quotes",
            json={
                **_quote_payload(harness, document_version_ids=[]),
                "amount_cents": 500_000,
            },
        ).json()
        rejected_sent = client.post(
            f"/api/projects/{SECOND_PROJECT_CODE}/quotes/"
            f"{rejected_quote['id']}/transition",
            json={
                "to_status": "sent",
                "occurred_at": "2026-08-31T11:00:00+08:00",
                "reason": None,
                "expected_revision": rejected_quote["revision"],
            },
        ).json()
        rejected = client.post(
            f"/api/projects/{SECOND_PROJECT_CODE}/quotes/"
            f"{rejected_quote['id']}/transition",
            json={
                "to_status": "rejected",
                "occurred_at": "2026-08-31T11:05:00+08:00",
                "reason": "预算不足",
                "expected_revision": rejected_sent["revision"],
            },
        )

    assert invalid.status_code == 409
    assert invalid.json()["error_code"] == "INVALID_QUOTE_TRANSITION"
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"
    assert duplicate_accept.status_code == 409
    assert duplicate_accept.json()["error_code"] == "ACCEPTED_QUOTE_EXISTS"
    assert rejected.json()["status"] == "rejected"
    connection = connect_database(harness.database_path)
    try:
        project_status = connection.execute(
            "SELECT status FROM projects WHERE project_code = ?",
            (SECOND_PROJECT_CODE,),
        ).fetchone()[0]
    finally:
        connection.close()
    assert project_status == "active"


def test_contract_create_lists_multi_project_allocations_and_detail(
    harness: CommercialHarness,
) -> None:
    allocations = [
        {"project_code": PROJECT_CODE, "amount_cents": 800_000},
        {"project_code": SECOND_PROJECT_CODE, "amount_cents": 480_000},
    ]
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(harness, allocations=allocations),
        )
        listing = client.get(f"/api/projects/{SECOND_PROJECT_CODE}/contracts")
        detail = client.get(
            f"/api/projects/{SECOND_PROJECT_CODE}/contracts/{created.json()['id']}"
        )

    assert created.status_code == 201
    assert created.json()["customer_company_name"] == "客户公司"
    assert created.json()["title"] == "自动化改造合同"
    assert [item["project_code"] for item in created.json()["allocations"]] == [
        PROJECT_CODE,
        SECOND_PROJECT_CODE,
    ]
    assert listing.json()["total"] == 1
    assert detail.json() == created.json()


def test_contract_multipart_creates_managed_documents_and_is_idempotent(
    harness: CommercialHarness,
) -> None:
    key = "72000000-0000-4000-8000-000000000001"
    payload = _contract_payload(harness)
    files_payload = [
        ("files", ("客户合同.pdf", b"contract-pdf", "application/pdf")),
        ("files", ("技术附件.docx", b"contract-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
    ]
    with harness.client() as client:
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=files_payload,
        )
        replay = client.post(
            f"/api/projects/{PROJECT_CODE.lower()}/contracts",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=files_payload,
        )
        conflict = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=[
                ("files", ("客户合同.pdf", b"changed-contract", "application/pdf")),
                ("files", ("技术附件.docx", b"contract-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        )

    assert first.status_code == replay.status_code == 201, first.text
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    assert first.json()["document_version_ids"][:1] == [
        harness.document_version_id
    ]
    new_version_ids = first.json()["document_version_ids"][1:]
    assert len(new_version_ids) == 2
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT versions.original_filename, versions.managed_filename,
                   versions.stored_relative_path, documents.category
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id IN (?, ?)
            ORDER BY versions.id
            """,
            new_version_ids,
        ).fetchall()
        assert connection.execute("SELECT COUNT(*) FROM contracts").fetchone()[0] == 1
    finally:
        connection.close()
    assert [row["managed_filename"] for row in rows] == [
        f"{PROJECT_CODE}_合同_HT-2026-001_01.pdf",
        f"{PROJECT_CODE}_合同_HT-2026-001_02.docx",
    ]
    assert [row["category"] for row in rows] == ["contract", "contract"]
    for row in rows:
        stored = harness.settings.data_dir / row["stored_relative_path"]
        assert stored.is_file()
        assert stored.name == row["managed_filename"]


def test_contract_json_retries_restore_the_created_contract(
    harness: CommercialHarness,
) -> None:
    key = "72100000-0000-4000-8000-000000000001"
    payload = _contract_payload(harness, document_version_ids=[])
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            f"/api/projects/{PROJECT_CODE.lower()}/contracts",
            headers={"Idempotency-Key": key},
            json=payload,
        )

    assert created.status_code == replay.status_code == 201, replay.text
    assert replay.json() == created.json()
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM contracts").fetchone()[0] == 1
    finally:
        connection.close()


def test_contract_rejects_duplicate_number_bad_allocations_and_cross_project_document(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(harness),
        )
        duplicate_no = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(harness, contract_no=" ht-2026-001 "),
        )
        duplicate_allocation = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                contract_no="HT-2026-002",
                allocations=[
                    {"project_code": PROJECT_CODE, "amount_cents": 640_000},
                    {"project_code": PROJECT_CODE, "amount_cents": 640_000},
                ],
            ),
        )
        missing_current = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                contract_no="HT-2026-003",
                allocations=[
                    {"project_code": SECOND_PROJECT_CODE, "amount_cents": 1_280_000}
                ],
            ),
        )
        cross_document = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                contract_no="HT-2026-004",
                document_version_ids=[harness.second_document_version_id],
            ),
        )

    assert created.status_code == 201
    assert duplicate_no.status_code == 409
    assert duplicate_no.json()["error_code"] == "CONTRACT_NO_EXISTS"
    _assert_validation_error(duplicate_allocation)
    _assert_validation_error(missing_current)
    _assert_validation_error(cross_document)


def test_contract_signing_requires_dates_and_exact_allocation_total(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(harness),
        ).json()
        missing_dates = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "signed",
                "occurred_at": "2026-08-31T12:00:00+08:00",
                "reason": None,
                "expected_revision": created["revision"],
            },
        )
        updated = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}",
            json={
                **_contract_payload(
                    harness,
                    signed_on="2026-08-31",
                    final_delivery_on="2026-12-31",
                    allocations=[
                        {"project_code": PROJECT_CODE, "amount_cents": 1_000_000}
                    ],
                ),
                "expected_revision": created["revision"],
            },
        ).json()
        wrong_sum = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "signed",
                "occurred_at": "2026-08-31T12:05:00+08:00",
                "reason": None,
                "expected_revision": updated["revision"],
            },
        )
        corrected = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}",
            json={
                **_contract_payload(
                    harness,
                    signed_on="2026-08-31",
                    final_delivery_on="2026-12-31",
                ),
                "expected_revision": updated["revision"],
            },
        ).json()
        signed = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "signed",
                "occurred_at": "2026-08-31T12:10:00+08:00",
                "reason": "双方盖章",
                "expected_revision": corrected["revision"],
            },
        )

    assert missing_dates.status_code == 409
    assert missing_dates.json()["error_code"] == "CONTRACT_SIGNING_REQUIREMENTS"
    assert wrong_sum.status_code == 409
    assert wrong_sum.json()["error_code"] == "CONTRACT_SIGNING_REQUIREMENTS"
    assert signed.status_code == 200
    assert signed.json()["status"] == "signed"


def test_contract_update_revision_signed_amount_lock_and_legal_transitions(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                signed_on="2026-08-31",
                final_delivery_on="2026-12-31",
            ),
        ).json()
        stale = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}",
            json={**_contract_payload(harness), "expected_revision": 99},
        )
        signed = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "signed",
                "occurred_at": "2026-08-31T13:00:00+08:00",
                "reason": None,
                "expected_revision": created["revision"],
            },
        ).json()
        amount_change = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}",
            json={
                **_contract_payload(
                    harness,
                    total_amount_cents=1_300_000,
                    signed_on="2026-08-31",
                    final_delivery_on="2026-12-31",
                    allocations=[
                        {"project_code": PROJECT_CODE, "amount_cents": 1_300_000}
                    ],
                ),
                "expected_revision": signed["revision"],
            },
        )
        notes_update = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}",
            json={
                **_contract_payload(
                    harness,
                    signed_on="2026-08-31",
                    final_delivery_on="2026-12-31",
                ),
                "notes": "签订后补充说明",
                "expected_revision": signed["revision"],
            },
        )
        completed = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "completed",
                "occurred_at": "2027-01-01T09:00:00+08:00",
                "reason": None,
                "expected_revision": notes_update.json()["revision"],
            },
        )
        invalid = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{created['id']}/transition",
            json={
                "to_status": "terminated",
                "occurred_at": "2027-01-02T09:00:00+08:00",
                "reason": "不应再终止",
                "expected_revision": completed.json()["revision"],
            },
        )

    assert stale.status_code == 409
    assert stale.json()["current_revision"] == 1
    assert amount_change.status_code == 409
    assert amount_change.json()["error_code"] == "CONTRACT_AMOUNT_LOCKED"
    assert notes_update.status_code == 200
    assert notes_update.json()["notes"] == "签订后补充说明"
    assert completed.json()["status"] == "completed"
    assert invalid.status_code == 409
    assert invalid.json()["error_code"] == "INVALID_CONTRACT_TRANSITION"


def test_signed_contract_allocation_reordering_does_not_change_locked_amounts(
    harness: CommercialHarness,
) -> None:
    allocations = [
        {"project_code": PROJECT_CODE, "amount_cents": 800_000},
        {"project_code": SECOND_PROJECT_CODE, "amount_cents": 480_000},
    ]
    with harness.client() as client:
        contract = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                contract_no="HT-REORDER",
                signed_on="2026-08-31",
                final_delivery_on="2026-12-31",
                allocations=allocations,
            ),
        ).json()
        signed = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{contract['id']}/transition",
            json={
                "to_status": "signed",
                "occurred_at": "2026-08-31T13:00:00+08:00",
                "reason": None,
                "expected_revision": contract["revision"],
            },
        ).json()
        reordered = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{contract['id']}",
            json={
                **_contract_payload(
                    harness,
                    contract_no="HT-REORDER",
                    signed_on="2026-08-31",
                    final_delivery_on="2026-12-31",
                    allocations=list(reversed(allocations)),
                ),
                "notes": "仅调整数组顺序",
                "expected_revision": signed["revision"],
            },
        )

    assert reordered.status_code == 200
    assert reordered.json()["notes"] == "仅调整数组顺序"
    assert {
        item["project_code"]: item["amount_cents"]
        for item in reordered.json()["allocations"]
    } == {PROJECT_CODE: 800_000, SECOND_PROJECT_CODE: 480_000}


@pytest.mark.parametrize("locked_status", ["signed", "completed", "terminated"])
def test_locked_contract_rejects_formal_and_attachment_overwrites_but_allows_notes(
    harness: CommercialHarness,
    locked_status: str,
) -> None:
    with harness.client() as client:
        locked = _create_signed_contract(
            client,
            harness,
            contract_no=f"HT-{locked_status.upper()}-FORMAL-LOCK",
            multi_project=True,
        )
        if locked_status != "signed":
            transitioned = client.post(
                f"/api/projects/{PROJECT_CODE}/contracts/{locked['id']}/transition",
                json={
                    "to_status": locked_status,
                    "occurred_at": "2026-09-01T09:00:00+08:00",
                    "reason": None if locked_status == "completed" else "客户终止",
                    "expected_revision": locked["revision"],
                },
            )
            assert transitioned.status_code == 200, transitioned.text
            locked = transitioned.json()

        allocations = [
            {
                "project_code": item["project_code"],
                "amount_cents": item["amount_cents"],
            }
            for item in locked["allocations"]
        ]
        baseline = {
            "contract_no": locked["contract_no"],
            "title": locked["title"],
            "customer_company_id": locked["customer_company_id"],
            "signed_on": locked["signed_on"],
            "total_amount_cents": locked["total_amount_cents"],
            "final_delivery_on": locked["final_delivery_on"],
            "allocations": allocations,
            "notes": locked["notes"],
            "document_version_ids": locked["document_version_ids"],
        }
        shifted_allocations = [
            {**allocations[0], "amount_cents": allocations[0]["amount_cents"] - 1},
            {**allocations[1], "amount_cents": allocations[1]["amount_cents"] + 1},
        ]
        mutations = [
            ("contract_no", {"contract_no": f"{locked['contract_no']}-EDIT"}),
            ("title", {"title": "改写后的合同标题"}),
            (
                "customer_company_id",
                {"customer_company_id": harness.second_company_id},
            ),
            ("signed_on", {"signed_on": "2026-08-21"}),
            (
                "total_amount_cents",
                {
                    "total_amount_cents": locked["total_amount_cents"] + 1,
                    "allocations": [
                        {
                            **allocations[0],
                            "amount_cents": allocations[0]["amount_cents"] + 1,
                        },
                        allocations[1],
                    ],
                },
            ),
            ("final_delivery_on", {"final_delivery_on": "2027-01-01"}),
            ("allocations", {"allocations": shifted_allocations}),
            ("document_version_ids", {"document_version_ids": []}),
        ]
        for field, mutation in mutations:
            rejected = client.put(
                f"/api/projects/{PROJECT_CODE}/contracts/{locked['id']}",
                json={
                    **baseline,
                    **mutation,
                    "expected_revision": locked["revision"],
                },
            )
            assert rejected.status_code == 409, (
                locked_status,
                field,
                rejected.text,
            )
            expected_error = (
                "CONTRACT_AMOUNT_LOCKED"
                if field in {"total_amount_cents", "allocations"}
                else "CONTRACT_FORMAL_FIELDS_LOCKED"
            )
            assert rejected.json()["error_code"] == expected_error

        unchanged = client.get(
            f"/api/projects/{PROJECT_CODE}/contracts/{locked['id']}"
        )
        notes_only = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{locked['id']}",
            json={
                **baseline,
                "notes": f"{locked_status} 状态补充备注",
                "expected_revision": locked["revision"],
            },
        )

    assert unchanged.status_code == 200
    assert unchanged.json() == locked
    assert notes_only.status_code == 200, notes_only.text
    assert notes_only.json()["notes"] == f"{locked_status} 状态补充备注"
    for field in (
        "contract_no",
        "title",
        "customer_company_id",
        "signed_on",
        "total_amount_cents",
        "final_delivery_on",
        "allocations",
        "document_version_ids",
    ):
        assert notes_only.json()[field] == locked[field]


def test_terminated_contract_keeps_signed_amount_and_allocation_history(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        signed = _create_signed_contract(
            client,
            harness,
            contract_no="HT-TERMINATED-LOCK",
        )
        receipt = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=signed["allocations"][0]["id"]),
        )
        assert receipt.status_code == 201
        terminated = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts/{signed['id']}/transition",
            json={
                "to_status": "terminated",
                "occurred_at": "2026-09-01T09:00:00+08:00",
                "reason": "客户终止",
                "expected_revision": signed["revision"],
            },
        ).json()
        changed_amount = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{signed['id']}",
            json={
                **_contract_payload(
                    harness,
                    contract_no="HT-TERMINATED-LOCK",
                    total_amount_cents=120_000,
                    signed_on="2026-08-20",
                    final_delivery_on="2026-12-31",
                    allocations=[
                        {"project_code": PROJECT_CODE, "amount_cents": 120_000}
                    ],
                ),
                "expected_revision": terminated["revision"],
            },
        )
        notes_only = client.put(
            f"/api/projects/{PROJECT_CODE}/contracts/{signed['id']}",
            json={
                **_contract_payload(
                    harness,
                    contract_no="HT-TERMINATED-LOCK",
                    total_amount_cents=100_000,
                    signed_on="2026-08-20",
                    final_delivery_on="2026-12-31",
                    allocations=[
                        {"project_code": PROJECT_CODE, "amount_cents": 100_000}
                    ],
                ),
                "notes": "终止补充说明",
                "expected_revision": terminated["revision"],
            },
        )

    assert changed_amount.status_code == 409
    assert changed_amount.json()["error_code"] == "CONTRACT_AMOUNT_LOCKED"
    assert notes_only.status_code == 200
    assert notes_only.json()["notes"] == "终止补充说明"
    assert notes_only.json()["allocations"] == terminated["allocations"]


def test_quote_pagination_rejects_offset_beyond_sqlite_integer(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        response = client.get(
            f"/api/projects/{PROJECT_CODE}/quotes"
            f"?page={2**63 - 1}&page_size=200"
        )
    _assert_validation_error(response)


def test_commercial_payloads_reject_unknown_fields(harness: CommercialHarness) -> None:
    with harness.client() as client:
        quote = client.post(
            f"/api/projects/{PROJECT_CODE}/quotes",
            json={**_quote_payload(harness), "unexpected": True},
        )
        contract = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json={**_contract_payload(harness), "unexpected": True},
        )
    _assert_validation_error(quote)
    _assert_validation_error(contract)


def _create_signed_contract(
    client: TestClient,
    harness: CommercialHarness,
    *,
    amount_cents: int = 100_000,
    contract_no: str = "HT-PAY-001",
    multi_project: bool = False,
) -> dict[str, object]:
    allocations = [{"project_code": PROJECT_CODE, "amount_cents": amount_cents}]
    if multi_project:
        allocations = [
            {"project_code": PROJECT_CODE, "amount_cents": amount_cents},
            {"project_code": SECOND_PROJECT_CODE, "amount_cents": amount_cents},
        ]
    created = client.post(
        f"/api/projects/{PROJECT_CODE}/contracts",
        json=_contract_payload(
            harness,
            contract_no=contract_no,
            total_amount_cents=sum(int(item["amount_cents"]) for item in allocations),
            signed_on="2026-08-20",
            final_delivery_on="2026-12-31",
            allocations=allocations,
        ),
    )
    assert created.status_code == 201, created.text
    contract = created.json()
    signed = client.post(
        f"/api/projects/{PROJECT_CODE}/contracts/{contract['id']}/transition",
        json={
            "to_status": "signed",
            "occurred_at": "2026-08-20T09:00:00+08:00",
            "reason": None,
            "expected_revision": contract["revision"],
        },
    )
    assert signed.status_code == 200, signed.text
    return signed.json()


def _term_payload(
    *,
    planned_amount_cents: object = 100_000,
    due_on: object = "2026-09-30",
    expected_revision: object = None,
) -> dict[str, object]:
    return {
        "due_on": due_on,
        "planned_amount_cents": planned_amount_cents,
        "notes": " 首付款 ",
        "expected_revision": expected_revision,
    }


def _receipt_payload(
    *,
    allocation_id: object = None,
    milestone: object = "advance",
    amount_cents: object = 40_000,
    notes: object = " 第一笔 ",
) -> dict[str, object]:
    return {
        "contract_allocation_id": allocation_id,
        "milestone": milestone,
        "received_on": "2026-08-30",
        "amount_cents": amount_cents,
        "payment_method": "bank_transfer",
        "reference_no": " BANK-001 ",
        "notes": notes,
    }


def _idempotency_headers(value: str | None = None) -> dict[str, str]:
    return {"Idempotency-Key": value or str(uuid.uuid4())}


def test_payment_overview_has_three_empty_nodes_and_null_denominators(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        response = client.get(f"/api/projects/{PROJECT_CODE}/payments")

    assert response.status_code == 200
    assert response.json() == {
        "contracted_amount_cents": 0,
        "receivable_amount_cents": 0,
        "received_amount_cents": 0,
        "allocated_received_amount_cents": 0,
        "unallocated_received_amount_cents": 0,
        "outstanding_receivable_cents": 0,
        "contract_collection_basis_points": None,
        "terms": [
            {
                "id": None,
                "milestone": milestone,
                "due_on": None,
                "planned_amount_cents": 0,
                "received_amount_cents": 0,
                "outstanding_amount_cents": 0,
                "term_fulfillment_basis_points": None,
                "status": "unplanned",
                "is_overdue": False,
                "notes": None,
                "revision": None,
            }
            for milestone in ("advance", "progress", "final")
        ],
        "receipts": [],
    }


def test_receipt_without_effective_contract_fails_without_consuming_idempotency_key(
    harness: CommercialHarness,
) -> None:
    key = "40000000-0000-4000-8000-000000000099"
    path = f"/api/projects/{PROJECT_CODE}/receipts"
    payload = _receipt_payload(allocation_id=None)
    with harness.client() as client:
        rejected = client.post(path, headers=_idempotency_headers(key), json=payload)
        _create_signed_contract(client, harness, contract_no="HT-AFTER-REJECT")
        retried = client.post(path, headers=_idempotency_headers(key), json=payload)

    assert rejected.status_code == 409
    assert rejected.json()["error_code"] == "RECEIPT_CONTRACT_REQUIRED"
    assert rejected.json()["field_errors"] == {
        "contract_allocation_id": ["项目暂无已生效合同，不能登记到账"]
    }
    assert retried.status_code == 201
    assert retried.json()["contract_allocation_id"] is not None


def test_receipt_without_allocation_auto_uses_the_only_effective_contract(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        signed = _create_signed_contract(client, harness, contract_no="HT-ONLY")
        created = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=None),
        )

    assert created.status_code == 201
    assert created.json()["contract_allocation_id"] == signed["allocations"][0]["id"]


def test_receipt_cannot_overpay_its_contract_allocation(
    harness: CommercialHarness,
) -> None:
    key = "40000000-0000-4000-8000-000000000100"
    with harness.client() as client:
        signed = _create_signed_contract(
            client,
            harness,
            amount_cents=100,
            contract_no="HT-RECEIPT-LIMIT",
        )
        allocation_id = signed["allocations"][0]["id"]
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=allocation_id, amount_cents=80),
        )
        rejected = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(key),
            json=_receipt_payload(allocation_id=allocation_id, amount_cents=21),
        )
        corrected = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(key),
            json=_receipt_payload(allocation_id=allocation_id, amount_cents=20),
        )

    assert first.status_code == 201
    assert rejected.status_code == 409
    assert rejected.headers["x-error-code"] == "RECEIPT_ALLOCATION_EXCEEDED"
    assert rejected.json()["field_errors"] == {
        "amount_cents": ["本次到账超过该合同在本项目的剩余应收 0.20 元"]
    }
    assert corrected.status_code == 201


def test_receipt_with_multiple_effective_contracts_requires_explicit_allocation(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        first = _create_signed_contract(client, harness, contract_no="HT-FIRST")
        _create_signed_contract(client, harness, contract_no="HT-SECOND")
        rejected = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=None),
        )
        accepted = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=first["allocations"][0]["id"]),
        )

    assert rejected.status_code == 409
    assert rejected.json()["error_code"] == "RECEIPT_CONTRACT_AMBIGUOUS"
    assert rejected.json()["field_errors"] == {
        "contract_allocation_id": ["项目存在多份已生效合同，必须明确选择本次到账归属"]
    }
    assert accepted.status_code == 201


def test_payment_term_initialization_and_update_have_explicit_revision_semantics(
    harness: CommercialHarness,
) -> None:
    path = f"/api/projects/{PROJECT_CODE}/payment-terms/advance"
    with harness.client() as client:
        created = client.put(path, json=_term_payload())
        duplicate_create = client.put(path, json=_term_payload())
        updated = client.put(
            path,
            json=_term_payload(
                planned_amount_cents=120_000,
                due_on="2026-10-15",
                expected_revision=created.json()["revision"],
            ),
        )
        invalid_milestone = client.put(
            f"/api/projects/{PROJECT_CODE}/payment-terms/deposit",
            json=_term_payload(),
        )

    assert created.status_code == 200
    assert created.json()["id"] is not None
    assert created.json()["revision"] == 1
    assert created.json()["status"] == "scheduled"
    assert created.json()["term_fulfillment_basis_points"] == 0
    assert duplicate_create.status_code == 409
    assert duplicate_create.json()["current_revision"] == 1
    assert updated.json()["planned_amount_cents"] == 120_000
    assert updated.json()["revision"] == 2
    _assert_validation_error(invalid_milestone)


def test_payments_use_signed_contracts_integer_rounding_overdue_and_split_receipts(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        draft = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(
                harness,
                contract_no="HT-DRAFT-NOT-BASIS",
                total_amount_cents=3,
                allocations=[{"project_code": PROJECT_CODE, "amount_cents": 3}],
            ),
        )
        assert draft.status_code == 201
        signed = _create_signed_contract(
            client,
            harness,
            amount_cents=3,
            contract_no="HT-ROUNDING",
        )
        term = client.put(
            f"/api/projects/{PROJECT_CODE}/payment-terms/advance",
            json=_term_payload(planned_amount_cents=3, due_on="2026-08-30"),
        )
        assert term.status_code == 200
        allocation_id = signed["allocations"][0]["id"]
        first = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=allocation_id, amount_cents=1),
        )
        second = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=None, amount_cents=1),
        )
        overview = client.get(f"/api/projects/{PROJECT_CODE}/payments")

    assert first.status_code == second.status_code == 201
    body = overview.json()
    assert body["contracted_amount_cents"] == 3
    assert body["receivable_amount_cents"] == 3
    assert body["received_amount_cents"] == 2
    assert body["allocated_received_amount_cents"] == 2
    assert body["unallocated_received_amount_cents"] == 0
    assert body["outstanding_receivable_cents"] == 1
    assert body["contract_collection_basis_points"] == 6667
    advance = body["terms"][0]
    assert advance["received_amount_cents"] == 2
    assert advance["outstanding_amount_cents"] == 1
    assert advance["term_fulfillment_basis_points"] == 6667
    assert advance["status"] == "partial"
    assert advance["is_overdue"] is True


def test_receipt_requires_idempotency_key_and_exact_integer_payload(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        missing = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            json=_receipt_payload(),
        )
        invalid_key = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers={"Idempotency-Key": "not-a-uuid"},
            json=_receipt_payload(),
        )
        floating = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(amount_cents=1.5),
        )
        unknown = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json={**_receipt_payload(), "unexpected": True},
        )

    _assert_validation_error(missing)
    _assert_validation_error(invalid_key)
    _assert_validation_error(floating)
    _assert_validation_error(unknown)


def test_receipt_allocation_must_belong_to_current_project(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        contract = _create_signed_contract(
            client,
            harness,
            amount_cents=50_000,
            multi_project=True,
        )
        second_allocation = next(
            item
            for item in contract["allocations"]
            if item["project_code"] == SECOND_PROJECT_CODE
        )
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=second_allocation["id"]),
        )

    _assert_validation_error(response)


def test_receipt_allocation_requires_an_effective_contract(
    harness: CommercialHarness,
) -> None:
    with harness.client() as client:
        draft = client.post(
            f"/api/projects/{PROJECT_CODE}/contracts",
            json=_contract_payload(harness, contract_no="HT-DRAFT-RECEIPT"),
        ).json()
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(allocation_id=draft["allocations"][0]["id"]),
        )

    _assert_validation_error(response)


def test_receipt_replay_returns_original_snapshot_and_key_reuse_conflicts(
    harness: CommercialHarness,
) -> None:
    key = "41000000-0000-4000-8000-000000000001"
    path = f"/api/projects/{PROJECT_CODE}/receipts"
    original_payload = _receipt_payload(notes="初次到账")
    with harness.client() as client:
        _create_signed_contract(client, harness, contract_no="HT-REPLAY")
        created = client.post(path, headers=_idempotency_headers(key), json=original_payload)
        receipt = created.json()
        updated = client.put(
            f"{path}/{receipt['id']}",
            json={
                "reference_no": "BANK-UPDATED",
                "notes": "后改说明",
                "expected_revision": receipt["revision"],
            },
        )
        replay = client.post(
            path,
            headers=_idempotency_headers(key),
            json=original_payload,
        )
        conflict = client.post(
            path,
            headers=_idempotency_headers(key),
            json=_receipt_payload(notes="不同请求"),
        )

    assert created.status_code == 201
    assert updated.json()["notes"] == "后改说明"
    assert replay.status_code == 201
    assert replay.json() == created.json()
    assert replay.json()["revision"] == 1
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"


def test_archived_project_blocks_new_writes_but_allows_successful_receipt_replay(
    harness: CommercialHarness,
) -> None:
    key = "42000000-0000-4000-8000-000000000001"
    path = f"/api/projects/{PROJECT_CODE}/receipts"
    payload = _receipt_payload()
    with harness.client() as client:
        _create_signed_contract(client, harness, contract_no="HT-ARCHIVE-REPLAY")
        created = client.post(path, headers=_idempotency_headers(key), json=payload)
        assert created.status_code == 201
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?,
                    archive_reason = '项目结束'
                WHERE project_code = ?
                """,
                (NOW.isoformat(), PROJECT_CODE),
            )
        finally:
            connection.close()
        replay = client.post(path, headers=_idempotency_headers(key), json=payload)
        new_receipt = client.post(
            path,
            headers=_idempotency_headers(),
            json=payload,
        )
        term = client.put(
            f"/api/projects/{PROJECT_CODE}/payment-terms/advance",
            json=_term_payload(),
        )

    assert replay.status_code == 201
    assert replay.json() == created.json()
    assert new_receipt.status_code == 409
    assert new_receipt.json()["error_code"] == "PROJECT_ARCHIVED"
    assert term.status_code == 409
    assert term.json()["error_code"] == "PROJECT_ARCHIVED"


def test_receipt_update_changes_only_description_fields_and_checks_revision(
    harness: CommercialHarness,
) -> None:
    path = f"/api/projects/{PROJECT_CODE}/receipts"
    with harness.client() as client:
        _create_signed_contract(client, harness, contract_no="HT-RECEIPT-UPDATE")
        created = client.post(
            path,
            headers=_idempotency_headers(),
            json=_receipt_payload(),
        ).json()
        changed = client.put(
            f"{path}/{created['id']}",
            json={
                "reference_no": " BANK-NEW ",
                "notes": " 新说明 ",
                "expected_revision": created["revision"],
            },
        )
        stale = client.put(
            f"{path}/{created['id']}",
            json={
                "reference_no": None,
                "notes": None,
                "expected_revision": created["revision"],
            },
        )
        amount_edit = client.put(
            f"{path}/{created['id']}",
            json={
                "reference_no": None,
                "notes": None,
                "amount_cents": 1,
                "expected_revision": changed.json()["revision"],
            },
        )

    assert changed.status_code == 200
    assert changed.json()["reference_no"] == "BANK-NEW"
    assert changed.json()["notes"] == "新说明"
    assert changed.json()["amount_cents"] == created["amount_cents"]
    assert changed.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["current_revision"] == 2
    _assert_validation_error(amount_edit)


def test_void_receipt_reverses_totals_preserves_history_and_is_revision_controlled(
    harness: CommercialHarness,
) -> None:
    path = f"/api/projects/{PROJECT_CODE}/receipts"
    with harness.client() as client:
        contract = _create_signed_contract(client, harness)
        term = client.put(
            f"/api/projects/{PROJECT_CODE}/payment-terms/advance",
            json=_term_payload(),
        )
        assert term.status_code == 200
        created = client.post(
            path,
            headers=_idempotency_headers(),
            json=_receipt_payload(
                allocation_id=contract["allocations"][0]["id"],
                amount_cents=40_000,
            ),
        ).json()
        stale = client.post(
            f"{path}/{created['id']}/void",
            json={
                "voided_on": "2026-08-31",
                "reason": "录入错误",
                "expected_revision": 99,
            },
        )
        voided = client.post(
            f"{path}/{created['id']}/void",
            json={
                "voided_on": "2026-08-31",
                "reason": " 录入错误 ",
                "expected_revision": created["revision"],
            },
        )
        repeated = client.post(
            f"{path}/{created['id']}/void",
            json={
                "voided_on": "2026-08-31",
                "reason": "再次作废",
                "expected_revision": voided.json()["revision"],
            },
        )
        edit_voided = client.put(
            f"{path}/{created['id']}",
            json={
                "reference_no": None,
                "notes": None,
                "expected_revision": voided.json()["revision"],
            },
        )
        overview = client.get(f"/api/projects/{PROJECT_CODE}/payments").json()

    assert stale.status_code == 409
    assert voided.status_code == 200
    assert voided.json()["status"] == "voided"
    assert voided.json()["void_reason"] == "录入错误"
    assert repeated.status_code == 409
    assert repeated.json()["error_code"] == "RECEIPT_NOT_ACTIVE"
    assert edit_voided.status_code == 409
    assert edit_voided.json()["error_code"] == "RECEIPT_NOT_ACTIVE"
    assert overview["received_amount_cents"] == 0
    assert overview["allocated_received_amount_cents"] == 0
    assert overview["terms"][0]["status"] == "scheduled"
    assert overview["receipts"][0]["status"] == "voided"


def test_receipt_and_idempotency_record_roll_back_together(
    harness: CommercialHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_save(*_args: object, **_kwargs: object) -> None:
        raise sqlite3.OperationalError("injected idempotency failure")

    with harness.client() as client:
        _create_signed_contract(client, harness, contract_no="HT-ROLLBACK")
    monkeypatch.setattr(commercial, "save_idempotent_response", fail_save)
    with TestClient(harness.app, raise_server_exceptions=False) as client:
        client.cookies.set(
            SESSION_COOKIE_NAME,
            create_session_token(harness.settings.session_secret),
        )
        response = client.post(
            f"/api/projects/{PROJECT_CODE}/receipts",
            headers=_idempotency_headers(),
            json=_receipt_payload(),
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM idempotency_requests"
            ).fetchone()[0]
            == 0
        )
    finally:
        connection.close()
