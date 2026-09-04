import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import InventoryCenter from '../components/inventory/InventoryCenter.vue'
import ProcurementWorkspace from '../components/procurement/ProcurementWorkspace.vue'
import type {
  ProcurementListDetailDto,
  PurchaseOrderDto,
} from '../domain/operations-api'
import type { RepositoryResult } from '../repositories/common'
import type { InventoryHttpRepository } from '../repositories/inventory.live'
import type { ProcurementHttpRepository } from '../repositories/procurement.live'

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function clickTeleportedMenuItem(wrapper: VueWrapper, triggerSelector: string, itemSelector: string): Promise<void> {
  await wrapper.get(triggerSelector).trigger('click')
  await settle()
  const item = document.body.querySelector<HTMLElement>(itemSelector)
  if (!item) throw new Error(`未找到菜单项 ${itemSelector}`)
  item.click()
  await settle()
}

const wrappers = new Set<VueWrapper>()

function mountComponent(component: object, props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(component, {
    attachTo: document.body,
    props,
    global: { plugins: [ElementPlus] },
  })
  wrappers.add(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers.clear()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const inventoryItem = {
  id: 5,
  brand: '汇川',
  name: '伺服电机',
  model: 'MS1H2',
  specification: '2kW',
  unit: '台',
  quantity: '3.500',
  average_unit_cost_cents: 128900,
  inventory_value_cents: 451150,
  notes: null,
  revision: 2,
  created_at: '2026-09-01T08:00:00+08:00',
  updated_at: '2026-09-01T08:00:00+08:00',
}

function procurementList(): ProcurementListDetailDto {
  const baseLine = {
    procurement_list_id: 11,
    category: '电气',
    specification: null,
    brand: '汇川',
    unit: '台',
    quoted_unit_price_cents: 150000,
    inventory_item_id: null,
    ordered_amount_cents: 0,
    paid_amount_cents: 0,
    received_quantity: '0.000',
    invoiced_amount_cents: 0,
    issued_quantity: '0.000',
    payment_status: 'unpaid' as const,
    receipt_status: 'not_received' as const,
    invoice_status: 'not_invoiced' as const,
    usage_status: 'unused' as const,
    revision: 2,
    created_at: '2026-09-01T08:00:00+08:00',
    updated_at: '2026-09-01T08:00:00+08:00',
  }
  const lines = [
    {
      ...baseLine,
      id: 101,
      sequence_no: 1,
      name: '伺服电机',
      model: 'MS1H2',
      quantity: '8.000',
      unit_cost_cents: 128900,
      cost_total_cents: 1031200,
      quoted_total_cents: 1200000,
      ordered_quantity: '2.000',
      order_status: 'partial' as const,
    },
    {
      ...baseLine,
      id: 102,
      sequence_no: 2,
      name: '伺服驱动器',
      model: 'SV660',
      quantity: '3.000',
      unit_cost_cents: 98000,
      cost_total_cents: 294000,
      quoted_total_cents: 450000,
      ordered_quantity: '0.000',
      order_status: 'not_ordered' as const,
    },
  ]
  return {
    id: 11,
    project_code: 'SY-001',
    name: '正式采购清单',
    notes: null,
    status: 'confirmed',
    revision: 3,
    line_count: lines.length,
    cost_total_cents: 1325200,
    quoted_total_cents: 1650000,
    lines,
    confirmed_at: '2026-09-01T09:00:00+08:00',
    created_at: '2026-09-01T08:00:00+08:00',
    updated_at: '2026-09-01T09:00:00+08:00',
  }
}

function purchaseOrder(): PurchaseOrderDto {
  return {
    id: 91,
    project_code: 'SY-001',
    order_no: 'PO-001',
    supplier_company_id: 8,
    supplier_company_name: '汇川技术',
    ordered_on: '2026-09-01',
    expected_delivery_on: null,
    notes: null,
    document_version_ids: [],
    status: 'confirmed',
    ordered_amount_cents: 1067000,
    revision: 3,
    lines: [
      {
        id: 901,
        purchase_order_id: 91,
        procurement_line_id: 101,
        quantity: '6.000',
        received_quantity: '1.000',
        unit_cost_cents: 128900,
        line_amount_cents: 773400,
        overage_reason: null,
      },
      {
        id: 902,
        purchase_order_id: 91,
        procurement_line_id: 102,
        quantity: '3.000',
        received_quantity: '0.000',
        unit_cost_cents: 97867,
        line_amount_cents: 293601,
        overage_reason: null,
      },
    ],
    created_at: '2026-09-01T08:00:00+08:00',
    updated_at: '2026-09-01T09:00:00+08:00',
  }
}

function procurementRepository(options: { withOrder?: boolean } = {}): ProcurementHttpRepository {
  const list = procurementList()
  const order = purchaseOrder()
  const summary = (({ lines: _lines, cost_total_cents: _cost, quoted_total_cents: _quote, ...rest }) => rest)(list)
  return {
    listSupplierCompanies: vi.fn(async () => live([{
      id: 8, name: '汇川技术', taxpayer_id: null, registered_address: null,
      registered_phone: null, bank_name: null, bank_account: null, notes: null,
      created_at: '', updated_at: '',
    }, {
      id: 3, name: '项目客户', taxpayer_id: null, registered_address: null,
      registered_phone: null, bank_name: null, bank_account: null, notes: null,
      created_at: '', updated_at: '',
    }])),
    listProcurementLists: vi.fn(async () => live({ items: [summary], total: 1, page: 1, page_size: 100 })),
    getProcurementList: vi.fn(async () => live(list)),
    listPurchaseOrders: vi.fn(async () => live({ items: options.withOrder ? [order] : [], total: options.withOrder ? 1 : 0, page: 1, page_size: 100 })),
    getPurchaseOrder: vi.fn(async () => live({
      ...order,
      paid_amount_cents: 0,
      invoiced_amount_cents: 0,
      received_amount_cents: 128900,
      supplier_payments: [],
      supplier_invoices: [],
      goods_receipts: [{
        id: 71,
        status: 'active' as const,
        revision: 1,
        received_on: '2026-09-02',
        warehouse_name: '主仓',
        reversal_reason: null,
        reversed_at: null,
        lines: [{
          id: 711,
          purchase_order_line_id: 901,
          inventory_item_id: 5,
          material_name: '伺服电机',
          material_model: 'MS1H2',
          unit: '台',
          quantity: '1.000',
          value_cents: 128900,
          movement_id: 41,
        }],
      }],
    })),
    getProcurementOverview: vi.fn(async () => live({
      project_code: 'SY-001', line_count: 2, line_status_counts: {},
      procurement_committed_cents: 1067000, procurement_received_cents: 128900,
      procurement_paid_cents: 0, material_consumed_cents: 0,
    })),
    createPurchaseOrder: vi.fn(async () => live(order)),
    receiveGoods: vi.fn(async () => live({
      id: 72, purchase_order_id: 91, received_on: '2026-09-03', warehouse_name: '主仓',
      notes: null, status: 'active' as const, revision: 1, lines: [], created_at: '', updated_at: '',
    })),
    reverseGoodsReceipt: vi.fn(async () => live({
      id: 71, purchase_order_id: 91, received_on: '2026-09-02', warehouse_name: '主仓',
      notes: null, status: 'reversed' as const, reversal_reason: '到货数量录错',
      reversed_at: '2026-09-03T10:00:00+08:00', revision: 2, lines: [], created_at: '', updated_at: '',
    })),
    createQuoteExport: vi.fn(async (_projectCode, listId, input) => live({
      id: 51, project_code: 'SY-001', procurement_list_id: listId,
      customer_company_name: '汇川技术', created_at: '', download_url: '/download', ...input,
    })),
    downloadQuoteExport: vi.fn(async () => new Blob(['xlsx'])),
    downloadImportTemplate: vi.fn(async () => new Blob(['xlsx'])),
    previewProcurementImport: vi.fn(),
    confirmProcurementImport: vi.fn(),
    createProcurementList: vi.fn(),
    updateProcurementList: vi.fn(),
    createProcurementLine: vi.fn(),
    updateProcurementLine: vi.fn(),
    deleteProcurementLine: vi.fn(),
    confirmProcurementList: vi.fn(),
    copyProcurementListAsDraft: vi.fn(async () => live({
      ...list, id: 12, name: '正式采购清单（修订草稿）', status: 'draft' as const,
      revision: 1, confirmed_at: null,
    })),
    confirmPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn(),
    cancelPurchaseOrder: vi.fn(),
    createSupplierPayment: vi.fn(),
    createSupplierInvoice: vi.fn(),
    reverseSupplierPayment: vi.fn(),
    reverseSupplierInvoice: vi.fn(),
    discardCreateProcurementList: vi.fn(() => false),
    discardCreateProcurementLine: vi.fn(() => false),
    discardCreatePurchaseOrder: vi.fn(() => false),
    discardReceiveGoods: vi.fn(() => false),
    discardPreviewProcurementImport: vi.fn(() => false),
    discardConfirmProcurementImport: vi.fn(() => false),
    discardCopyProcurementListAsDraft: vi.fn(() => false),
    discardCancelPurchaseOrder: vi.fn(() => false),
    discardCreateSupplierPayment: vi.fn(() => false),
    discardCreateSupplierInvoice: vi.fn(() => false),
    discardReverseSupplierPayment: vi.fn(() => false),
    discardReverseSupplierInvoice: vi.fn(() => false),
    discardCreateQuoteExport: vi.fn(() => false),
  } as unknown as ProcurementHttpRepository
}

describe('库存修复', () => {
  it('切换 repository 后只接纳新仓储的库存列表，忽略旧仓储迟到结果', async () => {
    const oldResult = deferred<RepositoryResult<{
      items: typeof inventoryItem[]
      total: number
      page: number
      page_size: number
    }>>()
    const oldRepository = {
      listInventoryItems: vi.fn(() => oldResult.promise),
    } as unknown as InventoryHttpRepository
    const newItem = { ...inventoryItem, id: 6, name: '新仓储伺服驱动器' }
    const newRepository = {
      listInventoryItems: vi.fn(async () => live({ items: [newItem], total: 1, page: 1, page_size: 20 })),
    } as unknown as InventoryHttpRepository
    const wrapper = mountComponent(InventoryCenter, { repository: oldRepository })
    await Promise.resolve()

    await wrapper.setProps({ repository: newRepository })
    await settle()
    expect(wrapper.text()).toContain('新仓储伺服驱动器')

    oldResult.resolve(live({ items: [{ ...inventoryItem, name: '迟到的旧仓储电机' }], total: 1, page: 1, page_size: 20 }))
    await settle()

    expect(wrapper.text()).toContain('新仓储伺服驱动器')
    expect(wrapper.text()).not.toContain('迟到的旧仓储电机')
  })

  it('库存调整冲销确认期间切换 repository 会关闭确认且不向新仓储提交旧 adjustment', async () => {
    const movement = {
      id: 42,
      inventory_item_id: 5,
      project_id: null,
      procurement_line_id: null,
      movement_type: 'adjustment' as const,
      quantity_delta: '1.000',
      value_delta_cents: 128900,
      quantity_after: '3.500',
      value_after_cents: 451150,
      source_type: 'inventory_adjustment',
      source_id: 8,
      occurred_on: '2026-09-01',
      reason: '盘盈',
      created_at: '2026-09-01T08:00:00+08:00',
      adjustment_status: 'active' as const,
      adjustment_revision: 1,
    }
    const oldReverse = vi.fn()
    const newReverse = vi.fn()
    const oldRepository = {
      listInventoryItems: vi.fn(async () => live({ items: [inventoryItem], total: 1, page: 1, page_size: 20 })),
      getInventoryItem: vi.fn(async () => live({ ...inventoryItem, movements: [movement] })),
      listInventoryMovements: vi.fn(async () => live({ items: [movement], total: 1, page: 1, page_size: 20 })),
      reverseInventoryAdjustment: oldReverse,
    } as unknown as InventoryHttpRepository
    const newRepository = {
      listInventoryItems: vi.fn(async () => live({ items: [], total: 0, page: 1, page_size: 20 })),
      reverseInventoryAdjustment: newReverse,
    } as unknown as InventoryHttpRepository
    const confirmation = deferred<unknown>()
    vi.spyOn(ElMessageBox, 'confirm')
      .mockReturnValue(confirmation.promise as ReturnType<typeof ElMessageBox.confirm>)
    const close = vi.spyOn(ElMessageBox, 'close')
    const wrapper = mountComponent(InventoryCenter, { repository: oldRepository })
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-5"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-adjustment-reverse-open-42"]').trigger('click')
    await wrapper.get('[data-testid="inventory-adjustment-reverse-reason"]').setValue('盘盈录错')
    await wrapper.get('[data-testid="inventory-adjustment-reverse-submit"]').trigger('click')
    await Promise.resolve()

    await wrapper.setProps({ repository: newRepository })
    await settle()
    expect(close).toHaveBeenCalledTimes(1)

    confirmation.resolve('confirm')
    await settle()
    expect(oldReverse).not.toHaveBeenCalled()
    expect(newReverse).not.toHaveBeenCalled()
  })

  it('库存反向流水按真实来源区分到货冲销、领用冲销和未知冲销', async () => {
    const reversalMovement = (id: number, sourceType: string) => ({
      id,
      inventory_item_id: 5,
      project_id: null,
      procurement_line_id: null,
      movement_type: 'reversal' as const,
      quantity_delta: '1.000',
      value_delta_cents: 128900,
      quantity_after: '3.500',
      value_after_cents: 451150,
      source_type: sourceType,
      source_id: id,
      occurred_on: '2026-09-01',
      reason: '冲销测试',
      created_at: '2026-09-01T08:00:00+08:00',
    })
    const movements = [
      reversalMovement(41, 'goods_receipt_reversal'),
      reversalMovement(42, 'inventory_issue_reversal'),
      reversalMovement(43, 'legacy_reversal'),
    ]
    const repository = {
      listInventoryItems: vi.fn(async () => live({ items: [inventoryItem], total: 1, page: 1, page_size: 20 })),
      getInventoryItem: vi.fn(async () => live({ ...inventoryItem, movements })),
      listInventoryMovements: vi.fn(async () => live({ items: movements, total: 3, page: 1, page_size: 20 })),
    } as unknown as InventoryHttpRepository
    const wrapper = mountComponent(InventoryCenter, { repository })
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-5"]').trigger('click')
    await settle()

    const rows = wrapper.get('[data-testid="inventory-detail-drawer"]').findAll('.el-table__body tbody tr')
    expect(rows[0]?.text()).toContain('到货冲销')
    expect(rows[1]?.text()).toContain('领用冲销')
    expect(rows[2]?.text()).toContain('冲销')
    expect(rows[2]?.text()).not.toContain('领用冲销')
  })

  it('手工库存调整按原 adjustment 精确冲销并经过危险操作确认', async () => {
    const movement = {
      id: 42,
      inventory_item_id: 5,
      project_id: null,
      procurement_line_id: null,
      movement_type: 'adjustment',
      quantity_delta: '1.000',
      value_delta_cents: 128900,
      quantity_after: '3.500',
      value_after_cents: 451150,
      source_type: 'inventory_adjustment',
      source_id: 8,
      occurred_on: '2026-09-01',
      reason: '盘盈',
      created_at: '2026-09-01T08:00:00+08:00',
      adjustment_status: 'active',
      adjustment_revision: 1,
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.startsWith('/api/inventory/items?')) {
        return new Response(JSON.stringify({ items: [inventoryItem], total: 1, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items/5') {
        return new Response(JSON.stringify({ ...inventoryItem, movements: [movement] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items/5/movements?page=1&page_size=20') {
        return new Response(JSON.stringify({ items: [movement], total: 1, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/adjustments/8/reverse' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 8, status: 'reversed', revision: 2 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-5"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-adjustment-reverse-open-42"]').trigger('click')
    await wrapper.get('[data-testid="inventory-adjustment-reverse-reason"]').setValue('盘盈录错')
    await wrapper.get('[data-testid="inventory-adjustment-reverse-submit"]').trigger('click')
    await settle()

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('原调整记录 #8'),
      '确认冲销库存调整',
      expect.objectContaining({ type: 'warning', confirmButtonText: '确认冲销' }),
    )
    const call = fetchMock.mock.calls.find(([path]) => String(path) === '/api/inventory/adjustments/8/reverse')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ reason: '盘盈录错', expected_revision: 1 })
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('新增库存把单位放在主表单且必须明确填写', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/inventory/items?page=1&page_size=20&status=all') {
        return new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ...inventoryItem, unit: 'PCS' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-create-open"]').trigger('click')
    const unit = wrapper.getComponent('[data-testid="inventory-create-unit"]') as VueWrapper<any>
    expect(unit.props('modelValue')).toBe('')
    expect(unit.element.closest('.el-collapse')).toBeNull()
    await wrapper.get('[data-testid="inventory-create-name"]').setValue('接线端子')
    await wrapper.get('[data-testid="inventory-create-quantity"]').setValue('2.500')
    await wrapper.get('[data-testid="inventory-create-price"]').setValue('35.67')
    await wrapper.get('[data-testid="inventory-create-submit"]').trigger('click')
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === '/api/inventory/items' && init?.method === 'POST')).toBe(false)
    expect(wrapper.get('[data-testid="inventory-create-error"]').text()).toContain('单位')

    unit.vm.$emit('update:modelValue', 'PCS')
    await wrapper.get('[data-testid="inventory-create-submit"]').trigger('click')
    await settle()
    const createCall = fetchMock.mock.calls.find(([path, init]) => String(path) === '/api/inventory/items' && init?.method === 'POST')!
    expect(JSON.parse(String(createCall[1]?.body))).toMatchObject({ unit: 'PCS' })
  })

  it('正数库存调整要求填写本次成本价并按分提交', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.startsWith('/api/inventory/items?')) {
        return new Response(JSON.stringify({ items: [inventoryItem], total: 1, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/adjustments') {
        return new Response(JSON.stringify({ id: 8 }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-adjust-open-5"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-adjust-quantity"]').setValue('1.000')
    await wrapper.get('[data-testid="inventory-adjust-reason"]').setValue('现场退料')
    expect(wrapper.get('[data-testid="inventory-adjust-unit-cost"]').isVisible()).toBe(true)

    await wrapper.get('[data-testid="inventory-adjust-submit"]').trigger('click')
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === '/api/inventory/adjustments')).toHaveLength(0)
    expect(wrapper.get('[data-testid="inventory-adjust-error"]').text()).toContain('成本单价')

    await wrapper.get('[data-testid="inventory-adjust-unit-cost"]').setValue('1289.00')
    await wrapper.get('[data-testid="inventory-adjust-submit"]').trigger('click')
    await settle()
    const call = fetchMock.mock.calls.find(([path]) => String(path) === '/api/inventory/adjustments')!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      quantity_delta: '1.000',
      unit_cost_cents: 128900,
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('项目领用可一次选择多项库存并关联当前项目施工员', async () => {
    const secondItem = {
      ...inventoryItem,
      id: 6,
      name: '伺服驱动器',
      model: 'SV660',
      quantity: '8.000',
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.startsWith('/api/inventory/items?')) {
        return new Response(JSON.stringify({ items: [inventoryItem, secondItem], total: 2, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/projects?status=active') {
        return new Response(JSON.stringify([{
          id: 1, project_code: 'SY-001', company_id: 8, company_name: '汇川技术', name: '产线改造',
          description: null, status: 'active', archive_reason: null, archived_at: null,
          created_at: '', updated_at: '',
        }]), { headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/api/projects/SY-001/crew-assignments?page=1&page_size=200&status=all') {
        return new Response(JSON.stringify({ items: [{
          id: 9, project_code: 'SY-001', worker_id: 44, worker_name: '王师傅', worker_phone: '13800000000',
          role: '电工', scheduled_start_on: '2026-09-01', scheduled_end_on: null,
          pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'active', revision: 1,
          created_at: '', updated_at: '',
        }], total: 1, page: 1, page_size: 200 }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/api/projects/SY-001/inventory-issues' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 90 }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-issue-open-5"]').trigger('click')
    await settle()
    const issueDialog = wrapper.get('[data-testid="inventory-issue-dialog"]')
    const candidates = issueDialog.get('[data-testid="inventory-issue-candidates"]')
    expect(candidates.element.closest('.inventory-issue-scroll')).not.toBeNull()
    expect(issueDialog.get('.el-dialog__footer').find('[data-testid="inventory-issue-submit"]').exists()).toBe(true)
    expect(issueDialog.get('.el-dialog__body').find('[data-testid="inventory-issue-submit"]').exists()).toBe(false)
    const projectSelect = wrapper.getComponent('[data-testid="inventory-issue-project"]') as VueWrapper
    projectSelect.vm.$emit('update:modelValue', 'SY-001')
    projectSelect.vm.$emit('change', 'SY-001')
    await settle()
    await wrapper.get('[data-testid="inventory-issue-line-select-6"]').trigger('click')
    await wrapper.get('[data-testid="inventory-issue-quantity-5"]').setValue('1.000')
    await wrapper.get('[data-testid="inventory-issue-quantity-6"]').setValue('2.500')
    ;(wrapper.getComponent('[data-testid="inventory-issue-worker"]') as VueWrapper).vm.$emit('update:modelValue', 44)
    await wrapper.get('[data-testid="inventory-issue-submit"]').trigger('click')
    await settle()

    const call = fetchMock.mock.calls.find(([path]) => String(path) === '/api/projects/SY-001/inventory-issues')!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      worker_id: 44,
      lines: [
        { inventory_item_id: 5, procurement_line_id: null, quantity: '1.000' },
        { inventory_item_id: 6, procurement_line_id: null, quantity: '2.500' },
      ],
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('库存提交失败时在当前弹窗显示错误、保留输入并锁住关闭与重复提交', async () => {
    const createResponse = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/inventory/items?page=1&page_size=20&status=all') {
        return new Response(JSON.stringify({ items: [inventoryItem], total: 1, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items' && init?.method === 'POST') return createResponse.promise
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-create-open"]').trigger('click')
    await wrapper.get('[data-testid="inventory-create-name"]').setValue('接线端子')
    await wrapper.get('[data-testid="inventory-create-quantity"]').setValue('2.500')
    await wrapper.get('[data-testid="inventory-create-price"]').setValue('35.67')
    ;(wrapper.getComponent('[data-testid="inventory-create-unit"]') as VueWrapper).vm.$emit('update:modelValue', '件')
    await wrapper.get('[data-testid="inventory-create-submit"]').trigger('click')
    await wrapper.get('[data-testid="inventory-create-submit"]').trigger('click')

    const createCalls = fetchMock.mock.calls.filter(([path, init]) => (
      String(path) === '/api/inventory/items' && init?.method === 'POST'
    ))
    expect(createCalls).toHaveLength(1)
    const dialogComponent = wrapper.findAllComponents(ElDialog)
      .find((dialog) => dialog.props('title') === '新增库存')!
    expect(dialogComponent.props('closeOnClickModal')).toBe(false)
    expect(dialogComponent.props('closeOnPressEscape')).toBe(false)
    expect(dialogComponent.props('showClose')).toBe(false)
    await wrapper.get('[data-testid="inventory-create-cancel"]').trigger('click')
    expect(wrapper.get('[data-testid="inventory-create-dialog"]').isVisible()).toBe(true)

    createResponse.resolve(new Response(JSON.stringify({ detail: '库存编号重复' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))
    await settle()

    expect(wrapper.get('[data-testid="inventory-create-error"]').text()).toContain('库存编号重复')
    expect(wrapper.get('[data-testid="inventory-create-dialog"]').isVisible()).toBe(true)
    expect((wrapper.get('[data-testid="inventory-create-name"]').element as HTMLInputElement).value).toBe('接线端子')
  })

  it('项目领用可搜索全部库存且切换搜索时保留已选物料', async () => {
    const searchedItem = {
      ...inventoryItem,
      id: 206,
      name: '远程 IO 模块',
      model: 'GL10',
      quantity: '12.000',
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/inventory/items?page=1&page_size=20&status=all') {
        return new Response(JSON.stringify({ items: [inventoryItem], total: 206, page: 1, page_size: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items?page=1&page_size=200&status=in_stock') {
        return new Response(JSON.stringify({ items: [inventoryItem], total: 206, page: 1, page_size: 200 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/inventory/items?page=1&page_size=200&query=GL10&status=in_stock') {
        return new Response(JSON.stringify({ items: [searchedItem], total: 1, page: 1, page_size: 200 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path === '/api/projects?status=active') {
        return new Response(JSON.stringify([{
          id: 1, project_code: 'SY-001', company_id: 8, company_name: '汇川技术', name: '产线改造',
          description: null, status: 'active', archive_reason: null, archived_at: null,
          created_at: '', updated_at: '',
        }]), { headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/api/projects/SY-001/inventory-issues' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 91 }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ detail: `unexpected ${path}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-issue-open-5"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-issue-quantity-5"]').setValue('1.000')
    await wrapper.get('[data-testid="inventory-issue-search"]').setValue('GL10')
    await wrapper.get('[data-testid="inventory-issue-search-submit"]').trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="inventory-issue-line-select-5"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="inventory-issue-quantity-5"]').element).toHaveProperty('value', '1.000')
    await wrapper.get('[data-testid="inventory-issue-line-select-206"]').trigger('click')
    await wrapper.get('[data-testid="inventory-issue-quantity-206"]').setValue('2.000')
    ;(wrapper.getComponent('[data-testid="inventory-issue-project"]') as VueWrapper).vm.$emit('update:modelValue', 'SY-001')
    await wrapper.get('[data-testid="inventory-issue-submit"]').trigger('click')
    await settle()

    const call = fetchMock.mock.calls.find(([path]) => String(path) === '/api/projects/SY-001/inventory-issues')!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      lines: [
        { inventory_item_id: 5, procurement_line_id: null, quantity: '1.000' },
        { inventory_item_id: 206, procurement_line_id: null, quantity: '2.000' },
      ],
    })
  })
})

describe('采购修复', () => {
  it('确认清单前展示名称、行数、金额和不可编辑警告，确认后可复制为新草稿', async () => {
    const repository = procurementRepository()
    const draft = { ...procurementList(), status: 'draft' as const, confirmed_at: null }
    vi.mocked(repository.listProcurementLists).mockResolvedValue(live({
      items: [((({ lines: _lines, cost_total_cents: _cost, quoted_total_cents: _quote, ...summary }) => summary)(draft))],
      total: 1, page: 1, page_size: 100,
    }))
    vi.mocked(repository.getProcurementList).mockResolvedValue(live(draft))
    vi.mocked(repository.confirmProcurementList).mockResolvedValue(live({
      ...draft, status: 'confirmed' as const, confirmed_at: '2026-09-01T09:00:00+08:00', revision: 4,
    }))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProcurementWorkspace, { projectCode: 'SY-001', repository })
    await settle()

    await wrapper.get('[data-testid="procurement-list-confirm-11"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/正式采购清单.*2 行.*13,252\.00 元.*确认后不可再编辑/s),
      '确认采购清单',
      expect.objectContaining({ type: 'warning', confirmButtonText: '确认并锁定' }),
    )
    expect(repository.confirmProcurementList).toHaveBeenCalledWith('SY-001', 11, {
      expected_revision: 3,
    })

    await wrapper.unmount()
    wrappers.delete(wrapper)
    const confirmedRepository = procurementRepository()
    const confirmedWrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository: confirmedRepository,
    })
    await settle()
    await confirmedWrapper.get('[data-testid="procurement-list-copy-11"]').trigger('click')
    await settle()
    expect(confirmedRepository.copyProcurementListAsDraft).toHaveBeenCalledWith('SY-001', 11, {
      expected_revision: 3,
    })
    expect(confirmedWrapper.emitted('changed')).toHaveLength(1)
  })

  it('采购详情展示付款、发票和到货逐行事实，并可按原流水冲销', async () => {
    const repository = procurementRepository({ withOrder: true })
    vi.mocked(repository.getPurchaseOrder).mockResolvedValue(live({
      ...purchaseOrder(),
      paid_amount_cents: 10000,
      invoiced_amount_cents: 10000,
      received_amount_cents: 128900,
      supplier_payments: [{
        id: 81, purchase_order_id: 91, paid_on: '2026-09-02', amount_cents: 10000,
        payment_method: '银行转账', reference_no: 'PAY-001', notes: '首付款',
        allocations: [{ purchase_order_line_id: 901, amount_cents: 10000 }],
        status: 'active' as const, reversal_reason: null, reversed_at: null, revision: 4,
        created_at: '', updated_at: '',
      }],
      supplier_invoices: [{
        id: 82, purchase_order_id: 91, invoice_no: 'INV-001', invoiced_on: '2026-09-03',
        amount_cents: 10000, allocations: [{ purchase_order_line_id: 901, amount_cents: 10000 }],
        document_version_ids: [], status: 'active' as const, reversal_reason: null,
        reversed_at: null, revision: 2, created_at: '', updated_at: '',
      }],
      goods_receipts: [{
        id: 71, status: 'active' as const, revision: 1, received_on: '2026-09-02',
        warehouse_name: '主仓', reversal_reason: null, reversed_at: null,
        lines: [{
          id: 711, purchase_order_line_id: 901, inventory_item_id: 5,
          material_name: '伺服电机', material_model: 'MS1H2', unit: '台',
          quantity: '1.000', value_cents: 128900, movement_id: 41,
        }],
      }],
    }))
    vi.mocked(repository.reverseSupplierPayment).mockResolvedValue(live({} as never))
    vi.mocked(repository.reverseSupplierInvoice).mockResolvedValue(live({} as never))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProcurementWorkspace, { projectCode: 'SY-001', repository })
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="supplier-payment-record-81"]').text())
      .toContain('银行转账 · PAY-001 · 首付款')
    expect(wrapper.get('[data-testid="supplier-invoice-record-82"]').text())
      .toContain('INV-001 · 2026-09-03')
    expect(wrapper.get('[data-testid="goods-receipt-record-71"]').text())
      .toContain('伺服电机 MS1H2 · 1.000 台 · 主仓 · 有效')

    await wrapper.get('[data-testid="supplier-payment-reverse-open-81"]').trigger('click')
    await wrapper.get('[data-testid="supplier-fact-reverse-reason"]').setValue('重复付款')
    await wrapper.get('[data-testid="supplier-fact-reverse-submit"]').trigger('click')
    await settle()
    expect(repository.reverseSupplierPayment).toHaveBeenCalledWith('SY-001', 81, {
      reason: '重复付款', expected_revision: 4,
    })

    await wrapper.get('[data-testid="supplier-invoice-reverse-open-82"]').trigger('click')
    await wrapper.get('[data-testid="supplier-fact-reverse-reason"]').setValue('发票作废')
    await wrapper.get('[data-testid="supplier-fact-reverse-submit"]').trigger('click')
    await settle()
    expect(repository.reverseSupplierInvoice).toHaveBeenCalledWith('SY-001', 82, {
      reason: '发票作废', expected_revision: 2,
    })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('归档项目的采购页仅允许查看已有记录', async () => {
    const repository = procurementRepository({ withOrder: true })
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, readonly: true,
    })
    await settle()

    expect(wrapper.text()).toContain('项目已归档，仅供查看')
    expect(wrapper.find('[data-testid="procurement-list-create-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="procurement-import-upload"]').exists()).toBe(false)

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="purchase-order-drawer"]').exists()).toBe(true)
    expect(wrapper.find('.drawer-actions').exists()).toBe(false)
    expect(wrapper.find('[data-testid="goods-receipt-reverse-71"]').exists()).toBe(false)
  })

  it('采购页高频动作无需打开菜单即可直接执行', async () => {
    const repository = procurementRepository({ withOrder: true })
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    expect(wrapper.get('.workspace-actions').findAll('button').map((button) => button.text()))
      .toEqual(['新建采购清单', '新增物料', '下载标准采购模板', '生成客户报价单'])
    expect(wrapper.find('[data-testid="procurement-line-open"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="procurement-template-download"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="procurement-quote-action"]').exists()).toBe(true)

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    expect(wrapper.get('.drawer-actions').findAll('button').map((button) => button.text()))
      .toEqual(['登记到货', '登记付款', '登记发票', '取消采购单'])
    expect(wrapper.find('[data-testid="purchase-order-actions-menu"]').exists()).toBe(false)
  })

  it('新建采购单可勾选多个未完成物料并一次提交', async () => {
    const repository = procurementRepository()
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    expect(wrapper.find('[data-testid="purchase-order-line-select-102"]').exists()).toBe(true)
    await wrapper.get('[data-testid="purchase-order-line-select-102"]').trigger('click')
    await wrapper.get('[data-testid="purchase-order-number"]').setValue('PO-MULTI')
    ;(wrapper.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper).vm.$emit('update:modelValue', 8)
    await wrapper.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()

    expect(repository.createPurchaseOrder).toHaveBeenCalledWith('SY-001', expect.objectContaining({
      order_no: 'PO-MULTI',
      lines: [
        expect.objectContaining({ procurement_line_id: 101, quantity: '6.000', unit_cost_cents: 128900 }),
        expect.objectContaining({ procurement_line_id: 102, quantity: '3.000', unit_cost_cents: 98000 }),
      ],
    }))
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('新建采购单不默认第一家公司，必须明确选择供应商', async () => {
    const repository = procurementRepository()
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    await wrapper.get('[data-testid="purchase-order-create-101"]').trigger('click')
    const supplier = wrapper.getComponent('[data-testid="purchase-order-supplier"]') as VueWrapper<any>
    expect(supplier.props('modelValue')).toBeNull()
    await wrapper.get('[data-testid="purchase-order-number"]').setValue('PO-EXPLICIT')
    await wrapper.get('[data-testid="purchase-order-submit"]').trigger('click')
    expect(repository.createPurchaseOrder).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="purchase-order-error"]').text()).toContain('请选择供应商')

    supplier.vm.$emit('update:modelValue', 8)
    await wrapper.get('[data-testid="purchase-order-submit"]').trigger('click')
    await settle()
    expect(repository.createPurchaseOrder).toHaveBeenCalledWith(
      'SY-001',
      expect.objectContaining({ supplier_company_id: 8 }),
    )
  })

  it('到货数量默认 0 且可从到货历史冲销', async () => {
    const repository = procurementRepository({ withOrder: true })
    const wrapper = mountComponent(ProcurementWorkspace, { projectCode: 'SY-001', repository })
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-receipt-open"]').trigger('click')
    expect((wrapper.get('[data-testid="purchase-event-quantity-901"]').element as HTMLInputElement).value).toBe('0.000')
    expect((wrapper.get('[data-testid="purchase-event-quantity-902"]').element as HTMLInputElement).value).toBe('0.000')
    await wrapper.get('[data-testid="purchase-event-dialog"] .el-dialog__headerbtn').trigger('click')

    expect(wrapper.get('[data-testid="goods-receipt-history"]').text()).toContain('2026-09-02')
    await wrapper.get('[data-testid="goods-receipt-reverse-71"]').trigger('click')
    await wrapper.get('[data-testid="goods-receipt-reverse-reason"]').setValue('到货数量录错')
    await wrapper.get('[data-testid="goods-receipt-reverse-submit"]').trigger('click')
    await settle()

    expect(repository.reverseGoodsReceipt).toHaveBeenCalledWith('SY-001', 71, {
      reason: '到货数量录错', expected_revision: 1,
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('报价已生成但下载失败时仅重试下载', async () => {
    const repository = procurementRepository()
    vi.mocked(repository.downloadQuoteExport)
      .mockRejectedValueOnce(new Error('下载连接中断'))
      .mockResolvedValueOnce(new Blob(['xlsx']))
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:quote'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(() => undefined),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    await wrapper.get('[data-testid="procurement-quote-action"]').trigger('click')
    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-action-error"]').text()).toContain('下载连接中断')
    expect(wrapper.get('[data-testid="procurement-quote-pending"]').text())
      .toContain('正式采购清单 报价单')
    expect(wrapper.get('[data-testid="procurement-quote-title"]').attributes('disabled')).toBeDefined()
    expect((wrapper.get('[data-testid="procurement-quote-title"]').element as HTMLInputElement).value)
      .toBe('正式采购清单 报价单')

    await wrapper.get('[data-testid="procurement-quote-cancel"]').trigger('click')
    await wrapper.get('[data-testid="procurement-quote-action"]').trigger('click')
    expect((wrapper.get('[data-testid="procurement-quote-title"]').element as HTMLInputElement).value)
      .toBe('正式采购清单 报价单')
    expect((wrapper.getComponent('[data-testid="procurement-quote-list"]') as VueWrapper<any>).props('disabled')).toBe(true)

    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()
    expect(repository.createQuoteExport).toHaveBeenCalledTimes(1)
    expect(repository.downloadQuoteExport).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('报价待下载时翻到无已确认清单的分页仍可重试', async () => {
    const repository = procurementRepository()
    const confirmed = procurementList()
    const confirmedSummary = (({ lines: _lines, cost_total_cents: _cost, quoted_total_cents: _quote, ...rest }) => rest)(confirmed)
    const draft = { ...confirmed, id: 12, name: '第二页草稿', status: 'draft' as const, confirmed_at: null }
    const draftSummary = (({ lines: _lines, cost_total_cents: _cost, quoted_total_cents: _quote, ...rest }) => rest)(draft)
    vi.mocked(repository.listProcurementLists).mockImplementation(async (_projectCode, query) => (
      live({
        items: query?.page === 2 ? [draftSummary] : [confirmedSummary],
        total: 101,
        page: query?.page ?? 1,
        page_size: 100,
      })
    ))
    vi.mocked(repository.getProcurementList).mockImplementation(async (_projectCode, listId) => (
      live(listId === 12 ? draft : confirmed)
    ))
    vi.mocked(repository.downloadQuoteExport)
      .mockRejectedValueOnce(new Error('下载连接中断'))
      .mockResolvedValueOnce(new Blob(['xlsx']))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:quote') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    await wrapper.get('[data-testid="procurement-quote-action"]').trigger('click')
    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="procurement-quote-cancel"]').trigger('click')

    ;(wrapper.getComponent('[data-testid="procurement-list-pagination"]') as VueWrapper<any>)
      .vm.$emit('current-change', 2)
    await settle()
    expect(wrapper.text()).toContain('第二页草稿')

    const quoteAction = wrapper.get('[data-testid="procurement-quote-action"]')
    expect(quoteAction.attributes('disabled')).toBeUndefined()
    await quoteAction.trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="procurement-quote-dialog"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="procurement-quote-pending"]').text()).toContain('本次只重试下载')
    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()

    expect(repository.createQuoteExport).toHaveBeenCalledTimes(1)
    expect(repository.downloadQuoteExport).toHaveBeenCalledTimes(2)
  })

  it('客户报价单锁定项目绑定客户，不使用公司列表第一项', async () => {
    const repository = procurementRepository()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:quote') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountComponent(ProcurementWorkspace, {
      projectCode: 'SY-001', repository, customerCompany: { id: 3, name: '项目客户' },
    })
    await settle()

    await wrapper.get('[data-testid="procurement-quote-action"]').trigger('click')
    expect(wrapper.get('[data-testid="procurement-quote-customer"]').text()).toContain('项目客户')
    expect(wrapper.find('[data-testid="procurement-quote-customer-select"]').exists()).toBe(false)
    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()
    expect(repository.createQuoteExport).toHaveBeenCalledWith('SY-001', 11, expect.objectContaining({
      customer_company_id: 3,
    }))
  })
})
