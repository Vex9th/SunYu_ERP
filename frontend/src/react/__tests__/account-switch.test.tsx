import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Application } from '../App'
import { createPlannedPostRequest, setAccountNamespace } from '../../api'
import { useProjectWrite } from '../project/useProjectWork'
import { ownerSession } from './access-fixtures'
import type { SessionState } from '../../types'
vi.mock('../HomePage', () => ({ default: function PendingWorkspace() { const write = useProjectWrite('purchase:ACCESS-A', () => undefined); return <><button onClick={() => { const request = createPlannedPostRequest('/api/projects/ACCESS-A/procurement-lists', { name: '合成采购' }); write.submit('采购提交', () => request.send()) }}>提交采购测试请求</button>{write.notice}</> } }))
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); const original = window.getComputedStyle.bind(window); window.getComputedStyle = element => original(element) })
afterEach(async () => { cleanup(); vi.restoreAllMocks(); setAccountNamespace(null); await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) }) })
const buyerSession: SessionState = { ...ownerSession, user: { ...ownerSession.user!, id: 2, username: 'buyer', display_name: '采购员', is_owner: false, group_id: 1, group_name: '采购组' }, permissions: ['projects.view', 'procurement.lines.view'], project_ids: [1] }
const financeSession: SessionState = { ...buyerSession, user: { ...buyerSession.user!, id: 3, username: 'finance', display_name: '财务员', group_id: 2, group_name: '财务组' } }
function renderAccessApp({ user }: { user: SessionState }) {
  let current = user
  let next = user
  const requests = new Map<string, { path: string; init?: RequestInit }[]>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url)
    if (path === '/api/auth/session') return new Response(JSON.stringify(current), { status: 200 })
    if (path === '/api/auth/logout') { current = { authenticated: false, password_configured: true, bootstrap_required: false, user: null }; return new Response(null, { status: 204 }) }
    if (path === '/api/auth/login') { current = next; return new Response(null, { status: 204 }) }
    if (path.endsWith('/procurement-lists')) { if (!current.permissions?.includes('procurement.lines.view')) return new Response(JSON.stringify({ detail: 'Permission denied' }), { status: 403 }); const key = current.user!.username; requests.set(key, [...(requests.get(key) ?? []), { path, init }]); throw new TypeError('模拟响应丢失') }
    throw new Error(`未预期请求 ${path}`)
  })
  render(<App><MemoryRouter><Application /></MemoryRouter></App>)
  return { revokePermissions: () => { current = { ...current, permissions: [], access_revision: (current.access_revision ?? 0) + 1 } }, requestsFor: (username: string) => requests.get(username) ?? [], startPendingPurchaseWrite: async () => { fireEvent.click(await screen.findByRole('button', { name: '提交采购测试请求' })); await screen.findByText('采购提交的结果尚未确认') }, logoutAndLogin: async (session: SessionState) => { next = session; fireEvent.click(screen.getByRole('button', { name: /退\s*出/ })); await screen.findByLabelText('登录名'); fireEvent.change(screen.getByLabelText('登录名'), { target: { value: session.user!.username } }); fireEvent.change(screen.getByLabelText('账号密码'), { target: { value: 'Synthetic123' } }); fireEvent.click(screen.getByRole('button', { name: '进入工作台' })); await screen.findByRole('button', { name: '提交采购测试请求' }) } }
}
describe('登录会话边界', () => {
  it('退出再登录另一账号，清除待重试界面且不重发旧账号请求', async () => { const app = renderAccessApp({ user: buyerSession }); await app.startPendingPurchaseWrite(); await app.logoutAndLogin(financeSession); expect(screen.queryByText('重试原请求')).toBeNull(); expect(app.requestsFor('buyer')).toHaveLength(1); expect(app.requestsFor('finance')).toHaveLength(0); expect(screen.queryByRole('menuitem', { name: /账号与权限/ })).toBeNull(); expect(screen.getByRole('menuitem', { name: /我的账号/ })).toBeTruthy() })
  it('403 后刷新会话，立即移除已撤权的页面', async () => { const app = renderAccessApp({ user: buyerSession }); const button = await screen.findByRole('button', { name: '提交采购测试请求' }); app.revokePermissions(); fireEvent.click(button); await waitFor(() => expect(screen.queryByRole('button', { name: '提交采购测试请求' })).toBeNull()); expect(await screen.findByText('需要调整权限时，请联系主账号。')).toBeTruthy() })
  it('主账号可见管理入口', async () => { renderAccessApp({ user: ownerSession }); await waitFor(() => expect(screen.getByRole('menuitem', { name: /账号与权限/ })).toBeTruthy()) })
})
