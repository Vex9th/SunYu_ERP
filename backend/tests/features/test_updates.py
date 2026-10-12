from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app.core.update_runtime import UpdateRuntime
from backend.app.features.updates import UpdateManager, atomic_json
from backend.app.main import create_app
from backend.app.version import VERSION


@pytest.fixture
def setup(tmp_path):
    (tmp_path / 'config.json').write_text(json.dumps({
        'data_dir': 'Data', 'session_secret': 'test-session-secret-with-at-least-32-bytes'
    }))
    (tmp_path / 'update.exe').write_bytes(b'test updater')
    calls = []
    def spawn(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(poll=lambda: None)
    manager = UpdateManager(tmp_path, enabled=True, spawn=spawn)
    app = create_app(config_path=tmp_path / 'config.json', update_manager=manager)
    with TestClient(app, base_url='http://127.0.0.1:8765', client=('127.0.0.1', 51000)) as client:
        assert client.post('/api/auth/setup', json={'password': '123456'}).status_code == 204
        assert client.post('/api/auth/login', json={'password': '123456'}).status_code == 204
        yield client, manager, calls, tmp_path


def test_requires_authentication(setup):
    client, _, calls, _ = setup
    client.cookies.clear()
    for method, path in [('get', ''), ('post', '/check'), ('post', '/install')]:
        assert getattr(client, method)('/api/system/updates' + path).status_code == 401
    assert not calls


def test_local_install_is_detached_and_duplicate_is_conflict(setup):
    client, manager, calls, root = setup
    response = client.post('/api/system/updates/install', headers={'Origin': str(client.base_url).rstrip('/')})
    assert response.status_code == 202, response.text
    payload = response.json()
    assert payload['busy'] and payload['job_id']
    assert calls[0][0] == [str(root / 'update.exe'), '--root', str(root), '--apply', '--job-id', payload['job_id'], '--no-pause']
    assert calls[0][1]['cwd'] == str(root)
    assert client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'}).status_code == 409
    assert len(calls) == 1
    assert manager.writes_blocked()


@pytest.mark.parametrize('headers', [
    {}, {'Origin': 'http://evil.example'}, {'Origin': 'null'},
    {'Origin': 'http://127.0.0.1:8765', 'X-Forwarded-For': '127.0.0.1'},
    {'Origin': 'http://127.0.0.1:8765', 'Forwarded': 'for=127.0.0.1'},
    {'Origin': 'http://127.0.0.1:8765', 'Host': 'evil.example'},
])
def test_rejects_missing_foreign_origin_and_proxy_headers(setup, headers):
    client, _, calls, _ = setup
    assert client.post('/api/system/updates/install', headers=headers).status_code == 403
    assert not calls


def test_remote_status_and_check_allowed_but_install_rejected(setup):
    client, _, calls, _ = setup
    client._transport.client = ('192.168.1.42', 51000)
    state = client.get('/api/system/updates').json()
    assert state['supported'] and not state['can_install']
    assert client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'}).status_code == 403
    assert client.post('/api/system/updates/check').status_code == 202
    assert '--check' in calls[0][0]


def test_dev_mode_cannot_spawn_updater(tmp_path):
    manager = UpdateManager(tmp_path, enabled=False)
    app = create_app(config_path=tmp_path / 'config.json', update_manager=manager)
    with TestClient(app) as client:
        client.post('/api/auth/setup', json={'password': '123456'})
        client.post('/api/auth/login', json={'password': '123456'})
        assert client.get('/api/system/updates').json()['supported'] is False
        assert client.post('/api/system/updates/check').status_code == 409
    assert not (tmp_path / '.updates').exists()


def test_install_maintenance_blocks_writes_until_verified(setup):
    client, manager, _, root = setup
    atomic_json(root / '.updates/install.json', {'job_id': 'test', 'phase': 'installing'})
    assert manager.writes_blocked()
    assert client.post('/api/companies', json={}).status_code == 503
    assert client.get('/api/companies').status_code == 200
    assert client.get('/api/health').json()['version'] == VERSION
    assert client.get('/api/system/updates').status_code == 200
    atomic_json(root / '.updates/install.json', {'job_id': 'test', 'phase': 'verified'})
    assert not manager.writes_blocked()
    assert client.post('/api/companies', json={}).status_code != 503


def test_corrupt_install_marker_fails_closed(setup):
    client, manager, _, root = setup
    (root / '.updates').mkdir(exist_ok=True)
    (root / '.updates/install.json').write_text('{broken')
    assert manager.writes_blocked()
    assert client.post('/api/companies', json={}).status_code == 503


def test_start_failure_visible_and_does_not_lock_business(setup):
    client, manager, _, _ = setup
    def fail(*args, **kwargs):
        raise OSError('permission denied')
    manager.spawn = fail
    response = client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'})
    assert response.status_code == 503
    status = client.get('/api/system/updates').json()
    assert status['phase'] == 'failed' and not status['busy']
    assert not manager.writes_blocked()


def test_apply_does_not_interrupt_in_flight_business_request(setup):
    client, manager, calls, _ = setup
    with manager.business_write():
        response = client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'})
    assert response.status_code == 409
    assert not calls


def test_runtime_only_honors_own_nonce_and_cleans_own_record(tmp_path):
    manager = UpdateManager(tmp_path, enabled=True)
    requested = []
    runtime = UpdateRuntime(manager, port=8765, shutdown=lambda: requested.append(True))
    runtime.publish()
    record = json.loads((tmp_path / '.updates/runtime.json').read_text())
    assert record['pid'] == os.getpid() and record['instance_id'] == manager.instance_id
    atomic_json(tmp_path / '.updates/shutdown.json', {'instance_id': 'another-instance'})
    runtime.poll_shutdown()
    assert not requested
    atomic_json(tmp_path / '.updates/shutdown.json', {'instance_id': manager.instance_id})
    runtime.poll_shutdown()
    assert requested == [True]
    atomic_json(tmp_path / '.updates/runtime.json', {**record, 'instance_id': 'replacement'})
    runtime.close()
    assert (tmp_path / '.updates/runtime.json').exists()


def test_running_async_backup_prevents_install(setup):
    from backend.app.core.database import connect_database
    client, _, calls, root = setup
    connection = connect_database(root / 'Data/iapm.sqlite')
    try:
        connection.execute("INSERT INTO backup_tasks(id,status,phase,started_at) VALUES('running-backup','running','queued','2026-10-13T00:00:00Z')")
        response = client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'})
        assert response.status_code == 409
        assert '备份' in response.json()['detail']
        assert not calls
    finally:
        connection.close()


def test_failed_child_exposes_error_and_releases_busy(setup):
    client, manager, _, _ = setup
    manager.spawn = lambda *args, **kwargs: SimpleNamespace(poll=lambda: 17)
    client.post('/api/system/updates/check')
    response = client.get('/api/system/updates').json()
    assert response['phase'] == 'failed' and response['busy'] is False
    assert '17' in response['error']


def test_verified_commit_releases_writes_before_status_cleanup(setup):
    _, manager, _, root = setup
    atomic_json(root / '.updates/install.json', {'job_id': 'test', 'phase': 'verified'})
    atomic_json(root / '.updates/status.json', {
        **manager.state(), 'job_id': 'test', 'phase': 'restarting', 'busy': True,
    })
    # Go must mark terminal state before business resumes, so cleanup cannot race writes.
    assert manager.writes_blocked()
    atomic_json(root / '.updates/status.json', {
        **manager.state(), 'job_id': 'test', 'phase': 'success', 'busy': False,
    })
    assert not manager.writes_blocked()


def test_stale_busy_without_worker_becomes_retryable(setup):
    _, manager, _, root = setup
    status_file = root / '.updates/status.json'
    atomic_json(status_file, {**manager.state(), 'phase': 'downloading', 'busy': True})
    os.utime(status_file, (1, 1))
    result = manager.state()
    assert not result['busy'] and result['phase'] == 'failed'


def test_stale_progress_with_live_worker_stays_busy(setup):
    from backend.app.core.file_lock import release_lock, try_lock
    _, manager, _, root = setup
    status_file = root / '.updates/status.json'
    atomic_json(status_file, {**manager.state(), 'phase': 'downloading', 'busy': True})
    os.utime(status_file, (1, 1))
    lock = try_lock(root / '.updates/updater.lock')
    assert lock is not None
    try:
        assert manager.state()['busy'] is True
    finally:
        release_lock(lock)


def test_second_runtime_does_not_replace_first_runtime(tmp_path):
    first = UpdateRuntime(UpdateManager(tmp_path, enabled=True), port=8765, shutdown=lambda: None)
    second = UpdateRuntime(UpdateManager(tmp_path, enabled=True), port=8765, shutdown=lambda: None)
    try:
        first.start()
        with pytest.raises(RuntimeError, match='已启动'):
            second.start()
        second.close()
        assert json.loads((tmp_path / '.updates/runtime.json').read_text())['instance_id'] == first.manager.instance_id
    finally:
        first.close()
    assert not (tmp_path / '.updates/runtime.json').exists()


def test_interrupted_install_offers_recovery_not_fresh_check(setup):
    client, _, calls, root = setup
    atomic_json(root / '.updates/install.json', {'job_id': 'old-job', 'phase': 'installing'})
    status = client.get('/api/system/updates').json()
    assert status['recovery_required'] is True
    assert client.post('/api/system/updates/check').status_code == 409
    response = client.post('/api/system/updates/install', headers={'Origin': 'http://127.0.0.1:8765'})
    assert response.status_code == 202
    assert len(calls) == 1 and '--apply' in calls[0][0]


def test_automatic_backup_waits_for_install_verification(tmp_path):
    from backend.app.features.system import BackupScheduler
    calls = []
    manager = UpdateManager(tmp_path, enabled=True)
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({
        'data_dir': 'Data', 'backup_dir': str(tmp_path / 'backup'),
        'session_secret': 'test-session-secret-with-at-least-32-bytes',
    }))
    atomic_json(tmp_path / '.updates/install.json', {'phase': 'installing'})
    class ManualScheduler(BackupScheduler):
        def start(self):
            pass
    def backup(*args, **kwargs):
        calls.append(True)
        raise RuntimeError('sentinel: backup reached')
    app = create_app(config_path=config, update_manager=manager,
                     scheduler_factory=ManualScheduler, backup_creator=backup)
    with TestClient(app):
        scheduler = app.state.backup_scheduler
        assert scheduler.run_cycle() is False
        assert not calls
        atomic_json(tmp_path / '.updates/install.json', {'phase': 'verified'})
        scheduler.run_cycle()
        assert calls == [True]


def test_install_result_remains_queryable_after_other_client_check(setup):
    client, manager, _, root = setup
    job = 'a' * 32
    finished = {**manager.state(), 'job_id': job, 'phase': 'success', 'busy': False,
                'message': '更新完成', 'progress': 100}
    atomic_json(root / '.updates/last-install.json', finished)
    atomic_json(root / '.updates/status.json', {**manager.state(), 'job_id': 'b' * 32, 'phase': 'idle'})
    response = client.get('/api/system/updates', params={'job_id': job})
    assert response.status_code == 200
    assert response.json()['job_id'] == job and response.json()['phase'] == 'success'
    assert client.get('/api/system/updates').json()['job_id'] != job


def test_client_request_id_is_idempotent(setup):
    client, _, calls, _ = setup
    job = 'c' * 32
    for _ in range(2):
        response = client.post('/api/system/updates/install', json={'job_id': job},
                               headers={'Origin': 'http://127.0.0.1:8765'})
        assert response.status_code == 202
        assert response.json()['job_id'] == job
    assert len(calls) == 1


def test_unknown_job_and_invalid_request_are_not_installed(setup):
    client, _, calls, _ = setup
    assert client.get('/api/system/updates', params={'job_id': 'd' * 32}).status_code == 410
    response = client.post('/api/system/updates/install', json={'job_id': '../../escape'},
                           headers={'Origin': 'http://127.0.0.1:8765'})
    assert response.status_code == 422
    assert not calls


def test_python_launch_failure_is_retained_after_a_new_check(setup):
    client, manager, _, _ = setup
    original_spawn = manager.spawn
    def fail(*args, **kwargs):
        raise OSError('fixture launch failure')
    manager.spawn = fail
    job = 'e' * 32
    response = client.post('/api/system/updates/install', json={'job_id': job},
                           headers={'Origin': 'http://127.0.0.1:8765'})
    assert response.status_code == 503
    manager.spawn = original_spawn
    assert client.post('/api/system/updates/check').status_code == 202
    result = client.get('/api/system/updates', params={'job_id': job})
    assert result.status_code == 200
    assert result.json()['phase'] == 'failed'
    assert 'fixture launch failure' in result.json()['error']
