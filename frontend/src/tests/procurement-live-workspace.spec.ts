import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox, type MessageBoxData } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProcurementWorkspace from '../components/procurement/ProcurementWorkspace.vue'
import { ApiError } from '../api'
import { localISODate } from '../domain/dates'
import type {
  GoodsReceiptInput,
  ProcurementLineInput,
  ProcurementListDetailDto,
  ProcurementListSummaryDto,
  ProcurementOverviewDto,
  PurchaseOrderDto,
  PurchaseOrderInput,
} from '../domain/operations-api'
import type { ProcurementImportPreviewDto } from '../domain/procurement-extensions'
import type { RepositoryResult } from '../repositories/common'
import type { ProcurementHttpRepository } from '../repositories/procurement.live'

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function liveResult<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const line = {
  id: 101,
  procurement_list_id: 11,
  sequence_no: 1,
  category: '电气',
  name: '伺服电机',
  specification: '2kW',
  brand: '汇川',
  model: 'MS1H2',
  quantity: '8.000',
  unit: '台',
  unit_cost_cents: 128900,
  quoted_unit_price_cents: 158900,
  inventory_item_id: null,
  cost_total_cents: 1031200,
  quoted_total_cents: 1271200,
  ordered_quantity: '2.000',
  ordered_amount_cents: 257800,
  paid_amount_cents: 0,
  received_quantity: '0.000',
  invoiced_amount_cents: 0,
  issued_quantity: '0.000',
  order_status: 'partial' as const,
  payment_status: 'unpaid' as const,
  receipt_status: 'not_received' as const,
  invoice_status: 'not_invoiced' as const,
  usage_status: 'unused' as const,
  revision: 2,
  created_at: '2026-08-29T08:00:00+08:00',
  updated_at: '2026-08-29T08:00:00+08:00',
}

function listDetail(projectCode = 'SY-001', status: 'draft' | 'confirmed' = 'draft'): ProcurementListDetailDto {
  return {
    id: 11,
    project_code: projectCode,
    name: `${projectCode}采购清单`,
    notes: '控制柜和伺服件',
    status,
    revision: 3,
    line_count: 1,
    cost_total_cents: 1031200,
    quoted_total_cents: 1271200,
    lines: [{ ...line }],
    confirmed_at: status === 'confirmed' ? '2026-08-29T10:00:00+08:00' : null,
    created_at: '2026-08-29T08:00:00+08:00',
    updated_at: '2026-08-29T08:00:00+08:00',
  }
}

function listSummary(detail: ProcurementListDetailDto): ProcurementListSummaryDto {
  const { cost_total_cents: _cost, quoted_total_cents: _quote, lines: _lines, ...summary } = detail
  return summary
}

function purchaseOrder(projectCode = 'SY-001', status: PurchaseOrderDto['status'] = 'draft'): PurchaseOrderDto {
  return {
    id: 91,
    project_code: projectCode,
    order_no: 'PO-2026-001',
    supplier_company_id: 8,
    supplier_company_name: '汇川技术',
    ordered_on: '2026-08-29',
    expected_delivery_on: '2026-09-05',
    notes: null,
    document_version_ids: [],
    status,
    ordered_amount_cents: 257800,
    revision: 2,
    lines: [{
      id: 901,
      purchase_order_id: 91,
      procurement_line_id: 101,
      quantity: '2.000',
      received_quantity: '0.000',
      unit_cost_cents: 128900,
      line_amount_cents: 257800,
      overage_reason: null,
    }],
    created_at: '2026-08-29T08:00:00+08:00',
    updated_at: '2026-08-29T08:00:00+08:00',
  }
}

function overview(projectCode = 'SY-001'): ProcurementOverviewDto {
  return {
    project_code: projectCode,
    line_count: 1,
    line_status_counts: { not_ordered: 0, partial: 0, ordered: 1, over_ordered: 0 },
    procurement_committed_cents: 257800,
    procurement_received_cents: 0,
    procurement_paid_cents: 0,
    material_consumed_cents: 0,
  }
}

function company(id = 8, name = '汇川技术') {
  return {
    id,
    name,
    taxpayer_id: null,
    registered_address: null,
    registered_phone: null,
    bank_name: null,
    bank_account: null,
    notes: null,
    created_at: '2026-08-29T08:00:00+08:00',
    updated_at: '2026-08-29T08:00:00+08:00',
  }
}

function createRepository(options: {
  projectCode?: string
  listStatus?: 'draft' | 'confirmed'
  orderStatus?: PurchaseOrderDto['status']
  companies?: ReturnType<typeof company>[]
  orderedQuantity?: string
} = {}): ProcurementHttpRepository {
  const projectCode = options.projectCode ?? 'SY-001'
  const detail = listDetail(projectCode, options.listStatus)
  if (options.orderedQuantity !== undefined) {
    detail.lines[0]!.ordered_quantity = options.orderedQuantity
  }
  const order = purchaseOrder(projectCode, options.orderStatus)
  return {
    listSupplierCompanies: vi.fn(async () => liveResult(options.companies ?? [company()])),
    downloadImportTemplate: vi.fn(async () => new Blob(['xlsx'])),
    previewProcurementImport: vi.fn(async () => liveResult({
      id: 31, project_code: projectCode, filename: '采购清单.xlsx', sha256: 'a'.repeat(64),
      status: 'preview' as const, revision: 1, expires_at: '2026-09-01T08:00:00+08:00',
      confirmed_list_id: null, rows: [], errors: [], created_at: '2026-08-31T08:00:00+08:00',
      updated_at: '2026-08-31T08:00:00+08:00',
    })),
    confirmProcurementImport: vi.fn(async () => liveResult({
      import: {
        id: 31, project_code: projectCode, filename: '采购清单.xlsx', sha256: 'a'.repeat(64),
        status: 'confirmed' as const, revision: 2, expires_at: '2026-09-01T08:00:00+08:00',
        confirmed_list_id: detail.id, rows: [], errors: [], created_at: '2026-08-31T08:00:00+08:00',
        updated_at: '2026-08-31T08:00:00+08:00',
      },
      procurement_list: detail,
    })),
    listProcurementLists: vi.fn(async () => liveResult({
      items: [listSummary(detail)], total: 1, page: 1, page_size: 100,
    })),
    createProcurementList: vi.fn(async () => liveResult(detail)),
    getProcurementList: vi.fn(async () => liveResult(detail)),
    updateProcurementList: vi.fn(async () => liveResult(detail)),
    createProcurementLine: vi.fn(async () => liveResult(detail.lines[0]!)),
    updateProcurementLine: vi.fn(async () => liveResult(detail.lines[0]!)),
    deleteProcurementLine: vi.fn(async () => undefined),
    confirmProcurementList: vi.fn(async () => liveResult({ ...detail, status: 'confirmed' as const })),
    copyProcurementListAsDraft: vi.fn(async () => liveResult({
      ...detail, id: 12, name: `${detail.name}（修订草稿）`, status: 'draft' as const,
      revision: 1, confirmed_at: null,
    })),
    listPurchaseOrders: vi.fn(async () => liveResult({
      items: [order], total: 1, page: 1, page_size: 100,
    })),
    listDocumentVersionOptions: vi.fn(async () => [
      { value: 44, label: '既有供应商合同 V1 · supplier-contract.pdf' },
    ]),
    createPurchaseOrder: vi.fn(async () => liveResult(order)),
    getPurchaseOrder: vi.fn(async () => liveResult(order)),
    confirmPurchaseOrder: vi.fn(async () => liveResult({ ...order, status: 'confirmed' as const })),
    updatePurchaseOrder: vi.fn(async () => liveResult(order)),
    cancelPurchaseOrder: vi.fn(async () => liveResult({ ...order, status: 'cancelled' as const })),
    receiveGoods: vi.fn(async () => liveResult({
        id: 1,
        purchase_order_id: order.id,
        received_on: '2026-08-31',
        warehouse_name: '主仓',
        notes: null,
        status: 'active' as const,
        reversal_reason: null,
        reversed_at: null,
        revision: 1,
        lines: [],
        created_at: '2026-08-31T08:00:00+08:00',
        updated_at: '2026-08-31T08:00:00+08:00',
    })),
    reverseGoodsReceipt: vi.fn(async () => liveResult({
      id: 1,
      purchase_order_id: order.id,
      received_on: '2026-08-31',
      warehouse_name: '主仓',
      notes: null,
      status: 'reversed' as const,
      reversal_reason: '到货录错',
      reversed_at: '2026-08-31T09:00:00+08:00',
      revision: 2,
      lines: [],
      created_at: '2026-08-31T08:00:00+08:00',
      updated_at: '2026-08-31T09:00:00+08:00',
    })),
    createSupplierPayment: vi.fn(async (_projectCode, _orderId, input) => liveResult({
      id: 1, purchase_order_id: order.id, ...input, status: 'active' as const,
      reversal_reason: null, reversed_at: null, revision: 1,
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    })),
    createSupplierInvoice: vi.fn(async (_projectCode, _orderId, input) => liveResult({
      id: 1, purchase_order_id: order.id, ...input, status: 'active' as const,
      reversal_reason: null, reversed_at: null, revision: 1,
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    })),
    reverseSupplierPayment: vi.fn(async (_projectCode, paymentId, input) => liveResult({
      id: paymentId, purchase_order_id: order.id, paid_on: '2026-08-31', amount_cents: 100,
      payment_method: '银行转账', reference_no: null, allocations: [], notes: null,
      status: 'reversed' as const, reversal_reason: input.reason,
      reversed_at: '2026-08-31T09:00:00+08:00', revision: input.expected_revision + 1,
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T09:00:00+08:00',
    })),
    reverseSupplierInvoice: vi.fn(async (_projectCode, invoiceId, input) => liveResult({
      id: invoiceId, purchase_order_id: order.id, invoice_no: 'INV-001', invoiced_on: '2026-08-31',
      amount_cents: 100, allocations: [], document_version_ids: [], status: 'reversed' as const,
      reversal_reason: input.reason, reversed_at: '2026-08-31T09:00:00+08:00',
      revision: input.expected_revision + 1, created_at: '2026-08-31T08:00:00+08:00',
      updated_at: '2026-08-31T09:00:00+08:00',
    })),
    createQuoteExport: vi.fn(async (_projectCode, listId, input) => liveResult({
      id: 1, project_code: projectCode, procurement_list_id: listId, ...input,
      customer_company_name: '客户公司', created_at: '2026-08-31T08:00:00+08:00',
      download_url: `/api/projects/${projectCode}/quote-exports/1/download`,
    })),
    listQuoteExports: vi.fn(async () => liveResult({
      items: [{
        id: 8, project_code: projectCode, procurement_list_id: detail.id,
        title: '客户报价单 V2', customer_company_id: 8,
        customer_company_name: '客户公司', notes: null,
        created_at: '2026-08-31T08:00:00+08:00',
        download_url: `/api/projects/${projectCode}/quote-exports/8/download`,
      }],
      total: 1, page: 1, page_size: 50,
    })),
    downloadQuoteExport: vi.fn(async () => new Blob(['quote'])),
    getProcurementOverview: vi.fn(async () => liveResult(overview(projectCode))),
    discardCreateProcurementList: vi.fn(() => false),
    discardCreateProcurementLine: vi.fn(() => false),
    discardCreatePurchaseOrder: vi.fn(() => false),
    discardReceiveGoods: vi.fn(() => false),
    discardReverseGoodsReceipt: vi.fn(() => false),
    discardPreviewProcurementImport: vi.fn(() => false),
    discardConfirmProcurementImport: vi.fn(() => false),
    discardCopyProcurementListAsDraft: vi.fn(() => false),
    discardCancelPurchaseOrder: vi.fn(() => false),
    discardCreateSupplierPayment: vi.fn(() => false),
    discardCreateSupplierInvoice: vi.fn(() => false),
    discardReverseSupplierPayment: vi.fn(() => false),
    discardReverseSupplierInvoice: vi.fn(() => false),
    discardCreateQuoteExport: vi.fn(() => false),
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function clickTeleportedMenuItem(wrapper: VueWrapper, triggerSelector: string, itemSelector: string): Promise<void> {
  await wrapper.get(triggerSelector).trigger('click')
  await settle()
  const items = document.body.querySelectorAll<HTMLElement>(itemSelector)
  const item = items.item(items.length - 1)
  if (!item) throw new Error(`未找到菜单项 ${itemSelector}`)
  item.click()
  await settle()
}

async function clickPurchaseOrderAction(wrapper: VueWrapper, itemSelector: string): Promise<void> {
  const directAction = wrapper.find(itemSelector)
  if (directAction.exists()) {
    await directAction.trigger('click')
    return
  }
  await clickTeleportedMenuItem(wrapper, '[data-testid="purchase-order-actions-menu"]', itemSelector)
}

function mountWorkspace(
  repository?: ProcurementHttpRepository,
  projectCode = 'SY-001',
): VueWrapper {
  const wrapper = mount(ProcurementWorkspace, {
    attachTo: document.body,
    props: { projectCode, ...(repository ? { repository } : {}) },
    global: { plugins: [ElementPlus] },
  })
  mountedWrappers.add(wrapper)
  return wrapper
}

function newProcurementLineInput(name = '空开'): ProcurementLineInput {
  return {
    sequence_no: 2,
    category: '其他',
    name,
    specification: null,
    brand: null,
    model: null,
    quantity: '2.000',
    unit: '个',
    unit_cost_cents: 10000,
    quoted_unit_price_cents: 13000,
  }
}

async function openAndFillNewLine(wrapper: VueWrapper, name = '空开') {
  await wrapper.get('[data-testid="procurement-line-open"]').trigger('click')
  const dialog = wrapper.get('[data-testid="procurement-line-dialog"]')
  await dialog.get('[data-testid="procurement-line-name"]').setValue(name)
  await dialog.get('[data-testid="procurement-line-quantity"]').setValue('2.000')
  await dialog.get('[data-testid="procurement-line-unit"]').setValue('个')
  await dialog.get('[data-testid="procurement-line-cost-price"]').setValue('100.00')
  await dialog.get('[data-testid="procurement-line-quote-price"]').setValue('130.00')
  return dialog
}

function expectWorkspaceReadCount(repository: ProcurementHttpRepository, count: number): void {
  expect(repository.listSupplierCompanies).toHaveBeenCalledTimes(count)
  expect(repository.listProcurementLists).toHaveBeenCalledTimes(count)
  expect(repository.listPurchaseOrders).toHaveBeenCalledTimes(count)
  expect(repository.getProcurementOverview).toHaveBeenCalledTimes(count)
}

const mountedWrappers = new Set<VueWrapper>()

function unmountWorkspace(wrapper: VueWrapper): void {
  wrapper.unmount()
  mountedWrappers.delete(wrapper)
}

describe('采购工作台真实接口', () => {
  afterEach(() => {
    for (const wrapper of mountedWrappers) wrapper.unmount()
    mountedWrappers.clear()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('生产默认读取真实清单摘要、详情、采购单、概览和供应商', async () => {
    const detail = listDetail()
    const order = purchaseOrder()
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path === '/api/projects/SY-001/procurement-lists?page=1&page_size=100') {
        return jsonResponse({ items: [listSummary(detail)], total: 1, page: 1, page_size: 100 })
      }
      if (path === '/api/projects/SY-001/procurement-lists/11') return jsonResponse(detail)
      if (path === '/api/projects/SY-001/purchase-orders?page=1&page_size=100') {
        return jsonResponse({ items: [order], total: 1, page: 1, page_size: 100 })
      }
      if (path === '/api/projects/SY-001/procurement-overview') return jsonResponse(overview())
      if (path === '/api/companies') return jsonResponse([company()])
      return jsonResponse({ detail: `unexpected ${path}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountWorkspace()
    await settle()

    const workspaceText = wrapper.get('[data-testid="procurement-workspace"]').text()
    expect(workspaceText).toContain('SY-001采购清单')
    expect(workspaceText).toContain('伺服电机')
    expect(workspaceText).toContain('PO-2026-001')
    expect(workspaceText).toContain('汇川技术')
    expect(workspaceText).toContain('物料行1')
    expect(workspaceText).toContain('已承诺金额2578.00 元')
    expect(workspaceText).toContain('已到货金额0.00 元')
    expect(workspaceText).not.toContain('真实数据')
    expect(workspaceText).not.toContain('演示数据')
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([
      '/api/projects/SY-001/procurement-lists?page=1&page_size=100',
      '/api/projects/SY-001/procurement-lists/11',
      '/api/projects/SY-001/purchase-orders?page=1&page_size=100',
      '/api/projects/SY-001/procurement-overview',
      '/api/companies',
    ]))
  })

  it('项目切换乱序返回时清空旧数据并只接纳最新一代', async () => {
    const projectA = createRepository({ projectCode: 'SY-A' })
    const projectB = createRepository({ projectCode: 'SY-B' })
    let resolveB!: (value: Awaited<ReturnType<ProcurementHttpRepository['listProcurementLists']>>) => void
    const delayedB = new Promise<Awaited<ReturnType<ProcurementHttpRepository['listProcurementLists']>>>((resolve) => {
      resolveB = resolve
    })
    vi.mocked(projectB.listProcurementLists).mockReturnValue(delayedB)
    const repository: ProcurementHttpRepository = {
      ...projectA,
      listProcurementLists: vi.fn((projectCode, query) => (
        projectCode === 'SY-A'
          ? projectA.listProcurementLists(projectCode, query)
          : projectB.listProcurementLists(projectCode, query)
      )),
      listPurchaseOrders: vi.fn((projectCode, query) => (
        projectCode === 'SY-A' ? projectA.listPurchaseOrders(projectCode, query) : projectB.listPurchaseOrders(projectCode, query)
      )),
      getProcurementList: vi.fn((projectCode, id) => (
        projectCode === 'SY-A' ? projectA.getProcurementList(projectCode, id) : projectB.getProcurementList(projectCode, id)
      )),
      getProcurementOverview: vi.fn((projectCode) => (
        projectCode === 'SY-A' ? projectA.getProcurementOverview(projectCode) : projectB.getProcurementOverview(projectCode)
      )),
    }
    const wrapper = mountWorkspace(repository, 'SY-A')
    await settle()
    expect(wrapper.text()).toContain('SY-A采购清单')

    await wrapper.setProps({ projectCode: 'SY-B' })
    expect(wrapper.text()).not.toContain('SY-A采购清单')
    expect(wrapper.text()).toContain('正在读取采购数据')

    await wrapper.setProps({ projectCode: 'SY-A' })
    await settle()
    expect(wrapper.text()).toContain('SY-A采购清单')

    resolveB({
      source: 'live',
      data: { items: [listSummary(listDetail('SY-B'))], total: 1, page: 1, page_size: 100 },
    })
    await settle()
    expect(wrapper.text()).toContain('SY-A采购清单')
    expect(wrapper.text()).not.toContain('SY-B采购清单')
    expect(repository.listProcurementLists).toHaveBeenCalledWith('SY-B', { page: 1, page_size: 100 })
    expect(repository.listPurchaseOrders).toHaveBeenCalledWith('SY-B', { page: 1, page_size: 100 })
  })

  it('同项目切换 repository 乱序返回时只接纳当前 repository', async () => {
    const repositoryA = createRepository()
    const repositoryB = createRepository()
    const detailA = { ...listDetail(), name: 'Repository A 清单' }
    const detailB = { ...listDetail(), name: 'Repository B 清单' }
    vi.mocked(repositoryA.getProcurementList).mockResolvedValue(liveResult(detailA))
    vi.mocked(repositoryB.getProcurementList).mockResolvedValue(liveResult(detailB))
    let resolveB!: (value: Awaited<ReturnType<ProcurementHttpRepository['listProcurementLists']>>) => void
    const delayedB = new Promise<Awaited<ReturnType<ProcurementHttpRepository['listProcurementLists']>>>((resolve) => {
      resolveB = resolve
    })
    vi.mocked(repositoryB.listProcurementLists).mockReturnValue(delayedB)

    const wrapper = mountWorkspace(repositoryA)
    await settle()
    expect(wrapper.text()).toContain('Repository A 清单')

    await wrapper.setProps({ repository: repositoryB })
    expect(wrapper.text()).not.toContain('Repository A 清单')
    expect(wrapper.text()).toContain('正在读取采购数据')

    await wrapper.setProps({ repository: repositoryA })
    await settle()
    expect(wrapper.text()).toContain('Repository A 清单')

    resolveB(liveResult({
      items: [listSummary(detailB)], total: 1, page: 1, page_size: 100,
    }))
    await settle()
    expect(wrapper.text()).toContain('Repository A 清单')
    expect(wrapper.text()).not.toContain('Repository B 清单')
    expect(repositoryB.listProcurementLists).toHaveBeenCalledWith('SY-001', { page: 1, page_size: 100 })
  })

  it('卸载后不消费迟到的详情结果，也不写回组件状态', async () => {
    const repository = createRepository()
    const detail = listDetail()
    let resolveDetail!: (value: RepositoryResult<ProcurementListDetailDto>) => void
    const delayedDetail = new Promise<RepositoryResult<ProcurementListDetailDto>>((resolve) => {
      resolveDetail = resolve
    })
    const readLateData = vi.fn(() => detail)
    const lateResult = { source: 'live' } as RepositoryResult<ProcurementListDetailDto>
    Object.defineProperty(lateResult, 'data', { get: readLateData })
    vi.mocked(repository.getProcurementList).mockReturnValue(delayedDetail)

    const wrapper = mountWorkspace(repository)
    await settle()
    expect(repository.getProcurementList).toHaveBeenCalledWith('SY-001', 11)

    unmountWorkspace(wrapper)
    resolveDetail(lateResult)
    await settle()

    expect(readLateData).not.toHaveBeenCalled()
  })

  it('单个采购子域读取失败时保留其他成功区块并提供局部错误', async () => {
    const failedRepository = createRepository()
    vi.mocked(failedRepository.listProcurementLists).mockRejectedValueOnce(new Error('采购清单接口失败'))
    const failedWrapper = mountWorkspace(failedRepository)
    await settle()
    expect(failedWrapper.get('[data-testid="procurement-list-load-error"]').text()).toContain('采购清单接口失败')
    expect(failedWrapper.text()).toContain('PO-2026-001')
    expect(failedWrapper.get('[data-testid="procurement-overview"]').text()).toContain('物料行')
    expect(failedWrapper.get('[data-testid="procurement-suppliers"]').text()).toContain('汇川技术')
    expect(failedWrapper.find('[data-testid="procurement-load-error"]').exists()).toBe(false)
  })

  it('采购清单和采购单独立翻页，每页数变更回到第一页并展示服务端总数', async () => {
    const repository = createRepository()
    const firstList = listDetail()
    const secondList = { ...listDetail(), id: 12, name: '第二页采购清单' }
    const firstOrder = purchaseOrder()
    const secondOrder = { ...purchaseOrder(), id: 92, order_no: 'PO-PAGE-2' }
    vi.mocked(repository.listProcurementLists).mockImplementation(async (_projectCode, query = {}) => liveResult({
      items: [listSummary(query.page === 2 ? secondList : firstList)],
      total: 205,
      page: query.page ?? 1,
      page_size: query.page_size ?? 100,
    }))
    vi.mocked(repository.getProcurementList).mockImplementation(async (_projectCode, id) => (
      liveResult(id === 12 ? secondList : firstList)
    ))
    vi.mocked(repository.listPurchaseOrders).mockImplementation(async (_projectCode, query = {}) => liveResult({
      items: [query.page === 2 ? secondOrder : firstOrder],
      total: 121,
      page: query.page ?? 1,
      page_size: query.page_size ?? 100,
    }))

    const wrapper = mountWorkspace(repository)
    await settle()
    expect(wrapper.get('[data-testid="procurement-list-page-info"]').text()).toContain('第 1 / 3 页，共 205 条')
    expect(wrapper.get('[data-testid="purchase-order-page-info"]').text()).toContain('第 1 / 2 页，共 121 条')

    wrapper.findAllComponents({ name: 'ElPagination' })[0]!.vm.$emit('current-change', 2)
    await settle()
    expect(repository.listProcurementLists).toHaveBeenLastCalledWith('SY-001', { page: 2, page_size: 100 })
    expect(repository.listPurchaseOrders).toHaveBeenLastCalledWith('SY-001', { page: 1, page_size: 100 })
    expect(wrapper.text()).toContain('第二页采购清单')
    expect(wrapper.get('[data-testid="procurement-list-page-info"]').text()).toContain('第 2 / 3 页')

    wrapper.findAllComponents({ name: 'ElPagination' })[1]!.vm.$emit('current-change', 2)
    await settle()
    expect(repository.listPurchaseOrders).toHaveBeenLastCalledWith('SY-001', { page: 2, page_size: 100 })
    expect(wrapper.text()).toContain('PO-PAGE-2')

    wrapper.findAllComponents({ name: 'ElPagination' })[0]!.vm.$emit('size-change', 50)
    await settle()
    expect(repository.listProcurementLists).toHaveBeenLastCalledWith('SY-001', { page: 1, page_size: 50 })
    expect(repository.listPurchaseOrders).toHaveBeenLastCalledWith('SY-001', { page: 2, page_size: 100 })
    expect(wrapper.get('[data-testid="procurement-list-page-info"]').text()).toContain('第 1 / 5 页，共 205 条')
  })

  it('清单与采购单各自展示空态，概览和供应商区域不随业务列表消失', async () => {
    const emptyListsRepository = createRepository({ companies: [] })
    vi.mocked(emptyListsRepository.listProcurementLists).mockResolvedValueOnce(liveResult({
      items: [], total: 0, page: 1, page_size: 100,
    }))
    const emptyListsWrapper = mountWorkspace(emptyListsRepository)
    await settle()
    expect(emptyListsWrapper.get('[data-testid="procurement-list-empty"]').text()).toContain('暂无采购清单')
    expect(emptyListsWrapper.text()).toContain('PO-2026-001')
    expect(emptyListsWrapper.find('[data-testid="procurement-list-pagination"]').exists()).toBe(false)
    expect(emptyListsWrapper.find('[data-testid="purchase-order-pagination"]').exists()).toBe(false)
    expect(emptyListsWrapper.get('[data-testid="procurement-overview"]').text()).toContain('物料行')
    expect(emptyListsWrapper.get('[data-testid="procurement-suppliers"]').text()).toContain('暂无可选往来单位')
    unmountWorkspace(emptyListsWrapper)

    const emptyOrdersRepository = createRepository()
    vi.mocked(emptyOrdersRepository.listPurchaseOrders).mockResolvedValueOnce(liveResult({
      items: [], total: 0, page: 1, page_size: 100,
    }))
    const emptyOrdersWrapper = mountWorkspace(emptyOrdersRepository)
    await settle()
    expect(emptyOrdersWrapper.text()).toContain('SY-001采购清单')
    expect(emptyOrdersWrapper.get('[data-testid="purchase-order-empty"]').text()).toContain('暂无采购单')
    expect(emptyOrdersWrapper.get('[data-testid="procurement-suppliers"]').text()).toContain('汇川技术')
  })

  it('清单、采购行和清单确认使用真实 DTO，未知结果关闭时放弃 pending', async () => {
    const repository = createRepository()
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    vi.mocked(repository.createProcurementList).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreateProcurementList).mockReturnValue(true)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="procurement-list-create-open"]').trigger('click')
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('临时补料')
    await wrapper.get('[data-testid="procurement-list-create-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    expect(wrapper.get('[data-testid="procurement-list-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="procurement-list-name"]').html()).toContain('disabled')
    expect(wrapper.get('[data-testid="procurement-list-create-submit"]').text()).toContain('原样重试')
    await wrapper.get('[data-testid="procurement-list-cancel"]').trigger('click')
    expect(repository.discardCreateProcurementList).toHaveBeenCalledWith('SY-001', {
      name: '临时补料', notes: null,
    })

    const dialog = await openAndFillNewLine(wrapper)
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()
    expect(repository.createProcurementLine).toHaveBeenCalledWith(
      'SY-001',
      11,
      newProcurementLineInput(),
    )

    await wrapper.get('[data-testid="procurement-list-confirm-11"]').trigger('click')
    await settle()
    expect(repository.confirmProcurementList).toHaveBeenCalledWith('SY-001', 11, { expected_revision: 3 })
  })

  it('采购行创建结果未知时关闭对话框，用原项目、清单和完整 DTO 放弃 pending', async () => {
    const repository = createRepository()
    vi.mocked(repository.createProcurementLine).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreateProcurementLine).mockReturnValue(true)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    const dialog = await openAndFillNewLine(wrapper)
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    expect(dialog.get('[data-testid="procurement-line-create-uncertain"]').text()).toContain('原样重试')
    expect(dialog.get('[data-testid="procurement-line-name"]').html()).toContain('disabled')
    const submittedInput = vi.mocked(repository.createProcurementLine).mock.calls[0]![2]
    expect(submittedInput).toEqual(newProcurementLineInput())

    await dialog.get('[data-testid="procurement-line-cancel"]').trigger('click')
    expect(repository.discardCreateProcurementLine).toHaveBeenCalledWith('SY-001', 11, submittedInput)
    expect(vi.mocked(repository.discardCreateProcurementLine).mock.calls[0]![2]).toBe(submittedInput)
  })

  it('清单创建结果未知后即使表单值被改动也只会原样重试', async () => {
    const repository = createRepository()
    const recovered = vi.mocked(repository.createProcurementList).getMockImplementation()!
    vi.mocked(repository.createProcurementList)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(recovered)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="procurement-list-create-open"]').trigger('click')
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('原清单')
    await wrapper.get('[data-testid="procurement-list-create-submit"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('误改清单')
    await wrapper.get('[data-testid="procurement-list-create-submit"]').trigger('click')
    await settle()

    expect(repository.createProcurementList).toHaveBeenCalledTimes(2)
    expect(vi.mocked(repository.createProcurementList).mock.calls[1]).toEqual(
      vi.mocked(repository.createProcurementList).mock.calls[0],
    )
    expect(repository.discardCreateProcurementList).not.toHaveBeenCalled()
  })

  it('清单创建成功后重新读取当前项目并展示刷新结果', async () => {
    const repository = createRepository()
    const initial = listDetail()
    const created: ProcurementListDetailDto = {
      ...initial,
      id: 12,
      name: '刷新后临时补料',
      notes: null,
      revision: 1,
      line_count: 0,
      cost_total_cents: 0,
      quoted_total_cents: 0,
      lines: [],
    }
    vi.mocked(repository.listProcurementLists)
      .mockResolvedValueOnce(liveResult({
        items: [listSummary(initial)], total: 1, page: 1, page_size: 100,
      }))
      .mockResolvedValueOnce(liveResult({
        items: [listSummary(initial), listSummary(created)], total: 2, page: 1, page_size: 100,
      }))
    vi.mocked(repository.getProcurementList).mockImplementation(async (_projectCode, listId) => (
      liveResult(listId === created.id ? created : initial)
    ))
    vi.mocked(repository.createProcurementList).mockResolvedValue(liveResult(created))
    const wrapper = mountWorkspace(repository)
    await settle()
    expectWorkspaceReadCount(repository, 1)

    await wrapper.get('[data-testid="procurement-list-create-open"]').trigger('click')
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('  刷新后临时补料  ')
    await wrapper.get('[data-testid="procurement-list-create-submit"]').trigger('click')
    await settle()

    expect(repository.createProcurementList).toHaveBeenCalledWith('SY-001', {
      name: '刷新后临时补料', notes: null,
    })
    expectWorkspaceReadCount(repository, 2)
    expect(wrapper.text()).toContain('刷新后临时补料')
  })

  it('采购行创建成功后重新读取当前项目并展示刷新结果', async () => {
    const repository = createRepository()
    const initial = listDetail()
    const input = newProcurementLineInput('刷新后空开')
    const createdLine = {
      ...line,
      ...input,
      id: 102,
      cost_total_cents: 20000,
      quoted_total_cents: 26000,
    }
    const refreshed: ProcurementListDetailDto = {
      ...initial,
      line_count: 2,
      cost_total_cents: initial.cost_total_cents + createdLine.cost_total_cents,
      quoted_total_cents: initial.quoted_total_cents + createdLine.quoted_total_cents,
      lines: [...initial.lines, createdLine],
    }
    vi.mocked(repository.getProcurementList)
      .mockResolvedValueOnce(liveResult(initial))
      .mockResolvedValueOnce(liveResult(refreshed))
    vi.mocked(repository.createProcurementLine).mockResolvedValue(liveResult(createdLine))
    const wrapper = mountWorkspace(repository)
    await settle()
    expectWorkspaceReadCount(repository, 1)

    const dialog = await openAndFillNewLine(wrapper, '刷新后空开')
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()

    expect(repository.createProcurementLine).toHaveBeenCalledWith('SY-001', 11, input)
    expectWorkspaceReadCount(repository, 2)
    expect(wrapper.text()).toContain('刷新后空开')
  })

  it('草稿采购行可编辑全部核心字段，使用当前 revision 并刷新当前页', async () => {
    const repository = createRepository()
    const updatedLine = {
      ...line,
      sequence_no: 2,
      category: '机械',
      name: '伺服驱动器',
      specification: '3kW',
      brand: '汇川技术',
      model: 'SV680',
      quantity: '3.500',
      unit: '件',
      unit_cost_cents: 120050,
      quoted_unit_price_cents: 150075,
      revision: 3,
    }
    const refreshed = { ...listDetail(), lines: [updatedLine] }
    vi.mocked(repository.updateProcurementLine).mockResolvedValue(liveResult(updatedLine))
    vi.mocked(repository.getProcurementList)
      .mockResolvedValueOnce(liveResult(listDetail()))
      .mockResolvedValueOnce(liveResult(refreshed))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="procurement-line-edit-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="procurement-line-dialog"]')
    await dialog.get('[data-testid="procurement-line-sequence"] input').setValue('2')
    await dialog.get('[data-testid="procurement-line-category"]').setValue('机械')
    await dialog.get('[data-testid="procurement-line-name"]').setValue('伺服驱动器')
    await dialog.get('[data-testid="procurement-line-specification"]').setValue('3kW')
    await dialog.get('[data-testid="procurement-line-brand"]').setValue('汇川技术')
    await dialog.get('[data-testid="procurement-line-model"]').setValue('SV680')
    await dialog.get('[data-testid="procurement-line-quantity"]').setValue('3.500')
    await dialog.get('[data-testid="procurement-line-unit"]').setValue('件')
    await dialog.get('[data-testid="procurement-line-cost-price"]').setValue('1200.50')
    await dialog.get('[data-testid="procurement-line-quote-price"]').setValue('1500.75')
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()

    expect(repository.updateProcurementLine).toHaveBeenCalledWith('SY-001', 11, 101, {
      sequence_no: 2,
      category: '机械',
      name: '伺服驱动器',
      specification: '3kW',
      brand: '汇川技术',
      model: 'SV680',
      quantity: '3.500',
      unit: '件',
      unit_cost_cents: 120050,
      quoted_unit_price_cents: 150075,
      expected_revision: 2,
    })
    expect(repository.listProcurementLists).toHaveBeenLastCalledWith('SY-001', { page: 1, page_size: 100 })
    expect(wrapper.get('[data-testid="procurement-line-dialog"]').isVisible()).toBe(false)
    expect(wrapper.text()).toContain('伺服驱动器')
  })

  it('删除草稿采购行必须通过 Element Plus 二次确认，写入中不重复请求并刷新', async () => {
    const repository = createRepository()
    const refreshed = { ...listDetail(), line_count: 0, lines: [] }
    let resolveDelete!: () => void
    vi.mocked(repository.deleteProcurementLine).mockReturnValue(new Promise<void>((resolve) => {
      resolveDelete = resolve
    }))
    vi.mocked(repository.getProcurementList)
      .mockResolvedValueOnce(liveResult(listDetail()))
      .mockResolvedValueOnce(liveResult(refreshed))
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
      .mockResolvedValue({ value: '', action: 'confirm' } as unknown as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    const deleteButton = wrapper.get('[data-testid="procurement-line-delete-101"]')
    await deleteButton.trigger('click')
    await Promise.resolve()
    await deleteButton.trigger('click')
    expect(confirm).toHaveBeenCalledWith(
      '删除后无法恢复，确定删除“伺服电机”吗？',
      '删除采购行',
      expect.objectContaining({ type: 'warning' }),
    )
    expect(repository.deleteProcurementLine).toHaveBeenCalledTimes(1)

    resolveDelete()
    await settle()
    expect(repository.deleteProcurementLine).toHaveBeenCalledWith('SY-001', 11, 101)
    expect(repository.listProcurementLists).toHaveBeenLastCalledWith('SY-001', { page: 1, page_size: 100 })
    expect(wrapper.text()).not.toContain('伺服电机')
  })

  it('采购行编辑或删除成功后刷新失败，明确提示但不重复写入', async () => {
    const updateRepository = createRepository()
    vi.mocked(updateRepository.listProcurementLists)
      .mockResolvedValueOnce(liveResult({ items: [listSummary(listDetail())], total: 1, page: 1, page_size: 100 }))
      .mockRejectedValueOnce(new Error('编辑后刷新失败'))
    const updateWrapper = mountWorkspace(updateRepository)
    await settle()
    await updateWrapper.get('[data-testid="procurement-line-edit-101"]').trigger('click')
    await updateWrapper.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()
    expect(updateRepository.updateProcurementLine).toHaveBeenCalledTimes(1)
    expect(updateWrapper.get('[data-testid="procurement-line-dialog"]').isVisible()).toBe(false)
    expect(updateWrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已保存，但刷新失败：采购清单（当前显示上次结果）读取失败：编辑后刷新失败')
    expect(updateWrapper.text()).toContain('伺服电机')
    unmountWorkspace(updateWrapper)

    const deleteRepository = createRepository()
    vi.mocked(deleteRepository.listProcurementLists)
      .mockResolvedValueOnce(liveResult({ items: [listSummary(listDetail())], total: 1, page: 1, page_size: 100 }))
      .mockRejectedValueOnce(new Error('删除后刷新失败'))
    vi.spyOn(ElMessageBox, 'confirm')
      .mockResolvedValue({ value: '', action: 'confirm' } as unknown as MessageBoxData)
    const deleteWrapper = mountWorkspace(deleteRepository)
    await settle()
    await deleteWrapper.get('[data-testid="procurement-line-delete-101"]').trigger('click')
    await settle()
    expect(deleteRepository.deleteProcurementLine).toHaveBeenCalledTimes(1)
    expect(deleteWrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已删除，但刷新失败：采购清单（当前显示上次结果）读取失败：删除后刷新失败')
    expect(deleteWrapper.text()).toContain('伺服电机')
  })

  it('已确认清单行不显示编辑和删除入口', async () => {
    const wrapper = mountWorkspace(createRepository({ listStatus: 'confirmed' }))
    await settle()
    expect(wrapper.find('[data-testid="procurement-line-edit-101"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="procurement-line-delete-101"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="procurement-list-confirm-11"]').exists()).toBe(false)
  })

  it('清单确认成功后重新读取当前项目并展示确认后的刷新结果', async () => {
    const repository = createRepository()
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    const draft = listDetail()
    const confirmed = { ...listDetail('SY-001', 'confirmed'), name: '刷新后已确认清单' }
    vi.mocked(repository.getProcurementList)
      .mockResolvedValueOnce(liveResult(draft))
      .mockResolvedValueOnce(liveResult(confirmed))
    vi.mocked(repository.confirmProcurementList).mockResolvedValue(liveResult(confirmed))
    const wrapper = mountWorkspace(repository)
    await settle()
    expectWorkspaceReadCount(repository, 1)

    await wrapper.get('[data-testid="procurement-list-confirm-11"]').trigger('click')
    await settle()

    expect(repository.confirmProcurementList).toHaveBeenCalledWith('SY-001', 11, {
      expected_revision: 3,
    })
    expectWorkspaceReadCount(repository, 2)
    expect(wrapper.text()).toContain('刷新后已确认清单')
    expect(wrapper.find('[data-testid="procurement-list-confirm-11"]').exists()).toBe(false)
  })

  it('采购行写入中切换项目和 repository，迟到未知结果返回原上下文后恢复', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A' })
    const repositoryB = createRepository({ projectCode: 'SY-B' })
    let rejectLine!: (reason?: unknown) => void
    const delayedLine = new Promise<Awaited<ReturnType<ProcurementHttpRepository['createProcurementLine']>>>((_, reject) => {
      rejectLine = reject
    })
    vi.mocked(repositoryA.createProcurementLine)
      .mockReturnValueOnce(delayedLine)
      .mockResolvedValueOnce(liveResult(line))
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()

    const dialog = await openAndFillNewLine(wrapper, '切换前空开')
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await Promise.resolve()
    const submittedInput = vi.mocked(repositoryA.createProcurementLine).mock.calls[0]![2]
    expect(submittedInput).toEqual(newProcurementLineInput('切换前空开'))

    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await settle()
    expect(wrapper.text()).toContain('SY-B采购清单')
    rejectLine(new TypeError('Failed to fetch'))
    await settle()

    expect(repositoryA.discardCreateProcurementLine).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('SY-B采购清单')
    expect(wrapper.text()).not.toContain('SY-A采购清单')
    expect(wrapper.find('[data-testid="procurement-action-error"]').exists()).toBe(false)

    await wrapper.setProps({ projectCode: 'SY-A', repository: repositoryA })
    await settle()
    const restored = wrapper.get('[data-testid="procurement-line-dialog"]')
    expect(restored.isVisible()).toBe(true)
    expect(restored.get('[data-testid="procurement-line-create-uncertain"]').text()).toContain('原样重试')
    await restored.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()
    expect(vi.mocked(repositoryA.createProcurementLine).mock.calls[1]![2]).toBe(submittedInput)
  })

  it('采购单新建、确认与到货真实保存，供应商只来自公司接口', async () => {
    const repository = createRepository({ listStatus: 'confirmed', orderStatus: 'draft' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const orderDialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    const supplierSelect = orderDialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper<any>
    expect(supplierSelect.props('modelValue')).toBeNull()
    expect(repository.listSupplierCompanies).toHaveBeenCalledTimes(1)
    supplierSelect.vm.$emit('update:modelValue', 8)
    expect((orderDialog.get('[data-testid="purchase-order-quantity"]').element as HTMLInputElement).value)
      .toBe('6.000')
    await orderDialog.get('[data-testid="purchase-order-number"]').setValue('PO-NEW')
    await orderDialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    const orderInput: PurchaseOrderInput = {
      order_no: 'PO-NEW',
      supplier_company_id: 8,
      ordered_on: localISODate(),
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: 101,
        quantity: '6.000',
        unit_cost_cents: 128900,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    }
    expect(repository.createPurchaseOrder).toHaveBeenCalledWith('SY-001', orderInput)

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-order-confirm"]').trigger('click')
    await settle()
    expect(repository.confirmPurchaseOrder).toHaveBeenCalledWith('SY-001', 91, { expected_revision: 2 })

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-receipt-open"]').trigger('click')
    const receiptDialog = wrapper.get('[data-testid="purchase-event-dialog"]')
    await receiptDialog.get('[data-testid="purchase-event-warehouse"]').setValue('主仓')
    await receiptDialog.get('[data-testid="purchase-event-quantity-901"]').setValue('2.000')
    await receiptDialog.get('[data-testid="purchase-event-submit"]').trigger('click')
    await settle()
    const receiptInput: GoodsReceiptInput = {
      received_on: localISODate(),
      warehouse_name: '主仓',
      lines: [{ purchase_order_line_id: 901, quantity: '2.000' }],
      notes: null,
    }
    expect(repository.receiveGoods).toHaveBeenCalledWith('SY-001', 91, receiptInput)
  })

  it('新建采购单可在同一弹窗拖入合同并按需关联已有资料', async () => {
    const repository = createRepository({ listStatus: 'confirmed' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    ;(dialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    expect(dialog.text()).toContain('供应商合同、盖章页或下单凭证')
    expect(dialog.text()).toContain('关联已有资料（可选）')
    expect(dialog.find('.el-dialog__footer [data-testid="purchase-order-submit"]').exists()).toBe(true)
    const attachment = dialog.get('[data-testid="purchase-order-attachments"]')
    const upload = attachment.findComponent({ name: 'ElUpload' })
    expect(upload.props('drag')).toBe(true)
    expect(upload.props('multiple')).toBe(true)
    expect(upload.props('accept')).toBe('.pdf,.doc,.docx,image/*')

    const contract = new File(['contract'], '供应商原合同.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const input = attachment.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [contract] })
    await input.trigger('change')
    await settle()
    await dialog.get('[data-testid="purchase-order-existing-documents"]').findComponent({ name: 'ElSelect' }).setValue([44])
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-WITH-CONTRACT')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()

    expect(repository.createPurchaseOrder).toHaveBeenCalledWith(
      'SY-001',
      expect.objectContaining({
        order_no: 'PO-WITH-CONTRACT',
        document_version_ids: [44],
      }),
      [contract],
    )
  })

  it('已有资料读取失败不阻断采购核心数据和合同直传', async () => {
    const repository = createRepository({ listStatus: 'confirmed' })
    vi.mocked(repository.listDocumentVersionOptions!).mockRejectedValueOnce(new Error('资料接口失败'))
    const wrapper = mountWorkspace(repository)
    await settle()

    expect(wrapper.text()).toContain('SY-001采购清单')
    expect(wrapper.text()).toContain('PO-2026-001')
    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    expect(dialog.get('[data-testid="purchase-order-existing-documents-error"]').text())
      .toContain('资料接口失败；仍可直接上传新文件')
    expect(dialog.get('[data-testid="purchase-order-existing-documents"]').findComponent({ name: 'ElSelect' }).props('disabled')).toBe(true)
    expect(dialog.get('[data-testid="purchase-order-attachments"]').findComponent({ name: 'ElUpload' }).props('disabled')).toBe(false)
  })

  it('采购单保存中锁定弹窗、附件和重复提交，完成后恢复', async () => {
    const repository = createRepository({ listStatus: 'confirmed' })
    const pending = deferred<Awaited<ReturnType<ProcurementHttpRepository['createPurchaseOrder']>>>()
    vi.mocked(repository.createPurchaseOrder).mockReturnValue(pending.promise)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    ;(dialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-PENDING')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await Promise.resolve()

    expect(dialog.find('.el-dialog__headerbtn').exists()).toBe(false)
    expect(dialog.get('[data-testid="purchase-order-attachments"]').findComponent({ name: 'ElUpload' }).props('disabled')).toBe(true)
    expect(dialog.get('[data-testid="purchase-order-submit"]').attributes('disabled')).toBeDefined()
    await dialog.get('form').trigger('submit')
    expect(repository.createPurchaseOrder).toHaveBeenCalledTimes(1)

    pending.resolve(liveResult(purchaseOrder('SY-001', 'draft')))
    await settle()
    expect(dialog.isVisible()).toBe(false)
  })

  it('采购行没有剩余数量时禁用普通采购单创建', async () => {
    const repository = createRepository({
      listStatus: 'confirmed',
      orderedQuantity: '8.000',
    })
    const wrapper = mountWorkspace(repository)
    await settle()

    const createButton = wrapper.get('[data-testid="purchase-order-create-101"]')
    expect(createButton.attributes('disabled')).toBeDefined()
    await createButton.trigger('click')
    expect(wrapper.find('[data-testid="purchase-order-dialog"]').exists()).toBe(false)
  })

  it('采购数量超过清单剩余数量时必须明确填写超采原因', async () => {
    const repository = createRepository({ listStatus: 'confirmed' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    ;(dialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-OVER')
    await dialog.get('[data-testid="purchase-order-quantity"]').setValue('6.001')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()

    expect(repository.createPurchaseOrder).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('必须填写超采原因')
    expect(dialog.get('[data-testid="purchase-order-error"]').text()).toContain('必须填写超采原因')

    await dialog.get('[data-testid="purchase-order-overage-reason"]').setValue('  项目追加  ')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    const input: PurchaseOrderInput = {
      order_no: 'PO-OVER',
      supplier_company_id: 8,
      ordered_on: localISODate(),
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: 101,
        quantity: '6.001',
        unit_cost_cents: 128900,
        overage_reason: '项目追加',
      }],
      notes: null,
      document_version_ids: [],
    }
    expect(repository.createPurchaseOrder).toHaveBeenCalledWith('SY-001', input)
  })

  it('草稿采购单可逐行修改数量、成本价和超采原因，并提交完整 PUT DTO', async () => {
    const repository = createRepository({ listStatus: 'confirmed', orderStatus: 'draft' })
    const editableList = listDetail('SY-001', 'confirmed')
    editableList.lines.push({
      ...editableList.lines[0]!, id: 102, name: '接触器', quantity: '4.000', ordered_quantity: '1.000',
    })
    const editableOrder = purchaseOrder('SY-001', 'draft')
    editableOrder.lines.push({
      ...editableOrder.lines[0]!, id: 902, procurement_line_id: 102, quantity: '1.000', unit_cost_cents: 8800,
    })
    vi.mocked(repository.getProcurementList).mockResolvedValue(liveResult(editableList))
    vi.mocked(repository.getPurchaseOrder).mockResolvedValue(liveResult(editableOrder))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-order-edit"]')
    const dialog = wrapper.get('[data-testid="purchase-order-edit-dialog"]')
    expect((dialog.get('[data-testid="purchase-order-edit-line-quantity-901"]').element as HTMLInputElement).value)
      .toBe('2.000')
    expect((dialog.get('[data-testid="purchase-order-edit-line-cost-901"]').element as HTMLInputElement).value)
      .toBe('1289.00')

    await dialog.get('[data-testid="purchase-order-edit-line-quantity-901"]').setValue('8.500')
    await dialog.get('[data-testid="purchase-order-edit-line-cost-901"]').setValue('1250.50')
    await dialog.get('[data-testid="purchase-order-edit-line-overage-901"]').setValue('  客户追加备件  ')
    await dialog.get('[data-testid="purchase-order-edit-line-quantity-902"]').setValue('3.000')
    await dialog.get('[data-testid="purchase-order-edit-line-cost-902"]').setValue('88.00')
    await dialog.get('[data-testid="purchase-order-edit-submit"]').trigger('click')
    await settle()

    expect(repository.updatePurchaseOrder).toHaveBeenCalledWith('SY-001', 91, {
      order_no: 'PO-2026-001',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: '2026-09-05',
      lines: [{
        procurement_line_id: 101,
        quantity: '8.500',
        unit_cost_cents: 125050,
        overage_reason: '客户追加备件',
      }, {
        procurement_line_id: 102,
        quantity: '3.000',
        unit_cost_cents: 8800,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
      expected_revision: 2,
    })
  })

  it('草稿采购单编辑拒绝非正数数量、负成本价和无原因超采', async () => {
    const repository = createRepository({ listStatus: 'confirmed', orderStatus: 'draft' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-order-edit"]')
    const dialog = wrapper.get('[data-testid="purchase-order-edit-dialog"]')
    const quantity = dialog.get('[data-testid="purchase-order-edit-line-quantity-901"]')
    const cost = dialog.get('[data-testid="purchase-order-edit-line-cost-901"]')
    const reason = dialog.get('[data-testid="purchase-order-edit-line-overage-901"]')

    await quantity.setValue('0')
    await dialog.get('[data-testid="purchase-order-edit-submit"]').trigger('click')
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('数量必须大于 0')

    await quantity.setValue('2.000')
    await cost.setValue('-1')
    await dialog.get('[data-testid="purchase-order-edit-submit"]').trigger('click')
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('成本价必须是非负金额')

    await cost.setValue('1289.00')
    await quantity.setValue('8.001')
    await reason.setValue('   ')
    await dialog.get('[data-testid="purchase-order-edit-submit"]').trigger('click')
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('超采必须填写原因')
    expect(repository.updatePurchaseOrder).not.toHaveBeenCalled()
  })

  it.each(['abc', '-1', '1.0001'])(
    '到货数量 %s 非法时显示操作错误且不产生未处理 Promise',
    async (invalidQuantity) => {
      const repository = createRepository({ orderStatus: 'confirmed' })
      const wrapper = mountWorkspace(repository)
      await settle()

      await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
      await settle()
      await wrapper.get('[data-testid="purchase-receipt-open"]').trigger('click')
      const dialog = wrapper.get('[data-testid="purchase-event-dialog"]')
      await dialog.get('[data-testid="purchase-event-warehouse"]').setValue('主仓')
      await dialog.get('[data-testid="purchase-event-quantity-901"]').setValue(invalidQuantity)
      let thrown: unknown
      try {
        await dialog.get('[data-testid="purchase-event-submit"]').trigger('click')
      } catch (error) {
        thrown = error
      }
      await settle()

      expect(thrown).toBeUndefined()
      expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('数量格式不正确')
      expect(repository.receiveGoods).not.toHaveBeenCalled()
    },
  )

  it('采购单创建结果未知时关闭对话框，用原项目和完整同一 DTO 放弃 pending', async () => {
    const repository = createRepository({ listStatus: 'confirmed' })
    vi.mocked(repository.createPurchaseOrder).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreatePurchaseOrder).mockReturnValue(true)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    ;(dialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-UNKNOWN')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    expect(dialog.get('[data-testid="purchase-order-create-uncertain"]').text()).toContain('原样重试')
    expect(dialog.get('[data-testid="purchase-order-number"]').html()).toContain('disabled')
    const submittedInput = vi.mocked(repository.createPurchaseOrder).mock.calls[0]![1]
    const expectedInput: PurchaseOrderInput = {
      order_no: 'PO-UNKNOWN',
      supplier_company_id: 8,
      ordered_on: localISODate(),
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: 101,
        quantity: '6.000',
        unit_cost_cents: 128900,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    }
    expect(submittedInput).toEqual(expectedInput)

    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    await dialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(repository.discardCreatePurchaseOrder).toHaveBeenCalledWith('SY-001', submittedInput)
    expect(vi.mocked(repository.discardCreatePurchaseOrder).mock.calls[0]![1]).toBe(submittedInput)
  })

  it('到货结果未知时关闭对话框，用原项目、采购单和完整同一 DTO 放弃 pending', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.receiveGoods).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardReceiveGoods).mockReturnValue(true)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-receipt-open"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-event-dialog"]')
    await dialog.get('[data-testid="purchase-event-warehouse"]').setValue('  主仓  ')
    await dialog.get('[data-testid="purchase-event-quantity-901"]').setValue('2.000')
    await dialog.get('[data-testid="purchase-event-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    expect(dialog.get('[data-testid="goods-receipt-create-uncertain"]').text()).toContain('原样重试')
    expect(dialog.get('[data-testid="purchase-event-warehouse"]').html()).toContain('disabled')
    const submittedInput = vi.mocked(repository.receiveGoods).mock.calls[0]![2]
    const expectedInput: GoodsReceiptInput = {
      received_on: localISODate(),
      warehouse_name: '主仓',
      lines: [{ purchase_order_line_id: 901, quantity: '2.000' }],
      notes: null,
    }
    expect(submittedInput).toEqual(expectedInput)

    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    await dialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(repository.discardReceiveGoods).toHaveBeenCalledWith('SY-001', 91, submittedInput)
    expect(vi.mocked(repository.discardReceiveGoods).mock.calls[0]![2]).toBe(submittedInput)
  })

  it('采购单写入中切换项目和 repository，迟到未知不污染且返回原上下文恢复', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A', listStatus: 'confirmed' })
    const repositoryB = createRepository({ projectCode: 'SY-B', listStatus: 'confirmed' })
    let rejectOrder!: (reason?: unknown) => void
    const delayedOrder = new Promise<Awaited<ReturnType<ProcurementHttpRepository['createPurchaseOrder']>>>((_, reject) => {
      rejectOrder = reject
    })
    vi.mocked(repositoryA.createPurchaseOrder)
      .mockReturnValueOnce(delayedOrder)
      .mockResolvedValueOnce(liveResult(purchaseOrder('SY-A', 'draft')))
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    ;(dialog.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-SWITCH')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await Promise.resolve()
    const submittedInput = vi.mocked(repositoryA.createPurchaseOrder).mock.calls[0]![1]
    expect(submittedInput.lines[0]!.quantity).toBe('6.000')

    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await settle()
    expect(wrapper.text()).toContain('SY-B采购清单')
    rejectOrder(new TypeError('Failed to fetch'))
    await settle()

    expect(repositoryA.discardCreatePurchaseOrder).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('SY-B采购清单')
    expect(wrapper.text()).not.toContain('SY-A采购清单')
    expect(wrapper.find('[data-testid="procurement-action-error"]').exists()).toBe(false)

    await wrapper.setProps({ projectCode: 'SY-A', repository: repositoryA })
    await settle()
    const restored = wrapper.get('[data-testid="purchase-order-dialog"]')
    expect(restored.get('[data-testid="purchase-order-create-uncertain"]').text()).toContain('结果未知')
    await restored.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    expect(vi.mocked(repositoryA.createPurchaseOrder).mock.calls[1]![1]).toBe(submittedInput)
  })

  it('付款 POST 成功但订单刷新失败时关闭表单并只报告已保存后的刷新错误', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.getPurchaseOrder)
      .mockResolvedValueOnce(liveResult(purchaseOrder('SY-001', 'confirmed')))
      .mockRejectedValueOnce(new Error('订单刷新失败'))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-payment-open"]')
    await wrapper.get('[data-testid="purchase-payment-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierPayment).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="purchase-payment-dialog"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已保存，但刷新失败：订单刷新失败')
  })

  it('供应商付款结果未知后锁定原始内容，重试复用原项目、订单和同一 DTO', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.createSupplierPayment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-payment-open"]')
    const dialog = wrapper.get('[data-testid="purchase-payment-dialog"]')
    await dialog.get('[data-testid="purchase-payment-amount"]').setValue('100.00')
    await dialog.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()

    const firstCall = vi.mocked(repository.createSupplierPayment).mock.calls[0]!
    const submittedInput = firstCall[2]
    expect(firstCall.slice(0, 2)).toEqual(['SY-001', 91])
    expect(submittedInput).toEqual({
      paid_on: localISODate(),
      amount_cents: 10_000,
      payment_method: '银行转账',
      reference_no: null,
      allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      notes: null,
    })
    expect(dialog.get('[data-testid="purchase-payment-pending"]').text()).toContain('结果未知')
    expect((dialog.get('[data-testid="purchase-payment-amount"]').element as HTMLInputElement).value).toBe('100.00')
    expect(dialog.get('[data-testid="purchase-payment-amount"]').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-testid="purchase-payment-submit"]').text()).toContain('重试')

    await dialog.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierPayment).toHaveBeenCalledTimes(2)
    const retryCall = vi.mocked(repository.createSupplierPayment).mock.calls[1]!
    expect(retryCall.slice(0, 2)).toEqual(['SY-001', 91])
    expect(retryCall[2]).toBe(submittedInput)
    expect(dialog.isVisible()).toBe(false)
  })

  it('供应商付款被服务端明确拒绝时不伪装成未知结果，允许修正后重新提交', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.createSupplierPayment).mockRejectedValueOnce(new ApiError('付款金额已超限', 422))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-payment-open"]')
    const dialog = wrapper.get('[data-testid="purchase-payment-dialog"]')
    const amount = dialog.get('[data-testid="purchase-payment-amount"]')
    await amount.setValue('100.00')
    await dialog.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()

    expect(dialog.get('[data-testid="purchase-payment-error"]').text()).toContain('付款金额已超限')
    expect(dialog.find('[data-testid="purchase-payment-pending"]').exists()).toBe(false)
    expect(amount.attributes('disabled')).toBeUndefined()

    await amount.setValue('80.00')
    await dialog.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.createSupplierPayment).mock.calls[1]![2].amount_cents).toBe(8_000)
  })

  it('供应商付款结果未知时，底部取消与右上角共用确认流程，确认放弃才清理原 pending', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.createSupplierPayment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreateSupplierPayment).mockReturnValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce(new Error('继续填写'))
      .mockResolvedValueOnce('confirm' as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-payment-open"]')
    const dialog = wrapper.get('[data-testid="purchase-payment-dialog"]')
    await dialog.get('[data-testid="purchase-payment-amount"]').setValue('100.00')
    await dialog.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()
    const submittedInput = vi.mocked(repository.createSupplierPayment).mock.calls[0]![2]

    await dialog.get('[data-testid="purchase-payment-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(dialog.isVisible()).toBe(true)
    expect(repository.discardCreateSupplierPayment).not.toHaveBeenCalled()

    await dialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]).toEqual(confirm.mock.calls[0])
    expect(repository.discardCreateSupplierPayment).toHaveBeenCalledWith('SY-001', 91, submittedInput)
    expect(vi.mocked(repository.discardCreateSupplierPayment).mock.calls[0]![2]).toBe(submittedInput)
    expect(dialog.isVisible()).toBe(false)
  })

  it('新建清单底部取消与右上角共用同一放弃确认流程', async () => {
    const repository = createRepository()
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce(new Error('继续填写'))
      .mockResolvedValueOnce('confirm' as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="procurement-list-create-open"]').trigger('click')
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('尚未保存的清单')
    await wrapper.get('[data-testid="procurement-list-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="procurement-list-name"]').isVisible()).toBe(true)

    const dialog = wrapper.get('[role="dialog"]')
    await dialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]).toEqual(confirm.mock.calls[0])
    expect(wrapper.get('[data-testid="procurement-list-name"]').isVisible()).toBe(false)
  })

  it('发票 POST 成功但订单刷新失败时关闭表单并只报告已保存后的刷新错误', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.getPurchaseOrder)
      .mockResolvedValueOnce(liveResult(purchaseOrder('SY-001', 'confirmed')))
      .mockRejectedValueOnce(new Error('订单刷新失败'))
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    await wrapper.get('[data-testid="purchase-invoice-number"]').setValue('INV-REFRESH')
    await wrapper.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierInvoice).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="purchase-invoice-dialog"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已保存，但刷新失败：订单刷新失败')
  })

  it('进项发票删除附件版本号输入并将多文件随正式登记提交', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    const dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    expect(dialog.find('.el-dialog__footer [data-testid="purchase-invoice-submit"]').exists()).toBe(true)
    expect(dialog.text()).not.toContain('附件版本号')
    expect(dialog.text()).not.toContain('逗号分隔')
    expect(dialog.text()).toContain('图片可直接随本次登记一起保存')
    const files = [
      new File(['front'], '进项发票.jpg', { type: 'image/jpeg' }),
      new File(['pdf'], '进项发票.pdf', { type: 'application/pdf' }),
    ]
    const input = dialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: files })
    await input.trigger('change')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-ATTACH')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierInvoice).toHaveBeenCalledWith('SY-001', 91, {
      invoice_no: 'INV-ATTACH', invoiced_on: localISODate(), amount_cents: 10_000,
      allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      document_version_ids: [],
    }, files)
  })

  it('进项发票校验与后端错误显示在弹窗内，关闭时放弃最近提交快照', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    const dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    expect(dialog.get('[data-testid="purchase-invoice-error"]').text())
      .toContain('请填写有效的发票号、开票日期和金额')

    const file = new File(['pdf'], '进项发票.pdf', { type: 'application/pdf' })
    const fileInput = dialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-ERROR')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    vi.mocked(repository.createSupplierInvoice).mockRejectedValueOnce(new Error('后端拒绝登记'))
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()

    expect(dialog.get('[data-testid="purchase-invoice-error"]').text()).toContain('后端拒绝登记')
    await dialog.get('[data-testid="purchase-invoice-cancel"]').trigger('click')
    await settle()
    expect(repository.discardCreateSupplierInvoice).toHaveBeenCalledWith('SY-001', 91, {
      invoice_no: 'INV-ERROR', invoiced_on: localISODate(), amount_cents: 10_000,
      allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      document_version_ids: [],
    }, [file])
  })

  it('进项发票结果未知后锁定原订单、内容和文件，放弃失败时仍可原样重试', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.createSupplierInvoice).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreateSupplierInvoice)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    const dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    const file = new File(['pdf'], '进项发票.pdf', { type: 'application/pdf' })
    const fileInput = dialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-ORIGINAL')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()

    expect(dialog.get('[data-testid="purchase-invoice-pending"]').text()).toContain('原样重试')
    expect(dialog.get('[data-testid="purchase-invoice-number"]').attributes('disabled')).toBeDefined()
    expect(fileInput.attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-testid="purchase-invoice-submit"]').text()).toContain('原样重试')
    const firstCall = vi.mocked(repository.createSupplierInvoice).mock.calls[0]!

    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-CHANGED')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]).toEqual(firstCall)
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![2]).toBe(firstCall[2])
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![3]).toBe(firstCall[3])

    await dialog.get('[data-testid="purchase-invoice-abandon-pending"]').trigger('click')
    await settle()
    expect(dialog.find('[data-testid="purchase-invoice-pending"]').exists()).toBe(true)
    expect(dialog.get('[data-testid="purchase-invoice-number"]').attributes('disabled')).toBeDefined()

    await dialog.get('[data-testid="purchase-invoice-abandon-pending"]').trigger('click')
    await settle()
    expect(dialog.find('[data-testid="purchase-invoice-pending"]').exists()).toBe(false)
    expect(dialog.get('[data-testid="purchase-invoice-number"]').attributes('disabled')).toBeUndefined()
  })

  it('进项发票未知结果在卸载重挂后仍用原 repository、订单、input 和 File 重试', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    vi.mocked(repository.createSupplierInvoice)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const first = mountWorkspace(repository)
    await settle()
    await first.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(first, '[data-testid="purchase-invoice-open"]')
    const firstDialog = first.get('[data-testid="purchase-invoice-dialog"]')
    const file = new File(['pdf'], '跨生命周期进项发票.pdf', { type: 'application/pdf' })
    const upload = firstDialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [file] })
    await upload.trigger('change')
    await firstDialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-REMOUNT')
    await firstDialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await firstDialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()
    const originalCall = vi.mocked(repository.createSupplierInvoice).mock.calls[0]!
    first.unmount()

    expect(repository.discardCreateSupplierInvoice).not.toHaveBeenCalled()
    const second = mountWorkspace(repository)
    await settle()
    await settle()
    const restored = second.get('[data-testid="purchase-invoice-dialog"]')
    expect(restored.isVisible()).toBe(true)
    expect(restored.get('[data-testid="purchase-invoice-pending"]').text()).toContain('原样重试')
    await restored.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![0]).toBe('SY-001')
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![1]).toBe(91)
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![2]).toBe(originalCall[2])
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![3]).toBe(originalCall[3])
    expect(vi.mocked(repository.createSupplierInvoice).mock.calls[1]![3]![0]).toBe(file)
  })

  it('迟到成功遇到其他操作忙碌时会在忙碌结束后消费，订单详情迟到也不重开已提交表单', async () => {
    type InvoiceResult = Awaited<ReturnType<ProcurementHttpRepository['createSupplierInvoice']>>
    const repository = createRepository({ orderStatus: 'confirmed' })
    const lateInvoice = deferred<InvoiceResult>()
    const lateOrderDetail = deferred<Awaited<ReturnType<ProcurementHttpRepository['getPurchaseOrder']>>>()
    const lateTemplate = deferred<Blob>()
    vi.mocked(repository.createSupplierInvoice).mockReturnValue(lateInvoice.promise)
    vi.mocked(repository.getPurchaseOrder)
      .mockResolvedValueOnce(liveResult(purchaseOrder('SY-001', 'confirmed')))
      .mockReturnValueOnce(lateOrderDetail.promise)
    vi.mocked(repository.downloadImportTemplate).mockReturnValue(lateTemplate.promise)

    const first = mountWorkspace(repository)
    await settle()
    await first.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(first, '[data-testid="purchase-invoice-open"]')
    const firstDialog = first.get('[data-testid="purchase-invoice-dialog"]')
    await firstDialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-LATE')
    await firstDialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await firstDialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await Promise.resolve()
    first.unmount()

    const second = mountWorkspace(repository)
    await settle()
    expect(repository.getPurchaseOrder).toHaveBeenCalledTimes(2)
    await second.get('[data-testid="procurement-template-download"]').trigger('click')
    lateInvoice.resolve(liveResult({
      id: 2, purchase_order_id: 91, invoice_no: 'INV-LATE', invoiced_on: localISODate(),
      amount_cents: 10_000, allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      document_version_ids: [], status: 'active' as const, reversal_reason: null,
      reversed_at: null, revision: 1, created_at: '', updated_at: '',
    }))
    await settle()

    lateTemplate.resolve(new Blob(['xlsx']))
    await settle()
    lateOrderDetail.resolve(liveResult(purchaseOrder('SY-001', 'confirmed')))
    await settle()

    expect(second.find('[data-testid="purchase-invoice-dialog"]').exists()).toBe(false)
    expect(second.emitted('changed')).toHaveLength(1)
    expect(repository.createSupplierInvoice).toHaveBeenCalledTimes(1)
  })

  it('进项发票保存期间整体禁用，首请求完成后恢复', async () => {
    const repository = createRepository({ orderStatus: 'confirmed' })
    const pending = deferred<Awaited<ReturnType<ProcurementHttpRepository['createSupplierInvoice']>>>()
    vi.mocked(repository.createSupplierInvoice).mockReturnValue(pending.promise)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    const dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-PENDING')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await Promise.resolve()

    expect(repository.createSupplierInvoice).toHaveBeenCalledTimes(1)
    expect(dialog.findAll('input,textarea').every((field) => field.attributes('disabled') !== undefined)).toBe(true)
    expect(dialog.find('.el-dialog__headerbtn').exists()).toBe(false)
    expect(dialog.get('[data-testid="purchase-invoice-cancel"]').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-testid="purchase-invoice-submit"]').attributes('disabled')).toBeDefined()
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-CHANGED')
    await dialog.get('form').trigger('submit')
    expect(repository.createSupplierInvoice).toHaveBeenCalledTimes(1)

    pending.resolve(liveResult({
      id: 1, purchase_order_id: 91, invoice_no: 'INV-PENDING', invoiced_on: localISODate(),
      amount_cents: 10_000, allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      document_version_ids: [], status: 'active' as const, reversal_reason: null,
      reversed_at: null, revision: 1, created_at: '', updated_at: '',
    }))
    await settle()

    expect(dialog.isVisible()).toBe(false)
    expect(dialog.get('[data-testid="purchase-invoice-number"]').attributes('disabled')).toBeUndefined()
  })

  it('A、B 发票交错提交时 A 迟到未知被保留，B 可完成且返回 A 原样重试', async () => {
    type InvoiceResult = Awaited<ReturnType<ProcurementHttpRepository['createSupplierInvoice']>>
    const repositoryA = createRepository({ projectCode: 'SY-A', orderStatus: 'confirmed' })
    const repositoryB = createRepository({ projectCode: 'SY-B', orderStatus: 'confirmed' })
    const pendingA = deferred<InvoiceResult>()
    const pendingB = deferred<InvoiceResult>()
    const savedInvoice = (projectCode: string, invoiceNo: string): InvoiceResult => liveResult({
      id: projectCode === 'SY-A' ? 1 : 2,
      purchase_order_id: 91,
      invoice_no: invoiceNo,
      invoiced_on: localISODate(),
      amount_cents: 10_000,
      allocations: [{ purchase_order_line_id: 901, amount_cents: 10_000 }],
      document_version_ids: [],
      status: 'active' as const,
      reversal_reason: null,
      reversed_at: null,
      revision: 1,
      created_at: '',
      updated_at: '',
    })
    vi.mocked(repositoryA.createSupplierInvoice)
      .mockReturnValueOnce(pendingA.promise)
      .mockResolvedValueOnce(savedInvoice('SY-A', 'INV-A-RETRY'))
    vi.mocked(repositoryB.createSupplierInvoice).mockReturnValueOnce(pendingB.promise)
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    let dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    const fileA = new File(['A'], 'A发票.pdf', { type: 'application/pdf' })
    let upload = dialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [fileA] })
    await upload.trigger('change')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-A')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await dialog.get('form').trigger('submit')
    await Promise.resolve()

    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await settle()
    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await clickPurchaseOrderAction(wrapper, '[data-testid="purchase-invoice-open"]')
    dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    const fileB = new File(['B'], 'B发票.pdf', { type: 'application/pdf' })
    upload = dialog.get('[data-testid="purchase-invoice-attachments"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [fileB] })
    await upload.trigger('change')
    await dialog.get('[data-testid="purchase-invoice-number"]').setValue('INV-B')
    await dialog.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await dialog.get('form').trigger('submit')
    await Promise.resolve()

    pendingA.reject(new Error('A 网络中断'))
    await settle()
    expect(repositoryA.discardCreateSupplierInvoice).not.toHaveBeenCalled()
    expect(repositoryB.discardCreateSupplierInvoice).not.toHaveBeenCalled()
    expect(dialog.isVisible()).toBe(true)

    pendingB.resolve(savedInvoice('SY-B', 'INV-B'))
    await settle()
    expect(dialog.isVisible()).toBe(false)

    await wrapper.setProps({ projectCode: 'SY-A', repository: repositoryA })
    await settle()
    dialog = wrapper.get('[data-testid="purchase-invoice-dialog"]')
    expect(dialog.get('[data-testid="purchase-invoice-pending"]').text()).toContain('结果未知')
    await dialog.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()
    expect(repositoryA.createSupplierInvoice).toHaveBeenCalledTimes(2)
    expect(vi.mocked(repositoryA.createSupplierInvoice).mock.calls[1]![2])
      .toBe(vi.mocked(repositoryA.createSupplierInvoice).mock.calls[0]![2])
    expect(vi.mocked(repositoryA.createSupplierInvoice).mock.calls[1]![3])
      .toBe(vi.mocked(repositoryA.createSupplierInvoice).mock.calls[0]![3])
    expect(vi.mocked(repositoryA.createSupplierInvoice).mock.calls[1]![3]![0]).toBe(fileA)
  })

  it('打开 A 采购单详情后切到 B 时不读取也不展示 A 的迟到结果', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A' })
    const repositoryB = createRepository({ projectCode: 'SY-B' })
    let resolveDetail!: (value: RepositoryResult<PurchaseOrderDto>) => void
    const delayedDetail = new Promise<RepositoryResult<PurchaseOrderDto>>((resolve) => {
      resolveDetail = resolve
    })
    vi.mocked(repositoryA.getPurchaseOrder).mockReturnValue(delayedDetail)
    const readLateData = vi.fn(() => purchaseOrder('SY-A'))
    const lateResult = { source: 'live' } as RepositoryResult<PurchaseOrderDto>
    Object.defineProperty(lateResult, 'data', { get: readLateData })
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await settle()
    resolveDetail(lateResult)
    await settle()

    expect(readLateData).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('SY-B采购清单')
    expect(wrapper.find('[data-testid="purchase-order-drawer"]').isVisible()).toBe(false)
  })

  it('A 的 Excel 预览迟到时不读取结果、不污染 B 预览并由 A repository 清理 pending', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A' })
    const repositoryB = createRepository({ projectCode: 'SY-B' })
    let resolvePreview!: (value: RepositoryResult<ProcurementImportPreviewDto>) => void
    const delayedPreview = new Promise<RepositoryResult<ProcurementImportPreviewDto>>((resolve) => {
      resolvePreview = resolve
    })
    vi.mocked(repositoryA.previewProcurementImport).mockReturnValue(delayedPreview)
    const readLateData = vi.fn(() => ({
      id: 31, project_code: 'SY-A', filename: 'A.xlsx', sha256: 'a'.repeat(64),
      status: 'preview' as const, revision: 1, expires_at: '2026-09-01T08:00:00+08:00',
      confirmed_list_id: null, rows: [], errors: [], created_at: '2026-08-31T08:00:00+08:00',
      updated_at: '2026-08-31T08:00:00+08:00',
    }))
    const lateResult = { source: 'live' } as RepositoryResult<ProcurementImportPreviewDto>
    Object.defineProperty(lateResult, 'data', { get: readLateData })
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()
    const file = new File(['xlsx'], 'A.xlsx')
    expect(wrapper.get('[data-testid="procurement-import-upload"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    const upload = wrapper.get('[data-testid="procurement-import-upload"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [file] })

    await upload.trigger('change')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await settle()
    resolvePreview(lateResult)
    await settle()

    expect(readLateData).not.toHaveBeenCalled()
    expect(repositoryA.discardPreviewProcurementImport).toHaveBeenCalledWith('SY-A', file)
    expect(repositoryB.previewProcurementImport).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="procurement-import-preview"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('SY-B采购清单')
  })

  it('模板走真实下载，扩展动作按采购单状态启用且空供应商阻止下单', async () => {
    const repository = createRepository({ listStatus: 'confirmed', companies: [] })
    const createObjectUrl = vi.fn(() => 'blob:template')
    const revokeObjectUrl = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const wrapper = mountWorkspace(repository)
    await settle()

    expect(wrapper.get('[data-testid="procurement-template-download"]').text()).toContain('下载标准采购模板')
    await wrapper.get('[data-testid="procurement-template-download"]').trigger('click')
    await settle()
    expect(repository.downloadImportTemplate).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Excel 会先预览校验，确认后才写入采购清单')
    expect(wrapper.get('[data-testid="procurement-import-upload"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    expect(wrapper.get('[data-testid="quote-export-history"]').text()).toContain('客户报价单 V2')
    await wrapper.get('[data-testid="quote-export-download-8"]').trigger('click')
    await settle()
    expect(repository.downloadQuoteExport).toHaveBeenCalledWith('SY-001', 8)

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    for (const testId of ['purchase-order-edit', 'purchase-order-cancel-open']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeUndefined()
    }
    for (const testId of ['purchase-payment-open', 'purchase-invoice-open']) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(false)
    }
    expect(wrapper.find('[data-testid="purchase-order-actions-menu"]').exists()).toBe(false)
    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    expect(wrapper.get('[data-testid="purchase-order-dialog"]').text()).toContain('暂无可选供应商')
    expect(wrapper.get('[data-testid="purchase-order-submit"]').attributes('disabled')).toBeDefined()
  })
})
