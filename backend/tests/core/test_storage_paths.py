from __future__ import annotations

import pytest

from backend.app.core.storage_paths import normalize_project_code


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("PRJ-001", "PRJ-001"),
        ("  PRJ-001\t", "PRJ-001"),
        ("CLOCK$", "CLOCK$"),
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


@pytest.mark.parametrize(
    "value",
    [
        "COM¹",
        "COM²",
        "COM³",
        "LPT¹",
        "LPT²",
        "LPT³",
        "com¹.txt",
        "Com².log",
        "cOM³.tar.gz",
        "lpt¹.txt",
        "Lpt².log",
        "lPT³.tar.gz",
    ],
)
def test_normalize_project_code_rejects_superscript_device_names(
    value: str,
) -> None:
    with pytest.raises(
        ValueError,
        match="project_code must be a safe single path segment",
    ):
        normalize_project_code(value)


@pytest.mark.parametrize(
    "value",
    [
        "CONIN$",
        "conin$",
        "ConIn$.txt",
        "CONOUT$",
        "conout$",
        "ConOut$.log",
        "CON .txt",
        "PRN .x",
        "COM1 .log",
        "LPT¹ .tar.gz",
    ],
)
def test_normalize_project_code_rejects_reserved_device_name_variants(
    value: str,
) -> None:
    with pytest.raises(
        ValueError,
        match="project_code must be a safe single path segment",
    ):
        normalize_project_code(value)


def test_normalize_project_code_rejects_non_string() -> None:
    with pytest.raises(TypeError, match="project_code must be a string"):
        normalize_project_code(123)  # type: ignore[arg-type]
