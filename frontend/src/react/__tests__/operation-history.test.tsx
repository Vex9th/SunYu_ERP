import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OperationHistory } from '../activity/OperationHistory'
import { ActivitySummary } from '../activity/ActivitySummary'
import { AccessProvider } from '../access/AccessProvider'
import type { SessionState } from '../../types'
beforeAll(() => { const original = window.getComputedStyle.bind(window); window.getComputedStyle = element => original(element); Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }) })
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) }) })
const session: SessionState = { authenticated: true, password_configured: true, bootstrap_required: false, user: { id: 1, username: 'owner', display_name: '新名字', is_owner: true, group_id: null, group_name: null, revision: 1 }, access_revision: 1, permissions: [], project_ids: null }
const renderHistory = () => render(<AccessProvider session={session} refresh={async () => undefined}><OperationHistory resourceType="document" resourceId={5} /></AccessProvider>)
describe('就地操作记录', () => {
  it('旧数据不虚构操作人', () => { render(<ActivitySummary label="上传者" actorName={null} />); expect(screen.getByText('历史记录，未记录操作人')).toBeTruthy() })
  it('按需加载历史，保持事件中的旧名字并分页', async () => { const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 3, action: 'documents.upload', actor_name: '当时的备注名', group_name: '原工作组', occurred_at: '2026-10-31T01:00:00Z', summary: '上传文件', reason: '补充资料', changes: { title: { before: '旧名称', after: '新名称' } } }], next_before_id: 3 }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ items: [], next_before_id: null }), { status: 200 })); renderHistory(); expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '查看操作记录' })); await screen.findByText('操作人：当时的备注名'); expect(screen.queryByText('新名字')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByText('已显示全部记录'); expect(fetcher.mock.calls[1]?.[0]).toContain('before_id=3') })
  it('失败保留重试入口，空历史明确说明未记录身份', async () => { vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ detail: '历史读取暂不可用' }), { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ items: [], next_before_id: null }), { status: 200 })); renderHistory(); fireEvent.click(screen.getByRole('button', { name: '查看操作记录' })); await screen.findByText('历史读取暂不可用'); fireEvent.click(screen.getByRole('button', { name: /重\s*试/ })); expect(await screen.findByText('历史记录，未记录操作人')).toBeTruthy() })
  it('账号变化关闭抽屉，不保留之前人员的记录', async () => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 3, action: 'documents.upload', actor_name: '原账号作者', group_name: null, occurred_at: '2026-10-31T01:00:00Z', summary: '上传文件', reason: null, changes: {} }], next_before_id: null }), { status: 200 })); const view = renderHistory(); fireEvent.click(screen.getByRole('button', { name: '查看操作记录' })); await screen.findByText('操作人：原账号作者'); view.rerender(<AccessProvider session={{ ...session, user: { ...session.user!, id: 2 } }} refresh={async () => undefined}><OperationHistory resourceType="document" resourceId={5} /></AccessProvider>); expect(screen.queryByText('操作人：原账号作者')).toBeNull() })
  it('字段变化显示中文日期，隐藏内部修订号', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 3, action: 'procurement.lines.confirm', actor_name: '采购员', group_name: '采购组', occurred_at: '2026-10-31T01:00:00Z', summary: '确认清单项', reason: null, changes: { confirmed_at: { before: null, after: '2026-10-31T01:00:00Z' }, revision: { before: 1, after: 2 } } }], next_before_id: null }), { status: 200 }))
    renderHistory()
    fireEvent.click(screen.getByRole('button', { name: '查看操作记录' }))
    expect(await screen.findByText('— → 2026年10月31日 09:00')).toBeTruthy()
    expect(screen.queryByText('revision')).toBeNull()
  })
  it('403 后清空事件并显示无权限', async () => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: '无权限' }), { status: 403 })); renderHistory(); fireEvent.click(screen.getByRole('button', { name: '查看操作记录' })); expect(await screen.findByText('无权查看此对象的操作记录')).toBeTruthy() })
})
