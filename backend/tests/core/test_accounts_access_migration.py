from pathlib import Path

from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations


def test_accounts_migration_adds_no_implicit_identity_and_preserves_legacy_rows(
    tmp_path: Path,
):
    source = Path(__file__).resolve().parents[2] / "migrations"
    legacy = tmp_path / "v025"
    legacy.mkdir()
    for path in sorted(source.glob("*.sql")):
        if path.name[:3] <= "025":
            (legacy / path.name).write_bytes(path.read_bytes())
    config = tmp_path / "config.json"
    config.write_bytes(b'{"test":"synthetic-config-preserved"}')
    connection = connect_database(tmp_path / "legacy.sqlite3")
    try:
        apply_migrations(connection, legacy)
        connection.execute(
            "INSERT INTO auth_secret VALUES (1, 'synthetic-old-hash', '2026-10-31')"
        )
        old_tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
            )
        ]
        before = {
            name: [tuple(row) for row in connection.execute(f'SELECT * FROM "{name}"')]
            for name in old_tables
        }
        upgrade = tmp_path / "v026"
        upgrade.mkdir()
        for path in sorted(source.glob("*.sql")):
            if path.name[:3] <= "026":
                (upgrade / path.name).write_bytes(path.read_bytes())
        applied = apply_migrations(connection, upgrade)
        assert "026_accounts_access" in applied
        assert connection.execute("SELECT count(*) FROM accounts").fetchone()[0] == 0
        assert before == {
            name: [tuple(row) for row in connection.execute(f'SELECT * FROM "{name}"')]
            for name in old_tables
        }
        assert config.read_bytes() == b'{"test":"synthetic-config-preserved"}'
    finally:
        connection.close()
