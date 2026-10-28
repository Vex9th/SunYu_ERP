import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectsPage from '../ProjectsPage'
import HomePage from '../HomePage'
import { dashboard, installProjectDom } from './project-fixtures'

const api = vi.hoisted(() => ({ send: vi.fn(), requestJson: vi.fn() }))
vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  requestJson: api.requestJson,
  createRetriablePostSender: () => ({ send: api.send }),
}))
beforeAll(installProjectDom)
beforeEach(() => {
  vi.clearAllMocks()
  api.requestJson.mockImplementation(async (path: string) => path === '/api/companies' ? [{ id: 1, name: '测试客户' }] : [])
  api.send.mockResolvedValue({ project_code: 'TEST-CATEGORY' })
})
afterEach(cleanup)

describe('新建项目类别', () => {
  it('工作台将贸易项目的验收代码显示为签收', async () => {
    api.requestJson.mockResolvedValue({
      summary: { active_project_count: 1, upcoming_delivery_count: 0, contracted_amount_cents: 0, received_amount_cents: 0, outstanding_receivable_cents: 0, overdue_receivable_count: 0 },
      projects: [{ project: { ...dashboard.project, project_category: 'trade' }, current_stage: { ...dashboard.stages[0], stage_code: 'acceptance', status: 'in_progress' }, contracted_amount_cents: 0, outstanding_receivable_cents: 0, received_amount_cents: 0, final_delivery_on: null, actual_profit_cents: null }],
      todos: [], backup: { healthy: true },
    })
    render(<MemoryRouter><HomePage /></MemoryRouter>)
    expect(await screen.findByText('签收')).toBeTruthy()
    expect(screen.queryByText('验收')).toBeNull()
  })

  it.each(['standard', 'trade'])('创建 %s 项目时提交所选类别', async (category) => {
    render(<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App><MemoryRouter initialEntries={['/projects?create=1']}><Routes>
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:projectCode" element={<div>已进入新项目</div>} />
    </Routes></MemoryRouter></App></ConfigProvider>)
    expect(await screen.findByRole('radio', { name: '工程' })).toHaveProperty('checked', true)
    if (category === 'trade') {
      fireEvent.click(screen.getByRole('radio', { name: '贸易' }))
      expect(screen.getByText('合同签订 → 预付款 → 采购 → 签收 → 尾款')).toBeTruthy()
    }
    fireEvent.change(screen.getByLabelText('项目编号'), { target: { value: 'TEST-CATEGORY' } })
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '类别验证' } })
    fireEvent.mouseDown(screen.getByLabelText('客户公司'))
    fireEvent.click(await screen.findByRole('option', { name: '测试客户' }))
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('/api/projects', {
      project_code: 'TEST-CATEGORY', name: '类别验证', company_id: 1, description: null, project_category: category,
    }))
    expect(await screen.findByText('已进入新项目')).toBeTruthy()
  })
})
