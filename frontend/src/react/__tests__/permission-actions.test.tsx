import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AccessProvider } from '../access/AccessProvider'
import { selectPermission } from '../access/access'
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
})
