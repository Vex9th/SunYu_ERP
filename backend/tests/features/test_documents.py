from __future__ import annotations

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
from starlette import formparsers
from starlette.datastructures import UploadFile

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity
from backend.app.features import documents as documents_module
from backend.app.features import files

NOW = datetime(2026, 8, 31, 6, 30, tzinfo=timezone.utc)


def _migrations_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations"


@dataclass(frozen=True)
class FixedClock:
    value: datetime = NOW

    def __call__(self) -> datetime:
        return self.value


@dataclass
class DocumentHarness:
    app: FastAPI
    database_path: Path
    settings: Settings

    def client(self, *, authenticated: bool = True) -> TestClient:
        client = TestClient(self.app)
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


def _build_harness(
    tmp_path: Path,
    *,
    max_document_upload_mb: int = 4096,
) -> DocumentHarness:
    from backend.app.features.documents import create_documents_router

    database_path = tmp_path / "iapm.sqlite"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, _migrations_dir())
        connection.execute(
            """
            INSERT INTO companies (id, name, created_at, updated_at)
            VALUES (1, '示例公司', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        for project_id, project_code, status in (
            (1, "P-001", "active"),
            (2, "P-002", "active"),
            (3, "P-ARCHIVED", "archived"),
        ):
            archive_reason = "项目已结束" if status == "archived" else None
            archived_at = NOW.isoformat() if status == "archived" else None
            connection.execute(
                """
                INSERT INTO projects
                    (id, project_code, project_code_key, company_id, name,
                     status, archive_reason, archived_at, created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    project_code,
                    project_code_identity(project_code),
                    f"项目 {project_code}",
                    status,
                    archive_reason,
                    archived_at,
                    NOW.isoformat(),
                    NOW.isoformat(),
                ),
            )
    finally:
        connection.close()

    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path / "Data",
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="document-test-secret",
        max_document_upload_mb=max_document_upload_mb,
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(database_path)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(
        create_documents_router(
            get_connection,
            lambda: settings,
            clock=FixedClock(),
        )
    )
    return DocumentHarness(app=app, database_path=database_path, settings=settings)


def _idempotency_key() -> str:
    return str(uuid.uuid4())


def _create_document(
    client: TestClient,
    *,
    project_code: str = "P-001",
    category: str = "mechanical_design",
    title: str = "机械总图",
    notes: str = "首次归档",
    filename: str = "机械总图.dwg",
    content: bytes = b"version-one",
    content_type: str = "application/acad",
    idempotency_key: str | None = None,
):
    return client.post(
        f"/api/projects/{project_code}/documents",
        headers={"Idempotency-Key": idempotency_key or _idempotency_key()},
        data={"category": category, "title": title, "notes": notes},
        files={"file": (filename, content, content_type)},
    )


def _append_version(
    client: TestClient,
    document_id: int,
    *,
    project_code: str = "P-001",
    expected_revision: int = 1,
    filename: str = "机械总图-v2.dwg",
    content: bytes = b"version-two",
    notes: str = "设计复核后更新",
    idempotency_key: str | None = None,
):
    return client.post(
        f"/api/projects/{project_code}/documents/{document_id}/versions",
        headers={"Idempotency-Key": idempotency_key or _idempotency_key()},
        data={"expected_revision": str(expected_revision), "notes": notes},
        files={"file": (filename, content, "application/acad")},
    )


def test_document_routes_require_authentication_before_request_validation(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client(authenticated=False) as client:
        listed = client.get("/api/projects/P-001/documents?category=not-valid")
        created = client.post("/api/projects/P-001/documents")

    assert listed.status_code == 401
    assert created.status_code == 401
    assert listed.json() == {"detail": "Authentication required"}
    assert created.json() == {"detail": "Authentication required"}


def test_create_list_detail_and_update_document_metadata(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        created = _create_document(client)
        listed = client.get(
            "/api/projects/P-001/documents"
            "?category=mechanical_design&page=1&page_size=10"
        )
        detail = client.get(
            f"/api/projects/P-001/documents/{created.json()['id']}"
        )
        updated = client.put(
            f"/api/projects/P-001/documents/{created.json()['id']}",
            json={
                "title": "机械总图（复核）",
                "notes": "负责人已复核",
                "expected_revision": 1,
            },
        )

    assert created.status_code == 201
    body = created.json()
    assert body == {
        "id": body["id"],
        "project_code": "P-001",
        "category": "mechanical_design",
        "title": "机械总图",
        "notes": "首次归档",
        "latest_version_number": 1,
        "archived_at": None,
        "revision": 1,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
        "versions": [
            {
                "id": body["versions"][0]["id"],
                "version_number": 1,
                "original_filename": "机械总图.dwg",
                "content_type": "application/acad",
                "size_bytes": len(b"version-one"),
                "sha256": body["versions"][0]["sha256"],
                "notes": "首次归档",
                "created_at": NOW.isoformat(),
            }
        ],
    }
    assert len(body["versions"][0]["sha256"]) == 64
    assert listed.status_code == 200
    assert listed.json() == {
        "items": [{key: value for key, value in body.items() if key != "versions"}],
        "total": 1,
        "page": 1,
        "page_size": 10,
    }
    assert detail.json() == body
    assert updated.status_code == 200
    assert updated.json()["title"] == "机械总图（复核）"
    assert updated.json()["notes"] == "负责人已复核"
    assert updated.json()["revision"] == 2
    assert updated.json()["versions"] == body["versions"]


def test_two_documents_in_same_category_each_start_at_version_one(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        first = _create_document(client, title="机械总图 A", content=b"drawing-a")
        second = _create_document(client, title="机械总图 B", content=b"drawing-b")

    assert first.status_code == 201
    assert second.status_code == 201
    first_body = first.json()
    second_body = second.json()
    assert first_body["versions"][0]["version_number"] == 1
    assert second_body["versions"][0]["version_number"] == 1

    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT document_id, version_number, stored_relative_path
            FROM document_versions
            ORDER BY document_id
            """
        ).fetchall()
    finally:
        connection.close()
    assert [(row["document_id"], row["version_number"]) for row in rows] == [
        (first_body["id"], 1),
        (second_body["id"], 1),
    ]
    assert Path(rows[0]["stored_relative_path"]).parts[:4] == (
        "Projects",
        "P-001",
        "mechanical_design",
        str(first_body["id"]),
    )
    assert Path(rows[1]["stored_relative_path"]).parts[:4] == (
        "Projects",
        "P-001",
        "mechanical_design",
        str(second_body["id"]),
    )


def test_append_version_updates_document_revision_and_rejects_stale_revision(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        created = _create_document(client)
        document_id = created.json()["id"]
        appended = _append_version(client, document_id)
        stale = _append_version(
            client,
            document_id,
            expected_revision=1,
            filename="stale.dwg",
            content=b"must-not-be-written",
        )
        detail = client.get(f"/api/projects/P-001/documents/{document_id}")

    assert appended.status_code == 201
    assert appended.json()["version_number"] == 2
    assert appended.json()["notes"] == "设计复核后更新"
    assert stale.status_code == 409
    assert stale.json() == {
        "detail": "Resource was modified",
        "error_code": "REVISION_CONFLICT",
        "field_errors": {},
        "current_revision": 2,
    }
    assert detail.json()["revision"] == 2
    assert [version["version_number"] for version in detail.json()["versions"]] == [
        1,
        2,
    ]
    document_dir = (
        harness.settings.data_dir
        / "Projects"
        / "P-001"
        / "mechanical_design"
        / str(document_id)
    )
    assert len(list(document_dir.iterdir())) == 2


def test_archive_keeps_files_and_blocks_editing_or_new_versions(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        created = _create_document(client)
        document_id = created.json()["id"]
        archived = client.post(
            f"/api/projects/P-001/documents/{document_id}/archive",
            headers={"Idempotency-Key": _idempotency_key()},
            json={"reason": "已经交付", "expected_revision": 1},
        )
        edited = client.put(
            f"/api/projects/P-001/documents/{document_id}",
            json={"title": "不应修改", "notes": None, "expected_revision": 2},
        )
        appended = _append_version(client, document_id, expected_revision=2)

    assert archived.status_code == 200
    assert archived.json()["archived_at"] == NOW.isoformat()
    assert archived.json()["revision"] == 2
    for response in (edited, appended):
        assert response.status_code == 409
        assert response.json()["error_code"] == "DOCUMENT_ARCHIVED"
    assert [path.read_bytes() for path in harness.settings.data_dir.rglob("*.dwg")] == [
        b"version-one"
    ]


def test_rejects_invalid_category_missing_or_archived_project_and_cross_project(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        invalid_category = _create_document(client, category="not-a-category")
        invalid_filter = client.get(
            "/api/projects/P-001/documents?category=not-a-category"
        )
        missing_project = _create_document(client, project_code="P-MISSING")
        archived_project = _create_document(client, project_code="P-ARCHIVED")
        created = _create_document(client)
        document_id = created.json()["id"]
        cross_project = client.get(
            f"/api/projects/P-002/documents/{document_id}"
        )

    assert invalid_category.status_code == 422
    assert invalid_category.json()["error_code"] == "INVALID_DOCUMENT_CATEGORY"
    assert invalid_filter.status_code == 422
    assert missing_project.status_code == 404
    assert missing_project.json()["error_code"] == "PROJECT_NOT_FOUND"
    assert archived_project.status_code == 409
    assert archived_project.json()["error_code"] == "PROJECT_ARCHIVED"
    assert cross_project.status_code == 404
    assert cross_project.json()["error_code"] == "DOCUMENT_NOT_FOUND"


def test_document_pagination_rejects_offset_outside_sqlite_range(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        response = client.get(
            "/api/projects/P-001/documents"
            "?page=9223372036854775807&page_size=200"
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_DOCUMENT_PAYLOAD"
    assert response.json()["field_errors"] == {"page": ["is out of range"]}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/projects/P-001/documents/not-an-id"),
        ("post", "/api/projects/P-001/documents/not-an-id/versions"),
        ("post", "/api/projects/P-001/documents/not-an-id/archive"),
        ("get", "/api/projects/P-001/documents/1/versions/not-an-id/download"),
    ],
)
def test_document_identifier_paths_use_structured_validation(
    tmp_path: Path,
    method: str,
    path: str,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        if method == "get":
            response = client.get(path)
        elif path.endswith("/archive"):
            response = client.post(
                path,
                headers={"Idempotency-Key": _idempotency_key()},
                json={"reason": "归档", "expected_revision": 1},
            )
        else:
            response = client.post(
                path,
                headers={"Idempotency-Key": _idempotency_key()},
                data={"expected_revision": "1"},
                files={"file": ("drawing.dwg", b"drawing", "application/acad")},
            )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_DOCUMENT_PAYLOAD"
    assert response.json()["field_errors"]


def test_document_upload_rejects_malformed_multipart_with_structured_error(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        response = client.post(
            "/api/projects/P-001/documents",
            headers={
                "Idempotency-Key": _idempotency_key(),
                "Content-Type": "multipart/form-data; boundary=broken",
            },
            content=b"--broken\r\ninvalid",
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_DOCUMENT_PAYLOAD"


def test_document_upload_rejects_file_above_configured_limit_and_closes_upload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    original_close = UploadFile.close
    closed_uploads: list[UploadFile] = []

    async def tracked_close(upload: UploadFile) -> None:
        closed_uploads.append(upload)
        await original_close(upload)

    monkeypatch.setattr(UploadFile, "close", tracked_close)

    with harness.client() as client:
        response = _create_document(client, content=b"x" * (1024 * 1024 + 1))

    assert response.status_code == 413, response.text
    assert response.json()["error_code"] == "DOCUMENT_FILE_TOO_LARGE"
    assert closed_uploads
    assert all(upload.file.closed for upload in closed_uploads)
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_document_upload_stops_chunked_body_before_parser_can_spool_without_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path, max_document_upload_mb=1)
    boundary = "sunyu-boundary"
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="category"\r\n\r\n'
        "mechanical_design\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="title"\r\n\r\n'
        "机械总图\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="large.dwg"\r\n'
        "Content-Type: application/acad\r\n\r\n"
    ).encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    created_spools: list[object] = []
    stage_calls = 0
    original_spooled_file = formparsers.SpooledTemporaryFile
    original_stage_upload = documents_module._stage_upload

    def tracked_spooled_file(*args: object, **kwargs: object):
        spool = original_spooled_file(*args, **kwargs)
        created_spools.append(spool)
        return spool

    def tracked_stage_upload(*args: object, **kwargs: object):
        nonlocal stage_calls
        stage_calls += 1
        return original_stage_upload(*args, **kwargs)

    def chunks():
        yield prefix
        for _ in range(6):
            yield b"x" * (512 * 1024)
        yield suffix

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", tracked_spooled_file)
    monkeypatch.setattr(documents_module, "_stage_upload", tracked_stage_upload)

    with harness.client() as client:
        response = client.post(
            "/api/projects/P-001/documents",
            headers={
                "Idempotency-Key": _idempotency_key(),
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            content=chunks(),
        )

    assert response.status_code == 413, response.text
    assert response.json()["error_code"] == "DOCUMENT_FILE_TOO_LARGE"
    assert stage_calls == 0
    assert created_spools == []


def test_document_file_staging_finishes_before_write_transaction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path)
    original_stage = files.stage_version
    original_publish = files.publish_staged_version
    original_transaction = documents_module.transaction_immediate
    transaction_active = False

    def tracked_stage(*args: object, **kwargs: object):
        assert not transaction_active
        return original_stage(*args, **kwargs)

    def tracked_publish(*args: object, **kwargs: object):
        assert transaction_active
        return original_publish(*args, **kwargs)

    @contextmanager
    def tracked_transaction(connection: sqlite3.Connection):
        nonlocal transaction_active
        with original_transaction(connection):
            transaction_active = True
            try:
                yield connection
            finally:
                transaction_active = False

    monkeypatch.setattr(files, "stage_version", tracked_stage)
    monkeypatch.setattr(files, "publish_staged_version", tracked_publish)
    monkeypatch.setattr(documents_module, "transaction_immediate", tracked_transaction)

    with harness.client() as client:
        response = _create_document(client, content=b"large-cad-content")

    assert response.status_code == 201


def test_create_recovers_uncommitted_file_and_reservation_after_crash(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    orphan_source = tmp_path / "orphan.dwg"
    orphan_source.write_bytes(b"orphan")
    orphan = files.store_version(
        orphan_source,
        harness.settings.data_dir,
        "P-001",
        "mechanical_design",
        document_id=1,
    )
    reservation = orphan.path.parent / ".version-000000000002.reserve"
    reservation.write_bytes(b"crash-reservation")

    with harness.client() as client:
        created = _create_document(client, content=b"committed")

    assert created.status_code == 201
    assert created.json()["versions"][0]["version_number"] == 1
    stored_files = [
        path
        for path in orphan.path.parent.iterdir()
        if not path.name.startswith(".")
    ]
    assert len(stored_files) == 1
    assert stored_files[0].read_bytes() == b"committed"
    assert not reservation.exists()


def test_append_recovers_uncommitted_next_version_after_crash(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        created = _create_document(client, content=b"version-one")

    document_id = created.json()["id"]
    orphan_source = tmp_path / "orphan-v2.dwg"
    orphan_source.write_bytes(b"orphan-version-two")
    files.store_version(
        orphan_source,
        harness.settings.data_dir,
        "P-001",
        "mechanical_design",
        document_id=document_id,
    )

    with harness.client() as client:
        appended = _append_version(
            client,
            document_id,
            content=b"committed-version-two",
        )

    assert appended.status_code == 201
    assert appended.json()["version_number"] == 2
    stored_contents = sorted(
        path.read_bytes()
        for path in (
            harness.settings.data_dir
            / "Projects"
            / "P-001"
            / "mechanical_design"
            / str(document_id)
        ).iterdir()
        if not path.name.startswith(".")
    )
    assert stored_contents == sorted([b"version-one", b"committed-version-two"])


def test_download_returns_original_content_and_safe_unicode_filename(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    content = b"contract-pdf-content"

    with harness.client() as client:
        created = _create_document(
            client,
            category="contract",
            title="设备采购合同",
            filename="设备采购合同（终版）.pdf",
            content=content,
            content_type="application/pdf",
        )
        document_id = created.json()["id"]
        version_id = created.json()["versions"][0]["id"]
        downloaded = client.get(
            f"/api/projects/P-001/documents/{document_id}"
            f"/versions/{version_id}/download"
        )
        cross_project = client.get(
            f"/api/projects/P-002/documents/{document_id}"
            f"/versions/{version_id}/download"
        )

    assert downloaded.status_code == 200
    assert downloaded.content == content
    assert downloaded.headers["content-type"] == "application/pdf"
    disposition = downloaded.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert "filename*=UTF-8''" in disposition
    assert "%E8%AE%BE%E5%A4%87" in disposition
    assert "\r" not in disposition and "\n" not in disposition
    assert cross_project.status_code == 404


def test_download_rejects_database_path_traversal_without_reading_outside_data(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    outside = tmp_path / "outside-secret.txt"
    outside.write_bytes(b"must-not-leak")

    with harness.client() as client:
        created = _create_document(client)
        document_id = created.json()["id"]
        version_id = created.json()["versions"][0]["id"]
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                """
                UPDATE document_versions
                SET stored_relative_path = '../outside-secret.txt', size_bytes = ?
                WHERE id = ?
                """,
                (outside.stat().st_size, version_id),
            )
        finally:
            connection.close()
        response = client.get(
            f"/api/projects/P-001/documents/{document_id}"
            f"/versions/{version_id}/download"
        )

    assert response.status_code == 404
    assert response.json()["error_code"] == "DOCUMENT_FILE_NOT_FOUND"
    assert b"must-not-leak" not in response.content


def test_database_failure_after_file_publish_removes_orphan_file(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_document_version_insert
            BEFORE INSERT ON document_versions
            BEGIN
                SELECT RAISE(ABORT, 'injected document version failure');
            END
            """
        )
    finally:
        connection.close()

    with harness.client() as client:
        failed = _create_document(client, content=b"must-be-cleaned")

    assert failed.status_code == 500
    assert failed.json()["error_code"] == "DOCUMENT_OPERATION_FAILED"
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
        assert (
            connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0]
            == 0
        )
    finally:
        connection.close()
    projects_dir = harness.settings.data_dir / "Projects"
    assert not projects_dir.exists() or [
        path for path in projects_dir.rglob("*") if path.is_file()
    ] == []


def test_create_is_idempotent_for_same_key_and_payload(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    key = _idempotency_key()

    with harness.client() as client:
        first = _create_document(client, idempotency_key=key)
        replay = _create_document(client, idempotency_key=key)

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json() == first.json()
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert (
            connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0]
            == 1
        )
    finally:
        connection.close()


def test_create_idempotency_uses_canonical_project_identity(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    key = _idempotency_key()

    with harness.client() as client:
        first = _create_document(client, project_code="P-001", idempotency_key=key)
        replay = _create_document(client, project_code="p-001", idempotency_key=key)

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json() == first.json()
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert (
            connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0]
            == 1
        )
    finally:
        connection.close()


def test_main_application_mounts_all_document_routes() -> None:
    from backend.app.main import create_app

    paths = create_app().openapi()["paths"]

    assert {
        "/api/projects/{project_code}/documents",
        "/api/projects/{project_code}/documents/{document_id}",
        "/api/projects/{project_code}/documents/{document_id}/versions",
        (
            "/api/projects/{project_code}/documents/{document_id}"
            "/versions/{version_id}/download"
        ),
        "/api/projects/{project_code}/documents/{document_id}/archive",
    } <= paths.keys()
