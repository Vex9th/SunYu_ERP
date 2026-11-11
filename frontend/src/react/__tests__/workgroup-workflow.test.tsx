import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkgroupEditor } from '../access/WorkgroupEditor'
import type { PermissionDefinition, Workgroup } from '../access/access'

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const catalog = [
  { key: 'projects.view', label: '查看项目资料', module: '项目资料', dependencies: [] },
  { key: 'procurement.orders.view', label: '查看采购单', module: '采购单', dependencies: [], workflow_dependencies: ['projects.view'] },
  { key: 'procurement.orders.create', label: '新建采购单', module: '采购单', dependencies: ['procurement.orders.view'], workflow_dependencies: ['sensitive.procurement_prices'] },
  { key: 'sensitive.procurement_prices', label: '查看采购价格', module: '敏感数据', dependencies: [] },
] as PermissionDefinition[]
const group: Workgroup = { id: 1, name: '采购组', enabled: true, archived: false, member_count: 1, revision: 1, permission_keys: ['procurement.orders.view', 'procurement.orders.create'], project_ids: [], created_at: '', updated_at: '' }

describe('工作组操作依赖', () => {
  it('旧授权显示缺项，仅在主账号补齐并保存后发送新权限', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const saved = vi.fn(async () => undefined)
    const view = render(<WorkgroupEditor group={group} catalog={catalog} projects={[]} onSaved={saved} />)
    expect(screen.getByText('部分操作缺少必要权限')).toBeTruthy()
    expect((screen.getByLabelText('查看采购价格') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存项目与权限' }))
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '补齐所需权限' }))
    expect((screen.getByLabelText('查看项目资料') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('查看采购价格') as HTMLInputElement).checked).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/尚未选择可见项目/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存项目与权限' }))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body.permission_keys).toEqual(['procurement.orders.create', 'procurement.orders.view', 'projects.view', 'sensitive.procurement_prices'])
    expect(body.project_ids).toEqual([])
    expect(await screen.findByText('项目与权限已保存')).toBeTruthy()
    view.rerender(<WorkgroupEditor group={{ ...group, revision: 2, permission_keys: body.permission_keys }} catalog={catalog} projects={[]} onSaved={saved} />)
    expect(screen.getByText('项目与权限已保存')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('新建采购单'))
    expect(screen.queryByText('项目与权限已保存')).toBeNull()
  })
})
