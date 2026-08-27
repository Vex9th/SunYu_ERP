"""Shared validation for project storage path segments."""

from __future__ import annotations

import unicodedata

_INVALID_WINDOWS_FILENAME_CHARACTERS = frozenset('<>:"/\\|?*')
_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
    | {f"{prefix}{number}" for prefix in ("COM", "LPT") for number in "¹²³"}
)
_MAX_PROJECT_CODE_UTF8_BYTES = 120


def normalize_project_code(value: str) -> str:
    """Return a normalized project code safe for use as one path segment."""
    if not isinstance(value, str):
        raise TypeError("project_code must be a string")

    normalized = value.strip()
    if (
        not normalized
        or normalized in {".", ".."}
        or any(
            character in _INVALID_WINDOWS_FILENAME_CHARACTERS
            or unicodedata.category(character) == "Cc"
            for character in normalized
        )
        or normalized.rstrip(". ") != normalized
        or normalized.partition(".")[0].rstrip(" ").upper() in _WINDOWS_DEVICE_NAMES
        or len(normalized.encode("utf-8")) > _MAX_PROJECT_CODE_UTF8_BYTES
    ):
        raise ValueError("project_code must be a safe single path segment")
    return normalized
