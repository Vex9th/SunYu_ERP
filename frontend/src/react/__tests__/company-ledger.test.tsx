import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import CompaniesPage from '../CompaniesPage'
import type { CompanyLedgerData } from '../company/ledger'
import { installProjectDom } from './project-fixtures'

beforeAll(installProjectDom)
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const company = {
  id: 1, name: '双角色公司', taxpayer_id: null, registered_address: null,
  registered_phone: null, bank_name: null, bank_account: null, notes: null,
  revision: 1, created_at: '', updated_at: '',
  contacts: [{ id: 11, company_id: 1, name: '张工', position: '采购', phone: '13800000000', email: null, notes: null, revision: 2, created_at: '', updated_at: '' }],
}
const ledger: CompanyLedgerData = {
  company_id: 1,
  supplier: {
    summary: { project_count: 2, order_count: 3, ordered_amount_cents: 225000, paid_amount_cents: 110000, unpaid_amount_cents: 115000, invoiced_amount_cents: 45000, uninvoiced_amount_cents: 180000 },
    orders: [
      { order_id: 101, order_no: 'PO_A_001', project_id: 10, project_code: 'A', project_name: '项目甲', ordered_on: '2026-10-01', status: 'confirmed', ordered_amount_cents: 120000, paid_amount_cents: 30000, unpaid_amount_cents: 90000, invoiced_amount_cents: 20000, uninvoiced_amount_cents: 100000 },
      { order_id: 102, order_no: 'PO_B_002', project_id: 20, project_code: 'B', project_name: '项目乙', ordered_on: '2026-10-05', status: 'received', ordered_amount_cents: 80000, paid_amount_cents: 80000, unpaid_amount_cents: 0, invoiced_amount_cents: 0, uninvoiced_amount_cents: 80000 },
      { order_id: 103, order_no: 'PO_A_003', project_id: 10, project_code: 'A', project_name: '项目甲', ordered_on: '2026-10-09', status: 'partially_received', ordered_amount_cents: 25000, paid_amount_cents: 0, unpaid_amount_cents: 25000, invoiced_amount_cents: 25000, uninvoiced_amount_cents: 0 },
    ],
  },
  customer: {
    summary: { project_count: 2, contract_count: 2, contracted_amount_cents: 300000, allocated_received_amount_cents: 90000, unreceived_amount_cents: 210000, unallocated_received_amount_cents: 8000, invoiced_amount_cents: 150000 },
    projects: [
      { project_id: 10, project_code: 'A', project_name: '项目甲', contracted_amount_cents: 200000, allocated_received_amount_cents: 50000, unreceived_amount_cents: 150000, unallocated_received_amount_cents: 7000, invoiced_amount_cents: 60000, contracts: [{ allocation_id: 31, contract_id: 21, contract_no: 'HT_A', title: '设备合同', status: 'signed', signed_on: '2026-09-01', allocated_amount_cents: 200000, received_amount_cents: 50000, unreceived_amount_cents: 150000 }] },
      { project_id: 20, project_code: 'B', project_name: '项目乙', contracted_amount_cents: 100000, allocated_received_amount_cents: 40000, unreceived_amount_cents: 60000, unallocated_received_amount_cents: 1000, invoiced_amount_cents: 90000, contracts: [{ allocation_id: 32, contract_id: 22, contract_no: 'HT_B', title: '施工合同', status: 'completed', signed_on: '2026-09-05', allocated_amount_cents: 100000, received_amount_cents: 40000, unreceived_amount_cents: 60000 }] },
    ],
  },
}
const emptyLedger: CompanyLedgerData = {
  company_id: 2,
  supplier: { summary: { project_count: 0, order_count: 0, ordered_amount_cents: 0, paid_amount_cents: 0, unpaid_amount_cents: 0, invoiced_amount_cents: 0, uninvoiced_amount_cents: 0 }, orders: [] },
  customer: { summary: { project_count: 0, contract_count: 0, contracted_amount_cents: 0, allocated_received_amount_cents: 0, unreceived_amount_cents: 0, unallocated_received_amount_cents: 0, invoiced_amount_cents: 0 }, projects: [] },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function serve(readLedger: (id: number) => Promise<Response> = async id => json(id === 1 ? ledger : emptyLedger)) {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async path => {
    if (String(path) === '/api/companies') return json([{ ...company, contact_count: 1 }, { ...company, id: 2, name: '另一家公司', contact_count: 0 }])
    const match = String(path).match(/^\/api\/companies\/(\d+)\/ledger$/)
    if (match) return readLedger(Number(match[1]))
    if (String(path) === '/api/companies/1') return json(company)
    if (String(path) === '/api/companies/2') return json({ ...company, id: 2, name: '另一家公司', contacts: [] })
    throw new Error(`Unexpected request: ${String(path)}`)
  }))
}
function mount() {
  return render(<MemoryRouter><ConfigProvider button={{ autoInsertSpace: false }}><App><CompaniesPage /></App></ConfigProvider></MemoryRouter>)
}
async function openLedger() {
  fireEvent.click(await screen.findByRole('button', { name: '双角色公司' }))
  return screen.findByRole('region', { name: '供应商汇总' })
}
function money(summary: HTMLElement, label: string, amount: string) {
  expect(within(summary).getByText(label).parentElement?.textContent).toContain(amount)
}

describe('公司往来账', () => {
  it('公司名称默认打开往来账，采购付款和客户到账独立汇总并提供业务链接', async () => {
    serve(); mount()
    const supplier = await openLedger()
    money(supplier, '采购金额', '¥2,250.00')
    money(supplier, '已付金额', '¥1,100.00')
    money(supplier, '未付金额', '¥1,150.00')
    expect(screen.getByRole('link', { name: 'PO_A_001' }).getAttribute('href')).toBe('/projects/A/procurement?section=orders&order=101')
    expect(screen.getAllByRole('link', { name: '项目甲' })[0].getAttribute('href')).toBe('/projects/A')
    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    const customer = await screen.findByRole('region', { name: '客户汇总' })
    money(customer, '有效合同分摊', '¥3,000.00')
    money(customer, '累计合同到账', '¥900.00')
    money(customer, '合同未收', '¥2,100.00')
    money(customer, '未关联合同到账', '¥80.00')
    money(customer, '项目销项发票', '¥1,500.00')
    expect(screen.getByText(/销项发票按项目甲方归集/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开项目甲合同' }))
    expect(screen.getByRole('link', { name: 'HT_A' }).getAttribute('href')).toBe('/projects/A/commercial?section=contracts')
    expect(screen.getAllByRole('link', { name: '查看发票' })[0].getAttribute('href')).toBe('/projects/A/delivery?section=invoices')
  })

  it('供应商日期和欠款欠票筛选同时作用于明细与汇总，清空恢复', async () => {
    serve(); mount(); await openLedger()
    fireEvent.click(screen.getByLabelText('仅未付款'))
    fireEvent.click(screen.getByLabelText('仅未开票'))
    const summary = screen.getByRole('region', { name: '供应商汇总' })
    money(summary, '采购金额', '¥1,200.00')
    expect(screen.queryByRole('link', { name: 'PO_B_002' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'PO_A_003' })).toBeNull()
    fireEvent.change(screen.getByLabelText('下单开始日期'), { target: { value: '2026-10-02' } })
    expect(await screen.findByText('没有符合筛选条件的采购单')).toBeTruthy()
    money(summary, '采购金额', '¥0.00')
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
    expect(await screen.findByRole('link', { name: 'PO_B_002' })).toBeTruthy()
    money(summary, '采购金额', '¥2,250.00')
    fireEvent.change(screen.getByLabelText('下单结束日期'), { target: { value: '2026-10-05' } })
    money(summary, '采购金额', '¥2,000.00')
    expect(screen.queryByRole('link', { name: 'PO_A_003' })).toBeNull()
  })

  it('项目筛选分别更新供应商与客户范围，保持项目级销项发票口径', async () => {
    serve(); mount(); await openLedger()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '筛选供应商项目' }))
    fireEvent.click(await screen.findByText('B · 项目乙'))
    money(screen.getByRole('region', { name: '供应商汇总' }), '采购金额', '¥800.00')
    expect(screen.queryByRole('link', { name: 'PO_A_001' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '筛选客户项目' }))
    fireEvent.click((await screen.findAllByText('A · 项目甲')).find(option => !option.closest('.ant-select-dropdown-hidden'))!)
    const customer = screen.getByRole('region', { name: '客户汇总' })
    money(customer, '有效合同分摊', '¥2,000.00')
    money(customer, '项目销项发票', '¥600.00')
    money(customer, '未关联合同到账', '¥70.00')
    expect(screen.getByText('当前筛选合计 · 1 个项目 · 1 份合同')).toBeTruthy()
  })

  it('往来类型切换保留各自的项目和日期筛选，回切显示原范围', async () => {
    serve(); mount(); await openLedger()
    expect((screen.getByRole('radio', { name: '供应商往来' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('仅未付款'))
    fireEvent.change(screen.getByLabelText('下单开始日期'), { target: { value: '2026-10-02' } })
    money(screen.getByRole('region', { name: '供应商汇总' }), '采购金额', '¥250.00')

    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    expect(screen.queryByRole('region', { name: '供应商汇总' })).toBeNull()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '筛选客户项目' }))
    fireEvent.click((await screen.findAllByText('B · 项目乙')).find(option => !option.closest('.ant-select-dropdown-hidden'))!)
    money(screen.getByRole('region', { name: '客户汇总' }), '有效合同分摊', '¥1,000.00')

    fireEvent.click(screen.getByRole('radio', { name: '供应商往来' }))
    expect(screen.queryByRole('region', { name: '客户汇总' })).toBeNull()
    expect((screen.getByRole('checkbox', { name: '仅未付款' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('下单开始日期') as HTMLInputElement).value).toBe('2026-10-02')
    expect(screen.getByRole('link', { name: 'PO_A_003' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'PO_A_001' })).toBeNull()
    money(screen.getByRole('region', { name: '供应商汇总' }), '采购金额', '¥250.00')

    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    money(screen.getByRole('region', { name: '客户汇总' }), '有效合同分摊', '¥1,000.00')
    expect(screen.getByRole('link', { name: '项目乙' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '项目甲' })).toBeNull()
  })

  it('大额到账和采购金额完整显示，并为金额列及横向滚动范围保留足够空间', async () => {
    const largeLedger = structuredClone(ledger)
    largeLedger.supplier.orders[0].ordered_amount_cents = 123456789012
    largeLedger.customer.projects[0].allocated_received_amount_cents = 123456789012
    largeLedger.customer.projects[0].contracts[0].received_amount_cents = 123456789012
    serve(async () => json(largeLedger))
    mount(); await openLedger()

    function expectLargeAmountColumn(table: HTMLTableElement, columnIndex: number) {
      const widths = [...table.querySelectorAll(':scope > colgroup > col')].map(column => Number.parseFloat((column as HTMLElement).style.width))
      // 完整大额需要超过原 112/125px 列宽，表格宽度必须包含各列所需空间。
      expect(widths[columnIndex]).toBeGreaterThanOrEqual(160)
      expect(Number.parseFloat(table.style.width)).toBeGreaterThanOrEqual(widths.reduce((sum, width) => sum + width, 0))
      expect(within(table).getByText('¥1,234,567,890.12')).toBeTruthy()
    }

    expectLargeAmountColumn(screen.getByRole('link', { name: 'PO_A_001' }).closest('table')!, 3)
    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    const expand = screen.getByRole('button', { name: '展开项目甲合同' })
    expectLargeAmountColumn(expand.closest('table')!, 3)
    fireEvent.click(expand)
    expectLargeAmountColumn(screen.getByRole('link', { name: 'HT_A' }).closest('table')!, 4)
  })

  it('读取失败显示重试，成功后恢复实际金额', async () => {
    let attempts = 0
    serve(async () => ++attempts === 1 ? json({ detail: '往来服务暂不可用' }, 503) : json(ledger))
    mount(); fireEvent.click(await screen.findByRole('button', { name: '双角色公司' }))
    expect(await screen.findByText('往来服务暂不可用')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '供应商汇总' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    money(await screen.findByRole('region', { name: '供应商汇总' }), '采购金额', '¥2,250.00')
  })

  it('切换公司期间清除旧账目，并忽略前一个公司延迟返回的数据', async () => {
    let resolveFirst!: (response: Response) => void
    const first = new Promise<Response>(resolve => { resolveFirst = resolve })
    serve(async id => id === 1 ? first : json(emptyLedger))
    mount(); fireEvent.click(await screen.findByRole('button', { name: '双角色公司' }))
    expect(await screen.findByRole('status', { name: '正在读取公司往来' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '另一家公司' }))
    expect(await screen.findByText('暂无供应商采购往来')).toBeTruthy()
    await act(async () => { resolveFirst(json(ledger)); await first })
    await waitFor(() => expect(screen.queryByRole('link', { name: 'PO_A_001' })).toBeNull())
    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    expect(await screen.findByText('暂无客户项目往来')).toBeTruthy()
  })

  it('有分页时摘要包括全部筛选记录，翻页不改变金额', async () => {
    serve(async () => json({ ...ledger, supplier: {
      summary: { project_count: 1, order_count: 11, ordered_amount_cents: 1320000, paid_amount_cents: 330000, unpaid_amount_cents: 990000, invoiced_amount_cents: 220000, uninvoiced_amount_cents: 1100000 },
      orders: Array.from({ length: 11 }, (_, i) => ({ ...ledger.supplier.orders[0], order_id: 200 + i, order_no: `PO_PAGE_${i + 1}` })),
    } }))
    mount(); const summary = await openLedger()
    money(summary, '采购金额', '¥13,200.00')
    expect(screen.queryByRole('link', { name: 'PO_PAGE_11' })).toBeNull()
    fireEvent.click(screen.getByTitle('2'))
    expect(await screen.findByRole('link', { name: 'PO_PAGE_11' })).toBeTruthy()
    money(summary, '采购金额', '¥13,200.00')
    expect(within(summary.parentElement!).getByText(/汇总包含当前筛选下的全部记录/)).toBeTruthy()
  })

  it('联系人入口仍直接显示资料且可编辑原联系人', async () => {
    serve(); mount()
    fireEvent.click(await screen.findByRole('button', { name: '1 位联系人' }))
    const edit = await screen.findByRole('button', { name: '编辑' })
    expect(screen.getByRole('tab', { name: '资料与联系人' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(edit)
    expect((await screen.findByLabelText('姓名') as HTMLInputElement).value).toBe('张工')
    expect(screen.queryByRole('region', { name: '供应商汇总' })).toBeNull()
  })

  it('已终止合同保留历史到账和原分摊信息，但不形成有效合同额或未收款', async () => {
    serve(async () => json({ ...ledger, customer: {
      summary: { project_count: 1, contract_count: 1, contracted_amount_cents: 0, allocated_received_amount_cents: 70000, unreceived_amount_cents: 0, unallocated_received_amount_cents: 9000, invoiced_amount_cents: 50000 },
      projects: [{ project_id: 30, project_code: 'HISTORY', project_name: '历史到账项目', contracted_amount_cents: 0, allocated_received_amount_cents: 70000, unreceived_amount_cents: 0, unallocated_received_amount_cents: 9000, invoiced_amount_cents: 50000,
        contracts: [{ allocation_id: 33, contract_id: 23, contract_no: 'HT_OLD', title: '已终止设备合同', status: 'terminated', signed_on: '2025-10-01', allocated_amount_cents: 180000, received_amount_cents: 70000, unreceived_amount_cents: 0 }],
      }],
    } }))
    mount(); await openLedger()
    fireEvent.click(screen.getByRole('radio', { name: '客户往来' }))
    fireEvent.click(await screen.findByRole('button', { name: '展开历史到账项目合同' }))
    expect(screen.getByText('已终止')).toBeTruthy()
    const summary = screen.getByRole('region', { name: '客户汇总' })
    money(summary, '有效合同分摊', '¥0.00')
    money(summary, '累计合同到账', '¥700.00')
    money(summary, '合同未收', '¥0.00')
    const row = screen.getByRole('link', { name: 'HT_OLD' }).closest('tr')!
    expect(within(row).getByText('¥1,800.00')).toBeTruthy()
    expect(within(row).getByText('¥700.00')).toBeTruthy()
    expect(within(row).getByText('¥0.00')).toBeTruthy()
    expect(screen.getByText('当前筛选合计 · 1 个项目 · 1 份合同')).toBeTruthy()
    expect(screen.getByText(/已终止合同保留历史到账，不再计入有效合同额和未收/)).toBeTruthy()
  })
})
