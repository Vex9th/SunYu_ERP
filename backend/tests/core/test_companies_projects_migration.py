from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from backend.app.core.database import connect_database
from backend.app.core.migrations import MigrationError, apply_migrations
from backend.app.core.storage_paths import project_code_identity


def _migrations_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations"


def test_unicode_project_identity_migration_exists() -> None:
    assert (_migrations_dir() / "004_project_code_identity.sql").is_file()


@pytest.fixture
def business_schema(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert apply_migrations(connection, _migrations_dir()) == [
            "001_foundation",
            "002_documents",
            "003_companies_projects",
            "004_project_code_identity",
        ]
        yield connection
    finally:
        connection.close()


def _insert_company(
    connection: sqlite3.Connection,
    *,
    company_id: int = 1,
    name: str = "示例公司",
) -> None:
    connection.execute(
        """
        INSERT INTO companies (id, name, created_at, updated_at)
        VALUES (?, ?, '2026-08-28T00:00:00+00:00', '2026-08-28T00:00:00+00:00')
        """,
        (company_id, name),
    )


def _copy_migration(staged_dir: Path, filename: str) -> None:
    staged_dir.mkdir(exist_ok=True)
    (staged_dir / filename).write_text(
        (_migrations_dir() / filename).read_text(encoding="utf-8"),
        encoding="utf-8",
    )


def _insert_project(
    connection: sqlite3.Connection,
    *,
    project_id: int = 1,
    company_id: int = 1,
    project_code: str = "PRJ-001",
    status: str = "active",
) -> None:
    archived_at = "2026-08-28T00:00:00+00:00" if status == "archived" else None
    try:
        project_code_key = project_code_identity(project_code)
    except (TypeError, ValueError):
        project_code_key = f"invalid-test-key-{project_id}"
    connection.execute(
        """
        INSERT INTO projects
            (id, project_code, project_code_key, company_id, name,
             status, archived_at,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, '示例项目', ?, ?,
                '2026-08-28T00:00:00+00:00', '2026-08-28T00:00:00+00:00')
        """,
        (
            project_id,
            project_code,
            project_code_key,
            company_id,
            status,
            archived_at,
        ),
    )


def test_business_migration_creates_exact_columns(
    business_schema: sqlite3.Connection,
) -> None:
    assert {
        row["name"]
        for row in business_schema.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    } >= {"companies", "contacts", "projects"}

    expected_columns = {
        "companies": [
            ("id", "INTEGER", 0, None, 1),
            ("name", "TEXT", 1, None, 0),
            ("taxpayer_id", "TEXT", 0, None, 0),
            ("registered_address", "TEXT", 0, None, 0),
            ("registered_phone", "TEXT", 0, None, 0),
            ("bank_name", "TEXT", 0, None, 0),
            ("bank_account", "TEXT", 0, None, 0),
            ("notes", "TEXT", 0, None, 0),
            ("created_at", "TEXT", 1, None, 0),
            ("updated_at", "TEXT", 1, None, 0),
        ],
        "contacts": [
            ("id", "INTEGER", 0, None, 1),
            ("company_id", "INTEGER", 1, None, 0),
            ("name", "TEXT", 1, None, 0),
            ("phone", "TEXT", 0, None, 0),
            ("email", "TEXT", 0, None, 0),
            ("position", "TEXT", 0, None, 0),
            ("notes", "TEXT", 0, None, 0),
            ("created_at", "TEXT", 1, None, 0),
            ("updated_at", "TEXT", 1, None, 0),
        ],
        "projects": [
            ("id", "INTEGER", 0, None, 1),
            ("project_code", "TEXT", 1, None, 0),
            ("project_code_key", "TEXT", 1, None, 0),
            ("company_id", "INTEGER", 1, None, 0),
            ("name", "TEXT", 1, None, 0),
            ("description", "TEXT", 0, None, 0),
            ("status", "TEXT", 1, "'active'", 0),
            ("archive_reason", "TEXT", 0, None, 0),
            ("archived_at", "TEXT", 0, None, 0),
            ("created_at", "TEXT", 1, None, 0),
            ("updated_at", "TEXT", 1, None, 0),
        ],
    }
    for table, expected in expected_columns.items():
        actual = [
            (
                row["name"],
                row["type"],
                row["notnull"],
                row["dflt_value"],
                row["pk"],
            )
            for row in business_schema.execute(f"PRAGMA table_info('{table}')")
        ]
        assert actual == expected


def test_business_migration_creates_required_indexes(
    business_schema: sqlite3.Connection,
) -> None:
    expected_indexes = {
        "idx_contacts_company": [("company_id", 0), ("id", 0)],
        "idx_projects_project_code_key": [("project_code_key", 0)],
        "idx_projects_company": [("company_id", 0), ("id", 0)],
        "idx_projects_status_created": [
            ("status", 0),
            ("created_at", 1),
            ("id", 1),
        ],
    }
    for index_name, expected in expected_indexes.items():
        assert business_schema.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
            (index_name,),
        ).fetchone()
        actual = [
            (row["name"], row["desc"])
            for row in business_schema.execute(f"PRAGMA index_xinfo('{index_name}')")
            if row["key"]
        ]
        assert actual == expected

    identity_index = business_schema.execute("PRAGMA index_list('projects')").fetchall()
    assert (
        next(
            row
            for row in identity_index
            if row["name"] == "idx_projects_project_code_key"
        )["unique"]
        == 1
    )


def test_business_migration_configures_foreign_key_delete_actions(
    business_schema: sqlite3.Connection,
) -> None:
    assert [
        (row["table"], row["from"], row["to"], row["on_delete"])
        for row in business_schema.execute("PRAGMA foreign_key_list('contacts')")
    ] == [("companies", "company_id", "id", "CASCADE")]
    assert [
        (row["table"], row["from"], row["to"], row["on_delete"])
        for row in business_schema.execute("PRAGMA foreign_key_list('projects')")
    ] == [("companies", "company_id", "id", "RESTRICT")]


def test_business_migration_upgrades_existing_documents_without_rewriting_them(
    tmp_path: Path,
) -> None:
    staged_migrations = tmp_path / "migrations"
    staged_migrations.mkdir()
    for filename in ("001_foundation.sql", "002_documents.sql"):
        (staged_migrations / filename).write_text(
            (_migrations_dir() / filename).read_text(encoding="utf-8"),
            encoding="utf-8",
        )

    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert apply_migrations(connection, staged_migrations) == [
            "001_foundation",
            "002_documents",
        ]
        document = (
            7,
            "LEGACY-ORPHAN",
            "图纸",
            "电气图",
            "2026-08-28T00:00:00+00:00",
        )
        version = (
            9,
            7,
            1,
            "legacy.dwg",
            "Projects/LEGACY-ORPHAN/图纸/legacy.dwg",
            123,
            "a" * 64,
            "2026-08-28T00:00:00+00:00",
        )
        connection.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", document)
        connection.execute(
            "INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            version,
        )
        connection.commit()

        filename = "003_companies_projects.sql"
        (staged_migrations / filename).write_text(
            (_migrations_dir() / filename).read_text(encoding="utf-8"),
            encoding="utf-8",
        )

        assert apply_migrations(connection, staged_migrations) == [
            "003_companies_projects"
        ]
        assert (
            tuple(connection.execute("SELECT * FROM documents").fetchone()) == document
        )
        assert (
            tuple(connection.execute("SELECT * FROM document_versions").fetchone())
            == version
        )
        assert connection.execute("PRAGMA foreign_key_list(documents)").fetchall() == []
        assert (
            connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'trigger' AND tbl_name = 'documents'
                """
            ).fetchall()
            == []
        )

        connection.execute(
            """
            INSERT INTO documents
                (project_code, category, logical_name, created_at)
            VALUES ('NEW-ORPHAN', '合同', '未注册项目合同', '2026-08-28T01:00:00+00:00')
            """
        )
    finally:
        connection.close()


def test_unicode_identity_migration_backfills_and_preserves_existing_state(
    tmp_path: Path,
) -> None:
    staged_migrations = tmp_path / "migrations"
    for filename in (
        "001_foundation.sql",
        "002_documents.sql",
        "003_companies_projects.sql",
    ):
        _copy_migration(staged_migrations, filename)

    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        assert apply_migrations(connection, staged_migrations) == [
            "001_foundation",
            "002_documents",
            "003_companies_projects",
        ]
        _insert_company(connection, company_id=7, name="迁移公司")
        original_project = (
            11,
            "PRJ-Ä",
            7,
            "迁移项目",
            "保留描述",
            "archived",
            "保留原因",
            "2026-08-28T03:00:00+00:00",
            "2026-08-28T01:00:00+00:00",
            "2026-08-28T03:00:00+00:00",
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, company_id, name, description, status,
                 archive_reason, archived_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            original_project,
        )
        original_document = (
            19,
            "ORPHAN-004",
            "合同",
            "孤立合同",
            "2026-08-28T02:00:00+00:00",
        )
        connection.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?)",
            original_document,
        )

        _copy_migration(staged_migrations, "004_project_code_identity.sql")
        assert apply_migrations(connection, staged_migrations) == [
            "004_project_code_identity"
        ]

        migrated = connection.execute(
            """
            SELECT id, project_code, project_code_key, company_id, name,
                   description, status, archive_reason, archived_at,
                   created_at, updated_at
            FROM projects
            """
        ).fetchone()
        assert tuple(migrated) == (
            original_project[0],
            original_project[1],
            project_code_identity(original_project[1]),
            *original_project[2:],
        )
        assert tuple(connection.execute("SELECT * FROM documents").fetchone()) == (
            original_document
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert (
            connection.execute("PRAGMA foreign_key_list('projects')").fetchall()[0][
                "on_delete"
            ]
            == "RESTRICT"
        )
        index = next(
            row
            for row in connection.execute("PRAGMA index_list('projects')")
            if row["name"] == "idx_projects_project_code_key"
        )
        assert index["unique"] == 1
        assert [
            (row["name"], row["coll"])
            for row in connection.execute(
                "PRAGMA index_xinfo('idx_projects_project_code_key')"
            )
            if row["key"]
        ] == [("project_code_key", "BINARY")]
        schema_sql = " ".join(
            row["sql"] or ""
            for row in connection.execute(
                "SELECT sql FROM sqlite_master WHERE tbl_name = 'projects'"
            )
        )
        assert "project_code_identity" not in schema_sql
        with pytest.raises(sqlite3.OperationalError):
            connection.execute("SELECT project_code_identity('PRJ-001')")
    finally:
        connection.close()

    raw = sqlite3.connect(database_path)
    try:
        assert raw.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        raw.execute(
            """
            INSERT INTO documents
                (project_code, category, logical_name, created_at)
            VALUES ('POST-004-ORPHAN', '图纸', '孤立图纸', 'now')
            """
        )
        raw.commit()
    finally:
        raw.close()


def test_unicode_identity_collision_rolls_back_schema_data_and_ledger(
    tmp_path: Path,
) -> None:
    staged_migrations = tmp_path / "migrations"
    for filename in (
        "001_foundation.sql",
        "002_documents.sql",
        "003_companies_projects.sql",
    ):
        _copy_migration(staged_migrations, filename)

    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert len(apply_migrations(connection, staged_migrations)) == 3
        _insert_company(connection)
        for project_id, project_code in ((1, "PRJ-Ä"), (2, "prj-ä")):
            connection.execute(
                """
                INSERT INTO projects
                    (id, project_code, company_id, name, created_at, updated_at)
                VALUES (?, ?, 1, ?, 'created', 'updated')
                """,
                (project_id, project_code, f"项目 {project_id}"),
            )
        before_rows = [
            tuple(row)
            for row in connection.execute("SELECT * FROM projects ORDER BY id")
        ]
        before_schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'"
        ).fetchone()[0]

        _copy_migration(staged_migrations, "004_project_code_identity.sql")
        with pytest.raises(
            MigrationError,
            match="Unicode project code identity collision",
        ) as raised:
            apply_migrations(connection, staged_migrations)

        assert isinstance(raised.value.__cause__, sqlite3.IntegrityError)
        assert (
            raised.value.__cause__.sqlite_errorcode
            == sqlite3.SQLITE_CONSTRAINT_UNIQUE
        )
        assert "projects_with_identity" not in str(raised.value)
        assert not connection.in_transaction
        assert [
            row["version"]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ] == [
            "001_foundation",
            "002_documents",
            "003_companies_projects",
        ]
        assert (
            connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'"
            ).fetchone()[0]
            == before_schema
        )
        assert "project_code_key" not in {
            row["name"] for row in connection.execute("PRAGMA table_info('projects')")
        }
        assert [
            tuple(row)
            for row in connection.execute("SELECT * FROM projects ORDER BY id")
        ] == before_rows
        assert (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'projects_with_identity'"
            ).fetchone()
            is None
        )
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        with pytest.raises(sqlite3.OperationalError):
            connection.execute("SELECT project_code_identity('PRJ-001')")
    finally:
        connection.close()


def test_company_name_is_case_insensitively_unique(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema, name="Acme")

    with pytest.raises(sqlite3.IntegrityError):
        _insert_company(business_schema, company_id=2, name="ACME")


@pytest.mark.parametrize(
    ("columns", "values"),
    [
        ("name", ("",)),
        ("name", (" 示例公司",)),
        ("taxpayer_id", (" ",)),
        ("taxpayer_id", (" TAX-1 ",)),
        ("registered_address", (" ",)),
        ("registered_address", (" 地址 ",)),
        ("registered_phone", (" ",)),
        ("registered_phone", (" 123 ",)),
        ("bank_name", (" ",)),
        ("bank_name", (" 银行 ",)),
        ("bank_account", (" ",)),
        ("bank_account", (" 001 ",)),
        ("notes", ("   ",)),
        ("name", ("\t示例公司",)),
        ("name", ("示例公司\r",)),
        ("taxpayer_id", ("\nTAX-1",)),
        ("registered_address", ("地址\r",)),
        ("registered_phone", ("\t123",)),
        ("bank_name", ("银行\n",)),
        ("bank_account", ("001\t",)),
        ("notes", ("\t\r\n",)),
    ],
)
def test_company_rejects_untrimmed_or_empty_values(
    business_schema: sqlite3.Connection,
    columns: str,
    values: tuple[str],
) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        if columns == "name":
            business_schema.execute(
                """
                INSERT INTO companies (name, created_at, updated_at)
                VALUES (?, 'now', 'now')
                """,
                values,
            )
        else:
            business_schema.execute(
                f"""
                INSERT INTO companies
                    (name, {columns}, created_at, updated_at)
                VALUES ('示例公司', ?, 'now', 'now')
                """,
                values,
            )


def test_company_notes_may_retain_surrounding_whitespace(
    business_schema: sqlite3.Connection,
) -> None:
    business_schema.execute(
        """
        INSERT INTO companies (name, notes, created_at, updated_at)
        VALUES ('示例公司', '\t 有效备注 \r', 'now', 'now')
        """
    )


def test_contacts_allow_duplicate_names_within_company(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    for contact_id in (1, 2):
        business_schema.execute(
            """
            INSERT INTO contacts
                (id, company_id, name, created_at, updated_at)
            VALUES (?, 1, '同名联系人', 'now', 'now')
            """,
            (contact_id,),
        )

    assert business_schema.execute("SELECT COUNT(*) FROM contacts").fetchone()[0] == 2


def test_contacts_are_deleted_with_company(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    business_schema.execute(
        """
        INSERT INTO contacts (company_id, name, created_at, updated_at)
        VALUES (1, '联系人', 'now', 'now')
        """
    )

    business_schema.execute("DELETE FROM companies WHERE id = 1")

    assert business_schema.execute("SELECT COUNT(*) FROM contacts").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("name", ""),
        ("name", " 联系人 "),
        ("phone", " "),
        ("phone", " 123 "),
        ("email", " "),
        ("email", " a@example.com "),
        ("position", " "),
        ("position", " 经理 "),
        ("notes", "   "),
        ("name", "\t联系人"),
        ("phone", "123\r"),
        ("email", "\na@example.com"),
        ("position", "经理\t"),
        ("notes", "\t\r\n"),
    ],
)
def test_contact_rejects_untrimmed_or_empty_values(
    business_schema: sqlite3.Connection,
    column: str,
    value: str,
) -> None:
    _insert_company(business_schema)
    with pytest.raises(sqlite3.IntegrityError):
        if column == "name":
            business_schema.execute(
                """
                INSERT INTO contacts
                    (company_id, name, created_at, updated_at)
                VALUES (1, ?, 'now', 'now')
                """,
                (value,),
            )
        else:
            business_schema.execute(
                f"""
                INSERT INTO contacts
                    (company_id, name, {column}, created_at, updated_at)
                VALUES (1, '联系人', ?, 'now', 'now')
                """,
                (value,),
            )


def test_contact_notes_may_retain_surrounding_whitespace(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    business_schema.execute(
        """
        INSERT INTO contacts
            (company_id, name, notes, created_at, updated_at)
        VALUES (1, '联系人', '\t 有效备注 \n', 'now', 'now')
        """
    )


def test_project_code_is_case_insensitively_unique(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    _insert_project(business_schema, project_code="prj-001")

    with pytest.raises(sqlite3.IntegrityError):
        _insert_project(business_schema, project_id=2, project_code="PRJ-001")


def test_project_code_allows_120_utf8_bytes(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    _insert_project(business_schema, project_code="a" * 120)
    _insert_project(business_schema, project_id=2, project_code="项" * 40)


def test_project_code_allows_clock_device_like_name(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    _insert_project(business_schema, project_code="CLOCK$")


@pytest.mark.parametrize(
    "project_code",
    [
        "",
        " ",
        " PRJ-001",
        "PRJ-001 ",
        "\tPRJ-001",
        "PRJ-001\r",
        ".",
        "..",
        "CON",
        "CONIN$",
        "COM¹",
        "NUL",
        "CON .txt",
        "A<B",
        "A>B",
        "A:B",
        'A"B',
        "A/B",
        "A\\B",
        "A|B",
        "a?b",
        "A*B",
        "trailing.",
        "A\x00B",
        "A\tB",
        "A\nB",
        "a" * 121,
        "项" * 41,
    ],
)
def test_project_rejects_invalid_project_code(
    business_schema: sqlite3.Connection,
    project_code: str,
) -> None:
    _insert_company(business_schema)
    with pytest.raises(sqlite3.IntegrityError):
        _insert_project(business_schema, project_code=project_code)


@pytest.mark.parametrize("control", [chr(codepoint) for codepoint in range(0x7F, 0xA0)])
def test_project_rejects_c1_control_characters(
    business_schema: sqlite3.Connection,
    control: str,
) -> None:
    _insert_company(business_schema)
    with pytest.raises(sqlite3.IntegrityError):
        _insert_project(business_schema, project_code=f"A{control}B")


@pytest.mark.parametrize(
    ("columns", "values"),
    [
        ("name", ("",)),
        ("name", (" 示例项目",)),
        ("description", ("   ",)),
        ("status", ("paused",)),
        ("archive_reason", ("仅归档原因",)),
        ("archived_at", ("2026-08-28T00:00:00+00:00",)),
        ("status, archived_at", ("archived", None)),
        ("status, archived_at", ("archived", "")),
        ("status, archived_at", ("archived", " \t\r\n ")),
        ("status, archived_at", ("archived", "\tnow")),
        ("status, archived_at", ("archived", "now\n")),
        ("status, archive_reason, archived_at", ("archived", "   ", "now")),
        ("name", ("\t示例项目",)),
        ("name", ("示例项目\n",)),
        ("description", ("\t\r\n",)),
        ("status, archive_reason, archived_at", ("archived", "\r\n", "now")),
    ],
)
def test_project_rejects_invalid_text_or_archive_state(
    business_schema: sqlite3.Connection,
    columns: str,
    values: tuple[str | None, ...],
) -> None:
    _insert_company(business_schema)
    placeholders = ", ".join("?" for _ in values)
    required_columns = "project_code, project_code_key, company_id"
    required_values = "'PRJ-001', 'prj-001', 1"
    if columns != "name":
        required_columns += ", name"
        required_values += ", '示例项目'"
    with pytest.raises(sqlite3.IntegrityError):
        business_schema.execute(
            f"""
            INSERT INTO projects
                ({required_columns}, {columns}, created_at, updated_at)
            VALUES ({required_values}, {placeholders}, 'now', 'now')
            """,
            values,
        )


def test_project_defaults_to_active(business_schema: sqlite3.Connection) -> None:
    _insert_company(business_schema)
    business_schema.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description,
             created_at, updated_at)
        VALUES ('PRJ-001', 'prj-001', 1, '示例项目', ' 有效描述 ', 'now', 'now')
        """
    )
    assert (
        business_schema.execute(
            "SELECT status FROM projects WHERE project_code = 'PRJ-001'"
        ).fetchone()[0]
        == "active"
    )


def test_project_optional_text_may_retain_surrounding_whitespace(
    business_schema: sqlite3.Connection,
) -> None:
    _insert_company(business_schema)
    business_schema.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description, status,
             archive_reason, archived_at, created_at, updated_at)
        VALUES ('PRJ-001', 'prj-001', 1, '归档项目', '\t 有效描述 \n', 'archived',
                '\r 有效原因 \t', 'now', 'now', 'now')
        """
    )


@pytest.mark.parametrize("status", ["active", "archived"])
def test_company_delete_is_restricted_by_projects(
    business_schema: sqlite3.Connection,
    status: str,
) -> None:
    _insert_company(business_schema)
    _insert_project(business_schema, status=status)

    with pytest.raises(sqlite3.IntegrityError):
        business_schema.execute("DELETE FROM companies WHERE id = 1")

    assert business_schema.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 1
