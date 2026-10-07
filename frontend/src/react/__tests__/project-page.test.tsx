import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { dashboard, installProjectDom } from './project-fixtures'
import { ApiError } from '../../api'
import ProjectPage from '../ProjectPage'

const repository = vi.hoisted(() => ({
  getProjectDashboard: vi.fn(),
  closeProject: vi.fn(),
  restoreProject: vi.fn(),
  updateProject: vi.fn(),
}))
vi.mock('../../repositories/project-operating.live', () => ({
  createHttpProjectOperatingRepository: () => repository,
}))
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  requestJson: vi.fn(async () => []),
}))
beforeAll(installProjectDom)
beforeEach(() => {
  vi.clearAllMocks()
  repository.getProjectDashboard.mockResolvedValue(dashboard)
})
afterEach(cleanup)
function mount() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <MemoryRouter initialEntries={['/projects/SY-A']}>
          <Routes>
            <Route path="/projects/:projectCode" element={<ProjectPage />} />
          </Routes>
        </MemoryRouter>
      </App>
    </ConfigProvider>,
  )
}
describe('React 项目关闭与恢复', () => {
  it('旧版本草稿不能覆盖最新项目资料，载入最新记录后才可继续编辑', async () => {
    repository.getProjectDashboard.mockResolvedValue({
      ...dashboard,
      project: { ...dashboard.project, description: '原项目说明', revision: 1 },
    })
    repository.updateProject.mockResolvedValue(dashboard.project)
    const first = mount()
    fireEvent.click(await screen.findByRole('button', { name: /编辑项目/ }))
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: { value: '我的草稿项目名' },
    })
    first.unmount()
    repository.getProjectDashboard.mockResolvedValue({
      ...dashboard,
      project: {
        ...dashboard.project,
        description: '其他人更新的重要说明',
        revision: 2,
      },
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /编辑项目/ }))
    expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe(
      '我的草稿项目名',
    )
    expect(await screen.findByText('记录已更新，请核对草稿')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: /保\s*存/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    expect(repository.updateProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '载入最新内容' }))
    expect((screen.getByLabelText(/项目说明/) as HTMLInputElement).value).toBe(
      '其他人更新的重要说明',
    )
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: { value: '核对后的项目名' },
    })
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() =>
      expect(repository.updateProject).toHaveBeenCalledWith(
        'SY-A',
        expect.objectContaining({
          name: '核对后的项目名',
          description: '其他人更新的重要说明',
          expected_revision: 2,
        }),
      ),
    )
  })

  it('关闭必须明确选择类型，并显示三项完工条件', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '更多项目操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /关闭项目/ }))
    fireEvent.change(screen.getByLabelText('关闭原因'), {
      target: { value: '项目取消原因' },
    })
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await screen.findByText('请选择关闭类型')
    expect(repository.closeProject).not.toHaveBeenCalled()
    expect(screen.getByText('项目阶段：未完成')).toBeTruthy()
    expect(screen.getByText('最终验收：未通过')).toBeTruthy()
    expect(screen.getByText('应收款：未结清')).toBeTruthy()
  })
  it('恢复遇版本冲突后重新读取最新版本并保留原因', async () => {
    repository.getProjectDashboard
      .mockResolvedValueOnce({
        ...dashboard,
        project: { ...dashboard.project, status: 'archived' },
      })
      .mockResolvedValue({
        ...dashboard,
        project: { ...dashboard.project, status: 'archived', revision: 2 },
      })
    repository.restoreProject
      .mockRejectedValueOnce(new ApiError('项目版本冲突', 409))
      .mockResolvedValue(dashboard.project)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /恢复项目/ }))
    fireEvent.change(screen.getByLabelText('恢复原因'), {
      target: { value: '继续执行项目' },
    })
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await screen.findByText('项目版本冲突')
    await waitFor(() =>
      expect(repository.getProjectDashboard).toHaveBeenCalledTimes(2),
    )
    fireEvent.click(await screen.findByRole('button', { name: '使用草稿内容' }))
    fireEvent.click(await screen.findByRole('button', { name: '保留草稿' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /保\s*存/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() =>
      expect(repository.restoreProject).toHaveBeenLastCalledWith('SY-A', {
        reason: '继续执行项目',
        expected_revision: 2,
      }),
    )
  })
})
