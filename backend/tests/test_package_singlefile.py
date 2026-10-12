from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import zipfile
from pathlib import Path

import pytest


def load_packager():
    path = Path(__file__).resolve().parents[2] / ".github/scripts/package_singlefile.py"
    spec = importlib.util.spec_from_file_location("package_singlefile", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def windows_exe(marker: bytes = b"main") -> bytes:
    data = bytearray(512)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<H", data, 0x84, 0x8664)
    struct.pack_into("<H", data, 0x98, 0x20B)
    return bytes(data) + marker


@pytest.fixture
def inputs(tmp_path: Path):
    project = tmp_path / "project"
    project.mkdir()
    for name in ("start.bat", "README.md", "LICENSE", "config.example.json"):
        (project / name).write_text(name, encoding="utf-8")
    (project / "Data").mkdir()
    (project / "Data/customer.txt").write_text("must not be packaged")
    (project / "config.json").write_text("must not be packaged")
    main = tmp_path / "main.exe"
    updater = tmp_path / "updater.exe"
    main.write_bytes(windows_exe())
    updater.write_bytes(windows_exe(b"updater"))
    return project, main, updater, tmp_path / "output"


def test_singlefile_package_has_exact_layout_and_consistent_hashes(inputs):
    module = load_packager()
    project, main, updater, output = inputs
    module.build_package("1.2.5", main, updater, output, project)
    assert sorted(item.name for item in output.iterdir()) == sorted(module.ASSETS)
    with zipfile.ZipFile(output / module.ARCHIVE) as archive:
        assert archive.testzip() is None
        assert sorted(archive.namelist()) == sorted(module.PACKAGE_FILES)
        assert all(not info.is_dir() for info in archive.infolist())
        assert archive.read("SunYu_ERP.exe") == main.read_bytes()
        assert archive.read("update.exe") == updater.read_bytes()
    metadata = json.loads((output / module.MANIFEST).read_text())
    assert metadata == {
        "format": 1, "application": "SunYu_ERP", "version": "1.2.5",
        "archive": {
            "url": "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.5/SunYu_ERP-windows-x64.zip",
            "sha256": hashlib.sha256((output / module.ARCHIVE).read_bytes()).hexdigest(),
        },
        "files": {
            "SunYu_ERP.exe": hashlib.sha256(main.read_bytes()).hexdigest(),
            "update.exe": hashlib.sha256(updater.read_bytes()).hexdigest(),
        },
    }
    assert (output / "update.exe").read_bytes() == updater.read_bytes()
    hashes = dict(line.split("  ")[::-1] for line in (output / "SHA256SUMS.txt").read_text().splitlines())
    assert set(hashes) == {module.ARCHIVE, module.MANIFEST, "update.exe"}
    for name, digest in hashes.items():
        assert digest == hashlib.sha256((output / name).read_bytes()).hexdigest()


@pytest.mark.parametrize("bad_input", ["main", "updater", "missing-document", "version"])
def test_bad_package_inputs_create_no_output(inputs, bad_input):
    module = load_packager()
    project, main, updater, output = inputs
    version = "1.2.5"
    if bad_input == "main":
        main.write_bytes(b"not an executable")
    elif bad_input == "updater":
        payload = bytearray(windows_exe())
        struct.pack_into("<H", payload, 0x84, 0x14C)
        updater.write_bytes(payload)
    elif bad_input == "missing-document":
        (project / "README.md").unlink()
    else:
        version = "1.2.5/../../other"
    with pytest.raises((ValueError, FileNotFoundError)):
        module.build_package(version, main, updater, output, project)
    assert not output.exists()


def test_existing_output_is_never_overwritten(inputs):
    module = load_packager()
    project, main, updater, output = inputs
    output.mkdir()
    marker = output / "customer.txt"
    marker.write_bytes(b"preserve")
    with pytest.raises(FileExistsError):
        module.build_package("1.2.5", main, updater, output, project)
    assert marker.read_bytes() == b"preserve"
    assert list(output.iterdir()) == [marker]
