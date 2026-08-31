import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createHttpInventoryRepository } from '../repositories/inventory.live'
import { createHttpProcurementRepository } from '../repositories/procurement.live'
import { createHttpProjectStageRepository } from '../repositories/project.live'
import { createHttpWorkforceRepository } from '../repositories/workforce.live'

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
}

function expectPlannedPost(init: RequestInit, body: unknown): void {
  const headers = init.headers as Record<string, string>
  expect(init.method).toBe('POST')
  expect(headers['Content-Type']).toBe('application/json')
  expect(headers['Idempotency-Key']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  expect(JSON.parse(String(init.body))).toEqual(body)
}

describe('真实 P0 Repository 契约', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('项目阶段严格使用冻结 URL，更新带 revision，状态迁移 POST 带 UUID 幂等键', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectStageRepository()

    await repository.listProjectStages('SY 2026/001')
    expect(lastRequest(fetchMock)).toEqual([
      '/api/projects/SY%202026%2F001/stages',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    ])

    const schedule = {
      planned_start_on: '2026-08-29',
      planned_end_on: null,
      notes: '现场确认',
      expected_revision: 3,
    }
    await repository.updateStageSchedule('SY-001', 'procurement', schedule)
    const [scheduleUrl, scheduleInit] = lastRequest(fetchMock)
    expect(scheduleUrl).toBe('/api/projects/SY-001/stages/procurement')
    expect(scheduleInit.method).toBe('PUT')
    expect(scheduleInit.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(scheduleInit.body))).toEqual(schedule)

    const transition = {
      to_status: 'in_progress' as const,
      occurred_at: '2026-08-29T08:00:00+08:00',
      reason: null,
      expected_revision: 4,
    }
    await repository.transitionStage('SY-001', 'procurement', transition)
    const [transitionUrl, transitionInit] = lastRequest(fetchMock)
    expect(transitionUrl).toBe('/api/projects/SY-001/stages/procurement/transition')
    expectPlannedPost(transitionInit, transition)
  })

  it('采购 Repository 覆盖模板、清单、清单行、采购单、到货与概览，不包含未实现动作', async () => {
    const workbook = new Blob(['xlsx'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    fetchMock.mockResolvedValueOnce(new Response(workbook))
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 2, page_size: 20 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProcurementRepository()

    await repository.listSupplierCompanies()
    expect(lastRequest(fetchMock)[0]).toBe('/api/companies')

    await expect(repository.downloadImportTemplate()).resolves.toBeInstanceOf(Blob)
    expect(lastRequest(fetchMock)[0]).toBe('/api/procurement/import-template.xlsx')

    await repository.listProcurementLists('SY/001', { page: 2, page_size: 20 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/procurement-lists?page=2&page_size=20')

    const listInput = { name: '控制柜采购', notes: null }
    await repository.createProcurementList('SY-001', listInput)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-lists')
    expectPlannedPost(lastRequest(fetchMock)[1], listInput)

    await repository.getProcurementList('SY-001', 7)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-lists/7')

    await repository.updateProcurementList('SY-001', 7, { ...listInput, expected_revision: 2 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-lists/7')
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')

    const lineInput = {
      sequence_no: 1,
      category: '电气',
      name: '变频器',
      specification: '11kW',
      brand: '汇川',
      model: null,
      quantity: '2.500',
      unit: '台',
      unit_cost_cents: 128800,
      quoted_unit_price_cents: 158800,
    }
    await repository.createProcurementLine('SY-001', 7, lineInput)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-lists/7/lines')
    expectPlannedPost(lastRequest(fetchMock)[1], lineInput)

    await repository.updateProcurementLine('SY-001', 7, 11, { ...lineInput, expected_revision: 3 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-lists/7/lines/11')
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await repository.deleteProcurementLine('SY-001', 7, 11)
    expect(lastRequest(fetchMock)).toEqual([
      '/api/projects/SY-001/procurement-lists/7/lines/11',
      expect.objectContaining({ credentials: 'same-origin', method: 'DELETE' }),
    ])

    await repository.confirmProcurementList('SY-001', 7, { expected_revision: 4 })
    expectPlannedPost(lastRequest(fetchMock)[1], { expected_revision: 4 })

    await repository.listPurchaseOrders('SY-001', { page: 1, page_size: 50, status: 'confirmed' })
    expect(lastRequest(fetchMock)[0]).toBe(
      '/api/projects/SY-001/purchase-orders?page=1&page_size=50&status=confirmed',
    )

    const orderInput = {
      order_no: 'PO-2026-001',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: '2026-09-05',
      lines: [{
        procurement_line_id: 11,
        quantity: '2.500',
        unit_cost_cents: 128800,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    }
    await repository.createPurchaseOrder('SY-001', orderInput)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/purchase-orders')
    expectPlannedPost(lastRequest(fetchMock)[1], orderInput)

    await repository.getPurchaseOrder('SY-001', 9)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/purchase-orders/9')
    await repository.confirmPurchaseOrder('SY-001', 9, { expected_revision: 1 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/purchase-orders/9/confirm')
    expectPlannedPost(lastRequest(fetchMock)[1], { expected_revision: 1 })

    const receiptInput = {
      received_on: '2026-08-29',
      warehouse_name: '主仓',
      lines: [{ purchase_order_line_id: 12, quantity: '1.250' }],
      notes: null,
    }
    await repository.receiveGoods('SY-001', 9, receiptInput)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/purchase-orders/9/goods-receipts')
    expectPlannedPost(lastRequest(fetchMock)[1], receiptInput)

    await repository.getProcurementOverview('SY-001')
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/procurement-overview')
    expect('recordSupplierPayment' in repository).toBe(false)
    expect('recordSupplierInvoice' in repository).toBe(false)
  })

  it('采购 POST 未知结果重试复用幂等键，明确放弃后才使用新键', async () => {
    const firstError = new TypeError('Failed to fetch')
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(jsonResponse({ id: 7 }))
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(jsonResponse({ id: 8 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProcurementRepository()
    const input = { name: '控制柜采购', notes: null }

    await expect(repository.createProcurementList('SY-001', input)).rejects.toThrow('无法连接本地服务')
    const firstKey = (lastRequest(fetchMock)[1].headers as Record<string, string>)['Idempotency-Key']
    await repository.createProcurementList('SY-001', input)
    const retryKey = (lastRequest(fetchMock)[1].headers as Record<string, string>)['Idempotency-Key']
    expect(retryKey).toBe(firstKey)

    await expect(repository.createProcurementList('SY-001', input)).rejects.toThrow('无法连接本地服务')
    const abandonedKey = (lastRequest(fetchMock)[1].headers as Record<string, string>)['Idempotency-Key']
    expect(repository.discardCreateProcurementList('SY-001', input)).toBe(true)
    await repository.createProcurementList('SY-001', input)
    const replacementKey = (lastRequest(fetchMock)[1].headers as Record<string, string>)['Idempotency-Key']
    expect(replacementKey).not.toBe(abandonedKey)
  })

  it('库存 Repository 保留金额分和十进制数量原值，并覆盖流水、调整和项目领用', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpInventoryRepository()

    await repository.listInventoryItems({ page: 3, page_size: 25, query: '变频 器', status: 'in_stock' })
    expect(lastRequest(fetchMock)[0]).toBe('/api/inventory/items?page=3&page_size=25&query=%E5%8F%98%E9%A2%91+%E5%99%A8&status=in_stock')

    const createInput = {
      brand: null,
      name: '接线端子',
      model: null,
      specification: '2.5mm²',
      unit: '盒',
      opening_quantity: '10.125',
      opening_unit_cost_cents: 3567,
      notes: null,
    }
    await repository.createInventoryItem(createInput)
    expectPlannedPost(lastRequest(fetchMock)[1], createInput)

    await repository.getInventoryItem(5)
    expect(lastRequest(fetchMock)[0]).toBe('/api/inventory/items/5')
    await repository.updateInventoryItem(5, {
      brand: null,
      name: '接线端子',
      model: null,
      specification: '2.5mm²',
      unit: '盒',
      notes: '更新',
      expected_revision: 6,
    })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')

    await repository.listInventoryMovements(5, { page: 2, page_size: 10 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/inventory/items/5/movements?page=2&page_size=10')

    const adjustment = {
      item_id: 5,
      quantity_delta: '-1.125',
      unit_cost_cents: null,
      reason: '盘亏',
      occurred_on: '2026-08-29',
    }
    await repository.createInventoryAdjustment(adjustment)
    expect(lastRequest(fetchMock)[0]).toBe('/api/inventory/adjustments')
    expectPlannedPost(lastRequest(fetchMock)[1], adjustment)

    const issue = {
      issued_on: '2026-08-29',
      worker_id: 2,
      lines: [{ inventory_item_id: 5, procurement_line_id: 11, quantity: '0.375' }],
      notes: null,
    }
    await repository.createProjectInventoryIssue('SY/001', issue)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/inventory-issues')
    expectPlannedPost(lastRequest(fetchMock)[1], issue)
  })

  it('人员 Repository 覆盖施工员、排单、上工查询与今日多人原子提交', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceRepository()

    await repository.listWorkers({ page: 1, page_size: 20, status: 'all', query: '张 工' })
    expect(lastRequest(fetchMock)[0]).toBe('/api/workers?page=1&page_size=20&status=all&query=%E5%BC%A0+%E5%B7%A5')

    const workerInput = { name: '张工', phone: '13800000000', notes: null }
    await repository.createWorker(workerInput)
    expectPlannedPost(lastRequest(fetchMock)[1], workerInput)
    await repository.getWorker(3)
    expect(lastRequest(fetchMock)[0]).toBe('/api/workers/3')
    await repository.updateWorker(3, { ...workerInput, expected_revision: 2 })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')
    await repository.deactivateWorker(3, {
      effective_on: '2026-08-29',
      reason: '离场',
      expected_revision: 3,
    })
    expect(lastRequest(fetchMock)[0]).toBe('/api/workers/3/deactivate')
    expectPlannedPost(lastRequest(fetchMock)[1], {
      effective_on: '2026-08-29', reason: '离场', expected_revision: 3,
    })

    const assignment = {
      worker_id: 3,
      role: '电工',
      scheduled_start_on: '2026-08-29',
      scheduled_end_on: null,
      pay_basis: 'daily' as const,
      rate_cents: 45000,
      notes: null,
    }
    await repository.listCrewAssignments('SY/001', { page: 1, page_size: 50, status: 'active' })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/crew-assignments?page=1&page_size=50&status=active')
    await repository.createCrewAssignment('SY-001', assignment)
    expectPlannedPost(lastRequest(fetchMock)[1], assignment)
    await repository.updateCrewAssignment('SY-001', 4, { ...assignment, expected_revision: 2 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/crew-assignments/4')
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')

    await repository.listLaborEntries('SY-001', {
      page: 1,
      page_size: 50,
      from: '2026-08-01',
      to: '2026-08-29',
      worker_id: 3,
    })
    expect(lastRequest(fetchMock)[0]).toBe(
      '/api/projects/SY-001/labor-entries?page=1&page_size=50&from=2026-08-01&to=2026-08-29&worker_id=3',
    )

    const batch = {
      work_date: '2026-08-29',
      entries: [{
        assignment_id: 4,
        attendance_status: 'present' as const,
        day_fraction: '1.000',
        work_minutes: null,
        work_summary: '控制柜接线',
        notes: null,
        expected_revision: null,
      }],
    }
    await repository.saveLaborEntriesBatch('SY-001', batch)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY-001/labor-entries/batch')
    expectPlannedPost(lastRequest(fetchMock)[1], batch)
  })

  it('真实接口失败直接透传结构化错误，绝不二次请求或回退 Mock', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      detail: 'Resource was modified',
      error_code: 'REVISION_CONFLICT',
      field_errors: { expected_revision: 'stale' },
      current_revision: 8,
    }, 409))
    vi.stubGlobal('fetch', fetchMock)

    const promise = createHttpProjectStageRepository().updateStageSchedule('SY-001', 'design', {
      planned_start_on: null,
      planned_end_on: null,
      notes: null,
      expected_revision: 7,
    })

    await expect(promise).rejects.toMatchObject({
      status: 409,
      errorCode: 'REVISION_CONFLICT',
      currentRevision: 8,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
