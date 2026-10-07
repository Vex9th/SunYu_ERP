import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ProcurementWorkspace from '../procurement/ProcurementWorkspace'
import { WorkspaceNavigationProvider } from '../navigationState'
import type { ProcurementHttpRepository } from '../../repositories/procurement.live'
import type { ProcurementImportPreviewDto, PurchaseOrderRecordDto } from '../../domain/procurement-extensions'
import type { ProcurementLineDto } from '../../domain/operations-api'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }) })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element) => original(element)
})
afterEach(cleanup)
function repository() {
  const list = { id: 1, project_code: 'SY-001', name: '弱电物料', notes: null, status: 'draft', revision: 1, line_count: 0, lines: [], cost_total_cents: 0, quoted_total_cents: 0, confirmed_at: null, created_at: '', updated_at: '' }
  const result = <T,>(data: T) => Promise.resolve({ source: 'live', data })
  return { listSupplierCompanies: () => result([{ id: 1, name: '供应商甲' }]), listProcurementLists: () => result({ items: [list], total: 1, page: 1, page_size: 20 }), getProcurementList: () => result(list), listPurchaseOrders: () => result({ items: [], total: 0, page: 1, page_size: 20 }), getProcurementOverview: () => result({ project_code: 'SY-001', line_count: 0, line_status_counts: {}, procurement_committed_cents: 0, procurement_received_cents: 0, procurement_paid_cents: 0, material_consumed_cents: 0 }), listDocumentVersionOptions: () => Promise.resolve([]), listQuoteExports: () => result({ items: [], total: 0, page: 1, page_size: 20 }), createProcurementList: vi.fn(() => result(list)), discardCreateProcurementList: () => true } as unknown as ProcurementHttpRepository
}
function material(id: number, name: string, quantity: string): ProcurementLineDto {
  return { id, procurement_list_id: 1, inventory_item_id: null, sequence_no: id, category: '弱电', name, specification: null, brand: null, model: null, quantity, unit: '件', unit_cost_cents: 1234, quoted_unit_price_cents: 2000, cost_total_cents: 2468, quoted_total_cents: 4000, ordered_quantity: '0.000', ordered_amount_cents: 0, paid_amount_cents: 0, received_quantity: '0.000', invoiced_amount_cents: 0, issued_quantity: '0.000', order_status: 'not_ordered', payment_status: 'unpaid', receipt_status: 'not_received', invoice_status: 'not_invoiced', usage_status: 'unused', revision: 1, created_at: '', updated_at: '' }
}
function LocationProbe() { return <output aria-label="当前地址">{useLocation().search}</output> }
describe('React 采购工作区', () => {
  it('读取 URL 的采购页签，切换页签时保留其他查询条件', async () => {
    render(<MemoryRouter initialEntries={['/projects/SY-URL-001/procurement?section=orders&keep=1']}><WorkspaceNavigationProvider>
      <ProcurementWorkspace projectCode="SY-URL-001" repository={repository()} customerCompany={{ id: 2, name: '客户甲' }} /><LocationProbe />
    </WorkspaceNavigationProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('tab', { name: /采购单/ }).getAttribute('aria-selected')).toBe('true'))
    expect(screen.queryByRole('button', { name: /新建清单/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '客户报价' }))
    await waitFor(() => expect(screen.getByLabelText('当前地址').textContent).toContain('section=quotes'))
    expect(screen.getByLabelText('当前地址').textContent).toContain('keep=1')
  })

  it('只显示当前清单物料，切换清单后新增操作使用明确的当前清单', async () => {
    const repo = repository()
    const first = { ...(await repo.getProcurementList('SY-001', 1)).data, lines: [material(1, '网络交换机', '2.000')] }
    const second = { ...first, id: 2, name: '电气清单', lines: [{ ...material(2, '电气柜', '1.000'), procurement_list_id: 2 }] }
    repo.listProcurementLists = async () => ({ source: 'live', data: { items: [first, second], total: 2, page: 1, page_size: 20 } })
    repo.getProcurementList = async (_code, id) => ({ source: 'live', data: id === 1 ? first : second })
    repo.createProcurementLine = vi.fn<ProcurementHttpRepository['createProcurementLine']>().mockResolvedValue({ source: 'live', data: { ...material(3, '接线端子', '2.000'), procurement_list_id: 2 } })
    repo.discardCreateProcurementLine = () => true
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByText('网络交换机')
    expect(screen.queryByText('电气柜')).toBeNull()
    expect(screen.queryByText('累计付款')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开网络交换机明细' }))
    expect(await screen.findByText('累计付款')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看清单 电气清单' }))
    await screen.findByText('电气柜')
    expect(screen.queryByText('网络交换机')).toBeNull()
    expect(screen.queryByText('累计付款')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加物料' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('电气清单')).toBeTruthy()
    for (const [label, value] of [['物料名称', '接线端子'], ['计量单位', '件'], ['需求数量', '2.000'], ['成本单价（元）', '1.00'], ['报价单价（元）', '2.00']]) fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(repo.createProcurementLine).toHaveBeenCalledWith('SY-001', 2, expect.objectContaining({ name: '接线端子' })))
  })

  it('报价页签没有新建清单操作，未指定上下文时必须主动选择报价清单', async () => {
    const repo = repository()
    const list = (await repo.getProcurementList('SY-001', 1)).data
    repo.getProcurementList = async () => ({ source: 'live', data: { ...list, status: 'confirmed' } })
    repo.createQuoteExport = vi.fn()
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('tab', { name: '客户报价' }))
    expect(screen.queryByRole('button', { name: /新建清单/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /生成报价单/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('报价标题'), { target: { value: '客户正式报价' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await within(dialog).findByText('请选择已确认采购清单')
    expect(repo.createQuoteExport).not.toHaveBeenCalled()
  })

  it('添加采购物料时默认数字序号 1 可直接提交，无需重新输入', async () => {
    const repo = repository()
    repo.createProcurementLine = vi.fn<ProcurementHttpRepository['createProcurementLine']>().mockResolvedValue({ source: 'live', data: { ...material(1, '测试交换机', '2.000'), unit: '台' } })
    repo.discardCreateProcurementLine = () => true
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getAllByRole('button', { name: '添加物料' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('序号') as HTMLInputElement).value).toBe('1')
    for (const [label, value] of [['物料名称', '测试交换机'], ['计量单位', '台'], ['需求数量', '2.000'], ['成本单价（元）', '12.34'], ['报价单价（元）', '20.00']]) fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(repo.createProcurementLine).toHaveBeenCalledWith('SY-001', 1, expect.objectContaining({ sequence_no: 1, name: '测试交换机', unit: '台', quantity: '2.000', unit_cost_cents: 1234, quoted_unit_price_cents: 2000 })))
  })
  it('归档只读仍能浏览清单，不出现新建、导入和确认写入入口', async () => {
    render(<ProcurementWorkspace projectCode="SY-001" readonly repository={repository()} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    expect(screen.queryByRole('button', { name: /新建清单/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /确认清单/ })).toBeNull()
    expect(screen.getByText(/项目已归档/)).toBeTruthy()
  })
  it('清单创建结果未知后卸载重挂仍保留原请求并原样重试', async () => {
    const repo = repository()
    const create = vi.mocked(repo.createProcurementList)
    create.mockRejectedValueOnce(new Error('连接中断'))
    const view = render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('button', { name: /新建清单/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('清单名称'), { target: { value: '设备清单' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await screen.findByText(/结果未知，原始请求已保留/)
    const original = create.mock.calls[0]![1]
    view.unmount()
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    fireEvent.click(await screen.findByRole('button', { name: '原样重试' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]![0]).toBe('SY-001')
    expect(create.mock.calls[1]![1]).toBe(original)
    await waitFor(() => expect(screen.queryByText(/结果未知，原始请求已保留/)).toBeNull())
  })
  it('写入中卸载重挂，原请求迟到成功后刷新当前清单', async () => {
    const repo = repository()
    const original = (await repo.getProcurementList('SY-001', 1)).data
    let saved = false
    let resolve!: () => void
    repo.getProcurementList = async () => ({ source: 'live', data: { ...original, name: saved ? '保存后的清单' : '弱电物料' } })
    repo.createProcurementList = () => new Promise((done) => { resolve = () => { saved = true; done({ source: 'live', data: original }) } })
    const view = render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('button', { name: /新建清单/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('清单名称'), { target: { value: '设备清单' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    view.unmount()
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    await act(async () => resolve())
    expect(await screen.findByRole('button', { name: '查看清单 保存后的清单' })).toBeTruthy()
  })
  it('已生成报价下载失败后，卸载重试只下载原报价，不再次生成', async () => {
    const repo = repository()
    const list = (await repo.getProcurementList('SY-001', 1)).data
    repo.getProcurementList = async () => ({ source: 'live', data: { ...list, status: 'confirmed' } })
    repo.createQuoteExport = vi.fn<ProcurementHttpRepository['createQuoteExport']>(async (_code, _id, input) => ({ source: 'live', data: { ...input, id: 42, project_code: 'SY-001', procurement_list_id: 1, customer_company_name: '客户甲', created_at: '', download_url: '' } }))
    repo.downloadQuoteExport = vi.fn().mockRejectedValueOnce(new Error('下载连接中断')).mockResolvedValue(new Blob(['quote']))
    URL.createObjectURL = vi.fn(() => 'blob:test-quote')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('button', { name: '客户报价' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await screen.findByText(/客户报价单结果未知/)
    view.unmount()
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    fireEvent.click(await screen.findByRole('button', { name: '原样重试' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(repo.createQuoteExport).toHaveBeenCalledTimes(1)
    expect(repo.downloadQuoteExport).toHaveBeenNthCalledWith(2, 'SY-001', 42)
    click.mockRestore()
  })
  it.each([
    { stage: '生成', navigation: '切换项目' },
    { stage: '生成', navigation: '卸载重挂' },
    { stage: '下载', navigation: '切换项目' },
    { stage: '下载', navigation: '卸载' },
  ])('报价 $stage 请求等待中 $navigation，不自动下载原页面文件', async ({ stage, navigation }) => {
    const repo = repository()
    const list = (await repo.getProcurementList('SY-001', 1)).data
    repo.getProcurementList = async () => ({ source: 'live', data: { ...list, status: 'confirmed' } })
    let finish!: () => void
    repo.createQuoteExport = vi.fn<ProcurementHttpRepository['createQuoteExport']>((_code, _id, input) => {
      const result = { source: 'live' as const, data: { ...input, id: 42, project_code: 'SY-001', procurement_list_id: 1, customer_company_name: '客户甲', created_at: '', download_url: '' } }
      return stage === '生成' ? new Promise((resolve) => { finish = () => resolve(result) }) : Promise.resolve(result)
    })
    repo.downloadQuoteExport = vi.fn<ProcurementHttpRepository['downloadQuoteExport']>(() => stage === '下载' ? new Promise((resolve) => { finish = () => resolve(new Blob(['quote'])) }) : Promise.resolve(new Blob(['quote'])))
    URL.createObjectURL = vi.fn(() => 'blob:test-stale-quote')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      const view = render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
      await screen.findByRole('button', { name: '查看清单 弱电物料' })
      fireEvent.click(screen.getByRole('button', { name: '客户报价' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
      await waitFor(() => expect(finish).toBeTypeOf('function'))
      if (navigation === '切换项目') {
        view.rerender(<ProcurementWorkspace projectCode="SY-002" repository={repo} customerCompany={{ id: 3, name: '客户乙' }} />)
      } else {
        view.unmount()
        if (navigation === '卸载重挂') render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
      }
      await act(async () => finish())
      expect(repo.createQuoteExport).toHaveBeenCalledTimes(1)
      expect(repo.downloadQuoteExport).toHaveBeenCalledTimes(stage === '生成' ? 0 : 1)
      expect(click).not.toHaveBeenCalled()
      expect(URL.createObjectURL).not.toHaveBeenCalled()
      expect(screen.queryByText(/客户报价单结果未知/)).toBeNull()
    } finally { click.mockRestore() }
  })
  it('Excel 预览存在错误时显示行列位置并禁止确认导入', async () => {
    const repo = repository()
    repo.previewProcurementImport = vi.fn<ProcurementHttpRepository['previewProcurementImport']>(async () => ({ source: 'live', data: { id: 3, project_code: 'SY-001', filename: '材料.xlsx', sha256: '', status: 'preview', revision: 1, expires_at: '', confirmed_list_id: null, rows: [], errors: [{ row: 2, column: 4, field: 'quantity', message: '数量必须为正数' }], created_at: '', updated_at: '' } satisfies ProcurementImportPreviewDto }))
    repo.discardPreviewProcurementImport = () => true
    repo.confirmProcurementImport = vi.fn()
    const view = render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('tab', { name: 'Excel 导入' }))
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['xlsx'], '材料.xlsx')] } })
    await screen.findByText('第 2 行，第 4 列 · 数量必须为正数')
    expect((screen.getByRole('button', { name: '确认导入' }) as HTMLButtonElement).disabled).toBe(true)
    expect(repo.confirmProcurementImport).not.toHaveBeenCalled()
  })
  it('到货数量默认零，填写实际数量后保留采购单行身份提交', async () => {
    const repo = repository()
    const record: PurchaseOrderRecordDto = { id: 9, project_code: 'SY-001', order_no: 'PO-009', supplier_company_id: 1, supplier_company_name: '供应商甲', status: 'confirmed', ordered_on: '2026-10-06', expected_delivery_on: null, notes: null, document_version_ids: [], revision: 2, ordered_amount_cents: 5000, created_at: '', updated_at: '', lines: [{ id: 91, purchase_order_id: 9, procurement_line_id: 7, quantity: '5.000', unit_cost_cents: 1000, line_amount_cents: 5000, overage_reason: null, received_quantity: '2.000' }] }
    repo.listPurchaseOrders = async () => ({ source: 'live', data: { items: [record], total: 1, page: 1, page_size: 20 } })
    repo.getPurchaseOrder = async () => ({ source: 'live', data: record })
    repo.receiveGoods = vi.fn<ProcurementHttpRepository['receiveGoods']>(async (_code, orderId, input) => ({ source: 'live', data: { ...input, id: 1, purchase_order_id: orderId, status: 'active', reversal_reason: null, reversed_at: null, revision: 1, lines: input.lines.map((line, index) => ({ ...line, id: index + 1, inventory_item_id: 3, material_name: '测试物料', material_model: null, unit: '件', value_cents: 1500, movement_id: 5 })), created_at: '', updated_at: '' } }))
    repo.discardReceiveGoods = () => true
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByRole('button', { name: '查看清单 弱电物料' })
    fireEvent.click(screen.getByRole('tab', { name: /采购单/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'PO-009' }))
    fireEvent.click(await screen.findByRole('button', { name: '登记到货' }))
    const dialogs = screen.getAllByRole('dialog')
    const dialog = dialogs[dialogs.length - 1]!
    const quantity = within(dialog).getByLabelText('本次到货数量') as HTMLInputElement
    expect(quantity.value).toBe('0')
    fireEvent.change(within(dialog).getByLabelText('仓库名称'), { target: { value: '项目仓库' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await within(dialog).findByText('请填写本次实际到货数量')
    expect(repo.receiveGoods).not.toHaveBeenCalled()
    fireEvent.change(quantity, { target: { value: '1.500' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(repo.receiveGoods).toHaveBeenCalledWith('SY-001', 9, expect.objectContaining({ warehouse_name: '项目仓库', lines: [{ purchase_order_line_id: 91, quantity: '1.500' }] })))
  })
  it('建立多行采购单必须明确选择供应商，并发送各物料数量和分单位成本', async () => {
    const repo = repository()
    const list = (await repo.getProcurementList('SY-001', 1)).data
    repo.getProcurementList = async () => ({ source: 'live', data: { ...list, status: 'confirmed', lines: [material(1, '交换机', '2.000'), material(2, '接头', '3.000')] } })
    repo.createPurchaseOrder = vi.fn<ProcurementHttpRepository['createPurchaseOrder']>(async (_code, input) => ({ source: 'live', data: { ...input, id: 4, project_code: 'SY-001', supplier_company_name: '供应商甲', status: 'draft', revision: 1, ordered_amount_cents: 6170, created_at: '', updated_at: '', lines: input.lines.map((line, index) => ({ ...line, id: index + 1, purchase_order_id: 4, received_quantity: '0.000', line_amount_cents: 1234 })) } }))
    repo.discardCreatePurchaseOrder = () => true
    render(<ProcurementWorkspace projectCode="SY-001" repository={repo} customerCompany={{ id: 2, name: '客户甲' }} />)
    await screen.findByText('交换机')
    fireEvent.click(screen.getAllByRole('button', { name: '建立采购单' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('采购单号'), { target: { value: 'PO-010' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await within(dialog).findByText('请选择供应商')
    expect(repo.createPurchaseOrder).not.toHaveBeenCalled()
    fireEvent.mouseDown(within(dialog).getByLabelText('供应商'))
    fireEvent.click(await screen.findByText('供应商甲'))
    fireEvent.click(within(dialog).getByRole('button', { name: /添加采购物料/ }))
    fireEvent.mouseDown(within(dialog).getAllByLabelText('采购物料')[1]!)
    fireEvent.click(await screen.findByText('接头 · 弱电物料 · 剩余 3.000 件'))
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(repo.createPurchaseOrder).toHaveBeenCalledWith('SY-001', expect.objectContaining({ order_no: 'PO-010', supplier_company_id: 1, lines: [{ procurement_line_id: 1, quantity: '2.000', unit_cost_cents: 1234, overage_reason: null }, { procurement_line_id: 2, quantity: '3.000', unit_cost_cents: 1234, overage_reason: null }] }), []))
  })
})
