import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthPage } from '../AuthPage'
import { AccessProvider, useAccess } from '../access/AccessProvider'
import { createPlannedPostRequest, setAccountNamespace } from '../../api'
import type { SessionState } from '../../types'

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }) })
afterEach(async () => { cleanup(); vi.restoreAllMocks(); setAccountNamespace(null); await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) }) })
export const buyerSession: SessionState = { authenticated: true, password_configured: true, bootstrap_required: false, user: { id: 2, username: 'buyer', display_name: '采购员', is_owner: false, group_id: 1, group_name: '采购组', revision: 1 }, access_revision: 1, permissions: ['projects.view', 'procurement.lines.view'], project_ids: [1] }
export const financeSession: SessionState = { ...buyerSession, user: { ...buyerSession.user!, id: 3, username: 'finance', display_name: '财务员', group_id: 2, group_name: '财务组' }, permissions: ['projects.view'], project_ids: [2] }
function Probe() { const access = useAccess(); return <><span>{access.user?.display_name}</span><span>{String(access.can('procurement.lines.view', 1))}</span><span>{access.can('projects.view', 2) ? '项目二可见' : '项目二受限'}</span></> }
describe('账号与权限', () => {
  it('使用当前权限和项目范围，切换账号立即撤去旧能力', () => { const view = render(<AccessProvider session={buyerSession} refresh={async () => undefined}><Probe /></AccessProvider>); expect(screen.getByText('true')).toBeTruthy(); expect(screen.getByText('项目二受限')).toBeTruthy(); view.rerender(<AccessProvider session={financeSession} refresh={async () => undefined}><Probe /></AccessProvider>); expect(screen.getByText('false')).toBeTruthy(); expect(screen.getByText('项目二可见')).toBeTruthy() })
  it('旧安装初始化明确要求原共享密码，新密码允许 Unicode', async () => { const submit = vi.fn(); render(<AuthPage passwordConfigured bootstrapRequired busy={false} error={null} onSubmit={submit} />); expect(screen.getByText(/本机需要升级为独立账号登录/)).toBeTruthy(); fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'owner' } }); fireEvent.change(screen.getByLabelText('备注名'), { target: { value: '负责人' } }); fireEvent.change(screen.getByLabelText('账号密码'), { target: { value: '新密码123456' } }); fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value: '新密码123456' } }); fireEvent.change(screen.getByLabelText('原共享密码'), { target: { value: '123456' } }); fireEvent.click(screen.getByRole('button', { name: '创建主账号并进入' })); await waitFor(() => expect(submit).toHaveBeenCalledWith({ username: 'owner', password: '新密码123456', display_name: '负责人', legacy_password: '123456' })) })
  it('旧账号准备的请求不能在另一账号下重新发送', async () => { setAccountNamespace(2); const fetcher = vi.spyOn(globalThis, 'fetch'); const request = createPlannedPostRequest('/api/companies', { name: '合成公司' }); setAccountNamespace(3); await expect(request.send()).rejects.toMatchObject({ errorCode: 'ACCOUNT_CHANGED' }); expect(fetcher).not.toHaveBeenCalled() })
})
