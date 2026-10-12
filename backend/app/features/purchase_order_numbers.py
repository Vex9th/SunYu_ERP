from __future__ import annotations

import re
import sqlite3
import unicodedata

from pypinyin import Style, lazy_pinyin

_MAX_NAME_LENGTH = 24
_NON_ASCII_ALPHANUMERIC = re.compile(r"[^A-Za-z0-9]")


def next_purchase_order_number(
    connection: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    supplier: sqlite3.Row,
    ordered_on: str,
) -> str:
    """只读计算下一个编号；保存时必须在调用方的写事务内使用。"""
    project_part = _name_part(str(project["name"]), f"P{project['id']}")
    supplier_part = _name_part(str(supplier["name"]), f"S{supplier['id']}")
    prefix = f"PO_{project_part}_{ordered_on.replace('-', '')}_{supplier_part}_"
    # 全库按字面前缀匹配，涵盖简称重名、手动编号及 SQLite 的 NOCASE 唯一约束。
    rows = connection.execute(
        """
        SELECT order_no FROM purchase_orders
        WHERE substr(order_no, 1, ?) = ? COLLATE NOCASE
        """,
        (len(prefix), prefix),
    )
    sequence = "0"
    for row in rows:
        suffix = str(row["order_no"])[len(prefix) :]
        if suffix.isascii() and suffix.isdecimal():
            candidate = suffix.lstrip("0") or "0"
            if (len(candidate), candidate) > (len(sequence), sequence):
                sequence = candidate
    return prefix + _increment_decimal(sequence).zfill(3)


def _increment_decimal(value: str) -> str:
    # 旧手动编号没有长度限制，不能依赖 Python 的整数字符串转换上限。
    remaining = value.rstrip("9")
    carried_zeros = "0" * (len(value) - len(remaining))
    if not remaining:
        return "1" + carried_zeros
    return remaining[:-1] + chr(ord(remaining[-1]) + 1) + carried_zeros


def _name_part(name: str, fallback: str) -> str:
    normalized = unicodedata.normalize("NFKC", name)
    initials = "".join(lazy_pinyin(normalized, style=Style.FIRST_LETTER))
    ascii_part = _NON_ASCII_ALPHANUMERIC.sub("", initials).upper()
    return ascii_part[:_MAX_NAME_LENGTH] or fallback
