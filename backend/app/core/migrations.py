from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

_TRANSACTION_KEYWORDS = frozenset(
    {"BEGIN", "COMMIT", "END", "RELEASE", "ROLLBACK", "SAVEPOINT"}
)
_UTF8_BOM = "\ufeff"


class MigrationError(RuntimeError):
    """Raised when migration discovery or application cannot safely continue."""


def apply_migrations(
    connection: sqlite3.Connection,
    migrations_dir: str | Path,
) -> list[str]:
    if connection.in_transaction:
        raise MigrationError("cannot run migrations inside an active transaction")

    migrations = _discover_migrations(Path(migrations_dir))
    versions = {path.stem for path in migrations}
    applied_versions = _read_applied_versions(connection)
    missing_versions = sorted(applied_versions - versions)
    if missing_versions:
        missing = ", ".join(missing_versions)
        raise MigrationError(f"migration drift: applied versions are missing: {missing}")
    ordered_versions = [path.stem for path in migrations]
    expected_prefix = set(ordered_versions[: len(applied_versions)])
    if applied_versions != expected_prefix:
        raise MigrationError(
            "migration drift: applied versions are not a continuous filename prefix"
        )

    applied_now: list[str] = []
    for migration_path in migrations:
        version = migration_path.stem
        if version in applied_versions:
            continue
        statements = _read_statements(migration_path)
        if _apply_one(connection, version, statements):
            applied_now.append(version)

    return applied_now


def _discover_migrations(migrations_dir: Path) -> list[Path]:
    if not migrations_dir.is_dir():
        raise MigrationError(f"migration directory does not exist: {migrations_dir}")

    migrations = sorted(
        (
            path
            for path in migrations_dir.iterdir()
            if path.is_file() and path.suffix.casefold() == ".sql"
        ),
        key=lambda path: path.name,
    )
    if not migrations:
        raise MigrationError(f"no SQL migrations found in: {migrations_dir}")

    normalized_versions: dict[str, str] = {}
    for migration in migrations:
        version = migration.stem
        normalized = version.casefold()
        previous = normalized_versions.get(normalized)
        if previous is not None:
            raise MigrationError(
                f"duplicate migration version: {previous} and {version}"
            )
        normalized_versions[normalized] = version
    return migrations


def _read_applied_versions(connection: sqlite3.Connection) -> set[str]:
    if not _ledger_exists(connection):
        return set()
    try:
        rows = connection.execute("SELECT version FROM schema_migrations").fetchall()
    except sqlite3.Error as exc:
        raise MigrationError(f"cannot read schema_migrations: {exc}") from exc
    return {row[0] for row in rows}


def _ledger_exists(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'schema_migrations'
        """
    ).fetchone()
    return row is not None


def _read_statements(migration_path: Path) -> list[str]:
    try:
        script = migration_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise MigrationError(f"cannot read migration {migration_path.name}: {exc}") from exc

    statements: list[str] = []
    buffer: list[str] = []
    for character in script:
        buffer.append(character)
        if character != ";":
            continue
        candidate = "".join(buffer)
        if sqlite3.complete_statement(candidate):
            if not _is_only_comments_and_whitespace(candidate):
                statements.append(candidate)
            buffer.clear()

    remainder = "".join(buffer)
    if not _is_only_comments_and_whitespace(remainder):
        raise MigrationError(f"incomplete SQL in migration {migration_path.name}")
    if not statements:
        raise MigrationError(
            f"migration {migration_path.name} contains no complete SQL statements"
        )
    for statement in statements:
        keyword = _leading_keyword(statement)
        if keyword in _TRANSACTION_KEYWORDS:
            raise MigrationError(
                f"transaction control is not allowed in migration "
                f"{migration_path.name}: {keyword}"
            )
    if _UTF8_BOM in script[1:]:
        raise MigrationError(
            f"BOM is only allowed at script start: {migration_path.name}"
        )
    return statements


def _is_only_comments_and_whitespace(sql: str) -> bool:
    index = 0
    length = len(sql)
    while index < length:
        if sql[index].isspace():
            index += 1
            continue
        if sql.startswith("--", index):
            newline = sql.find("\n", index + 2)
            if newline == -1:
                return True
            index = newline + 1
            continue
        if sql.startswith("/*", index):
            comment_end = sql.find("*/", index + 2)
            if comment_end == -1:
                return False
            index = comment_end + 2
            continue
        return False
    return True


def _leading_keyword(sql: str) -> str:
    index = 0
    length = len(sql)
    skipped_bom = False
    while index < length:
        if sql[index].isspace():
            index += 1
            continue
        if sql[index] == _UTF8_BOM and not skipped_bom:
            skipped_bom = True
            index += 1
            continue
        if sql.startswith("--", index):
            newline = sql.find("\n", index + 2)
            if newline == -1:
                return ""
            index = newline + 1
            continue
        if sql.startswith("/*", index):
            comment_end = sql.find("*/", index + 2)
            if comment_end == -1:
                return ""
            index = comment_end + 2
            continue
        break

    keyword_start = index
    while index < length and sql[index].isalpha():
        index += 1
    return sql[keyword_start:index].upper()


def _apply_one(
    connection: sqlite3.Connection,
    version: str,
    statements: list[str],
) -> bool:
    try:
        connection.execute("BEGIN IMMEDIATE")
    except BaseException as exc:
        if connection.in_transaction:
            _raise_after_rollback(connection, version, exc)
        if isinstance(exc, sqlite3.Error):
            raise MigrationError(
                f"migration {version} could not start BEGIN IMMEDIATE: {exc}"
            ) from exc
        raise

    try:
        if version in _read_applied_versions(connection):
            connection.commit()
            return False
        for statement in statements:
            connection.execute(statement)
        if not _ledger_exists(connection):
            raise MigrationError(
                f"migration {version} did not create schema_migrations"
            )
        connection.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
            (version, datetime.now(timezone.utc).isoformat()),
        )
        connection.commit()
        return True
    except BaseException as exc:  # noqa: BLE001 - rollback before re-raising signals
        _raise_after_rollback(connection, version, exc)


def _raise_after_rollback(
    connection: sqlite3.Connection,
    version: str,
    failure: BaseException,
) -> NoReturn:
    try:
        connection.rollback()
    except Exception as rollback_failure:  # noqa: BLE001 - report adapter failures
        if isinstance(failure, Exception):
            raise MigrationError(
                f"migration {version} failed: {failure}; "
                f"rollback failed: {rollback_failure}"
            ) from failure
        failure.add_note(f"rollback failed: {rollback_failure}")
        raise failure

    if isinstance(failure, MigrationError):
        raise failure
    if isinstance(failure, sqlite3.Error):
        raise MigrationError(f"migration {version} failed: {failure}") from failure
    raise failure
