import type { ReactNode } from 'react'
import { ConfigProvider } from 'antd'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import { WorkspaceNavigationProvider } from '../navigationState'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import WorkforceWorkspace, {
  advanceTotals,
  eligibleAssignments,
} from '../workforce/WorkforceWorkspace'
import { MockWorkforceRepository } from '../../repositories/workforce'
import { ApiError } from '../../api'
import { formatMoney } from '../../domain/formatters'
import { localISODate } from '../../domain/dates'
import type { WorkforceDemoViewModel } from '../../domain/workforce'

function render(node: ReactNode) {
  return testingRender(
    <ConfigProvider theme={{ token: { motion: false } }}>
      {node}
    </ConfigProvider>,
  )
}

beforeAll(() => {
  const computedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element) => computedStyle(element)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true
      },
    }),
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function uiRepository() {
  const repo = new MockWorkforceRepository()
  vi.spyOn(repo, 'getWorkforcePreview').mockImplementation(
    async (projectCode) => ({
      source: 'demo',
      data: {
        project_code: projectCode,
        workers: [],
        crew_assignments: [],
        labor_entries: [],
        site_daily_reports: [],
        material_advances: [],
      },
    }),
  )
  return repo
}

// 多步骤工作区回归包含完整表单与重挂流程，为 CI 留出渲染时间。
describe('React 施工工作区', { timeout: 15000 }, () => {
  it('同一工人优先使用有效的进行中安排，不包含停用和不在日期范围内的安排', async () => {
    const repo = new MockWorkforceRepository()
    const model = (await repo.getWorkforcePreview('SY-2026-001')).data
    const worker = model.workers[0]!
    const assignment = model.crew_assignments.find(
      (row) => row.worker_id === worker.worker_id,
    )!
    const input: WorkforceDemoViewModel = {
      ...model,
      workers: [{ ...worker, status: 'active' }],
      crew_assignments: [
        {
          ...assignment,
          assignment_id: 1,
          status: 'planned',
          scheduled_start_on: '2026-01-01',
          scheduled_end_on: '2026-12-31',
        },
        {
          ...assignment,
          assignment_id: 2,
          status: 'active',
          scheduled_start_on: '2026-01-01',
          scheduled_end_on: '2026-12-31',
        },
        {
          ...assignment,
          assignment_id: 3,
          status: 'active',
          scheduled_start_on: '2027-01-01',
          scheduled_end_on: '2027-12-31',
        },
      ],
    }
    expect(
      eligibleAssignments(input, '2026-10-06').map((row) => row.assignment_id),
    ).toEqual([2])
    expect(
      eligibleAssignments(
        { ...input, workers: [{ ...worker, status: 'inactive' }] },
        '2026-10-06',
      ),
    ).toEqual([])
  })
  it('垫资待报销金额不扣除已作废报销', async () => {
    const repo = new MockWorkforceRepository()
    const advance = (await repo.getWorkforcePreview('SY-2026-001')).data
      .material_advances[0]!
    const result = advanceTotals({
      ...advance,
      reimbursements: advance.reimbursements.map((row) => ({
        ...row,
        status: 'voided',
      })),
    })
    expect(result.reimbursed).toBe(0)
    expect(result.outstanding).toBe(result.total)
  })
  it('从人员档案抽屉新增施工员，空白电话保存为 null', async () => {
    const repo = uiRepository()
    const create = vi.spyOn(repo, 'createWorker')
    render(<WorkforceWorkspace projectCode="SY-2026-001" repository={repo} />)
    await screen.findByRole('tab', { name: '施工员档案' })
    fireEvent.click(screen.getByRole('tab', { name: '施工员档案' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新建施工员/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /新建施工员/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('姓名'), {
      target: { value: '现场电工' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /保.*存/ }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: '现场电工',
        phone: null,
        notes: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('上工历史空态可直接前往登记，档案草稿关闭需确认且切页后能恢复', async () => {
    const repo = uiRepository()
    const view = render(
      <WorkforceWorkspace projectCode="DRAFT" repository={repo} />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: '上工历史' }))
    fireEvent.click(await screen.findByRole('button', { name: '前往上工登记' }))
    expect(
      screen
        .getByRole('tab', { name: '上工登记' })
        .getAttribute('aria-selected'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '施工员档案' }))
    fireEvent.click(await screen.findByRole('button', { name: /新建施工员/ }))
    let drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('姓名'), {
      target: { value: '未提交的工人' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /^取.*消$/ }))
    await screen.findByRole('button', { name: '放弃并关闭' })
    fireEvent.click(screen.getByRole('button', { name: '继续填写' }))
    expect(
      (within(drawer).getByLabelText('姓名') as HTMLInputElement).value,
    ).toBe('未提交的工人')
    view.unmount()
    render(<WorkforceWorkspace projectCode="DRAFT" repository={repo} />)
    fireEvent.click(await screen.findByRole('button', { name: '继续填写' }))
    drawer = await screen.findByRole('dialog')
    expect(
      (within(drawer).getByLabelText('姓名') as HTMLInputElement).value,
    ).toBe('未提交的工人')
    expect(
      within(drawer).getByRole('button', { name: '保存施工员档案' }),
    ).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: /^取.*消$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText(/有未保存的草稿/)).toBeNull()
  })
  it('从 URL 恢复当前页签和搜索，离开再返回保留列表上下文', async () => {
    const repo = uiRepository()
    render(
      <MemoryRouter initialEntries={['/workforce?section=workers&q=原搜索']}>
        <WorkspaceNavigationProvider>
          <Routes>
            <Route
              path="/workforce"
              element={
                <>
                  <Link to="/other">离开工作区</Link>
                  <WorkforceWorkspace projectCode="NAV" repository={repo} />
                </>
              }
            />
            <Route
              path="/other"
              element={<Link to="/workforce">返回工作区</Link>}
            />
          </Routes>
        </WorkspaceNavigationProvider>
      </MemoryRouter>,
    )
    const search = await screen.findByRole('searchbox', { name: '搜索施工员' })
    expect((search as HTMLInputElement).value).toBe('原搜索')
    fireEvent.change(search, { target: { value: '木工' } })
    fireEvent.click(screen.getByRole('tab', { name: '项目安排' }))
    fireEvent.click(screen.getByRole('link', { name: '离开工作区' }))
    fireEvent.click(screen.getByRole('link', { name: '返回工作区' }))
    expect(
      (
        (await screen.findByRole('searchbox', {
          name: '搜索项目安排',
        })) as HTMLInputElement
      ).value,
    ).toBe('木工')
    expect(
      screen
        .getByRole('tab', { name: '项目安排' })
        .getAttribute('aria-selected'),
    ).toBe('true')
  })
  it('归档项目保留查询，但阻止所有新增操作', async () => {
    const repo = uiRepository()
    render(
      <WorkforceWorkspace
        projectCode="SY-2026-001"
        repository={repo}
        readonly
      />,
    )
    await screen.findByText('项目已归档，本页仅供查看')
    fireEvent.click(screen.getByRole('tab', { name: '施工员档案' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新建施工员/ })
          .hasAttribute('disabled'),
      ).toBe(true),
    )
    fireEvent.click(screen.getByRole('tab', { name: '项目安排' }))
    expect(
      screen
        .getByRole('button', { name: /添加项目工人/ })
        .hasAttribute('disabled'),
    ).toBe(true)
  })
  it('网络失败锁定原始人员提交，重试复用完全相同的输入', async () => {
    const repo = uiRepository()
    const original = repo.createWorker.bind(repo)
    const create = vi
      .spyOn(repo, 'createWorker')
      .mockRejectedValueOnce(new ApiError('请求超时', 0))
      .mockImplementation(original)
    render(<WorkforceWorkspace projectCode="SY-2026-001" repository={repo} />)
    await screen.findByRole('tab', { name: '施工员档案' })
    fireEvent.click(screen.getByRole('tab', { name: '施工员档案' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新建施工员/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /新建施工员/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('姓名'), {
      target: { value: '重试施工员' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /保.*存/ }))
    await screen.findByRole('button', { name: '重试原提交' })
    expect(
      (within(drawer).getByLabelText('姓名') as HTMLInputElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重试原提交' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
  })
  it('批量上工按各自日薪与时薪保存，统一工作内容作用于选中人员', async () => {
    const repo = uiRepository()
    const date = localISODate()
    const model: WorkforceDemoViewModel = {
      project_code: 'BATCH',
      workers: [
        {
          worker_id: 1,
          name: '日薪工人',
          status: 'active',
          phone: null,
          notes: null,
        },
        {
          worker_id: 2,
          name: '时薪工人',
          status: 'active',
          phone: null,
          notes: null,
        },
      ],
      crew_assignments: [
        {
          assignment_id: 10,
          worker_id: 1,
          role: '安装',
          scheduled_start_on: date,
          scheduled_end_on: date,
          pay_basis: 'daily',
          rate_cents: 30000,
          notes: null,
          status: 'active',
        },
        {
          assignment_id: 20,
          worker_id: 2,
          role: '接线',
          scheduled_start_on: date,
          scheduled_end_on: date,
          pay_basis: 'hourly',
          rate_cents: 5000,
          notes: null,
          status: 'active',
        },
      ],
      labor_entries: [],
      site_daily_reports: [],
      material_advances: [],
    }
    vi.spyOn(repo, 'getWorkforcePreview').mockResolvedValue({
      source: 'demo',
      data: model,
    })
    const save = vi
      .spyOn(repo, 'saveLaborEntriesBatch')
      .mockResolvedValue({ source: 'demo', data: [] })
    const batchView = render(
      <WorkforceWorkspace projectCode="BATCH" repository={repo} />,
    )
    await screen.findByText('日薪工人')
    fireEvent.click(screen.getByRole('button', { name: '全选到场' }))
    fireEvent.change(screen.getByLabelText('时薪工人的上工小时数'), {
      target: { value: '4.5' },
    })
    fireEvent.change(screen.getByPlaceholderText('统一填写工作内容'), {
      target: { value: '现场安装与接线' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用到已选人员' }))
    batchView.unmount()
    render(<WorkforceWorkspace projectCode="BATCH" repository={repo} />)
    await waitFor(() =>
      expect(
        (screen.getByLabelText('日薪工人的工作内容') as HTMLInputElement).value,
      ).toBe('现场安装与接线'),
    )
    fireEvent.click(screen.getByRole('button', { name: '保存 2 人上工记录' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('BATCH', {
        work_date: date,
        entries: [
          {
            assignment_id: 10,
            attendance_status: 'present',
            day_fraction: '1.000',
            work_minutes: null,
            work_summary: '现场安装与接线',
            notes: null,
          },
          {
            assignment_id: 20,
            attendance_status: 'present',
            day_fraction: null,
            work_minutes: 270,
            work_summary: '现场安装与接线',
            notes: null,
          },
        ],
      }),
    )
  })
  it('已保存但刷新失败时显示成功边界，不产生待重试写入', async () => {
    const repo = uiRepository()
    const snapshot = await repo.getWorkforcePreview('SY-2026-001')
    vi.spyOn(repo, 'getWorkforcePreview')
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValue(new ApiError('读取超时', 0))
    const create = vi.spyOn(repo, 'createWorker')
    render(<WorkforceWorkspace projectCode="SY-2026-001" repository={repo} />)
    fireEvent.click(await screen.findByRole('tab', { name: '施工员档案' }))
    fireEvent.click(await screen.findByRole('button', { name: /新建施工员/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('姓名'), {
      target: { value: '保存成功工人' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /保.*存/ }))
    await screen.findByText('已保存，但刷新失败。请刷新后查看最新记录。')
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '恢复并重试' })).toBeNull()
  })
})

it('旧日薪记录在安排涨薪及改时薪后仍展示历史日薪并提交日薪更正', async () => {
  const repo = new MockWorkforceRepository()
  const model = (await repo.getWorkforcePreview('HISTORICAL')).data
  const assignment = model.crew_assignments[0]!
  const entry = { ...model.labor_entries[0]!, pay_basis: 'daily' as const, rate_cents: 20000, revision: 1, day_fraction: '1.000' }
  vi.spyOn(repo, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: {
    ...model,
    crew_assignments: [{ ...assignment, pay_basis: 'hourly', rate_cents: 30000 }],
    labor_entries: [entry],
  } })
  const update = vi.spyOn(repo, 'updateLaborEntry').mockResolvedValue()
  render(<WorkforceWorkspace projectCode="HISTORICAL" repository={repo} />)
  fireEvent.click(await screen.findByRole('tab', { name: '上工历史' }))
  fireEvent.click(await screen.findByRole('button', { name: '更正' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText(`历史计薪：${formatMoney(20000)} / 日；更正费用预览：${formatMoney(20000)}`)).toBeTruthy()
  expect(within(dialog).queryByLabelText('上工小时数')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '更正上工记录' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith('HISTORICAL', entry.entry_id, expect.objectContaining({ expected_revision: 1, day_fraction: '1.000', work_minutes: null })))
})
