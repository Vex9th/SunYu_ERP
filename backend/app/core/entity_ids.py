from __future__ import annotations

import sqlite3

_ENTITY_TABLES = frozenset({"procurement_lines", "purchase_order_lines"})
_SQLITE_MAX_INTEGER = 2**63 - 1


def next_entity_id(connection: sqlite3.Connection, table_name: str) -> int:
    """在业务写事务内保留不会复用的 ID；失败时随业务一起回滚。"""
    if table_name not in _ENTITY_TABLES:
        raise ValueError("unsupported entity ID table")
    if not connection.in_transaction:
        raise RuntimeError("entity ID allocation requires a business transaction")
    # 同时检查当前表，兼容迁移后通过维护脚本或旧测试直接插入的记录。
    row = connection.execute(
        f"""UPDATE entity_id_sequences
        SET last_id = MAX(last_id, COALESCE((SELECT MAX(id) FROM {table_name}), 0)) + 1
        WHERE table_name = ?
          AND MAX(last_id, COALESCE((SELECT MAX(id) FROM {table_name}), 0)) < ?
        RETURNING last_id""",
        (table_name, _SQLITE_MAX_INTEGER),
    ).fetchone()
    if row is None:
        if connection.execute(
            "SELECT 1 FROM entity_id_sequences WHERE table_name = ?", (table_name,)
        ).fetchone() is None:
            raise sqlite3.DatabaseError("entity ID sequence is missing")
        raise OverflowError("entity ID range exhausted")
    return int(row[0])
