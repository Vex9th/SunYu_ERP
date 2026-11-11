import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AccessProvider } from '../access/AccessProvider'
import { selectPermission, type PermissionDefinition } from '../access/access'
import ProjectStages from '../project/ProjectStages'
import DocumentPreview from '../project/DocumentPreview'
import { ownerSession } from './access-fixtures'
import { installProjectDom, projectRepository } from './project-fixtures'
beforeAll(installProjectDom)
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const member = { ...ownerSession, user: { ...ownerSession.user!, id: 2, is_owner: false, group_id: 1, group_name: '只读组' }, permissions: ['project_stages.view', 'documents.view'], project_ids: [1] }
describe('业务能力边界', () => {
  it('只有查看阶段权限时不能更改计划或状态', async () => { const repository = projectRepository(); render(<AccessProvider session={member} refresh={async () => undefined}><MemoryRouter><ProjectStages projectCode="SY-A" projectId={1} repository={repository} /></MemoryRouter></AccessProvider>); const plan = await screen.findByRole('button', { name: /计划$/ }); expect((plan as HTMLButtonElement).disabled).toBe(true); fireEvent.click(plan); expect(repository.updateStageSchedule).not.toHaveBeenCalled() })
  it('只允许文件资料查看时，深链接也不请求正文', async () => { const repository = projectRepository(); render(<AccessProvider session={member} refresh={async () => undefined}><DocumentPreview projectCode="SY-A" documentId={6} versionId={22} repository={repository} onClose={() => undefined} onVersion={() => undefined} /></AccessProvider>); await screen.findByText(/现场会议纪要/); await waitFor(() => expect(repository.getDocument).toHaveBeenCalled()); expect(repository.downloadDocumentVersion).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: /下载原文件/ }) as HTMLButtonElement).disabled).toBe(true) })
  it('授权自动补足依赖，撤销查看权同步撤销写入权', () => { const catalog = [{ key: 'x.view', label: '查看', module: '测试', dependencies: [] }, { key: 'x.write', label: '修改', module: '测试', dependencies: ['x.view'] }]; expect(selectPermission([], 'x.write', true, catalog)).toEqual(['x.view', 'x.write']); expect(selectPermission(['x.view', 'x.write'], 'x.view', false, catalog)).toEqual([]) })
  it('采购操作补齐跨模块依赖，旧勾选也可补齐，取消项目查看会撤下依赖操作', () => {
    const catalog = [
      { key: 'projects.view', label: '查看项目资料', module: '项目资料', dependencies: [] },
      { key: 'procurement.orders.view', label: '查看采购单', module: '采购单', dependencies: [], workflow_dependencies: ['projects.view'] },
      { key: 'procurement.orders.create', label: '新建采购单', module: '采购单', dependencies: ['procurement.orders.view'], workflow_dependencies: ['sensitive.procurement_prices'] },
      { key: 'sensitive.procurement_prices', label: '查看采购价格', module: '敏感数据', dependencies: [] },
    ] as PermissionDefinition[]
    const old = ['procurement.orders.create', 'procurement.orders.view']
    const selected = selectPermission(old, 'procurement.orders.create', true, catalog)
    expect(selected).toEqual(['procurement.orders.create', 'procurement.orders.view', 'projects.view', 'sensitive.procurement_prices'])
    expect(selectPermission(selected, 'projects.view', false, catalog)).toEqual(['sensitive.procurement_prices'])
    expect(selectPermission(selected, 'sensitive.procurement_prices', false, catalog)).toEqual(['procurement.orders.view', 'projects.view'])
  })
  it('撤销库存查看不清空旧组尚未补齐的采购授权', () => {
    const catalog = [
      { key: 'projects.view', label: '项目', module: '项目', dependencies: [] },
      { key: 'procurement.orders.view', label: '采购', module: '采购', dependencies: [], workflow_dependencies: ['projects.view'] },
      { key: 'procurement.orders.create', label: '新建', module: '采购', dependencies: ['procurement.orders.view'] },
      { key: 'inventory.view', label: '库存', module: '库存', dependencies: [] },
    ] as PermissionDefinition[]
    expect(selectPermission(['procurement.orders.view', 'procurement.orders.create', 'inventory.view'], 'inventory.view', false, catalog))
      .toEqual(['procurement.orders.create', 'procurement.orders.view'])
  })
})
