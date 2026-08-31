import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import InventoryCenter from '../components/inventory/InventoryCenter.vue'
import ProcurementWorkspace from '../components/procurement/ProcurementWorkspace.vue'
import { createHttpProcurementRepository } from '../repositories/procurement.live'

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const wrappers = new Set<VueWrapper>()

function mountWithElementPlus(component: object, props: Record<string, unknown> = {}): VueWrapper {
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

describe('采购扩展真实 Repository 契约', () => {
  it('Excel 预览使用 multipart 且未知结果重试复用同一幂等键', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ id: 31, rows: [], errors: [] }, 201))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProcurementRepository()
    const file = new File(['xlsx'], '采购清单.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    await expect(repository.previewProcurementImport('SY/001', file)).rejects.toThrow('无法连接本地服务')
    const [firstUrl, firstInit] = lastRequest(fetchMock)
    const firstKey = (firstInit.headers as Record<string, string>)['Idempotency-Key']
    expect(firstUrl).toBe('/api/projects/SY%2F001/procurement-imports/preview')
    expect(firstInit.method).toBe('POST')
    expect(firstInit.body).toBeInstanceOf(FormData)
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(Object.keys(firstInit.headers as Record<string, string>)).not.toContain('Content-Type')

    await repository.previewProcurementImport('SY/001', file)
    const [, retryInit] = lastRequest(fetchMock)
    expect((retryInit.headers as Record<string, string>)['Idempotency-Key']).toBe(firstKey)
  })

  it('覆盖导入确认、采购单修订取消、付款开票与隐藏成本报价单', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ id: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProcurementRepository()

    await repository.confirmProcurementImport('SY-001', 31, {
      list_name: '正式清单', expected_revision: 2,
    })
    const [confirmUrl, confirmInit] = lastRequest(fetchMock)
    expect(confirmUrl).toBe('/api/projects/SY-001/procurement-imports/31/confirm')
    expect(confirmInit.method).toBe('POST')
    expect((confirmInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    await repository.updatePurchaseOrder('SY-001', 9, {
      order_no: 'PO-002', supplier_company_id: 8, ordered_on: '2026-08-31',
      expected_delivery_on: null, lines: [], notes: null, document_version_ids: [],
      expected_revision: 3,
    })
    expect(lastRequest(fetchMock)).toEqual([
      '/api/projects/SY-001/purchase-orders/9',
      expect.objectContaining({ method: 'PUT' }),
    ])

    await repository.cancelPurchaseOrder('SY-001', 9, { reason: '需求取消', expected_revision: 4 })
    const [cancelUrl, cancelInit] = lastRequest(fetchMock)
    expect(cancelUrl).toBe('/api/projects/SY-001/purchase-orders/9/cancel')
    expect((cancelInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    await repository.createSupplierPayment('SY-001', 9, {
      paid_on: '2026-08-31', amount_cents: 10000, payment_method: '银行转账',
      reference_no: null, allocations: [{ purchase_order_line_id: 91, amount_cents: 10000 }], notes: null,
    })
    const [paymentUrl, paymentInit] = lastRequest(fetchMock)
    expect(paymentUrl).toBe('/api/projects/SY-001/purchase-orders/9/supplier-payments')
    expect((paymentInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    await repository.createSupplierInvoice('SY-001', 9, {
      invoice_no: 'INV-001', invoiced_on: '2026-08-31', amount_cents: 10000,
      allocations: [{ purchase_order_line_id: 91, amount_cents: 10000 }], document_version_ids: [],
    })
    const [invoiceUrl, invoiceInit] = lastRequest(fetchMock)
    expect(invoiceUrl).toBe('/api/projects/SY-001/purchase-orders/9/supplier-invoices')
    expect((invoiceInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    const quote = await repository.createQuoteExport('SY-001', 11, {
      title: '客户报价单', customer_company_id: 8, notes: null,
    })
    const [quoteUrl, quoteInit] = lastRequest(fetchMock)
    expect(quoteUrl).toBe('/api/projects/SY-001/procurement-lists/11/quote-exports')
    expect((quoteInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
    await repository.downloadQuoteExport('SY-001', quote.data.id)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/quote-exports/1/download')
  })
})

describe('库存中心真实接口', () => {
  it('按后端分页搜索并打开真实流水，明确禁用不存在的领用冲销', async () => {
    const item = {
      id: 5, brand: '汇川', name: '伺服电机', model: 'MS1H2', specification: '2kW', unit: '台',
      quantity: '3.500', average_unit_cost_cents: 128900, inventory_value_cents: 451150,
      notes: null, revision: 2, created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    }
    const movement = {
      id: 41, inventory_item_id: 5, project_id: 7, procurement_line_id: null,
      movement_type: 'project_issue', quantity_delta: '-1.000', value_delta_cents: -128900,
      quantity_after: '3.500', value_after_cents: 451150, source_type: 'inventory_issue',
      source_id: 19, occurred_on: '2026-08-31', reason: null, created_at: '2026-08-31T08:00:00+08:00',
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/inventory/items?')) {
        return jsonResponse({ items: [item], total: 1, page: 1, page_size: 20 })
      }
      if (url === '/api/inventory/items/5') return jsonResponse({ ...item, movements: [movement] })
      if (url === '/api/inventory/items/5/movements?page=1&page_size=20') {
        return jsonResponse({ items: [movement], total: 1, page: 1, page_size: 20 })
      }
      return jsonResponse({ detail: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountWithElementPlus(InventoryCenter)
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory/items?page=1&page_size=20&status=all',
      expect.objectContaining({ method: 'GET' }),
    )

    await wrapper.get('[data-testid="inventory-search"]').setValue('伺服')
    await wrapper.get('[data-testid="inventory-search-submit"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory/items?page=1&page_size=20&query=%E4%BC%BA%E6%9C%8D&status=all',
      expect.anything(),
    )

    await wrapper.get('[data-testid="inventory-detail-open-5"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledWith('/api/inventory/items/5', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory/items/5/movements?page=1&page_size=20',
      expect.anything(),
    )
    expect(wrapper.get('[data-testid="inventory-detail-drawer"]').text()).toContain('项目领用')
    expect(wrapper.get('[data-testid="inventory-reversal-unavailable"]').text()).toContain('后端暂未提供领用冲销')
    expect(wrapper.text()).not.toContain('演示数据')
  })

  it('新增、编辑、调整与项目领用均提交真实接口并携带 revision/幂等键', async () => {
    const item = {
      id: 5, brand: '汇川', name: '伺服电机', model: 'MS1H2', specification: '2kW', unit: '台',
      quantity: '3.500', average_unit_cost_cents: 128900, inventory_value_cents: 451150,
      notes: null, revision: 2, created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/inventory/items?')) return jsonResponse({ items: [item], total: 1, page: 1, page_size: 20 })
      if (url === '/api/inventory/items/5' && init?.method === 'PUT') return jsonResponse({ ...item, model: 'MS1H2-A', revision: 3 })
      if (url === '/api/inventory/items/5') return jsonResponse({ ...item, movements: [] })
      if (url.includes('/api/inventory/items/5/movements')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 })
      if (url === '/api/inventory/items' && init?.method === 'POST') return jsonResponse({ ...item, id: 6 }, 201)
      if (url === '/api/inventory/adjustments') return jsonResponse({ id: 8 }, 201)
      if (url === '/api/projects/SY-001/inventory-issues') return jsonResponse({ id: 9 }, 201)
      return jsonResponse({ detail: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountWithElementPlus(InventoryCenter)
    await settle()

    await wrapper.get('[data-testid="inventory-create-open"]').trigger('click')
    await wrapper.get('[data-testid="inventory-create-name"]').setValue('接线端子')
    await wrapper.get('[data-testid="inventory-create-quantity"]').setValue('2.500')
    await wrapper.get('[data-testid="inventory-create-price"]').setValue('35.67')
    await wrapper.get('[data-testid="inventory-create-submit"]').trigger('click')
    await settle()
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/inventory/items' && init?.method === 'POST')!
    expect(JSON.parse(String(createCall[1]?.body))).toMatchObject({
      name: '接线端子', opening_quantity: '2.500', opening_unit_cost_cents: 3567,
    })
    expect((createCall[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    await wrapper.get('[data-testid="inventory-detail-open-5"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-edit-open"]').trigger('click')
    await wrapper.get('[data-testid="inventory-edit-model"]').setValue('MS1H2-A')
    await wrapper.get('[data-testid="inventory-edit-submit"]').trigger('click')
    await settle()
    const updateCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/inventory/items/5' && init?.method === 'PUT')!
    expect(JSON.parse(String(updateCall[1]?.body))).toMatchObject({ model: 'MS1H2-A', expected_revision: 2 })

    const rowActions = wrapper.getComponent('[data-testid="inventory-row-actions-5"]') as VueWrapper
    rowActions.vm.$emit('command', 'adjust')
    await settle()
    const adjustDialog = wrapper.get('[data-testid="inventory-adjust-dialog"]')
    await adjustDialog.findAll('input')[0]!.setValue('-0.500')
    await adjustDialog.findAll('input')[1]!.setValue('盘亏')
    await adjustDialog.find('form').trigger('submit')
    await settle()
    const adjustCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/inventory/adjustments')!
    expect(JSON.parse(String(adjustCall[1]?.body))).toMatchObject({ item_id: 5, quantity_delta: '-0.500', reason: '盘亏' })
    expect((adjustCall[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    ;(wrapper.getComponent('[data-testid="inventory-row-actions-5"]') as VueWrapper).vm.$emit('command', 'issue')
    await settle()
    await wrapper.get('[data-testid="inventory-issue-project"]').setValue('SY-001')
    await wrapper.get('[data-testid="inventory-issue-quantity"]').setValue('1.000')
    await wrapper.get('[data-testid="inventory-issue-submit"]').trigger('click')
    await settle()
    const issueCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/projects/SY-001/inventory-issues')!
    expect(JSON.parse(String(issueCall[1]?.body))).toMatchObject({
      worker_id: null,
      lines: [{ inventory_item_id: 5, procurement_line_id: null, quantity: '1.000' }],
    })
    expect((issueCall[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
  })
})

describe('采购工作台扩展动作', () => {
  it('Excel 导入按钮启用并显示后端逐格校验错误', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url === '/api/companies') return jsonResponse([])
      if (url.includes('/procurement-lists?')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (url.includes('/purchase-orders?')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (url.endsWith('/procurement-overview')) {
        return jsonResponse({ project_code: 'SY-001', line_count: 0, line_status_counts: {}, procurement_committed_cents: 0, procurement_received_cents: 0, procurement_paid_cents: 0, material_consumed_cents: 0 })
      }
      if (url.endsWith('/procurement-imports/preview')) {
        return jsonResponse({
          id: 31, project_code: 'SY-001', filename: 'bad.xlsx', sha256: 'a'.repeat(64),
          status: 'preview', revision: 1, expires_at: '2026-09-01T08:00:00+08:00', confirmed_list_id: null,
          rows: [], errors: [{ row: 2, column: 7, field: 'quantity', message: '数量格式不正确' }],
          created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
        }, 201)
      }
      return jsonResponse({ detail: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountWithElementPlus(ProcurementWorkspace, { projectCode: 'SY-001' })
    await settle()

    const upload = wrapper.get('[data-testid="procurement-import-upload"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', {
      configurable: true,
      value: [new File(['bad'], 'bad.xlsx')],
    })
    await upload.trigger('change')
    await settle()

    expect(wrapper.get('[data-testid="procurement-import-errors"]').text())
      .toContain('第 2 行，第 7 列：数量格式不正确')
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/procurement-imports/preview')) as [string, RequestInit]
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
  })

  it('采购单编辑、付款、发票、取消和报价导出均由页面提交真实请求', async () => {
    const company = {
      id: 8, name: '客户兼供应商', taxpayer_id: null, registered_address: null, registered_phone: null,
      bank_name: null, bank_account: null, notes: null,
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    }
    const line = {
      id: 101, procurement_list_id: 11, sequence_no: 1, category: '电气', name: '伺服电机',
      specification: '2kW', brand: '汇川', model: 'MS1H2', quantity: '1.000', unit: '台',
      unit_cost_cents: 10000, quoted_unit_price_cents: 13000, inventory_item_id: null,
      cost_total_cents: 10000, quoted_total_cents: 13000, ordered_quantity: '1.000', ordered_amount_cents: 10000,
      paid_amount_cents: 0, received_quantity: '0.000', invoiced_amount_cents: 0, issued_quantity: '0.000',
      order_status: 'ordered', payment_status: 'unpaid', receipt_status: 'not_received',
      invoice_status: 'not_invoiced', usage_status: 'unused', revision: 1,
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    }
    const list = {
      id: 11, project_code: 'SY-001', name: '正式采购清单', notes: null, status: 'confirmed', revision: 2,
      line_count: 1, cost_total_cents: 10000, quoted_total_cents: 13000, lines: [line],
      confirmed_at: '2026-08-31T08:00:00+08:00', created_at: '2026-08-31T08:00:00+08:00',
      updated_at: '2026-08-31T08:00:00+08:00',
    }
    let orderStatus = 'draft'
    const order = () => ({
      id: 9, project_code: 'SY-001', order_no: 'PO-001', supplier_company_id: 8,
      supplier_company_name: company.name, ordered_on: '2026-08-31', expected_delivery_on: null,
      notes: null, document_version_ids: [], status: orderStatus, ordered_amount_cents: 10000,
      paid_amount_cents: 0, invoiced_amount_cents: 0, received_amount_cents: 0,
      supplier_payments: [], supplier_invoices: [], goods_receipts: [], revision: 3,
      lines: [{ id: 91, purchase_order_id: 9, procurement_line_id: 101, quantity: '1.000', received_quantity: '0.000', unit_cost_cents: 10000, line_amount_cents: 10000, overage_reason: null }],
      created_at: '2026-08-31T08:00:00+08:00', updated_at: '2026-08-31T08:00:00+08:00',
    })
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url === '/api/companies') return jsonResponse([company])
      if (url.includes('/procurement-lists?')) return jsonResponse({ items: [{ ...list, lines: undefined, cost_total_cents: undefined, quoted_total_cents: undefined }], total: 1, page: 1, page_size: 100 })
      if (url === '/api/projects/SY-001/procurement-lists/11') return jsonResponse(list)
      if (url.includes('/purchase-orders?')) return jsonResponse({ items: [order()], total: 1, page: 1, page_size: 100 })
      if (url === '/api/projects/SY-001/purchase-orders/9' && init?.method === 'PUT') return jsonResponse(order())
      if (url === '/api/projects/SY-001/purchase-orders/9') return jsonResponse(order())
      if (url.endsWith('/procurement-overview')) return jsonResponse({ project_code: 'SY-001', line_count: 1, line_status_counts: { ordered: 1 }, procurement_committed_cents: 10000, procurement_received_cents: 0, procurement_paid_cents: 0, material_consumed_cents: 0 })
      if (url.endsWith('/supplier-payments')) return jsonResponse({ id: 1 }, 201)
      if (url.endsWith('/supplier-invoices')) return jsonResponse({ id: 2 }, 201)
      if (url.endsWith('/cancel')) { orderStatus = 'cancelled'; return jsonResponse(order()) }
      if (url.endsWith('/quote-exports')) return jsonResponse({ id: 7, download_url: '/api/projects/SY-001/quote-exports/7/download' }, 201)
      if (url.endsWith('/quote-exports/7/download')) return new Response(new Blob(['quote']))
      return jsonResponse({ detail: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const createObjectUrl = vi.fn(() => 'blob:quote')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountWithElementPlus(ProcurementWorkspace, { projectCode: 'SY-001' })
    await settle()

    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-order-edit"]').trigger('click')
    await wrapper.get('[data-testid="purchase-order-edit-number"]').setValue('PO-002')
    await wrapper.get('[data-testid="purchase-order-edit-submit"]').trigger('click')
    await settle()
    const updateCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/purchase-orders/9') && init?.method === 'PUT')!
    expect(JSON.parse(String(updateCall[1]?.body))).toMatchObject({ order_no: 'PO-002', expected_revision: 3 })

    orderStatus = 'confirmed'
    await wrapper.get('[data-testid="purchase-order-detail-open"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="purchase-payment-open"]').trigger('click')
    await wrapper.get('[data-testid="purchase-payment-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-payment-submit"]').trigger('click')
    await settle()
    const paymentCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/supplier-payments'))!
    expect(JSON.parse(String(paymentCall[1]?.body))).toMatchObject({ amount_cents: 10000, allocations: [{ purchase_order_line_id: 91, amount_cents: 10000 }] })

    await wrapper.get('[data-testid="purchase-invoice-open"]').trigger('click')
    await wrapper.get('[data-testid="purchase-invoice-number"]').setValue('INV-001')
    await wrapper.get('[data-testid="purchase-invoice-amount"]').setValue('100.00')
    await wrapper.get('[data-testid="purchase-invoice-submit"]').trigger('click')
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/supplier-invoices'))).toBe(true)

    await wrapper.get('[data-testid="purchase-order-cancel-open"]').trigger('click')
    await wrapper.get('[data-testid="purchase-cancel-reason"]').setValue('需求取消')
    await wrapper.get('[data-testid="purchase-cancel-submit"]').trigger('click')
    await settle()
    const cancelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cancel'))!
    expect(JSON.parse(String(cancelCall[1]?.body))).toEqual({ reason: '需求取消', expected_revision: 3 })

    orderStatus = 'confirmed'
    await wrapper.get('[data-testid="procurement-quote-action"]').trigger('click')
    await wrapper.get('[data-testid="procurement-quote-submit"]').trigger('click')
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/procurement-lists/11/quote-exports'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/quote-exports/7/download'))).toBe(true)
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
  })
})
