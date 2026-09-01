import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox, type MessageBoxData } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProcurementWorkspace from '../components/procurement/ProcurementWorkspace.vue'
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
    listPurchaseOrders: vi.fn(async () => liveResult({
      items: [order], total: 1, page: 1, page_size: 100,
    })),
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
        revision: 1,
        lines: [],
        created_at: '2026-08-31T08:00:00+08:00',
        updated_at: '2026-08-31T08:00:00+08:00',
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
    createQuoteExport: vi.fn(async (_projectCode, listId, input) => liveResult({
      id: 1, project_code: projectCode, procurement_list_id: listId, ...input,
      customer_company_name: '客户公司', created_at: '2026-08-31T08:00:00+08:00',
      download_url: `/api/projects/${projectCode}/quote-exports/1/download`,
    })),
    downloadQuoteExport: vi.fn(async () => new Blob(['quote'])),
    getProcurementOverview: vi.fn(async () => liveResult(overview(projectCode))),
    discardCreateProcurementList: vi.fn(() => false),
    discardCreateProcurementLine: vi.fn(() => false),
    discardCreatePurchaseOrder: vi.fn(() => false),
    discardReceiveGoods: vi.fn(() => false),
    discardPreviewProcurementImport: vi.fn(() => false),
    discardConfirmProcurementImport: vi.fn(() => false),
    discardCancelPurchaseOrder: vi.fn(() => false),
    discardCreateSupplierPayment: vi.fn(() => false),
    discardCreateSupplierInvoice: vi.fn(() => false),
    discardCreateQuoteExport: vi.fn(() => false),
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
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
    expect(workspaceText).toContain('已承诺金额2578 元')
    expect(workspaceText).toContain('已到货金额0 元')
    expect(workspaceText).toContain('真实数据')
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

  it('读取错误明确展示', async () => {
    const failedRepository = createRepository()
    vi.mocked(failedRepository.listProcurementLists).mockRejectedValueOnce(new Error('采购清单接口失败'))
    const failedWrapper = mountWorkspace(failedRepository)
    await settle()
    expect(failedWrapper.get('[data-testid="procurement-load-error"]').text()).toContain('采购清单接口失败')
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
    expect(emptyListsWrapper.get('[data-testid="procurement-overview"]').text()).toContain('物料行')
    expect(emptyListsWrapper.get('[data-testid="procurement-suppliers"]').text()).toContain('暂无供应商')
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
    vi.mocked(repository.createProcurementList).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(repository.discardCreateProcurementList).mockReturnValue(true)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="procurement-list-create-open"]').trigger('click')
    await wrapper.get('[data-testid="procurement-list-name"]').setValue('临时补料')
    await wrapper.get('[data-testid="procurement-list-create-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
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
    const wrapper = mountWorkspace(repository)
    await settle()

    const dialog = await openAndFillNewLine(wrapper)
    await dialog.get('[data-testid="procurement-line-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    const submittedInput = vi.mocked(repository.createProcurementLine).mock.calls[0]![2]
    expect(submittedInput).toEqual(newProcurementLineInput())

    await dialog.get('[data-testid="procurement-line-cancel"]').trigger('click')
    expect(repository.discardCreateProcurementLine).toHaveBeenCalledWith('SY-001', 11, submittedInput)
    expect(vi.mocked(repository.discardCreateProcurementLine).mock.calls[0]![2]).toBe(submittedInput)
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
      .toContain('操作已保存，但刷新失败：编辑后刷新失败')
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
      .toContain('操作已删除，但刷新失败：删除后刷新失败')
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

  it('采购行写入中切换项目和 repository，迟到未知结果不污染且由原 repository 放弃', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A' })
    const repositoryB = createRepository({ projectCode: 'SY-B' })
    let rejectLine!: (reason?: unknown) => void
    const delayedLine = new Promise<Awaited<ReturnType<ProcurementHttpRepository['createProcurementLine']>>>((_, reject) => {
      rejectLine = reject
    })
    vi.mocked(repositoryA.createProcurementLine).mockReturnValue(delayedLine)
    vi.mocked(repositoryA.discardCreateProcurementLine)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
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

    expect(repositoryA.discardCreateProcurementLine).toHaveBeenLastCalledWith('SY-A', 11, submittedInput)
    const discardCalls = vi.mocked(repositoryA.discardCreateProcurementLine).mock.calls
    expect(discardCalls[discardCalls.length - 1]![2]).toBe(submittedInput)
    expect(wrapper.text()).toContain('SY-B采购清单')
    expect(wrapper.text()).not.toContain('SY-A采购清单')
    expect(wrapper.find('[data-testid="procurement-action-error"]').exists()).toBe(false)
  })

  it('采购单新建、确认与到货真实保存，供应商只来自公司接口', async () => {
    const repository = createRepository({ listStatus: 'confirmed', orderStatus: 'draft' })
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const orderDialog = wrapper.get('[data-testid="purchase-order-dialog"]')
    expect(orderDialog.text()).toContain('汇川技术')
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
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-OVER')
    await dialog.get('[data-testid="purchase-order-quantity"]').setValue('6.001')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()

    expect(repository.createPurchaseOrder).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('必须填写超采原因')

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
    await wrapper.get('[data-testid="purchase-order-edit"]').trigger('click')
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
    await wrapper.get('[data-testid="purchase-order-edit"]').trigger('click')
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
    await dialog.get('[data-testid="purchase-order-number"]').setValue('PO-UNKNOWN')
    await dialog.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
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

    await dialog.get('.el-dialog__headerbtn').trigger('click')
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
    await dialog.get('[data-testid="purchase-event-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('无法连接')
    const submittedInput = vi.mocked(repository.receiveGoods).mock.calls[0]![2]
    const expectedInput: GoodsReceiptInput = {
      received_on: localISODate(),
      warehouse_name: '主仓',
      lines: [{ purchase_order_line_id: 901, quantity: '2.000' }],
      notes: null,
    }
    expect(submittedInput).toEqual(expectedInput)

    await dialog.get('.el-dialog__headerbtn').trigger('click')
    expect(repository.discardReceiveGoods).toHaveBeenCalledWith('SY-001', 91, submittedInput)
    expect(vi.mocked(repository.discardReceiveGoods).mock.calls[0]![2]).toBe(submittedInput)
  })

  it('采购单写入中切换项目和 repository，迟到失败不污染且由原 repository 放弃', async () => {
    const repositoryA = createRepository({ projectCode: 'SY-A', listStatus: 'confirmed' })
    const repositoryB = createRepository({ projectCode: 'SY-B', listStatus: 'confirmed' })
    let rejectOrder!: (reason?: unknown) => void
    const delayedOrder = new Promise<Awaited<ReturnType<ProcurementHttpRepository['createPurchaseOrder']>>>((_, reject) => {
      rejectOrder = reject
    })
    vi.mocked(repositoryA.createPurchaseOrder).mockReturnValue(delayedOrder)
    vi.mocked(repositoryA.discardCreatePurchaseOrder)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const wrapper = mountWorkspace(repositoryA, 'SY-A')
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const dialog = wrapper.get('[data-testid="purchase-order-dialog"]')
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

    expect(repositoryA.discardCreatePurchaseOrder).toHaveBeenLastCalledWith('SY-A', submittedInput)
    const discardCalls = vi.mocked(repositoryA.discardCreatePurchaseOrder).mock.calls
    expect(discardCalls[discardCalls.length - 1]![1]).toBe(submittedInput)
    expect(wrapper.text()).toContain('SY-B采购清单')
    expect(wrapper.text()).not.toContain('SY-A采购清单')
    expect(wrapper.find('[data-testid="procurement-action-error"]').exists()).toBe(false)
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
    await wrapper.get('[data-testid="purchase-payment-open"]').trigger('click')
    await wrapper.get('[data-testid="purchase-payment-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierPayment).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="purchase-payment-dialog"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已保存，但刷新失败：订单刷新失败')
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
    await wrapper.get('[data-testid="purchase-invoice-open"]').trigger('click')
    await wrapper.get('[data-testid="purchase-invoice-number"]').setValue('INV-REFRESH')
    await wrapper.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()

    expect(repository.createSupplierInvoice).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="purchase-invoice-dialog"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="procurement-action-error"]').text())
      .toContain('操作已保存，但刷新失败：订单刷新失败')
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

    await wrapper.get('[data-testid="procurement-template-download"]').trigger('click')
    await settle()
    expect(repository.downloadImportTemplate).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Excel 会先预览校验，确认后才写入采购清单')
    expect(wrapper.get('[data-testid="procurement-excel-import"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    for (const testId of ['purchase-order-edit', 'purchase-order-cancel-open']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeUndefined()
    }
    for (const testId of ['purchase-payment-open', 'purchase-invoice-open']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeDefined()
    }
    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    expect(wrapper.get('[data-testid="purchase-order-dialog"]').text()).toContain('暂无可选供应商')
    expect(wrapper.get('[data-testid="purchase-order-submit"]').attributes('disabled')).toBeDefined()
  })
})
