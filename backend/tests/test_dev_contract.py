from __future__ import annotations

import asyncio
import subprocess
from collections.abc import Iterable
from pathlib import Path, PureWindowsPath

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_required_development_entries_exist() -> None:
    required_entries = (
        PROJECT_ROOT / "dev.py",
        PROJECT_ROOT / "backend" / "app" / "main.py",
        PROJECT_ROOT / "frontend" / "package.json",
        PROJECT_ROOT / "frontend" / "src" / "main.ts",
    )

    assert all(path.is_file() for path in required_entries)


def test_health_endpoint_returns_ok() -> None:
    from httpx import ASGITransport, AsyncClient

    from backend.app.main import app

    async def get_health():
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            return await client.get("/api/health")

    response = asyncio.run(get_health())

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_dev_commands_bind_to_expected_hosts_and_ports() -> None:
    import dev

    backend_command, frontend_command = dev.build_commands()

    assert_command_binding(backend_command, host="0.0.0.0", port="8765")
    assert_command_binding(frontend_command, host="0.0.0.0", port="5173")


def test_windows_frontend_command_uses_node_and_npm_cli_without_cmd() -> None:
    import dev

    npm_command = r"C:\Program Files\nodejs\npm.cmd"
    node_command = r"C:\Program Files\nodejs\node.exe"
    npm_cli = r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
    executables = {"npm.cmd": npm_command, "node.exe": node_command}
    lookups: list[str] = []
    path_checks: list[PureWindowsPath] = []

    def find_executable(candidate: str) -> str | None:
        lookups.append(candidate)
        return executables.get(candidate)

    def path_exists(candidate: PureWindowsPath) -> bool:
        path_checks.append(candidate)
        return str(candidate) == npm_cli

    _, frontend_command = dev.build_commands(
        platform_name="nt",
        executable_finder=find_executable,
        path_exists=path_exists,
    )

    assert frontend_command == (
        node_command,
        npm_cli,
        "--prefix",
        "frontend",
        "run",
        "dev",
        "--",
        "--host",
        "0.0.0.0",
        "--port",
        "5173",
        "--strictPort",
    )
    assert lookups == ["npm.cmd", "node.exe"]
    assert path_checks == [PureWindowsPath(npm_cli)]
    assert all("cmd.exe" not in argument.lower() for argument in frontend_command)


@pytest.mark.parametrize(
    ("available_executables", "npm_cli_exists", "expected_message"),
    (
        ({}, True, "npm.cmd"),
        ({"npm.cmd": r"C:\Node\npm.cmd"}, True, "node.exe"),
        (
            {
                "npm.cmd": r"C:\Node\npm.cmd",
                "node.exe": "node.exe",
            },
            True,
            "absolute node.exe",
        ),
        (
            {
                "npm.cmd": r"C:\Node\npm.cmd",
                "node.exe": r"C:\Node\node.exe",
            },
            False,
            "npm-cli.js",
        ),
    ),
)
def test_windows_frontend_command_fails_fast_when_launcher_is_missing(
    available_executables: dict[str, str],
    npm_cli_exists: bool,
    expected_message: str,
) -> None:
    import dev

    with pytest.raises(RuntimeError, match=expected_message):
        dev.build_commands(
            platform_name="nt",
            executable_finder=available_executables.get,
            path_exists=lambda _: npm_cli_exists,
        )


def test_windows_npm_cmd_must_resolve_to_absolute_path() -> None:
    import dev

    executables = {
        "npm.cmd": "npm.cmd",
        "node.exe": r"C:\Node\node.exe",
    }

    with pytest.raises(RuntimeError, match="absolute npm.cmd"):
        dev.build_commands(
            platform_name="nt",
            executable_finder=executables.get,
            path_exists=lambda _: True,
        )


@pytest.mark.parametrize(
    ("platform_name", "expected_options"),
    (
        ("posix", {"start_new_session": True}),
        ("nt", {"creationflags": 0x00000200}),
    ),
)
def test_run_starts_children_in_independent_process_groups(
    platform_name: str,
    expected_options: dict[str, object],
) -> None:
    import dev

    process_options: list[dict[str, object]] = []
    processes = iter((FakeProcess(return_code=0), FakeProcess(return_code=None)))
    executables = {
        "npm": "/opt/node/bin/npm",
        "npm.cmd": r"C:\Node\npm.cmd",
        "node.exe": r"C:\Node\node.exe",
    }

    def create_process(*args, **kwargs):
        process_options.append(kwargs)
        return next(processes)

    exit_code = dev.run(
        dev.RuntimeHooks(
            process_factory=create_process,
            sleep=lambda _: None,
            platform_name=platform_name,
            executable_finder=executables.get,
            path_exists=lambda _: True,
            signal_registrar=lambda _signum, _handler: None,
        )
    )

    assert exit_code == 0
    assert len(process_options) == 2
    assert all(
        {key: options[key] for key in expected_options} == expected_options
        for options in process_options
    )
    unexpected_option = (
        "creationflags" if platform_name == "posix" else "start_new_session"
    )
    assert all(unexpected_option not in options for options in process_options)


def test_windows_timeout_forces_entire_process_tree_without_sigkill() -> None:
    import dev

    process = FakeProcess(return_code=None, pid=321, wait_times_out=True)
    taskkill_calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def run_taskkill(command, **kwargs):
        taskkill_calls.append((tuple(command), kwargs))

    dev.stop_process(
        process,
        platform_name="nt",
        taskkill_runner=run_taskkill,
    )

    assert process.sent_signals == [dev.WINDOWS_CTRL_BREAK_EVENT]
    assert not process.killed
    assert taskkill_calls == [
        (
            ("taskkill", "/PID", "321", "/T", "/F"),
            {
                "check": False,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            },
        )
    ]


def test_windows_already_exited_parent_still_cleans_descendants() -> None:
    import dev

    process = FakeProcess(return_code=7, pid=654)
    taskkill_commands: list[tuple[str, ...]] = []

    dev.stop_process(
        process,
        platform_name="nt",
        taskkill_runner=lambda command, **kwargs: taskkill_commands.append(
            tuple(command)
        ),
    )

    assert process.sent_signals == []
    assert taskkill_commands == [("taskkill", "/PID", "654", "/T", "/F")]


def test_posix_cleanup_uses_launch_pid_as_pgid_after_parent_exit() -> None:
    import dev

    process = FakeProcess(return_code=7, pid=777)
    group_signals: list[tuple[int, int]] = []

    dev.stop_process(
        process,
        platform_name="posix",
        process_group_killer=lambda pgid, sig: group_signals.append((pgid, sig)),
    )

    assert group_signals == [
        (777, dev.POSIX_SIGTERM),
        (777, dev.POSIX_SIGKILL),
    ]


def test_posix_timeout_escalates_the_same_process_group() -> None:
    import dev

    process = FakeProcess(return_code=None, pid=778, wait_times_out=True)
    group_signals: list[tuple[int, int]] = []

    dev.stop_process(
        process,
        platform_name="posix",
        process_group_killer=lambda pgid, sig: group_signals.append((pgid, sig)),
    )

    assert group_signals == [
        (778, dev.POSIX_SIGTERM),
        (778, dev.POSIX_SIGKILL),
    ]


def test_run_cleans_first_child_when_second_child_fails_to_start() -> None:
    import dev

    first_process = FakeProcess(return_code=None, pid=901)
    starts = 0
    group_signals: list[tuple[int, int]] = []

    def create_process(*args, **kwargs):
        nonlocal starts
        starts += 1
        if starts == 1:
            return first_process
        raise OSError("frontend failed to start")

    with pytest.raises(OSError, match="frontend failed to start"):
        dev.run(
            dev.RuntimeHooks(
                process_factory=create_process,
                platform_name="posix",
                executable_finder=lambda candidate: f"/opt/bin/{candidate}",
                process_group_killer=lambda pgid, sig: group_signals.append(
                    (pgid, sig)
                ),
                signal_registrar=lambda _signum, _handler: None,
            )
        )

    assert group_signals == [(901, dev.POSIX_SIGTERM)]


@pytest.mark.parametrize("termination_signal", (1, 15))
def test_posix_termination_signal_cleans_children_and_returns_shell_code(
    termination_signal: int,
) -> None:
    import dev

    processes = iter(
        (
            FakeProcess(return_code=None, pid=910),
            FakeProcess(return_code=None, pid=911),
        )
    )
    previous_handlers = {1: object(), 15: object()}
    installed_handlers: dict[int, object] = dict(previous_handlers)
    group_signals: list[tuple[int, int]] = []

    def register_signal(signum: int, handler: object) -> object:
        previous_handler = installed_handlers[signum]
        installed_handlers[signum] = handler
        return previous_handler

    def send_termination_signal(_: float) -> None:
        handler = installed_handlers[termination_signal]
        assert callable(handler)
        handler(termination_signal, None)

    exit_code = dev.run(
        dev.RuntimeHooks(
            process_factory=lambda *args, **kwargs: next(processes),
            sleep=send_termination_signal,
            platform_name="posix",
            executable_finder=lambda candidate: f"/opt/bin/{candidate}",
            process_group_killer=lambda pgid, sig: group_signals.append(
                (pgid, sig)
            ),
            signal_registrar=register_signal,
        )
    )

    assert exit_code == 128 + termination_signal
    assert group_signals == [
        (911, dev.POSIX_SIGTERM),
        (910, dev.POSIX_SIGTERM),
    ]
    assert installed_handlers == previous_handlers


@pytest.mark.parametrize(
    ("exit_index", "expected_exit_code"),
    ((0, 17), (1, 23)),
)
def test_run_stops_peer_when_either_child_exits(
    exit_index: int,
    expected_exit_code: int,
) -> None:
    import dev

    child_processes = [FakeProcess(return_code=None), FakeProcess(return_code=None)]
    exited_process = child_processes[exit_index]
    exited_process.return_code = expected_exit_code
    processes = iter(child_processes)

    exit_code = dev.run(
        dev.RuntimeHooks(
            process_factory=lambda *args, **kwargs: next(processes),
            sleep=lambda _: None,
        )
    )

    assert exit_code == expected_exit_code
    assert not exited_process.terminated
    assert child_processes[1 - exit_index].terminated


def test_run_stops_all_children_on_keyboard_interrupt() -> None:
    import dev

    backend_process = FakeProcess(return_code=None)
    frontend_process = FakeProcess(return_code=None)
    processes = iter((backend_process, frontend_process))

    def interrupt(_: float) -> None:
        raise KeyboardInterrupt

    exit_code = dev.run(
        dev.RuntimeHooks(
            process_factory=lambda *args, **kwargs: next(processes),
            sleep=interrupt,
        )
    )

    assert exit_code == 130
    assert backend_process.terminated
    assert frontend_process.terminated


def assert_command_binding(command: Iterable[str], *, host: str, port: str) -> None:
    arguments = tuple(command)
    assert arguments[arguments.index("--host") + 1] == host
    assert arguments[arguments.index("--port") + 1] == port


class FakeProcess:
    def __init__(
        self,
        return_code: int | None,
        *,
        pid: int | None = None,
        wait_times_out: bool = False,
    ) -> None:
        self.return_code = return_code
        self.pid = pid
        self.wait_times_out = wait_times_out
        self.terminated = False
        self.killed = False
        self.sent_signals: list[int] = []

    def poll(self) -> int | None:
        return self.return_code

    def terminate(self) -> None:
        self.terminated = True
        self.return_code = -15

    def wait(self, timeout: float | None = None) -> int:
        if self.wait_times_out:
            self.wait_times_out = False
            raise subprocess.TimeoutExpired("fake-process", timeout)
        return self.return_code or 0

    def kill(self) -> None:
        self.killed = True
        self.return_code = -9

    def send_signal(self, sig: int) -> None:
        self.sent_signals.append(sig)
