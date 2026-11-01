from io import BytesIO
from pathlib import Path

from openpyxl import load_workbook

from backend.tests.features.test_procurement import _line_payload
from backend.tests.features.test_procurement_extensions import _build_harness
from backend.tests.features.test_procurement_line_confirmation import (
    confirm_line,
    post,
    two_lines,
)


def workbook_cells(content):
    workbook = load_workbook(BytesIO(content), data_only=False)
    return [[(cell.value,cell.number_format,cell.data_type) for cell in row] for row in workbook.active]


def test_partial_quote_snapshots_survive_reopen_edit_delete_and_customer_rename(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a,_b) = two_lines(client, harness.project_code)
        a = confirm_line(client,url,a)
        quote = post(client, f'{url}/quote-exports', {'title':'冻结报价','customer_company_id':harness.customer_company_id,'notes':None})
        assert quote.status_code == 201, quote.text
        assert quote.json()['line_count'] == 1
        before = workbook_cells(client.get(quote.json()['download_url']).content)
        assert before[5][2][0] == '物料 A'
        assert len(before) == 6
        reopened = post(client, f"{url}/lines/{a['id']}/reopen", {'expected_revision':a['revision'],'reason':'调整'})
        assert reopened.status_code == 200, reopened.text
        edited = client.put(f"{url}/lines/{a['id']}",json={**_line_payload(),'name':'新名称','quantity':'99.000','expected_revision':reopened.json()['revision']})
        assert edited.status_code == 200, edited.text
        assert client.delete(f"{url}/lines/{a['id']}?expected_revision={edited.json()['revision']}").status_code == 204
        with harness.connection() as connection:
            connection.execute('UPDATE companies SET name=? WHERE id=?',('新客户名',harness.customer_company_id))
        assert workbook_cells(client.get(quote.json()['download_url']).content) == before
        history = client.get(f'/api/projects/{harness.project_code}/quote-exports').json()
        assert history['items'][0]['customer_company_name'] == quote.json()['customer_company_name']


def test_quote_rejects_empty_or_unconfirmed_explicit_selection(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url,(a,b) = two_lines(client,harness.project_code)
        payload = {'title':'选择报价','customer_company_id':harness.customer_company_id,'notes':None}
        assert post(client,f'{url}/quote-exports',payload).status_code == 409
        confirm_line(client,url,a)
        assert post(client,f'{url}/quote-exports',{**payload,'procurement_line_ids':[]}).status_code == 422
        assert post(client,f'{url}/quote-exports',{**payload,'procurement_line_ids':[b['id']]}).status_code == 409
        selected = post(client,f'{url}/quote-exports',{**payload,'procurement_line_ids':[a['id']]})
        assert selected.status_code == 201,selected.text
        assert selected.json()['line_count'] == 1
