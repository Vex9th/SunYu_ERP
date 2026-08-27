from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
POSIX_SIGHUP = 1
POSIX_SIGTERM = 15
POSIX_SIGKILL = 9
WINDOWS_CREATE_NEW_PROCESS_GROUP = 0x00000200
WINDOWS_CTRL_BREAK_EVENT = 1


class TerminationRequested(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


@dataclass(frozen=True)
class RuntimeHooks:
    process_factory: Callable[..., Any] = subprocess.Popen
    sleep: Callable[[float], None] = time.sleep
    platform_name: str = os.name
    executable_finder: Callable[[str], str | None] = shutil.which
    path_exists: Callable[[PureWindowsPath], bool] = os.path.exists
    taskkill_runner: Callable[..., Any] = subprocess.run
    process_group_killer: Callable[[int, int], None] | None = None
    signal_registrar: Callable[[int, Any], Any] = signal.signal


def build_commands(
    *,
    platform_name: str = os.name,
    executable_finder: Callable[[str], str | None] = shutil.which,
    path_exists: Callable[[PureWindowsPath], bool] = os.path.exists,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    backend_command = (
        sys.executable,
        "-m",
        "uvicorn",
        "backend.app.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8765",
        "--reload",
    )
    npm_name = "npm.cmd" if platform_name == "nt" else "npm"
    npm_command = executable_finder(npm_name)
    if npm_command is None:
        raise RuntimeError(f"Required executable not found: {npm_name}")

    frontend_arguments = (
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
    if platform_name == "nt":
        node_command, npm_cli = resolve_windows_npm_launcher(
            npm_command,
            executable_finder,
            path_exists,
        )
        frontend_command = (node_command, npm_cli, *frontend_arguments)
    else:
        frontend_command = (npm_command, *frontend_arguments)
    return backend_command, frontend_command


def resolve_windows_npm_launcher(
    npm_command: str,
    executable_finder: Callable[[str], str | None],
    path_exists: Callable[[PureWindowsPath], bool],
) -> tuple[str, str]:
    npm_path = PureWindowsPath(npm_command)
    if not npm_path.is_absolute():
        raise RuntimeError("Required executable must resolve to absolute npm.cmd path")

    node_command = executable_finder("node.exe")
    if node_command is None:
        raise RuntimeError("Required executable not found: node.exe")
    node_path = PureWindowsPath(node_command)
    if not node_path.is_absolute():
        raise RuntimeError("Required executable must resolve to absolute node.exe path")

    npm_cli = (
        npm_path.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    )
    if not path_exists(npm_cli):
        raise RuntimeError(f"Required npm CLI script not found: {npm_cli}")
    return str(node_path), str(npm_cli)


def run(runtime: RuntimeHooks | None = None) -> int:
    runtime = RuntimeHooks() if runtime is None else runtime
    processes: list[Any] = []
    previous_signal_handlers: dict[int, Any] = {}
    try:
        if runtime.platform_name == "posix":
            previous_signal_handlers = install_termination_signal_handlers(
                runtime.signal_registrar
            )
        start_processes(processes, runtime)
        return monitor_processes(processes, runtime.sleep)
    except KeyboardInterrupt:
        return 130
    except TerminationRequested as request:
        return 128 + request.signum
    finally:
        try:
            cleanup_processes(processes, runtime)
        finally:
            for signum, previous_handler in previous_signal_handlers.items():
                runtime.signal_registrar(signum, previous_handler)


def start_processes(processes: list[Any], runtime: RuntimeHooks) -> None:
    commands = build_commands(
        platform_name=runtime.platform_name,
        executable_finder=runtime.executable_finder,
        path_exists=runtime.path_exists,
    )
    platform_options = (
        {"creationflags": WINDOWS_CREATE_NEW_PROCESS_GROUP}
        if runtime.platform_name == "nt"
        else {"start_new_session": True}
    )
    for command in commands:
        processes.append(
            runtime.process_factory(command, cwd=PROJECT_ROOT, **platform_options)
        )


def monitor_processes(
    processes: list[Any],
    sleep: Callable[[float], None],
) -> int:
    while True:
        for process in processes:
            return_code = process.poll()
            if return_code is not None:
                return return_code
        sleep(0.1)


def cleanup_processes(processes: list[Any], runtime: RuntimeHooks) -> None:
    for process in reversed(processes):
        stop_process(
            process,
            platform_name=runtime.platform_name,
            taskkill_runner=runtime.taskkill_runner,
            process_group_killer=runtime.process_group_killer,
        )


def install_termination_signal_handlers(
    signal_registrar: Callable[[int, Any], Any],
) -> dict[int, Any]:
    def request_termination(signum: int, frame: Any) -> None:
        raise TerminationRequested(signum)

    return {
        signum: signal_registrar(signum, request_termination)
        for signum in (POSIX_SIGHUP, POSIX_SIGTERM)
    }


def stop_process(
    process: Any,
    *,
    platform_name: str = os.name,
    taskkill_runner: Callable[..., Any] = subprocess.run,
    process_group_killer: Callable[[int, int], None] | None = None,
) -> None:
    if platform_name == "nt":
        stop_windows_process_tree(process, taskkill_runner)
        return

    stop_posix_process_tree(process, process_group_killer)


def stop_posix_process_tree(
    process: Any,
    process_group_killer: Callable[[int, int], None] | None,
) -> None:
    pid = getattr(process, "pid", None)
    if isinstance(pid, int) and pid > 0:
        kill_group = (
            os.killpg if process_group_killer is None else process_group_killer
        )
        signal_process_group(kill_group, pid, POSIX_SIGTERM)
        if process.poll() is not None:
            signal_process_group(kill_group, pid, POSIX_SIGKILL)
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            group_exists = signal_process_group(kill_group, pid, POSIX_SIGKILL)
            if not group_exists:
                process.kill()
            process.wait()
        return

    if process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def signal_process_group(
    process_group_killer: Callable[[int, int], None],
    pgid: int,
    sig: int,
) -> bool:
    try:
        process_group_killer(pgid, sig)
    except ProcessLookupError:
        return False
    return True


def stop_windows_process_tree(
    process: Any,
    taskkill_runner: Callable[..., Any],
) -> None:
    pid = getattr(process, "pid", None)
    if not isinstance(pid, int) or pid <= 0:
        if process.poll() is None:
            process.terminate()
        return

    if process.poll() is None:
        try:
            process.send_signal(WINDOWS_CTRL_BREAK_EVENT)
            process.wait(timeout=5)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass

    taskkill_runner(
        ("taskkill", "/PID", str(pid), "/T", "/F"),
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


if __name__ == "__main__":
    raise SystemExit(run())
