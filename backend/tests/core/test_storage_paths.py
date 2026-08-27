from __future__ import annotations

import pytest

from backend.app.core.storage_paths import normalize_project_code


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("PRJ-001", "PRJ-001"),
        ("  PRJ-001\t", "PRJ-001"),
        ("项" * 40, "项" * 40),
    ],
)
def test_normalize_project_code_returns_trimmed_safe_value(
    value: str,
    expected: str,
) -> None:
    assert normalize_project_code(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        ".",
        " .. ",
        "/absolute",
        "C:\\absolute",
        "a/b",
        "a\\b",
        "a:b",
        "a<b",
        "a>b",
        'a"b',
        "a?b",
        "a|b",
        "a*b",
        "trailing.",
        "CON",
        "PRN.txt",
        "AUX",
        "NUL",
        "COM1",
        "COM9.log",
        "LPT1",
        "LPT9.dat",
        "nul\0x",
        "control\x1fname",
        "line\nbreak",
        "a" * 121,
        "项" * 41,
    ],
)
def test_normalize_project_code_rejects_unsafe_values(value: str) -> None:
    with pytest.raises(
        ValueError,
        match="project_code must be a safe single path segment",
    ):
        normalize_project_code(value)


def test_normalize_project_code_rejects_non_string() -> None:
    with pytest.raises(TypeError, match="project_code must be a string"):
        normalize_project_code(123)  # type: ignore[arg-type]
