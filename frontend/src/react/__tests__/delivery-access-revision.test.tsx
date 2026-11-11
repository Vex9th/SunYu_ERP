import { afterEach, beforeAll, it } from 'vitest';
import { installProjectDom } from './project-fixtures';
beforeAll(installProjectDom);
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); setAccountNamespace(null); globalThis.fetch = originalFetch; });
import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import DeliveryWorkspace from '../delivery/DeliveryWorkspace';
import { AccessProvider } from '../access/AccessProvider';
import { setAccountNamespace } from '../../api';
const writes: { key: string | null; body: BodyInit | null | undefined }[] = [];
const committed = new Map();
let failNext = true;
let allowWrite = true;
let holdReads = false;
const waitingReads: (() => void)[] = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
globalThis.fetch = async (path, init) => {
    const url = String(path).split('?')[0];
    if (holdReads && init?.method !== 'POST')
        await new Promise<void>(resolve => waitingReads.push(resolve));
    if (init?.method === 'POST' && url.endsWith('/invoices')) {
        const key = new Headers(init.headers).get('Idempotency-Key');
        writes.push({ key, body: init.body });
        if (!allowWrite)
            return response({ detail: 'Permission denied' }, 403);
        const payload = JSON.parse(String(init.body));
        if (!committed.has(key))
            committed.set(key, { ...payload, id: committed.size + 1, project_code: 'REV-REVIEW', revision: 1, void_reason: null, created_at: '', updated_at: '' });
        if (failNext) {
            failNext = false;
            throw new TypeError('response lost after commit');
        }
        return response(committed.get(key));
    }
    if (url.endsWith('/drawing-signoffs'))
        return response([]);
    if (url.endsWith('/warranty'))
        return response(null);
    const items = url.endsWith('/invoices') ? [...committed.values()] : [];
    return response({ items, total: items.length, page: 1, page_size: 200 });
};
const session = { authenticated: true, password_configured: true, bootstrap_required: false, user: { id: 77, username: 'review-invoice', display_name: '合成开票员', group_name: '合成组', is_owner: false, group_id: 1, revision: 1 }, access_revision: 1, permissions: ['customer_invoices.view', 'customer_invoices.register'], project_ids: [1] };
const layout = (rev: number, write = true) => <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}><App><AccessProvider session={{ ...session, access_revision: rev, permissions: write ? session.permissions : ['customer_invoices.view'] }} refresh={async () => { }}><DeliveryWorkspace key={rev} projectCode="REV-REVIEW"/></AccessProvider></App></ConfigProvider>;
async function create(note: string) { const add = await screen.findByRole('button', { name: /新增发票记录/ }); await waitFor(() => { if ((add as HTMLButtonElement).disabled)
    throw Error('waiting load'); }); fireEvent.click(add); const drawer = await screen.findByRole('dialog'); fireEvent.change(within(drawer).getByLabelText('备注'), { target: { value: note } }); fireEvent.click(within(drawer).getByRole('button', { name: '保存发票记录' })); await screen.findByText('上次请求结果尚未确认'); }
async function retry() { const button = await screen.findByRole('button', { name: '恢复并重试' }); await waitFor(() => { if ((button as HTMLButtonElement).disabled)
    throw Error('waiting permission/loading'); }); fireEvent.click(button); fireEvent.click(await screen.findByRole('button', { name: '重试原提交' })); }
it('发票请求保留原身份且撤权阻止重试', async () => {
    setAccountNamespace(77);
    const view = render(layout(1));
    await create('first');
    holdReads = true;
    view.rerender(layout(2));
    const recover = await screen.findByRole('button', { name: '恢复并重试' });
    if (!(recover as HTMLButtonElement).disabled) throw Error('retry allowed before project data loaded');
    fireEvent.click(recover);
    if (writes.length !== 1) throw Error('POST sent before refresh completed');
    holdReads = false;
    waitingReads.splice(0).forEach(resolve => resolve());
    await retry();
    await waitFor(() => { if (writes.length !== 2 || screen.queryByRole('dialog'))
        throw Error(JSON.stringify({ stage: 'waiting success', writes: writes.length, dialogs: screen.queryAllByRole('dialog').map(item => item.textContent?.slice(0, 180)) })); });
    if (writes[0]!.key !== writes[1]!.key || writes[0]!.body !== writes[1]!.body || committed.size !== 1)
        throw Error('revision refresh changed request identity');
    failNext = true;
    await create('second');
    view.rerender(layout(3, false));
    allowWrite = false;
    await waitFor(() => { if ((screen.getByRole('button', { name: /刷新$/ }) as HTMLButtonElement).disabled)
        throw Error('waiting current data'); });
    const denied = screen.queryByRole('button', { name: '恢复并重试' });
    const revokedBlocked = !denied || (denied as HTMLButtonElement).disabled;
    if (!revokedBlocked) {
        await retry();
        await waitFor(() => { if (writes.length !== 4)
            throw Error('waiting denied POST'); });
    }
    console.log(JSON.stringify({ case: 'delivery-access-revision-fixed', pendingSurvivedRevision: true, retrySameKey: true, retrySamePayload: true, revokedBlocked, writes: writes.length, serverRecords: committed.size }));
    cleanup();
    if (!revokedBlocked)
        throw Error('revoked permission still allows restore and retry');
});
