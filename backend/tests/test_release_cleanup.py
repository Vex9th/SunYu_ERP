from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tarfile
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / '.github/scripts/release_cleanup.py'
VERSION = '1.2.8'
RECEIPT = {'version': VERSION, 'github_verified': True, 'mirror_verified': True,
           'native_verified': True}


@pytest.fixture
def cleanup(monkeypatch):
    assert SCRIPT.is_file(), 'The controlled batch cleanup engine is not implemented'
    spec = importlib.util.spec_from_file_location('release_cleanup', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'active_processes', lambda root: [])
    return module


def put(root, name, content=b'fixture'):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def batch(cleanup, tmp_path):
    root = tmp_path / 'batch'
    cleanup.register_batch(root, VERSION)
    return root


def test_registration_binds_new_directory_and_cannot_overwrite(cleanup, tmp_path):
    root = tmp_path / 'batch'
    record = cleanup.register_batch(root, VERSION)
    assert record['root'] == str(root.resolve())
    assert record['version'] == VERSION
    marker = root / '.sunyu-release-batch.json'
    before = marker.read_bytes()
    with pytest.raises((ValueError, FileExistsError)):
        cleanup.register_batch(root, VERSION)
    assert marker.read_bytes() == before


@pytest.mark.parametrize('version', ['v1.2.8', '1.2', '01.2.8', '1.2.8\n', '../1.2.8'])
def test_invalid_version_cannot_create_directory(cleanup, tmp_path, version):
    root = tmp_path / 'batch'
    with pytest.raises(ValueError, match='version'):
        cleanup.register_batch(root, version)
    assert not root.exists()


@pytest.mark.parametrize('name', ['missing', 'mismatch', 'copied-marker', 'git'])
def test_invalid_batch_identity_prevents_deletion(cleanup, tmp_path, name):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    if name == 'missing':
        (root / '.sunyu-release-batch.json').unlink()
    elif name == 'copied-marker':
        marker = root / '.sunyu-release-batch.json'
        record = json.loads(marker.read_text())
        record['root'] = str(tmp_path / 'another')
        marker.write_text(json.dumps(record))
    elif name == 'git':
        put(root, 'source/.git', b'gitdir: another')
    with pytest.raises((ValueError, RuntimeError)):
        cleanup.clean_batch(root, '1.2.9' if name == 'mismatch' else VERSION, RECEIPT)
    assert target.read_bytes() == b'fixture'


@pytest.mark.parametrize('receipt', [
    {}, {**RECEIPT, 'version': '1.2.9'}, {**RECEIPT, 'github_verified': False},
    {**RECEIPT, 'native_verified': 1}, {**RECEIPT, 'mirror_verified': 'true'},
    {**RECEIPT, 'extra': True},
])
def test_incomplete_or_nonboolean_receipt_never_deletes(cleanup, tmp_path, receipt):
    root = batch(cleanup, tmp_path)
    target = put(root, 'build/temp.obj')
    with pytest.raises(ValueError, match='receipt'):
        cleanup.clean_batch(root, VERSION, receipt)
    assert target.exists()


def test_only_generated_files_are_deleted_and_second_cleanup_is_idempotent(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    targets = ['candidate/program.exe', 'validation/_internal/a.dll',
               'tests/install/a.pyd', 'source/app/cache.pyc', 'build/a.obj',
               'build/a.pkg', 'build/a.pyz', 'worktemp/a.tmp']
    kept = [
        'release/SunYu_ERP.exe', 'official/update.exe', 'source/dist/release/update.exe',
        'reports/report.bin', 'verification/native-test.exe', 'candidate/Data/customer.db',
        'candidate/dAtA/payload.exe', 'candidate/config.JSON', 'build/.env',
        'source/Backups/archive.exe', 'candidate/attachments/upload.exe',
        'candidate/database.sqlite3', 'candidate/database.sqlite3-wal',
        'source/node_modules/package/compiler.exe', 'source/.venv/tool.exe',
        'dependencies/tool.exe', 'candidate/settings.json', 'build/build.log',
        'build/analysis.toc', 'build/notes.txt', 'candidate/index.html',
        'build/events.jsonl',
        'source/test.py', 'source/fix.ps1', 'source/app.js', 'build/change.patch',
        'candidate/image.png', 'candidate/config.bak', 'candidate/unknown.blob',
        'unknown/program.exe',
    ]
    for name in targets + kept:
        put(root, name)
    first = cleanup.clean_batch(root, VERSION, RECEIPT)
    assert first['status'] == 'success'
    assert set(first['deleted']) == set(targets)
    assert all(not (root / name).exists() for name in targets)
    assert all((root / name).read_bytes() == b'fixture' for name in kept)
    assert (root / 'verification/cleanup-plan.json').is_file()
    second = cleanup.clean_batch(root, VERSION, RECEIPT)
    assert second['status'] == 'success'
    assert second['deleted'] == []
    assert all((root / name).read_bytes() == b'fixture' for name in kept)
    saved = json.loads((root / 'verification/cleanup-result.json').read_text())
    assert saved['protected_hashes_unchanged'] is True
    history = list((root / 'verification/cleanup-history').glob('*/cleanup-result.json'))
    assert len(history) == 1
    assert set(json.loads(history[0].read_text())['deleted']) == set(targets)
    assert (history[0].parent / 'cleanup-plan.json').is_file()


def test_archives_with_data_and_all_official_archives_are_preserved(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    archives = {
        'source.zip': 'source/main.py', 'tests/transfer.zip': 'program.exe',
        'tests/customer.zip': 'nested/dAtA/file.bin',
        'tests/config.zip': 'nested/CONFIG.json',
        'tests/database.zip': 'customer.sqlite3-wal',
        'candidate/SunYu_ERP-windows-x64.zip': 'program.exe',
        'build/SunYu_ERP-windows-x64.zip': 'program.exe',
    }
    for name, member in archives.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr(member, b'fixture')
    source = put(root, 'tests/DATA/customer.dat')
    with tarfile.open(root / 'tests/transfer.tar', 'w') as archive:
        archive.add(source, arcname='Data/customer.dat')
    corrupt = put(root, 'tests/corrupt.zip', b'not a zip')
    kept = {name: (root / name).read_bytes() for name in archives
            if name not in {'source.zip', 'tests/transfer.zip'}}
    kept['tests/transfer.tar'] = (root / 'tests/transfer.tar').read_bytes()
    result = cleanup.clean_batch(root, VERSION, RECEIPT)
    assert set(result['deleted']) == {'source.zip', 'tests/transfer.zip'}
    assert all((root / name).read_bytes() == content for name, content in kept.items())
    assert corrupt.read_bytes() == b'not a zip'


@pytest.mark.parametrize('extension', ['json', 'jsonl', 'log', 'txt', 'html', 'png', 'pdf', 'csv'])
@pytest.mark.parametrize('archive_format', ['zip', 'tar'])
def test_archived_verification_evidence_is_preserved(cleanup, tmp_path, extension, archive_format):
    root = batch(cleanup, tmp_path)
    report = put(root, f'verification/verification-result.{extension}', b'verification evidence')
    archive_path = root / f'validation/transfer.{archive_format}'
    archive_path.parent.mkdir()
    if archive_format == 'zip':
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.write(report, arcname=f'verification-result.{extension}')
    else:
        with tarfile.open(archive_path, 'w') as archive:
            archive.add(report, arcname=f'verification-result.{extension}')
    before = archive_path.read_bytes()
    result = cleanup.clean_batch(root, VERSION, RECEIPT)
    assert result['deleted'] == []
    assert archive_path.read_bytes() == before


def test_archive_with_extensionless_report_is_preserved(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    archive_path = root / 'tests/transfer.zip'
    archive_path.parent.mkdir()
    with zipfile.ZipFile(archive_path, 'w') as archive:
        archive.writestr('reports/acceptance-result', b'verification evidence')
    before = archive_path.read_bytes()
    cleanup.clean_batch(root, VERSION, RECEIPT)
    assert archive_path.read_bytes() == before


def test_links_and_internal_link_targets_are_protected(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    internal = put(root, 'build/custom-data/valuable.exe')
    outside = put(tmp_path, 'outside/valuable.exe')
    (root / 'candidate').mkdir()
    (root / 'candidate/DATA').symlink_to(internal.parent, target_is_directory=True)
    (root / 'candidate/external').symlink_to(outside.parent, target_is_directory=True)
    (root / 'candidate/linked.exe').symlink_to(outside)
    hardlink = root / 'candidate/hardlink.exe'
    os.link(outside, hardlink)
    normal = put(root, 'candidate/program.exe')
    cleanup.clean_batch(root, VERSION, RECEIPT)
    assert not normal.exists()
    assert internal.read_bytes() == outside.read_bytes() == b'fixture'
    assert hardlink.read_bytes() == b'fixture'
    assert (root / 'candidate/DATA').is_symlink()
    assert (root / 'candidate/external').is_symlink()
    assert (root / 'candidate/linked.exe').is_symlink()


def test_root_parent_symlink_and_filesystem_root_are_rejected(cleanup, tmp_path):
    real = tmp_path / 'real'
    real.mkdir()
    alias = tmp_path / 'alias'
    alias.symlink_to(real, target_is_directory=True)
    for path in [Path(Path.cwd().anchor), SCRIPT.parents[2], alias / 'batch']:
        with pytest.raises((ValueError, FileExistsError)):
            cleanup.register_batch(path, VERSION)
    assert not (real / 'batch').exists()


def test_report_directory_link_cannot_write_outside_batch(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (root / 'verification').symlink_to(outside, target_is_directory=True)
    target = put(root, 'candidate/program.exe')
    with pytest.raises((ValueError, RuntimeError)):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()
    assert list(outside.iterdir()) == []


def test_activity_or_probe_failure_stops_and_records_reason(cleanup, tmp_path, monkeypatch):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    monkeypatch.setattr(cleanup, 'active_processes', lambda root: [
        {'pid': 43, 'command': 'service --password must-not-be-logged'}])
    with pytest.raises(RuntimeError, match='43'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()
    result = json.loads((root / 'verification/cleanup-result.json').read_text())
    assert result['status'] == 'failed'
    assert '43' in result['error']
    assert 'must-not-be-logged' not in result['error']
    def failure(root):
        raise RuntimeError('process scan failed')
    monkeypatch.setattr(cleanup, 'active_processes', failure)
    with pytest.raises(RuntimeError, match='scan failed'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()


def test_retained_file_change_before_deletion_is_detected(cleanup, tmp_path, monkeypatch):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    protected = put(root, 'candidate/config.json')
    count = 0
    def probe(root):
        nonlocal count
        count += 1
        if count == 2:
            protected.write_bytes(b'changed concurrently')
        return []
    monkeypatch.setattr(cleanup, 'active_processes', probe)
    with pytest.raises(RuntimeError, match='changed'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()
    assert protected.read_bytes() == b'changed concurrently'


def test_process_probe_ignores_ancestors_and_does_not_match_sibling(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('release_cleanup_process', SCRIPT)
    assert SCRIPT.is_file(), 'The controlled batch cleanup engine is not implemented'
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    root = tmp_path / 'batch'
    monkeypatch.setattr(cleanup.sys, 'platform', 'linux')
    text = (f'{os.getpid()} 12 python cleanup {root}\n12 1 shell {root}\n'
            f'55 1 python {root}/tests/smoke.py\n56 1 python {root}-old/service.py\n')
    monkeypatch.setattr(cleanup.subprocess, 'run', lambda *a, **kw:
                        subprocess.CompletedProcess(a, 0, text, ''))
    assert [row['pid'] for row in cleanup.active_processes(root)] == [55]


def test_replaced_candidate_is_detected_before_unlink(cleanup, tmp_path, monkeypatch):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe', b'original')
    original_check = cleanup._regular
    def check(path):
        if path == target:
            target.write_bytes(b'replaced')  # 同 inode、同长度不能绕过目标校验。
        original_check(path)
    monkeypatch.setattr(cleanup, '_regular', check)
    with pytest.raises(RuntimeError, match='changed'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.read_bytes() == b'replaced'


def test_case_insensitive_release_path_is_preserved(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    protected = put(root, 'source/Dist/Release/update.exe')
    cleanup.clean_batch(root, VERSION, RECEIPT)
    assert protected.read_bytes() == b'fixture'


def test_report_file_link_and_existing_lock_block_cleanup(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    outside = put(tmp_path, 'outside.json', b'keep')
    (root / 'verification').mkdir()
    report = root / 'verification/cleanup-plan.json'
    report.symlink_to(outside)
    with pytest.raises(ValueError):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert outside.read_bytes() == b'keep'
    report.unlink()
    (root / '.sunyu-release-cleanup.lock').symlink_to(outside)
    with pytest.raises((ValueError, FileExistsError)):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()
    assert outside.read_bytes() == b'keep'


def test_unlink_failure_is_recorded_and_can_retry(cleanup, tmp_path, monkeypatch):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    original = Path.unlink
    def failure(path, *args, **kwargs):
        if path == target:
            raise PermissionError('candidate is locked')
        return original(path, *args, **kwargs)
    with monkeypatch.context() as local:
        local.setattr(Path, 'unlink', failure)
        with pytest.raises(PermissionError, match='locked'):
            cleanup.clean_batch(root, VERSION, RECEIPT)
    report = json.loads((root / 'verification/cleanup-result.json').read_text())
    assert report['status'] == 'failed'
    assert report['deleted'] == []
    assert 'locked' in report['error']
    assert cleanup.clean_batch(root, VERSION, RECEIPT)['deleted'] == ['candidate/program.exe']


def test_preexisting_foreign_report_is_not_overwritten(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    target = put(root, 'candidate/program.exe')
    report = put(root, 'verification/cleanup-result.json', b'{"customer_note":"keep"}')
    with pytest.raises(ValueError, match='report'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert target.exists()
    assert report.read_bytes() == b'{"customer_note":"keep"}'


def test_windows_probe_reads_executable_and_rejects_malformed_table(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('release_cleanup_windows', SCRIPT)
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    monkeypatch.setattr(cleanup.sys, 'platform', 'win32')
    root = tmp_path / 'batch'
    rows = [
        {'ProcessId': os.getpid(), 'ParentProcessId': 0, 'CommandLine': str(root)},
        {'ProcessId': 44, 'ParentProcessId': 0, 'ExecutablePath': f'{root}/candidate/APP.exe',
         'CommandLine': None},
    ]
    encoded = ('\ufeff' + json.dumps(rows)).encode('utf-8')
    monkeypatch.setattr(cleanup.subprocess, 'run', lambda *a, **kw:
                        subprocess.CompletedProcess(a, 0, encoded.decode(kw['encoding']), ''))
    assert [row['pid'] for row in cleanup.active_processes(root)] == [44]
    monkeypatch.setattr(cleanup.subprocess, 'run', lambda *a, **kw:
                        subprocess.CompletedProcess(a, 0, '[]', ''))
    with pytest.raises(RuntimeError, match='scan failed'):
        cleanup.active_processes(root)


def test_process_scan_detects_a_real_batch_child(tmp_path):
    spec = importlib.util.spec_from_file_location('release_cleanup_live', SCRIPT)
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    root = tmp_path / 'batch'
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', str(root)])
    try:
        assert child.pid in {row['pid'] for row in cleanup.active_processes(root)}
    finally:
        child.terminate()
        child.wait(timeout=10)


def test_process_scan_detects_batch_working_directory_without_batch_argv(tmp_path):
    spec = importlib.util.spec_from_file_location('release_cleanup_cwd_live', SCRIPT)
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    root = tmp_path / 'batch'
    source = root / 'source'
    source.mkdir(parents=True)
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=source)
    try:
        assert child.pid in {row['pid'] for row in cleanup.active_processes(root)}
    finally:
        child.terminate()
        child.wait(timeout=10)


@pytest.mark.parametrize('unreadable', ['cwd', 'empty_cwd', 'owner', 'empty_owner', 'missing_dependency'])
def test_unreadable_process_working_directory_cannot_mean_idle(tmp_path, monkeypatch, unreadable):
    spec = importlib.util.spec_from_file_location('release_cleanup_cwd_denied', SCRIPT)
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    monkeypatch.setattr(cleanup.sys, 'platform', 'linux')
    text = f'{os.getpid()} 0 python cleanup\n55 0 python -m pytest\n'
    monkeypatch.setattr(cleanup.subprocess, 'run', lambda *a, **kw:
                        subprocess.CompletedProcess(a, 0, text, ''))
    class AccessDenied(Exception):
        pass
    class NoSuchProcess(Exception):
        pass
    def denied():
        raise AccessDenied('test account access denied')
    def process(pid):
        return SimpleNamespace(
            username=(denied if unreadable == 'owner' and pid == 55 else
                      lambda: '' if unreadable == 'empty_owner' and pid == 55 else 'current-account'),
            cwd=(lambda: '') if unreadable == 'empty_cwd' else denied,
        )
    dependency = SimpleNamespace(Process=process, AccessDenied=AccessDenied, NoSuchProcess=NoSuchProcess)
    monkeypatch.setitem(sys.modules, 'psutil', None if unreadable == 'missing_dependency' else dependency)
    with pytest.raises(RuntimeError, match='(PID 55|requirements-release)'):
        cleanup.active_processes(tmp_path / 'batch')


def test_cwd_probe_skips_other_accounts_and_known_windows_system_pids(cleanup, tmp_path, monkeypatch):
    class AccessDenied(Exception):
        pass
    class NoSuchProcess(Exception):
        pass
    def denied():
        raise AccessDenied('system protected')
    def process(pid):
        return SimpleNamespace(
            username=denied if pid in {0, 4} else lambda: 'ours' if pid == os.getpid() else 'another',
            cwd=denied,
        )
    dependency = SimpleNamespace(Process=process, AccessDenied=AccessDenied, NoSuchProcess=NoSuchProcess)
    monkeypatch.setitem(sys.modules, 'psutil', dependency)
    monkeypatch.setattr(cleanup.sys, 'platform', 'win32')
    assert cleanup._cwd_processes(tmp_path, [{'pid': 0}, {'pid': 4}, {'pid': 55}], set()) == []


def test_history_link_refuses_retry_without_overwriting_previous_result(cleanup, tmp_path):
    root = batch(cleanup, tmp_path)
    put(root, 'candidate/program.exe')
    cleanup.clean_batch(root, VERSION, RECEIPT)
    previous = (root / 'verification/cleanup-result.json').read_bytes()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (root / 'verification/cleanup-history').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='history'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    assert (root / 'verification/cleanup-result.json').read_bytes() == previous
    assert not list(outside.iterdir())


def test_long_cleanup_checks_new_activity_before_next_group(cleanup, tmp_path, monkeypatch):
    root = batch(cleanup, tmp_path)
    for index in range(65):
        put(root, f'candidate/app-{index:03d}.exe')
    calls = 0
    def probe(root):
        nonlocal calls
        calls += 1
        return [{'pid': 87}] if calls >= 3 else []
    monkeypatch.setattr(cleanup, 'active_processes', probe)
    monkeypatch.setattr(time, 'monotonic', lambda: 0)
    with pytest.raises(RuntimeError, match='87'):
        cleanup.clean_batch(root, VERSION, RECEIPT)
    remaining = list((root / 'candidate').glob('*.exe'))
    assert len(remaining) == 1
    result = json.loads((root / 'verification/cleanup-result.json').read_text())
    assert len(result['deleted']) == 64
