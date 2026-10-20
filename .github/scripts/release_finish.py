"""发布收尾：正式附件、原生报告、蓝奏下载均通过后，自动清理已登记的两端批次。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PureWindowsPath

from publish_lanzou import prepare
from release_cleanup import (
    _link,
    _regular,
    _write,
    checked_batch,
    clean_batch,
    register_batch,
)

PROJECT = Path(__file__).resolve().parents[2]
SCRIPTS = Path(__file__).parent
ASSETS = ("SunYu_ERP-windows-x64.zip", "update.exe",
          "update-manifest-singlefile.json", "SHA256SUMS.txt")
REPO = "Vex9th/SunYu_ERP"
REMOTE_PYTHON = r"D:\Developer\SunYu_ERP\dependencies\verification\Scripts\python.exe"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_output(path: Path) -> None:
    for part in (path.absolute(), *path.absolute().parents):
        if os.path.lexists(part) and _link(part):
            raise ValueError(f"拒绝写入链接路径：{part}")
    if path.exists() and not path.is_dir():
        _regular(path)


def save(path: Path, value: dict) -> None:
    path = path.absolute()
    check_output(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write(path, value)


def validate_remote_path(value: str) -> None:
    root = PureWindowsPath(value)
    parent = PureWindowsPath(r"D:\Developer\SunYu_ERP\builds\release")
    if root.parent != parent or not re.fullmatch(r"[A-Za-z0-9_-]+", root.name):
        raise ValueError("远端仅允许 SunYu_ERP/builds/release 下的单个发布批次")


def validate_native(report: dict, metadata: dict) -> None:
    if (report.get("status") != "passed" or report.get("version") != metadata["version"]
            or type(report.get("owned_active_processes")) is not int
            or report["owned_active_processes"] != 0):
        raise ValueError("原生验证未通过、版本不一致或仍有测试进程")
    if report.get("archive_sha256") == metadata["archive"]["sha256"]:
        return
    if (report.get("main_sha256") != metadata["files"]["SunYu_ERP.exe"]
            or report.get("updater_sha256") != metadata["files"]["update.exe"]):
        raise ValueError("原生验证报告不属于当前正式包")


def validate_mirror_events(text: str) -> None:
    events = [json.loads(line) for line in text.splitlines() if line.strip()]
    if any(item.get("Action") == "fail" for item in events) or not any(
        item.get("Action") == "pass" and item.get("Test") == "TestLanzouLivePublishedMirror"
        for item in events
    ):
        raise ValueError("未发现蓝奏公开下载测试的成功结果")


def mirror_receipt(version: str, checksum: str, upload: str, verify: str, log: Path) -> dict:
    verified = False
    if (upload == verify == "success"
            and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
            and re.fullmatch(r"[a-f0-9]{64}", checksum) and log.is_file()):
        try:
            validate_mirror_events(log.read_text("utf-8"))
            verified = True
        except (ValueError, OSError):
            pass
    return {"version": version, "archive_sha256": checksum, "verified": verified}


def verify_github(assets: Path, version: str, work: Path) -> dict:
    release = json.loads(subprocess.check_output(
        ["gh", "api", f"repos/{REPO}/releases/tags/v{version}"], timeout=60
    ))
    if (release.get("tag_name") != f"v{version}" or release.get("draft") is not False
            or release.get("prerelease") is not False):
        raise ValueError("GitHub 版本尚未正式发布")
    uploaded = {x["name"] for x in release["assets"] if x.get("state") == "uploaded"}
    if not set(ASSETS) <= uploaded:
        raise ValueError("GitHub 正式附件不完整")
    check_output(work)
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="github-", dir=work) as destination:
        command = ["gh", "release", "download", f"v{version}", "--repo", REPO,
                   "--dir", destination]
        for name in ASSETS:
            command.extend(["--pattern", name])
        subprocess.run(command, check=True, timeout=300)
        for name in ASSETS:
            if digest(Path(destination) / name) != digest(assets / name):
                raise ValueError(f"GitHub 正式附件不一致：{name}")
    return {"version": version, "verified": True, "url": release["html_url"],
            "assets": {name: digest(assets / name) for name in ASSETS}}


def verify_mirror(metadata: dict, report_dir: Path, work: Path) -> dict:
    check_output(work)
    work.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "SUNYU_LANZOU_LIVE_TEST": "1",
           "SUNYU_LANZOU_EXPECTED_VERSION": metadata["version"],
           "SUNYU_LANZOU_EXPECTED_SHA256": metadata["archive"]["sha256"],
           "TMPDIR": str(work), "TMP": str(work), "TEMP": str(work)}
    log = report_dir / "mirror-live.jsonl"
    check_output(log)
    with log.open("w", encoding="utf-8") as output:
        subprocess.run(
            ["go", "test", "-C", str(PROJECT / "updater"), "-json",
             "-run", "^TestLanzouLivePublishedMirror$", "-count=1"],
            env=env, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=240,
        )
    validate_mirror_events(log.read_text("utf-8"))
    return {"version": metadata["version"], "verified": True,
            "archive_sha256": metadata["archive"]["sha256"]}


# 代码和参数通过 SSH stdin 传递；不把路径、报告内容拼接到远端 shell 命令。
REMOTE = r'''
import base64, hashlib, json, os, pathlib, uuid, zipfile
exec(base64.b64decode(ENGINE), globals())
request = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path(request["root"])
version = request["version"]
action = request["action"]
if action == "init":
    result = register_batch(root, version)
elif action == "clean":
    result = clean_batch(root, version, request["receipt"])
elif action == "collect":
    root = checked_batch(root, version)
    assets = root / request["assets"]
    if not assets.resolve().is_relative_to(root.resolve()):
        raise ValueError("Assets escaped batch")
    for part in (assets, *assets.parents):
        if part == root.parent:
            break
        if part.is_symlink() or part.is_junction():
            raise ValueError("Linked asset directory")
    archive = root / ("verification/export-" + uuid.uuid4().hex + ".zip")
    if archive.is_symlink() or archive.parent.is_symlink() or archive.parent.is_junction():
        raise ValueError("Linked export path")
    archive.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(archive):
        _regular(archive)
    hashes = {}
    reports = {}
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as output:
        for name in ASSETS:
            source = assets / name
            if source.is_symlink() or not source.is_file():
                raise ValueError("Invalid official asset")
            payload = source.read_bytes()
            hashes[name] = hashlib.sha256(payload).hexdigest()
            output.writestr("official/" + name, payload)
        for index, name in enumerate(request["reports"]):
            source = root / name
            if not source.resolve().is_relative_to(root.resolve()) or source.is_symlink():
                raise ValueError("Report escaped batch")
            payload = source.read_bytes()
            reports[name] = json.loads(payload)
            output.writestr("native/" + str(index) + ".json", payload)
        for current, dirs, files in os.walk(root, followlinks=False):
            parent = pathlib.Path(current)
            dirs[:] = [name for name in dirs
                if name.lower() not in {"data", "backups", ".git", ".venv", "node_modules"}
                and not (parent/name).is_symlink() and not (parent/name).is_junction()]
            for name in files:
                source = parent / name
                if source == archive or source.is_symlink() or name.lower() == "config.json":
                    continue
                if source.suffix.lower() in {".log", ".json", ".jsonl", ".toc", ".png", ".jpg", ".txt"}:
                    output.write(source, "reports/" + source.relative_to(root).as_posix())
    with archive.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    result = {"archive": str(archive), "sha256": checksum, "assets": hashes, "reports": reports}
else:
    raise ValueError("Invalid remote action")
print(json.dumps(result, ensure_ascii=True))
'''


def remote_call(action: str, payload: dict) -> dict:
    engine = base64.b64encode((SCRIPTS / "release_cleanup.py").read_bytes()).decode()
    data = base64.b64encode(json.dumps({**payload, "action": action}).encode()).decode()
    code = (f"ENGINE={engine!r}\nPAYLOAD={data!r}\nASSETS={ASSETS!r}\n" + REMOTE).encode()
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
         "winbuild", REMOTE_PYTHON, "-"], input=code, capture_output=True, check=True, timeout=180,
    )
    return json.loads(result.stdout)


def initialize(batch: Path, version: str, remote: str | None) -> None:
    if remote:
        validate_remote_path(remote)
    register_batch(batch, version)
    context = {"version": version, "remote_batch": remote}
    save(batch / "verification/release-context.json", context)
    if remote:
        remote_call("init", {"root": remote, "version": version})


def run_release(command: list[str], batch: Path, assets: Path, reports: list[Path], **kwargs) -> dict:
    """已登记批次的发布命令成功后自动验证、收集和清理；命令失败保留现场。"""
    if not command:
        raise ValueError("缺少发布命令")
    context = json.loads((batch / "verification/release-context.json").read_text("utf-8"))
    batch = checked_batch(batch, context["version"])
    env = {**os.environ, "SUNYU_RELEASE_BATCH": str(batch.absolute()),
           "SUNYU_RELEASE_VERSION": context["version"],
           "SUNYU_REMOTE_BATCH": context["remote_batch"] or ""}
    subprocess.run(command, env=env, check=True)
    return finish(batch, assets, reports, **kwargs)


def finish_actions(batch: Path, run_id: str, **kwargs) -> dict:
    """接入现有 Windows Release：等待发布，回传正式包/报告，然后自动收尾。"""
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("无效的 Actions run ID")
    context = json.loads((batch / "verification/release-context.json").read_text("utf-8"))
    batch = checked_batch(batch, context["version"])
    subprocess.run(["gh", "run", "watch", run_id, "--repo", REPO, "--exit-status"], check=True)
    run = json.loads(subprocess.check_output(
        ["gh", "api", f"repos/{REPO}/actions/runs/{run_id}"], timeout=60,
    ))
    if (run.get("path") != ".github/workflows/release.yml"
            or run.get("status") != "completed" or run.get("conclusion") != "success"):
        raise ValueError("指定任务不是已成功完成的 Windows Release")
    work = batch / "worktemp"
    check_output(work)
    work.mkdir(exist_ok=True)
    # 下载失败保留现场；不使用退出时无条件删除的临时目录。
    downloaded = Path(tempfile.mkdtemp(prefix=f"actions-{run_id}-", dir=work))
    subprocess.run(
        ["gh", "run", "download", run_id, "--repo", REPO, "--name", "SunYu_ERP-windows-x64",
         "--dir", str(downloaded)], check=True, timeout=300,
    )
    assets = downloaded / "official"
    assets.mkdir()
    for name in ASSETS:
        matches = list(downloaded.rglob(name))
        if len(matches) != 1:
            raise ValueError(f"Actions 附件缺失或不唯一：{name}")
        (assets / name).write_bytes(matches[0].read_bytes())
    reports = list(downloaded.rglob("verification-result.json"))
    if len(reports) != 1:
        raise ValueError("Actions 缺少唯一的 Windows 原生验证报告")
    save(batch / "verification/actions-run.json", {"id": run_id, "repo": REPO, **run})
    return finish(batch, assets, reports, **kwargs)


def finish(batch: Path, assets: Path, reports: list[Path], *,
           remote_assets: str = "source/dist/release", remote_reports: list[str] = ()) -> dict:
    batch = batch.absolute()
    context = json.loads((batch / "verification/release-context.json").read_text("utf-8"))
    version = context["version"]
    batch = checked_batch(batch, version)
    verification = batch / "verification"
    remote = context["remote_batch"]
    if remote:
        validate_remote_path(remote)
        if remote_assets not in {"release", "official", "source/dist/release"}:
            raise ValueError("构建机正式包必须位于约定的保留目录")
    check_output(verification)
    # 每次独立保留证据，网络失败后的重试也不覆盖上一轮报告。
    report_dir = Path(tempfile.mkdtemp(prefix="release-", dir=verification))
    metadata, _ = prepare(assets)
    if metadata["version"] != version:
        raise ValueError("正式包版本与发布批次不一致")
    if digest(assets / "update.exe") != metadata["files"]["update.exe"]:
        raise ValueError("独立 update.exe 与清单不一致")
    retained = batch / "release"
    check_output(retained)
    retained.mkdir(exist_ok=True)
    for name in ASSETS:
        destination = retained / name
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or digest(destination) != digest(assets / name):
                raise ValueError("已保留的正式包与本次发布不一致")
        else:
            with destination.open("xb") as output:
                output.write((assets / name).read_bytes())
    native = [json.loads(p.read_text("utf-8")) for p in reports]
    for index, report in enumerate(native):
        validate_native(report, metadata)
        save(report_dir / f"native-{index}.json", report)
    if remote:
        exported = remote_call("collect", {"root": remote, "version": version,
                               "assets": remote_assets, "reports": remote_reports})
        if exported["assets"] != {name: digest(assets / name) for name in ASSETS}:
            raise ValueError("构建机正式包与本地正式包不一致")
        remote_native = list(exported["reports"].values())
        if not remote_native:
            raise ValueError("缺少构建机原生验证报告")
        for report in remote_native:
            validate_native(report, metadata)
        destination = report_dir / "winbuild-retained.zip"
        export_path = PureWindowsPath(exported["archive"])
        if (export_path.parent != PureWindowsPath(remote) / "verification"
                or not re.fullmatch(r"export-[a-f0-9]{32}\.zip", export_path.name)):
            raise ValueError("构建机报告归档路径不一致")
        check_output(destination)
        subprocess.run(
            ["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
             "winbuild:" + PureWindowsPath(exported["archive"]).as_posix(), str(destination)],
            check=True, timeout=180,
        )
        if digest(destination) != exported["sha256"]:
            raise ValueError("构建机报告回传校验失败")
        native.extend(remote_native)
        save(report_dir / "winbuild-export.json", exported)
    if not native:
        raise ValueError("没有已通过的 Windows 原生验证报告")
    github = verify_github(assets, version, batch / "worktemp")
    if github.get("verified") is not True:
        raise ValueError("GitHub 正式包未验证")
    save(report_dir / "github-verified.json", github)
    mirror = verify_mirror(metadata, report_dir, batch / "worktemp")
    if mirror.get("verified") is not True:
        raise ValueError("蓝奏公开下载未验证")
    save(report_dir / "mirror-verified.json", mirror)
    receipt = {"version": version, "github_verified": True,
               "mirror_verified": True, "native_verified": True}
    save(report_dir / "publication-verified.json", receipt)
    result = {"version": version, "status": "running"}
    try:
        if remote:
            result["winbuild"] = remote_call("clean", {
                "root": remote, "version": version, "receipt": receipt,
            })
        result["local"] = clean_batch(batch, version, receipt)
        result["status"] = "passed"
    except Exception as error:
        result.update(status="failed", error=str(error))
        raise
    finally:
        save(report_dir / "release-finish.json", result)
        save(verification / "release-finish.json", {**result, "reports": str(report_dir)})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    init = commands.add_parser("init")
    init.add_argument("--batch", type=Path, required=True)
    init.add_argument("--version", required=True)
    init.add_argument("--remote-batch")
    mirror = commands.add_parser("mirror-receipt")
    mirror.add_argument("--output", type=Path, required=True)
    mirror.add_argument("--log", type=Path, required=True)
    for action in ("finish", "run", "actions"):
        complete = commands.add_parser(action)
        complete.add_argument("--batch", type=Path, required=True)
        if action == "actions":
            complete.add_argument("--run-id", required=True)
        else:
            complete.add_argument("--assets", type=Path, required=True)
            complete.add_argument("--native-report", type=Path, action="append", default=[])
        complete.add_argument("--remote-assets", default="source/dist/release")
        complete.add_argument("--remote-report", action="append", default=[])
        if action == "run":
            complete.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "init":
        initialize(args.batch.absolute(), args.version, args.remote_batch)
    elif args.action == "mirror-receipt":
        receipt = mirror_receipt(
            os.environ.get("SUNYU_LANZOU_EXPECTED_VERSION", ""),
            os.environ.get("SUNYU_LANZOU_EXPECTED_SHA256", ""),
            os.environ.get("UPLOAD_RESULT", ""), os.environ.get("VERIFY_RESULT", ""), args.log,
        )
        save(args.output, receipt)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write(f"verified={str(receipt['verified']).lower()}\n")
    else:
        options = {"remote_assets": args.remote_assets, "remote_reports": args.remote_report}
        try:
            if args.action == "actions":
                result = finish_actions(args.batch, args.run_id, **options)
            elif args.action == "run":
                command = args.command[1:] if args.command[:1] == ["--"] else args.command
                result = run_release(command, args.batch, args.assets, args.native_report, **options)
            else:
                result = finish(args.batch, args.assets, args.native_report, **options)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            # A failed check never becomes a successful cleanup receipt.
            report = args.batch / "verification/release-finish.json"
            if report.parent.is_dir() and not report.parent.is_symlink():
                # Preserve per-host results when only one host completed cleanup.
                previous = json.loads(report.read_text("utf-8")) if report.is_file() else {}
                save(report, {**previous, "status": "failed", "error": str(error)})
            raise SystemExit(f"发布收尾停止，保留未清理现场：{error}") from None
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
