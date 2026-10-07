import type { ReactNode } from 'react'
import { ConfigProvider } from 'antd'
import { MemoryRouter } from 'react-router-dom'
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
import DeliveryWorkspace, {
  afterSalesTransitions,
  changeTransitions,
  invoiceInput,
} from '../delivery/DeliveryWorkspace'
import { MockWorkforceRepository } from '../../repositories/workforce'
import type { DeliveryWorkspaceRepository } from '../../repositories/delivery.live'
import { ApiError } from '../../api'

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
function repository() {
  const repo =
    new MockWorkforceRepository() as unknown as DeliveryWorkspaceRepository
  vi.spyOn(repo, 'getDeliveryPreview').mockImplementation(
    async (projectCode) => ({
      source: 'demo',
      data: {
        project_code: projectCode,
        drawing_signoffs: [],
        commissioning_sessions: [],
        engineering_changes: [],
        acceptances: [],
        warranty: null,
        invoices: [],
        after_sales: [],
      },
    }),
  )
  return repo
}

// 多步骤工作区回归包含完整表单与重挂流程，为 CI 留出渲染时间。
describe('React 交付工作区', { timeout: 15000 }, () => {
  it('已登记发票要求完整信息与正确日期顺序', () => {
    expect(() =>
      invoiceInput({ status: 'recorded', invoice_number: 'FP-1' }, 0),
    ).toThrow('已登记发票必须填写')
    expect(() =>
      invoiceInput(
        {
          status: 'recorded',
          requested_on: '2026-10-02',
          recorded_on: '2026-10-01',
          invoice_number: 'FP-1',
          amount: '100.25',
        },
        0,
      ),
    ).toThrow('登记日期不能早于申请日期')
    expect(
      invoiceInput(
        {
          invoice_type: 'contract_payment',
          status: 'recorded',
          requested_on: '2026-10-01',
          recorded_on: '2026-10-02',
          invoice_number: 'FP-1',
          amount: '100.25',
        },
        0,
      ).amount_cents,
    ).toBe(10025)
    expect(() => invoiceInput({ status: 'planned' }, 0)).toThrow('请至少上传')
  })
  it('工程变更和售后终态没有可逆操作入口', () => {
    expect(changeTransitions.implemented).toEqual([])
    expect(changeTransitions.cancelled).toEqual([])
    expect(afterSalesTransitions.completed).toEqual([])
    expect(afterSalesTransitions.cancelled).toEqual([])
  })
  it('创建失败后即使关闭并重新挂载，也能重试同一发票提交', async () => {
    const repo = repository()
    const create = vi
      .spyOn(repo, 'saveInvoice')
      .mockRejectedValueOnce(new ApiError('请求超时', 0))
      .mockResolvedValue(undefined)
    const view = render(
      <DeliveryWorkspace projectCode="SY-2026-001" repository={repo} />,
    )
    await screen.findByRole('tab', { name: '发票' })
    fireEvent.click(screen.getByRole('tab', { name: '发票' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新增发票记录/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /新增发票记录/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('发票号码'), {
      target: { value: 'RETRY-001' },
    })
    const file = new File(['receipt'], 'receipt.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(drawer.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    await within(drawer).findByText('receipt.pdf')
    fireEvent.click(within(drawer).getByRole('button', { name: /保.*存/ }))
    await screen.findByRole('button', { name: '重试原提交' })
    view.unmount()
    render(<DeliveryWorkspace projectCode="SY-2026-001" repository={repo} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复并重试' }))
    fireEvent.click(await screen.findByRole('button', { name: '重试原提交' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
    expect(create.mock.calls[1]?.[1].invoice_number).toBe('RETRY-001')
    expect(create.mock.calls[1]?.[2]?.[0]).toBe(file)
  })
  it('跨页面放弃待确认提交后，不再恢复为可重复新建的草稿', async () => {
    const repo = repository()
    vi.spyOn(repo, 'saveInvoice').mockRejectedValue(new ApiError('请求超时', 0))
    vi.spyOn(repo, 'discardSaveInvoice').mockReturnValue(true)
    const view = render(
      <DeliveryWorkspace projectCode="DISCARD" repository={repo} />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: '发票' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新增发票记录/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /新增发票记录/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('发票号码'), {
      target: { value: 'DISCARD-001' },
    })
    fireEvent.click(
      within(drawer).getByRole('button', { name: '保存发票记录' }),
    )
    await screen.findByRole('button', { name: '重试原提交' })
    view.unmount()
    render(<DeliveryWorkspace projectCode="DISCARD" repository={repo} />)
    fireEvent.click(await screen.findByRole('button', { name: '放弃提交' }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并刷新' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '恢复并重试' })).toBeNull(),
    )
    expect(screen.queryByText(/有未保存的草稿/)).toBeNull()
    expect(screen.queryByRole('button', { name: '继续填写' })).toBeNull()
  })
  it('明确业务拒绝保持表单可编辑，不锁定为网络重试', async () => {
    const repo = repository()
    const create = vi
      .spyOn(repo, 'saveInvoice')
      .mockRejectedValue(
        new ApiError('号码重复', 409, 'INVOICE_NUMBER_CONFLICT'),
      )
    render(<DeliveryWorkspace projectCode="SY-2026-001" repository={repo} />)
    await screen.findByRole('tab', { name: '发票' })
    fireEvent.click(screen.getByRole('tab', { name: '发票' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /新增发票记录/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /新增发票记录/ }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('发票号码'), {
      target: { value: 'DUPLICATE' },
    })
    fireEvent.click(within(drawer).getByRole('button', { name: /保.*存/ }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await within(drawer).findByText('发票号码已存在，请核对后再保存')
    expect(
      (within(drawer).getByLabelText('发票号码') as HTMLInputElement).disabled,
    ).toBe(false)
    expect(screen.queryByRole('button', { name: '重试原提交' })).toBeNull()
  })
  it('URL 定位发票页签，搜索空态清除后可直接登记，未提交附件切页后保留', async () => {
    const repo = repository()
    const view = render(
      <MemoryRouter initialEntries={['/delivery?section=invoices&q=未找到']}>
        <WorkspaceNavigationProvider>
          <DeliveryWorkspace projectCode="DRAFT" repository={repo} />
        </WorkspaceNavigationProvider>
      </MemoryRouter>,
    )
    const search = await screen.findByRole('searchbox', {
      name: '搜索发票记录',
    })
    expect((search as HTMLInputElement).value).toBe('未找到')
    fireEvent.click(await screen.findByRole('button', { name: '清除筛选' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '登记第一张发票' }),
    )
    let drawer = await screen.findByRole('dialog')
    fireEvent.change(within(drawer).getByLabelText('发票号码'), {
      target: { value: 'DRAFT-001' },
    })
    const file = new File(['draft attachment'], 'draft.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(drawer.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    await within(drawer).findByText('draft.pdf')
    view.unmount()
    render(<DeliveryWorkspace projectCode="DRAFT" repository={repo} />)
    fireEvent.click(await screen.findByRole('button', { name: '继续填写' }))
    drawer = await screen.findByRole('dialog')
    expect(
      (within(drawer).getByLabelText('发票号码') as HTMLInputElement).value,
    ).toBe('DRAFT-001')
    expect(await within(drawer).findByText('draft.pdf')).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: /^取.*消$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('归档项目只能查看，交付 scope 保留验收、发票和售后', async () => {
    render(
      <DeliveryWorkspace
        projectCode="SY-2026-001"
        repository={repository()}
        readonly
        scope="delivery"
      />,
    )
    await screen.findByText('项目已归档，本页仅供查看')
    expect(screen.queryByRole('tab', { name: '图纸与调试' })).toBeNull()
    expect(screen.getByRole('tab', { name: '发票' })).toBeTruthy()
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /安排验收/ })
          .hasAttribute('disabled'),
      ).toBe(true),
    )
  })
  it('最终验收通过时一并提交质保信息并保留原附件关联', async () => {
    const repo = repository()
    const preview = await repo.getDeliveryPreview('FINAL')
    vi.spyOn(repo, 'getDeliveryPreview').mockResolvedValue({
      ...preview,
      data: {
        ...preview.data,
        acceptances: [
          {
            acceptance_id: 91,
            acceptance_type: 'final',
            status: 'scheduled',
            scheduled_on: '2026-10-06',
            performed_on: null,
            notes: null,
            document_version_ids: [21],
            cancel_reason: null,
            cancelled_at: null,
          },
        ],
      },
    })
    const complete = vi
      .spyOn(repo, 'completeAcceptance')
      .mockRejectedValueOnce(new ApiError('结果未知', 0))
      .mockResolvedValue(undefined)
    render(
      <DeliveryWorkspace
        projectCode="FINAL"
        repository={repo}
        scope="delivery"
      />,
    )
    const result = await screen.findByRole('button', { name: '登记结果' })
    fireEvent.click(result)
    const drawer = await screen.findByRole('dialog')
    fireEvent.mouseDown(within(drawer).getByLabelText('真实验收结果'))
    fireEvent.click(
      await screen.findByText('通过', {
        selector: '.ant-select-item-option-content',
      }),
    )
    fireEvent.change(await within(drawer).findByLabelText('续保价格'), {
      target: { value: '123.45' },
    })
    fireEvent.click(
      within(drawer).getByRole('button', { name: '登记验收结果' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '重试原提交' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    expect(complete.mock.calls[1]).toEqual(complete.mock.calls[0])
    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        'FINAL',
        91,
        expect.objectContaining({
          status: 'passed',
          document_version_ids: [21],
          warranty: expect.objectContaining({
            duration_months: 12,
            renewal_price_cents: 12345,
          }),
        }),
        [],
      ),
    )
  })
})
