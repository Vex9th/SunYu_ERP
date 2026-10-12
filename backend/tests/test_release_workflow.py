from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RELEASE_WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "release.yml"


def test_windows_smoke_stops_the_launcher_and_runtime_process_tree() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")

    assert "taskkill.exe /PID $process.Id /T /F" in workflow
    assert "Wait-Process -Id $process.Id -Timeout 15" in workflow
    assert "process tree did not stop within 15 seconds" in workflow


def test_windows_smoke_copies_full_installation_and_checks_versioned_assets() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")

    assert "Copy-Item 'dist\\modular\\SunYu_ERP\\*' $smokeRoot -Recurse" in workflow
    assert '/__frontend/[^/]+/assets/' in workflow
    smoke = workflow.index('python .github/scripts/modular_smoke.py --package-dir')
    assert smoke < workflow.index('uses: actions/upload-artifact')
    assert smoke < workflow.index('gh release upload')


def test_windows_release_remains_manual_only() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    triggers = workflow.split("'on':", 1)[1].split('concurrency:', 1)[0]

    assert 'workflow_dispatch:' in triggers
    assert 'push:' not in triggers
    assert 'pull_request:' not in triggers


def test_windows_smoke_proves_the_old_server_stopped_before_restart() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    first_stop = workflow.index("Stop-SunYuProcess $first")
    stopped_probe = workflow.index("Wait-SunYuStopped", first_stop)
    second_start = workflow.index("$second = Start-SunYuProcess 'second'")

    assert first_stop < stopped_probe < second_start
    assert "[System.Net.Sockets.TcpClient]::new()" in workflow
    assert "Port 8765 remained reachable after process-tree termination" in workflow


def test_windows_smoke_keeps_the_restarted_process_alive() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    second_start = workflow.index("$second = Start-SunYuProcess 'second'")
    second_alive = workflow.index(
        "Restarted SunYu_ERP.exe exited immediately after health check",
        second_start,
    )
    second_stop = workflow.index("Stop-SunYuProcess $second", second_start)

    assert second_start < second_alive < second_stop


def test_windows_smoke_does_not_shadow_powershell_home_variable() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")

    assert "$home" not in workflow.lower()
    assert "$indexResponse = Invoke-WebRequest" in workflow
    assert "$indexResponse.StatusCode" in workflow
    assert "$indexResponse.Content" in workflow


def test_public_boundary_ignores_structured_log_directory() -> None:
    ignore_rules = (PROJECT_ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "/logs/" in ignore_rules.splitlines()
