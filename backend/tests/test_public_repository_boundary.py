from __future__ import annotations

import subprocess
from pathlib import Path, PurePosixPath

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_DIRECTORY_NAMES = {
    ".agents",
    ".codex",
    ".worktrees",
    "Backups",
    "CustomerData",
    "Data",
    "customer-data",
    "secrets",
}
FORBIDDEN_FILE_NAMES = {"AGENTS.md", "config.json"}
FORBIDDEN_DATABASE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}


def is_forbidden_public_path(path_text: str) -> bool:
    path = PurePosixPath(path_text)
    parts = path.parts
    if any(part in FORBIDDEN_DIRECTORY_NAMES for part in parts):
        return True
    if path.name in FORBIDDEN_FILE_NAMES:
        return True
    if parts[:2] == ("docs", "superpowers"):
        return True
    return any(
        path.name.endswith(suffix) or f"{suffix}-" in path.name
        for suffix in FORBIDDEN_DATABASE_SUFFIXES
    )


def test_public_path_classifier_rejects_internal_and_business_data() -> None:
    forbidden = [
        "docs/superpowers/notes.md",
        ".codex/settings.json",
        ".agents/skills/local.md",
        ".worktrees/feature/file.py",
        "AGENTS.md",
        "Data/iapm.sqlite",
        "Backups/20260831/iapm.sqlite3",
        "config.json",
        "customer-data/acme/contract.pdf",
        "secrets/token.txt",
        "cache.db-wal",
    ]
    allowed = [
        "docs/api-contract.md",
        "docs/backend-development-plan.md",
        "config.example.json",
        "backend/app/core/database.py",
        "frontend/src/components/ProjectDashboard.vue",
    ]

    assert all(is_forbidden_public_path(path) for path in forbidden)
    assert not any(is_forbidden_public_path(path) for path in allowed)


def test_git_index_contains_no_private_or_runtime_paths() -> None:
    completed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
    )
    tracked_paths = completed.stdout.decode().split("\0")

    forbidden = [path for path in tracked_paths if path and is_forbidden_public_path(path)]

    assert forbidden == [], f"公开仓库索引包含禁止路径: {forbidden}"
