"""只清理新登记发布批次中的已知生成物；回执真实性由调用方核验。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

MARKER = '.sunyu-release-batch.json'
LOCK = '.sunyu-release-cleanup.lock'
REPORTS = {'verification/cleanup-plan.json', 'verification/cleanup-result.json'}
SCOPES = {'source', 'build', 'worktemp', 'candidate', 'validation', 'tests'}
PROTECTED_DIRS = {'data', 'backups', 'backup', 'attachments', 'uploads', 'node_modules',
                  '.venv', 'venv', 'dependencies', '.git'}
SCRIPT_SUFFIXES = {'.py', '.pyw', '.sh', '.ps1', '.bat', '.cmd', '.js', '.mjs', '.cjs',
                   '.ts', '.tsx', '.jsx'}
KEEP_SUFFIXES = {'.json', '.jsonl', '.log', '.toc', '.txt', '.html', '.htm', '.png', '.jpg',
                 '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.tiff', '.avif',
                 '.patch', '.diff', '.bak', '.backup', '.pdf', '.csv', '.xml', '.md',
                 '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb'} | SCRIPT_SUFFIXES
GENERATED = {'.exe', '.dll', '.pyd', '.pyc', '.pyo', '.obj', '.o', '.pkg', '.pyz',
             '.pdb', '.lib', '.exp', '.ilk', '.res', '.tmp'}
ARCHIVES = {'.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz'}


def _link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _root(root: Path, version: str) -> Path:
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Invalid version: expected MAJOR.MINOR.PATCH')
    root = Path(os.path.abspath(root))
    for part in (root, *root.parents):
        if os.path.lexists(part) and _link(part):
            raise ValueError(f'Batch path contains a link: {part}')
    root = root.resolve()
    if root == Path(root.anchor) or root == Path(__file__).resolve().parents[2]:
        raise ValueError('Filesystem root and repository root cannot be batches')
    if root.exists() and not root.is_dir():
        raise ValueError('Batch root must be a directory')
    return root


def _identity(root: Path, version: str) -> dict:
    return {'application': 'SunYu_ERP', 'format': 1, 'root': str(root), 'version': version}


def register_batch(root: Path, version: str) -> dict:
    """独占新建批次；现存目录（包括空目录）不可追认。"""
    root = _root(root, version)
    root.mkdir()  # 不创建/接管父目录，不覆盖已有批次。
    record = _identity(root, version)
    with (root / MARKER).open('x', encoding='utf-8') as output:
        json.dump(record, output, ensure_ascii=False, indent=2)
    return record


def checked_batch(root: Path, version: str) -> Path:
    """只接受登记内容、位置、版本一致且无链接的批次。"""
    root = _root(root, version)
    marker = root / MARKER
    if not marker.exists():
        raise ValueError('Batch has no registration marker')
    _regular(marker)
    if json.loads(marker.read_text(encoding='utf-8')) != _identity(root, version):
        raise ValueError('Batch registration root or version mismatch')
    return root


def _regular(path: Path) -> None:
    info = path.lstat()
    if _link(path) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError(f'Expected a private regular file: {path}')


def _write(path: Path, value: dict) -> None:
    if path.parent.resolve() != path.parent or _link(path.parent):
        raise ValueError(f'Report directory contains a link: {path.parent}')
    if os.path.lexists(path):
        _regular(path)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                     prefix='.cleanup-', suffix='.tmp', delete=False) as output:
        temporary = Path(output.name)
        json.dump(value, output, ensure_ascii=False, indent=2)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _archive_reports(report_dir: Path) -> None:
    previous = [report_dir / Path(name).name for name in sorted(REPORTS)
                if (report_dir / Path(name).name).exists()]
    if not previous:
        return
    history = report_dir / 'cleanup-history'
    if os.path.lexists(history) and (_link(history) or not history.is_dir()):
        raise ValueError('Cleanup history directory must not be a link or file')
    if history.resolve() != history:
        raise ValueError('Cleanup history directory escaped its batch')
    history.mkdir(exist_ok=True)
    attempt = history / uuid.uuid4().hex
    attempt.mkdir()
    for source in previous:
        _regular(source)
        with (attempt / source.name).open('xb') as output:
            output.write(source.read_bytes())


def _cwd_processes(root: Path, rows: list[dict], ignored: set[int]) -> list[dict]:
    """其他账号由进程表匹配；本账号的 cwd 必须可验证，消失的进程可跳过。"""
    try:
        import psutil
    except ImportError as error:
        raise RuntimeError('Working directory scan requires requirements-release.txt (psutil)') from error
    try:
        owner = psutil.Process(os.getpid()).username()
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError) as error:
        raise RuntimeError('Cannot identify the cleanup account') from error
    if not owner:
        raise RuntimeError('Cannot identify the cleanup account')
    found = []
    for row in rows:
        pid = row['pid']
        if pid in ignored or (sys.platform == 'win32' and pid in {0, 4}):
            continue
        try:
            process = psutil.Process(pid)
            account = process.username()
            if not account:
                raise RuntimeError(f'Cannot identify account for PID {pid}')
            if account.casefold() != owner.casefold():
                continue
            working = process.cwd()
            if not working:
                raise RuntimeError(f'Cannot inspect working directory for PID {pid}')
            if Path(working).resolve().is_relative_to(root):
                found.append(row)
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError) as error:
            raise RuntimeError(f'Cannot inspect account or working directory for PID {pid}') from error
    return found


def active_processes(root: Path) -> list[dict]:
    """读取当前进程表；探测失败即抛错，调用方不得将其当作无占用。"""
    windows = sys.platform == 'win32'
    command = (['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                ('$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '
                'Get-CimInstance Win32_Process | '
                'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress')]
               if windows else ['ps', '-axo', 'pid=,ppid=,command='])
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8-sig', check=True, timeout=30)
        if windows:
            payload = json.loads(result.stdout)
            payload = payload if isinstance(payload, list) else [payload]
            rows = [{'pid': int(p['ProcessId']), 'parent': int(p['ParentProcessId']),
                     'command': f"{p.get('ExecutablePath') or ''} {p.get('CommandLine') or ''}"} for p in payload]
        else:
            rows = []
            for line in result.stdout.splitlines():
                pid, parent, text = line.strip().split(None, 2)
                rows.append({'pid': int(pid), 'parent': int(parent), 'command': text})
        if not rows or os.getpid() not in {p['pid'] for p in rows}:
            raise ValueError('Incomplete process table')
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError(f'Process scan failed: {error}') from error
    parents = {row['pid']: row['parent'] for row in rows}
    ignored, current = set(), os.getpid()
    while current and current not in ignored:
        ignored.add(current)
        current = parents.get(current, 0)
    pattern = re.compile(re.escape(str(root).replace('\\', '/')) + r"""(?=$|[/\s"'=,;])""",
                         re.IGNORECASE if windows else 0)
    matching = [row for row in rows if row['pid'] not in ignored
                and pattern.search(row['command'].replace('\\', '/'))]
    return matching or _cwd_processes(root, rows, ignored)


def _idle(root: Path) -> None:
    running = active_processes(root)
    if running:
        raise RuntimeError(f'Active batch processes prevent cleanup; PIDs: {[row["pid"] for row in running]}')


def _protected(name: str) -> bool:
    path = Path(name.replace('\\', '/'))
    parts = [part.lower() for part in path.parts]
    return (any(part in PROTECTED_DIRS for part in parts)
            or path.name.lower() in {'config.json', 'sunyu_erp-windows-x64.zip'}
            or any(part.startswith('.env') for part in parts)
            or path.suffix.lower() in KEEP_SUFFIXES
            or re.search(r'\.(db|sqlite|sqlite3)(-(wal|shm|journal))?$', path.name.lower()) is not None)


def _archive_safe(path: Path) -> bool:
    try:
        if path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                return bool(members) and all(
                    not _protected_archive_name(item.filename)
                    and not stat.S_ISLNK(item.external_attr >> 16) for item in members)
        with tarfile.open(path) as archive:
            members = archive.getmembers()
            return bool(members) and all(not _protected_archive_name(item.name)
                                         and (item.isfile() or item.isdir()) for item in members)
    except (OSError, ValueError, zipfile.BadZipFile, tarfile.TarError):
        return False


def _protected_archive_name(name: str) -> bool:
    path = Path(name.replace('\\', '/'))
    parts = [part.lower() for part in path.parts]
    # 归档中的报告与数据也须保留；普通脚本不阻止源码传输包回收。
    return (path.is_absolute() or '..' in parts
            or any(part in PROTECTED_DIRS | {'reports', 'verification', 'logs'}
                   or part.startswith('.env') for part in parts)
            or path.name.lower() in {'config.json', 'sunyu_erp-windows-x64.zip'}
            or re.search(r'\.(db|sqlite|sqlite3)(-(wal|shm|journal))?$', path.name.lower()) is not None
            or path.suffix.lower() in ARCHIVES | (KEEP_SUFFIXES - SCRIPT_SUFFIXES))


def _inventory(root: Path) -> tuple[dict, list[Path]]:
    def failed(error):
        raise error
    entries, targets = {}, []
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        parent = Path(directory)
        for name in dirs[:] + files:
            path = parent / name
            relative = path.relative_to(root).as_posix()
            if name.lower() == '.git':
                raise ValueError(f'Repository metadata exists in batch: {relative}')
            if relative in REPORTS | {LOCK}:
                _regular(path)
                continue
            if _link(path):
                if name in dirs:
                    dirs.remove(name)
                entries[relative] = {'link': os.readlink(path)}
                resolved = path.resolve()
                if resolved.is_relative_to(root):
                    targets.append(resolved)
            elif path.is_file():
                info = path.stat()
                with path.open('rb') as source:
                    digest = hashlib.file_digest(source, 'sha256').hexdigest()
                entries[relative] = {'sha256': digest, 'device': info.st_dev,
                                     'inode': info.st_ino, 'size': info.st_size, 'links': info.st_nlink}
            elif not path.is_dir():
                entries[relative] = {'special': path.lstat().st_mode}
    return entries, targets


def _removable(root: Path, name: str, entry: dict, links: list[Path]) -> bool:
    path, parts = root / name, Path(name.lower()).parts
    if entry.get('links') != 1 or _protected(name):
        return False
    if any(path.is_relative_to(target) for target in links):
        return False
    if parts[0] in {'release', 'official', 'reports', 'verification'} or name.lower().startswith('source/dist/release/'):
        return False
    scoped = parts[0] in SCOPES
    if path.suffix.lower() in ARCHIVES:
        allowed = scoped or name == 'source.zip' or re.fullmatch(r'(test|transfer)[-_][^/]+\.zip', name)
        return bool(allowed and _archive_safe(path))
    return scoped and path.suffix.lower() in GENERATED


def clean_batch(root: Path, version: str, receipt: dict) -> dict:
    """校验、记录计划、删除已知生成物并核对保留文件；失败抛错且保留失败报告。"""
    root = checked_batch(root, version)
    expected = {'version': version, 'github_verified': True, 'mirror_verified': True, 'native_verified': True}
    if not isinstance(receipt, dict) or receipt != expected or any(
            receipt.get(key) is not True for key in expected if key != 'version'):
        raise ValueError('Invalid verification receipt: every verification must be True')
    report_dir = root / 'verification'
    if os.path.lexists(report_dir) and (_link(report_dir) or not report_dir.is_dir()):
        raise ValueError('Verification report directory must not be a link or file')
    report_dir.mkdir(exist_ok=True)
    for name in REPORTS:
        if os.path.lexists(root / name):
            _regular(root / name)
            previous = json.loads((root / name).read_text(encoding='utf-8'))
            if not isinstance(previous, dict) or any(
                    previous.get(key) != value for key, value in _identity(root, version).items()):
                raise ValueError(f'Existing report does not belong to this cleanup batch: {name}')
    lock = root / LOCK
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        _archive_reports(report_dir)
    except Exception:
        lock.unlink()
        raise
    result = {**_identity(root, version), 'status': 'failed', 'deleted': [],
              'protected_hashes_unchanged': False}
    try:
        _idle(root)
        before, links = _inventory(root)
        delete = {name: item for name, item in before.items() if _removable(root, name, item, links)}
        preserve = {name: item for name, item in before.items() if name not in delete}
        _write(report_dir / 'cleanup-plan.json', {**_identity(root, version), 'receipt': receipt,
                                                 'delete': delete, 'preserve': preserve})
        _idle(root)
        last_check = time.monotonic()
        current, _ = _inventory(root)
        if current != before:
            raise RuntimeError('Batch files changed before deletion')
        for index, (name, item) in enumerate(delete.items()):
            if (index and index % 64 == 0) or time.monotonic() - last_check >= 2:
                _idle(root)
                last_check = time.monotonic()
            path = root / name
            if path.resolve() != path:
                raise RuntimeError(f'Deletion path changed to a link: {name}')
            _regular(path)
            info = path.stat()
            if (info.st_dev, info.st_ino, info.st_size) != (item['device'], item['inode'], item['size']):
                raise RuntimeError(f'Deletion target changed: {name}')
            with path.open('rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                    raise RuntimeError(f'Deletion target contents changed: {name}')
            path.unlink()
            result['deleted'].append(name)
        _idle(root)
        after, _ = _inventory(root)
        if after != preserve:
            raise RuntimeError('Preserved files changed during cleanup')
        result.update(status='success', protected_hashes_unchanged=True)
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        try:
            _write(report_dir / 'cleanup-result.json', result)
        finally:
            lock.unlink()
    return result
