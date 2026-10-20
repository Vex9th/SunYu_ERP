from __future__ import annotations

import hashlib
import importlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


@pytest.fixture
def finish(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / ".github/scripts"))
    return importlib.import_module("release_finish")


def native_report():
    return {
        "status": "passed", "version": "1.2.9", "owned_active_processes": 0,
        "main_sha256": "a" * 64, "updater_sha256": "b" * 64,
    }


def metadata():
    return {"version": "1.2.9", "archive": {"sha256": "c" * 64},
            "files": {"SunYu_ERP.exe": "a" * 64, "update.exe": "b" * 64}}


@pytest.mark.parametrize("change", [
    {"status": "failed"}, {"version": "1.2.8"}, {"owned_active_processes": 1},
    {"owned_active_processes": False}, {"main_sha256": "d" * 64},
])
def test_failed_stale_or_other_package_native_report_blocks_finish(finish, change):
    report = {**native_report(), **change}
    with pytest.raises(ValueError):
        finish.validate_native(report, metadata())


def test_native_report_is_bound_to_actual_package(finish):
    finish.validate_native(native_report(), metadata())
    archive_report = {k: v for k, v in native_report().items() if not k.endswith("sha256")}
    archive_report["archive_sha256"] = "c" * 64
    finish.validate_native(archive_report, metadata())
    del archive_report["owned_active_processes"]
    with pytest.raises(ValueError):
        finish.validate_native(archive_report, metadata())


@pytest.mark.parametrize("events", [
    [], [{"Action": "skip", "Test": "TestLanzouLivePublishedMirror"}],
    [{"Action": "pass"}],
    [{"Action": "pass", "Test": "TestLanzouLivePublishedMirror"},
     {"Action": "fail"}],
])
def test_zero_exit_without_actual_mirror_pass_is_not_verified(finish, events):
    with pytest.raises(ValueError):
        finish.validate_mirror_events("\n".join(map(json.dumps, events)))


def test_mirror_requires_named_live_test_to_pass(finish):
    finish.validate_mirror_events(
        '{"Action":"pass","Test":"TestLanzouLivePublishedMirror"}\n{"Action":"pass"}'
    )


def test_remote_payload_is_stdin_data_not_shell_interpolation(finish, monkeypatch):
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return type("Result", (), {"stdout": b'{"ok":true}', "returncode": 0})()

    monkeypatch.setattr(finish.subprocess, "run", run)
    result = finish.remote_call("inspect", {
        "root": r"D:\Developer\SunYu_ERP\builds\release\batch & evil",
        "version": "1.2.9",
    })
    assert result == {"ok": True}
    args, options = calls[0]
    assert args[:6] == ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "winbuild"]
    assert all("evil" not in arg for arg in args)
    assert b"batch & evil" not in options["input"]  # JSON payload is base64, not shell code.


def test_invalid_remote_batch_cannot_target_dependencies_or_other_projects(finish):
    for path in [r"D:\Developer\SunYu_ERP\dependencies", r"D:\Developer\Other\builds\x",
                 r"D:\Developer\SunYu_ERP\builds\release\..\..\dependencies"]:
        with pytest.raises(ValueError):
            finish.validate_remote_path(path)
    finish.validate_remote_path(r"D:\Developer\SunYu_ERP\builds\release\20261021-v130-01")


@pytest.mark.parametrize("upload,verify", [("failure", "success"), ("success", "failure"),
                                         ("skipped", "skipped")])
def test_successful_job_with_failed_upload_or_test_never_authorizes_cleanup(
    finish, tmp_path, upload, verify,
):
    log = tmp_path / "live.jsonl"
    log.write_text('{"Action":"pass","Test":"TestLanzouLivePublishedMirror"}')
    assert finish.mirror_receipt("1.2.9", "c" * 64, upload, verify, log)["verified"] is False


@pytest.fixture
def release_batch(finish, tmp_path, monkeypatch):
    engine = importlib.import_module("release_cleanup")
    # Only replace the OS process query; package validation and deletion are real.
    monkeypatch.setattr(engine, "active_processes", lambda root: [])
    batch = tmp_path / "batch"
    finish.initialize(batch, "1.2.9", None)
    assets = batch / "release"
    assets.mkdir()
    files = {"SunYu_ERP.exe": b"main", "update.exe": b"updater", "start.bat": b"start",
             "README.md": b"readme", "LICENSE": b"license", "config.example.json": b"{}"}
    with zipfile.ZipFile(assets / "SunYu_ERP-windows-x64.zip", "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    sha = lambda value: hashlib.sha256(value).hexdigest()
    meta = {"application": "SunYu_ERP", "format": 1, "version": "1.2.9",
            "archive": {"url": "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.9/SunYu_ERP-windows-x64.zip",
                        "sha256": sha((assets / "SunYu_ERP-windows-x64.zip").read_bytes())},
            "files": {name: sha(files[name]) for name in ("SunYu_ERP.exe", "update.exe")}}
    (assets / "update-manifest-singlefile.json").write_text(json.dumps(meta))
    (assets / "update.exe").write_bytes(files["update.exe"])
    (assets / "SHA256SUMS.txt").write_text("synthetic checksums")
    report = batch / "verification/native.json"
    report.write_text(json.dumps({**native_report(), "archive_sha256": meta["archive"]["sha256"]}))
    (batch / "candidate/Data").mkdir(parents=True)
    (batch / "candidate/Data/customer.exe").write_bytes(b"customer attachment")
    (batch / "candidate/config.json").write_text('{"custom":true}')
    disposable = batch / "candidate/program.exe"
    disposable.write_bytes(b"test executable")
    return batch, assets, report, disposable


def test_successful_publication_automatically_cleans_only_registered_batch(
    finish, release_batch, monkeypatch,
):
    batch, assets, report, disposable = release_batch
    before = {p.name: p.read_bytes() for p in assets.iterdir()}
    monkeypatch.setattr(finish, "verify_github", lambda *args: {"verified": True})
    monkeypatch.setattr(finish, "verify_mirror", lambda *args: {"verified": True})
    result = finish.run_release([sys.executable, "-c", "pass"], batch, assets, [report])
    assert result["status"] == "passed"
    assert not disposable.exists()
    assert (batch / "candidate/Data/customer.exe").read_bytes() == b"customer attachment"
    assert (batch / "candidate/config.json").read_text() == '{"custom":true}'
    assert {p.name: p.read_bytes() for p in assets.iterdir()} == before
    assert report.exists()


@pytest.mark.parametrize("gate", ["github", "mirror", "publication"])
def test_failed_publication_or_distribution_check_keeps_test_program(
    finish, release_batch, monkeypatch, gate,
):
    batch, assets, report, disposable = release_batch
    monkeypatch.setattr(finish, "verify_github",
                        lambda *args: {"verified": gate != "github"})
    monkeypatch.setattr(finish, "verify_mirror",
                        lambda *args: {"verified": gate != "mirror"})
    command = [sys.executable, "-c", "raise SystemExit(3)" if gate == "publication" else "pass"]
    with pytest.raises((ValueError, subprocess.CalledProcessError)):
        finish.run_release(command, batch, assets, [report])
    assert disposable.exists()
    assert not list((batch / "verification").rglob("publication-verified.json"))


@pytest.mark.parametrize("kind", ["file-symlink", "directory-symlink", "hardlink"])
def test_output_cannot_overwrite_data_through_link(finish, tmp_path, kind):
    target = tmp_path / "Data"
    target.mkdir()
    original = target / "config.json"
    original.write_text('{"preserve":true}')
    destination = tmp_path / "output.json"
    if kind == "file-symlink":
        destination.symlink_to(original)
    elif kind == "directory-symlink":
        directory = tmp_path / "linked"
        directory.symlink_to(target, target_is_directory=True)
        destination = directory / "config.json"
    else:
        destination.hardlink_to(original)
    with pytest.raises(ValueError):
        finish.save(destination, {"overwrite": True})
    assert original.read_text() == '{"preserve":true}'


def test_actions_release_downloads_evidence_then_calls_real_finish(
    finish, release_batch, monkeypatch,
):
    batch, assets, report, disposable = release_batch
    commands = []

    def run(args, **kwargs):
        commands.append(args)
        if args[1:3] == ["run", "download"]:
            destination = Path(args[args.index("--dir") + 1])
            for source in (*assets.iterdir(), report):
                name = "verification-result.json" if source == report else source.name
                folder = destination / ("a/_temp/中文 Upgrade" if source == report else "a/SunYu_ERP/dist/release")
                folder.mkdir(parents=True, exist_ok=True)
                (folder / name).write_bytes(source.read_bytes())
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(finish.subprocess, "run", run)
    monkeypatch.setattr(finish.subprocess, "check_output", lambda *a, **kw: json.dumps({
        "path": ".github/workflows/release.yml", "status": "completed", "conclusion": "success",
    }).encode())
    monkeypatch.setattr(finish, "verify_github", lambda *a: {"verified": True})
    monkeypatch.setattr(finish, "verify_mirror", lambda *a: {"verified": True})
    result = finish.finish_actions(batch, "12345")
    assert result["status"] == "passed"
    assert commands[0][1:3] == ["run", "watch"]
    assert not disposable.exists()
    assert (batch / "release/update.exe").exists()
    assert len(list((batch / "verification").rglob("native-0.json"))) == 1


def test_failed_actions_run_does_not_download_or_cleanup(finish, release_batch, monkeypatch):
    batch, _, _, disposable = release_batch

    def failed(args, **kwargs):
        assert args[1:3] == ["run", "watch"]
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(finish.subprocess, "run", failed)
    with pytest.raises(subprocess.CalledProcessError):
        finish.finish_actions(batch, "12345")
    assert disposable.exists()


def test_retry_keeps_prior_reports_and_does_not_reuse_old_success_receipt(
    finish, release_batch, monkeypatch,
):
    batch, assets, report, disposable = release_batch
    monkeypatch.setattr(finish, "verify_github", lambda *a: {"verified": True})
    monkeypatch.setattr(finish, "verify_mirror", lambda *a: {"verified": True})
    finish.finish(batch, assets, [report])
    evidence = {path: path.read_bytes()
                for path in (batch / "verification").glob("release-*/*.json")}
    disposable.write_bytes(b"new failed attempt")
    monkeypatch.setattr(finish, "verify_mirror", lambda *a: {"verified": False})
    with pytest.raises(ValueError):
        finish.finish(batch, assets, [report])
    assert disposable.read_bytes() == b"new failed attempt"
    assert all(path.read_bytes() == value for path, value in evidence.items())
