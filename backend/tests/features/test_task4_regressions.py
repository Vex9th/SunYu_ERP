from datetime import timedelta

from backend.app.features import backups
from backend.tests.features.test_backups import NOW, _connection, _settings


def test_prune_skips_hashing_unexpired_middle_backups(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    connection = _connection(settings)
    for days in range(5):
        backups.create_backup(connection, settings, now=NOW + timedelta(days=days))
    original = backups._verify_backup_contents
    calls = []
    def verify(path):
        calls.append(path)
        return original(path)
    monkeypatch.setattr(backups, '_verify_backup_contents', verify)
    assert backups.prune_backups(settings.backup_dir, 30, now=NOW + timedelta(days=5)) == []
    assert len(calls) == 2
    connection.close()


def test_restart_marks_running_interrupted_without_removing_unknown_directory(tmp_path):
    from backend.app.features.system import recover_interrupted_backups
    settings = _settings(tmp_path)
    connection = _connection(settings)
    unknown = tmp_path / '.incomplete-unknown'
    unknown.mkdir()
    connection.execute("INSERT INTO backup_runs(started_at,status,target_path) VALUES (?, 'running', ?)", (NOW.isoformat(), str(unknown)))
    recover_interrupted_backups(connection)
    connection.execute("INSERT INTO backup_tasks(id,status,phase,started_at) VALUES('interrupted-task','running','creating',?)", (NOW.isoformat(),))
    recover_interrupted_backups(connection)
    assert connection.execute("SELECT status FROM backup_tasks WHERE id='interrupted-task'").fetchone()['status'] == 'interrupted'
    row = connection.execute('SELECT status,error_message FROM backup_runs').fetchone()
    assert row['status'] == 'failed'
    assert row['error_message'] == 'Backup interrupted by service restart'
    assert unknown.exists()
    connection.close()


def test_background_backup_returns_while_slow_and_duplicate_reuses_task(tmp_path):
    from threading import Event
    from time import monotonic, sleep

    from fastapi.testclient import TestClient

    from backend.app.main import create_app
    from backend.tests.features.test_system import (
        _login,
        _noop_scheduler_factory,
        _write_config,
    )
    entered, release = Event(), Event()
    def slow(connection, settings, *, now):
        entered.set()
        assert release.wait(5)
        return backups.create_backup(connection, settings, now=now)
    config = tmp_path / 'config.json'
    _write_config(config, backup_dir='Backups')
    app = create_app(config_path=config, scheduler_factory=_noop_scheduler_factory, backup_creator=slow)
    with TestClient(app) as client:
        _login(client)
        started = client.post('/api/system/backup-tasks')
        assert started.status_code == 202
        task_id = started.json()['task_id']
        assert entered.wait(2)
        try:
            start = monotonic()
            duplicate = client.post('/api/system/backup-tasks')
            assert monotonic() - start < 1
            assert duplicate.json()['task_id'] == task_id
            assert client.get('/api/health').status_code == 200
            assert client.get(f'/api/system/backup-tasks/{task_id}').json()['status'] == 'running'
        finally:
            release.set()
        for _ in range(100):
            result = client.get(f'/api/system/backup-tasks/{task_id}').json()
            if result['status'] != 'running':
                break
            sleep(.01)
        assert result['status'] == 'success'


def test_search_reuses_persistent_version_text_and_invalidates_changed_file(tmp_path, monkeypatch):
    from backend.app.features import documents
    from backend.tests.features.test_documents import _build_harness, _create_document
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        created = _create_document(client, category='planning_minutes', title='会议纪要', filename='minutes.txt', content=b'old content', content_type='text/plain')
        assert created.status_code == 201
        original = documents._read_minutes_search_text
        calls = []
        def read(*args, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)
        monkeypatch.setattr(documents, '_read_minutes_search_text', read)
        assert client.get('/api/projects/P-001/documents?search=old').json()['total'] == 1
        assert client.get('/api/projects/P-001/documents?search=old').json()['total'] == 1
        assert len(calls) == 1
        path = next((harness.settings.data_dir / 'Projects').rglob('*.txt'))
        path.write_bytes(b'new content')
        assert client.get('/api/projects/P-001/documents?search=new').json()['total'] == 1
        assert len(calls) == 2


def test_document_upload_does_not_block_event_loop(tmp_path, monkeypatch):
    import asyncio
    from threading import Event

    import httpx

    from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
    from backend.app.features import documents
    from backend.tests.features.test_documents import _build_harness
    harness = _build_harness(tmp_path)
    entered, release = Event(), Event()
    original = documents._stage_upload
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(documents, '_stage_upload', slow)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=harness.app), base_url='http://test', cookies={SESSION_COOKIE_NAME: create_session_token(harness.settings.session_secret)}) as client:
            task = asyncio.create_task(client.post('/api/projects/P-001/documents', headers={'Idempotency-Key': '10000000-0000-4000-8000-000000000001'}, data={'category': 'mechanical_design', 'title': 'large drawing'}, files={'file': ('drawing.dwg', b'x' * (2 * 1024 * 1024), 'application/acad')}))
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                response = await asyncio.wait_for(client.get('/api/projects/P-001/documents'), .5)
                assert response.status_code == 200
            finally:
                release.set()
            assert (await task).status_code == 201
    asyncio.run(run())


def test_cached_search_preserves_historical_versions(tmp_path):
    from backend.tests.features.test_documents import (
        _build_harness,
        _create_document,
    )
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        first = _create_document(client, category='planning_minutes', title='minutes', filename='minutes.txt', content=b'historical phrase', content_type='text/plain')
        document_id = first.json()['id']
        second = client.post(f'/api/projects/P-001/documents/{document_id}/versions', headers={'Idempotency-Key': '10000000-0000-4000-8000-000000000002'}, data={'expected_revision': '1', 'notes': 'updated'}, files={'file': ('minutes-v2.txt', b'current words', 'text/plain')})
        assert second.status_code == 201
        for phrase in ('historical', 'current', 'historical'):
            result = client.get(f'/api/projects/P-001/documents?search={phrase}').json()
            assert result['total'] == 1
            assert result['items'][0]['id'] == document_id


def test_backup_diagnostics_redact_private_exception_path(tmp_path, caplog):
    settings = _settings(tmp_path)
    connection = _connection(settings)
    private = tmp_path / 'private-customer-name'
    settings.config_path.unlink()
    with caplog.at_level('ERROR'):
        import pytest
        with pytest.raises(OSError):
            backups.create_backup(connection, settings, now=NOW)
    assert 'task=' in caplog.text
    assert 'errno=2' in caplog.text
    assert str(tmp_path) not in caplog.text
    assert str(private) not in caplog.text
    connection.close()


def test_manual_and_scheduled_jobs_share_whole_job_mutex(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock

    from backend.app.features.system import run_backup_job
    settings = _settings(tmp_path)
    entered, release = Event(), Event()
    state_lock = Lock()
    active = 0
    maximum = 0
    def slow(connection, settings, *, now):
        nonlocal active, maximum
        with state_lock:
            active += 1
            maximum = max(active, maximum)
        entered.set()
        assert release.wait(3)
        with state_lock:
            active -= 1
        return tmp_path / 'test-backup'
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(run_backup_job, None, settings, NOW, creator=slow, pruner=lambda *args, **kwargs: [])
        assert entered.wait(1)
        second = executor.submit(run_backup_job, None, settings, NOW, creator=slow, pruner=lambda *args, **kwargs: [])
        release.set()
        first.result()
        second.result()
    assert maximum == 1


def test_workbook_parsing_does_not_block_event_loop(tmp_path, monkeypatch):
    import asyncio
    from threading import Event

    import httpx

    from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
    from backend.app.features import procurement_extensions
    from backend.tests.features.test_procurement_extensions import (
        _build_harness,
        _workbook_bytes,
    )
    harness = _build_harness(tmp_path)
    entered, release = Event(), Event()
    original = procurement_extensions._parse_import_workbook
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(procurement_extensions, '_parse_import_workbook', slow)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=harness.app), base_url='http://test', cookies={SESSION_COOKIE_NAME: create_session_token(harness.settings.session_secret)}) as client:
            content = _workbook_bytes([['M-001', '名称', '规格', '个', 1, 2, '备注']])
            task = asyncio.create_task(client.post(f'/api/projects/{harness.project_code}/procurement-imports/preview', headers={'Idempotency-Key': '10000000-0000-4000-8000-000000000003'}, files={'file': ('import.xlsx', content, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}))
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                # 同一事件循环能够继续处理请求，不依赖其他 TestClient 线程。
                response = await asyncio.wait_for(client.get('/unrelated-route'), .5)
                assert response.status_code == 404
            finally:
                release.set()
            assert (await task).status_code == 201
    asyncio.run(run())


def test_worker_connection_failure_is_rejected_before_creating_running_task(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend.app.features import system
    from backend.app.main import create_app
    from backend.tests.features.test_system import (
        _login,
        _noop_scheduler_factory,
        _write_config,
    )
    config = tmp_path / 'config.json'
    _write_config(config, backup_dir='Backups')
    app = create_app(config_path=config, scheduler_factory=_noop_scheduler_factory)
    with TestClient(app) as client:
        _login(client)
        original = system.connect_database
        def unavailable(*args, **kwargs):
            raise OSError(24, 'private path cannot be opened')
        monkeypatch.setattr(system, 'connect_database', unavailable)
        response = client.post('/api/system/backup-tasks')
        assert response.status_code == 503
        connection = _connection(_settings(tmp_path))
        assert connection.execute("SELECT count(*) FROM backup_tasks WHERE status='running'").fetchone()[0] == 0
        connection.close()
        monkeypatch.setattr(system, 'connect_database', original)
        accepted = client.post('/api/system/backup-tasks')
        assert accepted.status_code == 202
        from time import sleep
        for _ in range(100):
            result = client.get(f"/api/system/backup-tasks/{accepted.json()['task_id']}").json()
            if result['status'] != 'running':
                break
            sleep(.01)
        assert result['status'] == 'success'


def test_recover_allows_explicit_minimal_schema_without_backup_tables():
    import sqlite3

    from backend.app.features.system import recover_interrupted_backups
    connection = sqlite3.connect(':memory:')
    recover_interrupted_backups(connection)
    connection.close()


def test_transient_minutes_read_failure_does_not_poison_unchanged_file_cache(tmp_path, monkeypatch):
    from backend.app.features import documents
    from backend.tests.features.test_documents import _build_harness, _create_document
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        assert _create_document(client, category='planning_minutes', title='minutes', filename='minutes.txt', content=b'find again', content_type='text/plain').status_code == 201
        original = documents._read_minutes_search_text
        calls = []
        def transient(*args, **kwargs):
            calls.append(1)
            return None if len(calls) == 1 else original(*args, **kwargs)
        monkeypatch.setattr(documents, '_read_minutes_search_text', transient)
        assert client.get('/api/projects/P-001/documents?search=find').json()['total'] == 0
        assert client.get('/api/projects/P-001/documents?search=find').json()['total'] == 1
        assert len(calls) == 2


def test_successful_backup_is_not_failed_when_only_task_success_record_fails(tmp_path, monkeypatch):
    import sqlite3
    from threading import Event

    from fastapi.testclient import TestClient

    from backend.app.features import system
    from backend.app.main import create_app
    from backend.tests.features.test_system import (
        _login,
        _noop_scheduler_factory,
        _write_config,
    )
    config = tmp_path / 'config.json'
    _write_config(config, backup_dir='Backups')
    app = create_app(config_path=config, scheduler_factory=_noop_scheduler_factory)
    finished = Event()
    with TestClient(app) as client:
        _login(client)
        original = system.connect_database
        class FailStatusOnce:
            def __init__(self, connection):
                self.connection = connection
                self.failed_once = False
            def __getattr__(self, name):
                return getattr(self.connection, name)
            def execute(self, sql, *args):
                if "UPDATE backup_tasks SET status='success'" in sql and not self.failed_once:
                    self.failed_once = True
                    raise sqlite3.OperationalError('status persistence transient failure')
                return self.connection.execute(sql, *args)
            def close(self):
                self.connection.close()
                finished.set()
        monkeypatch.setattr(system, 'connect_database', lambda *args: FailStatusOnce(original(*args)))
        response = client.post('/api/system/backup-tasks')
        task_id = response.json()['task_id']
        assert finished.wait(3)
        connection = original(tmp_path / 'Data' / 'iapm.sqlite')
        run = connection.execute('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1').fetchone()
        assert run['status'] == 'success'
        from pathlib import Path
        assert (Path(run['target_path']) / 'manifest.json').exists()
        connection.close()
        result = client.get(f'/api/system/backup-tasks/{task_id}').json()
        assert result['status'] == 'success'
        assert result['path'] == run['target_path']
