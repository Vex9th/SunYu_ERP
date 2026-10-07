import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api'
import ProjectStages, { stageReasonRequired } from '../project/ProjectStages'
import { installProjectDom, projectRepository, stage } from './project-fixtures'

beforeAll(installProjectDom)
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('React 项目阶段', () => {
  it('保存计划保留版本，并拒绝结束早于开始', async () => {
    const repository = projectRepository()
    render(<ProjectStages projectCode="STAGE-A" repository={repository} />)
    fireEvent.click(await screen.findByRole('button', { name: /计\s*划$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('计划开始'), { target: { value: '2026-10-08' } })
    fireEvent.change(within(dialog).getByLabelText('计划结束'), { target: { value: '2026-10-07' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存$/ }))
    await screen.findByText('计划结束日期不能早于开始日期')
    expect(repository.updateStageSchedule).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText('计划结束'), { target: { value: '2026-10-09' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存$/ }))
    await waitFor(() => expect(repository.updateStageSchedule).toHaveBeenCalledWith('STAGE-A', 'planning', { planned_start_on: '2026-10-08', planned_end_on: '2026-10-09', notes: null, expected_revision: 4 }))
  })
  it('状态提交结果未知后，卸载重挂仍使用原发生时间与版本重试', async () => {
    const repository = projectRepository()
    vi.mocked(repository.transitionStage).mockRejectedValueOnce(new ApiError('超时', 0))
    const view = render(<ProjectStages projectCode="STAGE-RETRY" repository={repository} />)
    fireEvent.click(await screen.findByRole('button', { name: /状\s*态$/ }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /保\s*存$/ }))
    await screen.findByText('变更阶段状态的结果尚未确认')
    const original = vi.mocked(repository.transitionStage).mock.calls[0][2]
    view.unmount()
    render(<ProjectStages projectCode="STAGE-RETRY" repository={repository} />)
    fireEvent.click(await screen.findByRole('button', { name: '重试原请求' }))
    await waitFor(() => expect(repository.transitionStage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(repository.transitionStage).mock.calls[1][2]).toBe(original)
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试原请求' })).toBeNull())
  })
  it('跨项目晚到结果不能覆盖新项目阶段', async () => {
    const repository = projectRepository()
    let resolve!: (value: { source: 'live'; data: typeof stage[] }) => void
    vi.mocked(repository.listProjectStages).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ source: 'live', data: [{ ...stage, stage_code: 'acceptance' }] })
    const view = render(<ProjectStages projectCode="OLD" repository={repository} />)
    view.rerender(<ProjectStages projectCode="NEW" repository={repository} />)
    await screen.findByText('验收')
    await act(async () => { resolve({ source: 'live', data: [stage] }) })
    expect(screen.queryByText('项目规划')).toBeNull()
  })
  it('归档只读禁用写入，并保留流转原因规则', async () => {
    const repository = projectRepository()
    render(<ProjectStages projectCode="READONLY" readonly repository={repository} />)
    await screen.findByText('项目规划')
    expect((screen.getByRole('button', { name: /计\s*划$/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(stageReasonRequired('completed', 'in_progress')).toBe(true)
    expect(stageReasonRequired('pending', 'skipped')).toBe(true)
    expect(stageReasonRequired('in_progress', 'completed')).toBe(false)
  })
  it('默认聚焦进行中、受阻和下一步，完整计划与历史仍可直接查看', async () => {
    const repository = projectRepository()
    vi.mocked(repository.listProjectStages).mockResolvedValue({ source: 'live', data: [
      { ...stage, status: 'completed' },
      { ...stage, stage_code: 'site_survey', status: 'blocked', status_reason: '等待客户开放现场' },
      { ...stage, stage_code: 'quotation', status: 'in_progress' },
      { ...stage, stage_code: 'technical_agreement' },
      { ...stage, stage_code: 'contract' },
    ] })
    render(<ProjectStages projectCode="STAGE-FOCUS" repository={repository} />)
    await screen.findByText('等待客户开放现场')
    expect(screen.queryByText('项目规划')).toBeNull()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4)
    expect(screen.getByText('下一步')).toBeTruthy()
    expect(screen.getByRole('button', { name: '合同签订' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '完整计划 (5)' }))
    expect(await screen.findByText('项目规划')).toBeTruthy()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(6)
    fireEvent.click(screen.getByRole('tab', { name: '完成 / 跳过 (1)' }))
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
  })
  it('取消阶段计划需要确认，继续编辑保留已填内容', async () => {
    render(<ProjectStages projectCode="STAGE-DRAFT" repository={projectRepository()} />)
    fireEvent.click(await screen.findByRole('button', { name: /计\s*划$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('计划说明'), { target: { value: '等周五到场后再安排' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }))
    expect(within(dialog).getByLabelText('计划说明')).toHaveProperty('value', '等周五到场后再安排')
  })

})
