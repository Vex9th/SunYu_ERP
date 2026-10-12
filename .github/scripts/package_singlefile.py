"""打包 Python 单 EXE 与独立更新器，不读取业务数据或本机配置。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import zipfile
from pathlib import Path

ARCHIVE = "SunYu_ERP-windows-x64.zip"
MANIFEST = "update-manifest-singlefile.json"
PACKAGE_FILES = (
    "SunYu_ERP.exe", "update.exe", "start.bat", "README.md", "LICENSE", "config.example.json",
)
ASSETS = (ARCHIVE, "update.exe", MANIFEST, "SHA256SUMS.txt")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def read_regular(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Not a regular input file: {path}")
    return path.read_bytes()


def require_windows_amd64(payload: bytes, name: str) -> None:
    if len(payload) < 64 or payload[:2] != b"MZ":
        raise ValueError(f"Invalid Windows executable: {name}")
    offset = struct.unpack_from("<I", payload, 0x3C)[0]
    if (offset + 26 > len(payload) or payload[offset:offset + 4] != b"PE\0\0"
            or struct.unpack_from("<H", payload, offset + 4)[0] != 0x8664
            or struct.unpack_from("<H", payload, offset + 24)[0] != 0x20B):
        raise ValueError(f"Expected Windows AMD64 PE32+ executable: {name}")


def build_package(
    version: str, executable: Path, updater: Path, output: Path, project: Path,
) -> None:
    if not VERSION.fullmatch(version):
        raise ValueError("Invalid version: expected MAJOR.MINOR.PATCH")
    # 先完整读取并校验固定文件集合，再创建输出，避免把配置或历史产物带入包中。
    files = {"SunYu_ERP.exe": read_regular(executable), "update.exe": read_regular(updater)}
    for name, payload in files.items():
        require_windows_amd64(payload, name)
    files.update({name: read_regular(project / name) for name in PACKAGE_FILES[2:]})
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in PACKAGE_FILES:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])
    metadata = {
        "format": 1,
        "application": "SunYu_ERP",
        "version": version,
        "archive": {
            "url": f"https://github.com/Vex9th/SunYu_ERP/releases/download/v{version}/{ARCHIVE}",
            "sha256": sha256(archive_bytes.getvalue()),
        },
        "files": {name: sha256(files[name]) for name in PACKAGE_FILES[:2]},
    }
    assets = {
        ARCHIVE: archive_bytes.getvalue(),
        "update.exe": files["update.exe"],
        MANIFEST: (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    }
    assets["SHA256SUMS.txt"] = "".join(
        f"{sha256(payload)}  {name}\n" for name, payload in sorted(assets.items())
    ).encode("ascii")
    output.mkdir(parents=True, exist_ok=False)
    for name, payload in assets.items():
        with (output / name).open("xb") as artifact:
            artifact.write(payload)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--updater", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    build_package(args.version, args.exe, args.updater, args.output, args.project_root)
    print(f"Verified singlefile package {args.version}: {args.output}")


if __name__ == "__main__":
    main()
