import { afterEach, beforeAll, it } from 'vitest';
import { installProjectDom } from './project-fixtures';
beforeAll(installProjectDom);
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); setAccountNamespace(null); globalThis.fetch = originalFetch; });
import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import AccountsPage from '../access/AccountsPage';
import { AccessProvider } from '../access/AccessProvider';
import { setAccountNamespace } from '../../api';
const writes: { key: string | null; body: BodyInit | null | undefined }[] = [];
let failNext = true;
globalThis.fetch = async (path, init) => { if (init?.method === 'POST') {
    writes.push({ body: init.body, key: new Headers(init.headers).get('Idempotency-Key') });
    if (failNext) {
        failNext = false;
        throw new TypeError('offline');
    }
    return new Response('{"id":1}', { status: 201 });
} return new Response('[]'); };
const session = { authenticated: true, password_configured: true, bootstrap_required: false, user: { id: 55, username: 'review-owner', display_name: '合成主账号', group_name: null, is_owner: true, group_id: null, revision: 1 }, access_revision: 1, permissions: [], project_ids: null };
const layout = (rev: number) => <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}><App><AccessProvider session={{ ...session, access_revision: rev }} refresh={async () => { }}><AccountsPage key={rev}/></AccessProvider></App></ConfigProvider>;
async function openGroup() { fireEvent.click(await screen.findByRole('tab', { name: '工作组与授权' })); fireEvent.click(screen.getByRole('button', { name: /创建工作组/ })); return screen.findByRole('dialog'); }
async function saveGroup(name: string) { const dialog = await openGroup(); fireEvent.change(screen.getByLabelText('组名'), { target: { value: name } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存' })); }
it('账号管理未知请求在权限刷新后恢复，原样重试与明确放弃', async () => {
    setAccountNamespace(55);
    const view = render(layout(1));
    await saveGroup('A组');
    await screen.findByText('无法连接本地服务，请确认服务仍在运行');
    if (!(screen.getByLabelText('组名') as HTMLInputElement).disabled)
        throw Error('unknown result field is editable');
    view.rerender(layout(2));
    await openGroup();
    if ((screen.getByLabelText('组名') as HTMLInputElement).value !== 'A组' || !(screen.getByLabelText('组名') as HTMLInputElement).disabled)
        throw Error('pending lost after permission revision');
    fireEvent.click(screen.getByRole('button', { name: '原样重试' }));
    await waitFor(() => { if (screen.queryByRole('dialog'))
        throw Error('waiting close'); });
    if (writes.length !== 2 || writes[0]!.key !== writes[1]!.key || writes[0]!.body !== writes[1]!.body)
        throw Error('retry changed original request');
    failNext = true;
    await saveGroup('C组');
    await screen.findByText('无法连接本地服务，请确认服务仍在运行');
    fireEvent.click(screen.getByRole('button', { name: '放弃请求' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认放弃' }));
    await waitFor(() => { if (screen.queryByLabelText('组名'))
        throw Error('waiting abandon'); });
    await saveGroup('D组');
    await waitFor(() => { if (writes.length !== 4 || screen.queryByRole('dialog'))
        throw Error('waiting replacement'); });
    if (writes[2]!.key === writes[3]!.key)
        throw Error('replacement reused discarded key');
    console.log(JSON.stringify({ case: 'accounts-pending-fixed', fieldLocked: true, pendingSurvivedRevision: true, retrySameKey: true, retrySamePayload: true, discardAllowsNewRequest: true, writes: writes.length }));
    cleanup();
});
