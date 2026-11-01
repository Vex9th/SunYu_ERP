from pathlib import Path
from uuid import uuid4

import pytest

from backend.app.core.database import connect_database
from backend.app.core.security import SESSION_COOKIE_NAME, hash_account_password
from backend.app.features.auth import _new_session
from backend.tests.features.test_business_access import business as _business
from backend.tests.features.test_business_access import member
from backend.tests.features.test_company_ledger import _order, _supplier_fact
from backend.tests.features.test_documents import _build_harness, _create_document

business = _business

def member_client(harness, *, permissions=(), projects=(1,)):
    with connect_database(harness.database_path) as connection:
        connection.execute("INSERT INTO workgroups(id,name,name_key,created_at,updated_at) VALUES (1,'文件组','文件组','2026-10-31','2026-10-31')")
        connection.execute("""INSERT INTO accounts(id,username,username_key,display_name,password_hash,group_id,created_at,updated_at)
            VALUES (2,'member','member','文件测试人员',?,1,'2026-10-31','2026-10-31')""",(hash_account_password('DocumentTest123'),))
        connection.executemany('INSERT INTO workgroup_projects(group_id,project_id) VALUES (1,?)',[(item,) for item in projects])
        connection.executemany('INSERT INTO workgroup_permissions(group_id,permission_key) VALUES (1,?)',[(item,) for item in {'documents.view','documents.download','documents.upload','documents.edit',*permissions}])
        token = _new_session(connection,harness.settings.session_secret,2)
    client = harness.client(authenticated=False)
    client.cookies.set(SESSION_COOKIE_NAME,token)
    return client


def test_document_permissions_filter_before_paging_search_and_version_choices(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as owner:
        visible = _create_document(owner,category='other',title='可见文件').json()
        another = _create_document(owner,category='planning_minutes',title='公开纪要',filename='minutes.txt',content=b'visible').json()
        hidden_response = _create_document(owner,category='procurement_list',title='秘密价格')
        assert hidden_response.status_code == 201,hidden_response.text
        hidden = hidden_response.json()
    with member_client(harness) as member:
        listing = member.get('/api/projects/P-001/documents?page_size=1')
        assert listing.status_code == 200,listing.text
        assert listing.json()['total'] == 2
        assert {listing.json()['items'][0]['id']} <= {visible['id'],another['id']}
        assert member.get('/api/projects/P-001/documents?search=秘密').json()['total'] == 0
        assert member.get('/api/projects/P-001/documents?category=procurement_list').json()['total'] == 0
        options = member.get('/api/projects/P-001/document-version-options').json()
        assert {row['value'] for row in options} == {visible['versions'][0]['id'],another['versions'][0]['id']}
        assert member.get(f"/api/projects/P-001/documents/{hidden['id']}").status_code == 403
        assert member.get('/api/projects/P-002/documents').status_code == 403
        for url in [f"/api/projects/P-001/documents/{hidden['id']}/versions/{hidden['versions'][0]['id']}/download",f"/api/projects/P-001/document-versions/{hidden['versions'][0]['id']}/download"]:
            assert member.get(url).status_code == 403
        assert _create_document(member,category='procurement_list',title='越权新文件').status_code == 403
    with connect_database(harness.database_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 3
        assert connection.execute("SELECT COUNT(*) FROM operation_events WHERE action='documents.download'").fetchone()[0] == 0


def test_cross_project_contract_original_is_excluded_even_under_visible_category(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as owner:
        response = _create_document(owner,category='contract',title='多项目合同')
        assert response.status_code == 201,response.text
        document = response.json()
    with connect_database(harness.database_path) as connection:
        connection.execute("INSERT INTO contracts(id,contract_no,title,customer_company_id,total_amount_cents,created_at,updated_at) VALUES (1,'CT-TEST','跨项目',1,200,'2026-10-31','2026-10-31')")
        connection.executemany('INSERT INTO contract_project_allocations(contract_id,project_id,amount_cents) VALUES (1,?,100)',[(1,),(2,)])
        connection.execute('INSERT INTO contract_document_versions VALUES (1,?)',(document['versions'][0]['id'],))
    with member_client(harness,permissions=('contracts.view',)) as member:
        assert member.get('/api/projects/P-001/documents').json()['total'] == 0
        assert member.get(f"/api/projects/P-001/document-versions/{document['versions'][0]['id']}/download").status_code == 403


def test_download_records_request_only_after_authorized_file_open(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as owner:
        document = _create_document(owner,category='other',title='下载审计').json()
        version = document['versions'][0]['id']
        for url in [f"/api/projects/P-001/documents/{document['id']}/versions/{version}/download",f"/api/projects/P-001/document-versions/{version}/download"]:
            downloaded = owner.get(url)
            assert downloaded.status_code == 200,downloaded.text
            assert downloaded.content == b'version-one'
        with connect_database(harness.database_path) as connection:
            events = connection.execute("SELECT * FROM operation_events WHERE action='documents.download' ORDER BY id").fetchall()
            assert len(events) == 2
            assert all(row['summary'] == '请求下载文件' and row['resource_type'] == 'document_version' and row['resource_id'] == str(version) for row in events)
            assert all(row['actor_name'] == '采购测试主账号' for row in events)
            stored = connection.execute('SELECT stored_relative_path FROM document_versions WHERE id=?',(version,)).fetchone()[0]
        (harness.settings.data_dir / stored).unlink()
        assert owner.get(f'/api/projects/P-001/document-versions/{version}/download').status_code == 404
        with connect_database(harness.database_path) as connection:
            assert connection.execute("SELECT COUNT(*) FROM operation_events WHERE action='documents.download'").fetchone()[0] == 2


def test_real_routes_recheck_category_permission_before_upload_replay_and_download(business):
    owner, _, database = business
    visible = _create_document(owner, project_code='TEST-1', category='other', title='公开合成文件')
    assert visible.status_code == 201, visible.text
    permissions = ['projects.view', 'documents.view', 'documents.upload', 'documents.download',
                   'procurement.lines.view', 'sensitive.procurement_prices']
    client, _, group = member(business, permissions)
    key = str(uuid4())
    upload = {'project_code': 'TEST-1', 'category': 'procurement_list', 'title': '合成采购原件', 'idempotency_key': key}
    created = _create_document(client, **upload)
    assert created.status_code == 201, created.text
    document = created.json()
    version = document['versions'][0]['id']
    replay = _create_document(client, **upload)
    assert replay.status_code == 201 and replay.json()['id'] == document['id']
    downloaded = client.get(f'/api/projects/TEST-1/document-versions/{version}/download')
    assert downloaded.status_code == 200, downloaded.text
    history = client.get(f'/api/operation-history/document_version/{version}')
    assert history.status_code == 200, history.text
    downloads = [item for item in history.json()['items'] if item['action'] == 'documents.download']
    assert len(downloads) == 1
    assert downloads[0]['summary'] == '请求下载文件'
    assert downloads[0]['actor_name'] == '采购张姐'

    current = next(row for row in owner.get('/api/workgroups').json() if row['id'] == group['id'])
    changed = owner.put(f"/api/workgroups/{group['id']}/access", json={
        'expected_revision': current['revision'], 'project_ids': [1],
        'permission_keys': [key for key in permissions if key != 'sensitive.procurement_prices'],
    })
    assert changed.status_code == 200, changed.text
    assert _create_document(client, **upload).status_code == 403
    assert client.get('/api/projects/TEST-1/documents').json()['total'] == 1
    assert client.get(f'/api/projects/TEST-1/document-versions/{version}/download').status_code == 403
    assert client.get(f'/api/operation-history/document_version/{version}').status_code == 403
    hidden_event_ids = {row[0] for row in database.execute('''SELECT id FROM operation_events WHERE
        (resource_type='document' AND resource_id=?) OR (resource_type='document_version' AND resource_id=?)''',
        (str(document['id']), str(version)))}
    project_history = client.get('/api/operation-history/project/1?limit=1')
    assert project_history.status_code == 200, project_history.text
    assert len(project_history.json()['items']) == 1
    assert not hidden_event_ids.intersection(item['id'] for item in project_history.json()['items'])
    assert '合成采购原件' not in project_history.text
    assert database.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 2
    assert database.execute("SELECT COUNT(*) FROM operation_events WHERE action='documents.download'").fetchone()[0] == 1
    unsupported = owner.put(f"/api/projects/TEST-1/documents/{document['id']}", json={
        'title': '不改分类', 'notes': None, 'expected_revision': document['revision'], 'category': 'other',
    })
    assert unsupported.status_code == 422
    assert database.execute('SELECT category FROM documents WHERE id=?', (document['id'],)).fetchone()[0] == 'procurement_list'


def test_download_audit_failure_closes_file_and_does_not_send_stream(tmp_path: Path, monkeypatch):
    from backend.app.features import documents

    harness = _build_harness(tmp_path)
    opened = []
    original_open = documents._open_download_file

    def track_open(*args):
        handle = original_open(*args)
        opened.append(handle)
        return handle

    def fail_audit(*args, **kwargs):
        raise RuntimeError('synthetic audit failure')

    with harness.client() as owner:
        document = _create_document(owner, category='other').json()
        monkeypatch.setattr(documents, '_open_download_file', track_open)
        monkeypatch.setattr(documents, 'append_operation_event', fail_audit)
        with pytest.raises(RuntimeError, match='synthetic audit failure'):
            owner.get(f"/api/projects/P-001/document-versions/{document['versions'][0]['id']}/download")
    assert len(opened) == 1 and opened[0].closed
    with connect_database(harness.database_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM operation_events WHERE action='documents.download'").fetchone()[0] == 0


@pytest.mark.parametrize(('category', 'source_permission', 'commercial_permission'), [
    ('invoice', 'procurement.invoices.view', 'customer_invoices.view'),
    ('quotation', 'procurement.lines.view', 'quotes.view'),
])
def test_procurement_document_source_controls_shared_category_and_combined_origins(
    tmp_path: Path, category: str, source_permission: str, commercial_permission: str,
):
    harness = _build_harness(tmp_path)
    with harness.client() as owner:
        source = _create_document(owner, category=category, title='采购来源原件').json()
        _create_document(owner, category=category, title='未关联来源原件')
    version = source['versions'][0]['id']
    with connect_database(harness.database_path) as connection:
        order = _order(connection, 1, 1, 'SOURCE-ORDER', 'confirmed', [(1000, 1000)])
        if category == 'invoice':
            _supplier_fact(connection, 'supplier_invoices', order, 1000)
            invoice = connection.execute('SELECT id FROM supplier_invoices').fetchone()[0]
            connection.execute('INSERT INTO supplier_invoice_documents VALUES (?, ?)', (invoice, version))
        else:
            procurement_list = connection.execute('SELECT id FROM procurement_lists').fetchone()[0]
            connection.execute('''INSERT INTO quote_exports(project_id,procurement_list_id,title,
                customer_company_id,document_version_id,idempotency_key,request_hash,created_at)
                VALUES(1,?,'来源报价',1,?,'source-key','source-hash','2026-11-01')''',
                (procurement_list, version))
    with member_client(harness, permissions=(source_permission, 'sensitive.procurement_prices')) as member:
        listing = member.get('/api/projects/P-001/documents').json()
        assert [row['id'] for row in listing['items']] == [source['id']]
        options = member.get('/api/projects/P-001/document-version-options').json()
        assert [row['value'] for row in options] == [version]
        download = f'/api/projects/P-001/document-versions/{version}/download'
        assert member.get(download).status_code == 200
        assert _create_document(member, category=category, title='不能借来源权限直接上传').status_code == 403

        with connect_database(harness.database_path) as connection:
            if category == 'invoice':
                connection.execute('''INSERT INTO project_invoices(id,project_id,invoice_type,status,created_at,updated_at)
                    VALUES(1,1,'other','recorded','2026-11-01','2026-11-01')''')
                connection.execute("""INSERT INTO workforce_document_links(project_id,resource_type,resource_id,document_version_id,created_at)
                    VALUES(1,'invoice',1,?,'2026-11-01')""", (version,))
            else:
                connection.execute('''INSERT INTO quotes(id,project_id,version_number,quote_date,amount_cents,created_at,updated_at)
                    VALUES(1,1,1,'2026-11-01',1000,'2026-11-01','2026-11-01')''')
                connection.execute('INSERT INTO quote_document_versions VALUES(1,?)', (version,))
        assert member.get('/api/projects/P-001/documents').json()['total'] == 0
        assert member.get(download).status_code == 403
        with connect_database(harness.database_path) as connection:
            connection.execute('INSERT INTO workgroup_permissions VALUES(1,?)', (commercial_permission,))
        assert member.get(download).status_code == 200
        with connect_database(harness.database_path) as connection:
            connection.execute("DELETE FROM workgroup_permissions WHERE permission_key='sensitive.procurement_prices'")
        assert member.get(download).status_code == 403
