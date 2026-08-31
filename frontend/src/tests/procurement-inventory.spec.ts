import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createDemoBusinessContext,
  resetDemoBusinessContext,
  useDemoBusinessContext,
} from '../repositories/demo-context'
import { MockProcurementRepository } from '../repositories/procurement'

async function createDraftOrder(
  repository: MockProcurementRepository,
  projectCode: string,
  orderNo: string,
  quantity = '1.000',
) {
  const workspace = await repository.getProjectWorkspace(projectCode)
  const procurementLine = workspace.data.procurement_lists[0]!.lines[0]!
  await repository.createPurchaseOrder(projectCode, {
    order_no: orderNo,
    supplier_company_id: 8,
    ordered_on: '2026-08-29',
    expected_delivery_on: null,
    lines: [{ procurement_line_id: procurementLine.id, quantity, unit_cost_cents: 100, overage_reason: null }],
    notes: null,
    document_version_ids: [],
  })
  return (await repository.getProjectWorkspace(projectCode)).data.purchase_orders[0]!
}

afterEach(() => {
  resetDemoBusinessContext()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MockProcurementRepository', () => {
  it('以演示数据返回采购清单、采购行和采购单且不请求后端', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new MockProcurementRepository()

    const result = await repository.getProjectWorkspace('SY-2026-001')

    expect(result.source).toBe('demo')
    expect(result.data.project_code).toBe('SY-2026-001')
    expect(result.data.procurement_lists[0]?.status).toBe('draft')
    expect(result.data.procurement_lists[0]?.lines[0]).toMatchObject({
      quantity: '12.500',
      unit_cost_cents: 128900,
      quoted_unit_price_cents: 158000,
      order_status: 'partial',
      payment_status: 'partial',
      receipt_status: 'partial',
      invoice_status: 'not_invoiced',
      usage_status: 'unused',
    })
    expect(result.data.purchase_orders[0]?.lines[0]?.quantity).toBe('8.000')
    expect(Number.isInteger(result.data.purchase_orders[0]?.lines[0]?.unit_cost_cents)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('只通过冻结动作确认或取消采购事实并保留 revision', async () => {
    const repository = new MockProcurementRepository()
    const before = await repository.getProjectWorkspace('SY-2026-001')
    const list = before.data.procurement_lists[0]!
    const order = await createDraftOrder(repository, 'SY-2026-001', 'PO-FREEZE')

    await repository.confirmProcurementList('SY-2026-001', list.id, list.revision)
    await repository.confirmPurchaseOrder('SY-2026-001', order.id, order.revision)
    const confirmed = await repository.getProjectWorkspace('SY-2026-001')

    expect(confirmed.data.procurement_lists[0]).toMatchObject({ status: 'confirmed', revision: list.revision + 1 })
    expect(confirmed.data.purchase_orders[0]).toMatchObject({ status: 'confirmed', revision: order.revision + 1 })

    const confirmedOrder = confirmed.data.purchase_orders[0]!
    await repository.cancelPurchaseOrder('SY-2026-001', confirmedOrder.id, {
      reason: '客户交期调整',
      expected_revision: confirmedOrder.revision,
    })
    expect((await repository.getProjectWorkspace('SY-2026-001')).data.purchase_orders[0]?.status).toBe('cancelled')
  })

  it('创建采购单整单校验采购行归属且失败时不写入', async () => {
    const repository = new MockProcurementRepository()
    const foreignWorkspace = await repository.getProjectWorkspace('SY-FOREIGN')
    const foreignList = foreignWorkspace.data.procurement_lists[0]!
    await repository.createProcurementLine('SY-FOREIGN', foreignList.id, {
      sequence_no: 2,
      category: '气动元件',
      name: '外项目气缸',
      specification: '32×50',
      brand: 'SMC',
      model: 'CDQ2B',
      quantity: '1.000',
      unit: '只',
      unit_cost_cents: 86500,
      quoted_unit_price_cents: 102000,
    })
    const foreignLines = (await repository.getProjectWorkspace('SY-FOREIGN'))
      .data.procurement_lists[0]!.lines
    const foreignLine = foreignLines[foreignLines.length - 1]!
    const before = await repository.getProjectWorkspace('SY-2026-001')

    await expect(repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-FOREIGN',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: foreignLine.id,
        quantity: '1.000',
        unit_cost_cents: 86500,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    })).rejects.toThrow('采购行不存在')

    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(before)
  })

  it('同单重复采购行按合计数量校验并派生下单状态', async () => {
    const repository = new MockProcurementRepository()
    await repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-2026-019',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [
        { procurement_line_id: 101, quantity: '2.500', unit_cost_cents: 128900, overage_reason: null },
        { procurement_line_id: 101, quantity: '2.000', unit_cost_cents: 128900, overage_reason: null },
      ],
      notes: null,
      document_version_ids: [],
    })
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.lines[0]?.order_status).toBe('ordered')

    const beforeOverage = await repository.getProjectWorkspace('SY-2026-001')
    await expect(repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-OVERAGE-REJECTED',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [
        { procurement_line_id: 101, quantity: '0.500', unit_cost_cents: 128900, overage_reason: null },
        { procurement_line_id: 101, quantity: '0.500', unit_cost_cents: 128900, overage_reason: null },
      ],
      notes: null,
      document_version_ids: [],
    })).rejects.toThrow('超采必须填写原因')
    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(beforeOverage)

    await repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-OVERAGE',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [
        { procurement_line_id: 101, quantity: '0.500', unit_cost_cents: 128900, overage_reason: '现场备用' },
        { procurement_line_id: 101, quantity: '0.500', unit_cost_cents: 128900, overage_reason: '调试备用' },
      ],
      notes: null,
      document_version_ids: [],
    })
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.lines[0]?.order_status).toBe('over_ordered')
  })

  it('取消采购单后按剩余未取消订单回退采购行下单状态', async () => {
    const repository = new MockProcurementRepository()
    await repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-2026-019',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{ procurement_line_id: 101, quantity: '4.500', unit_cost_cents: 128900, overage_reason: null }],
      notes: null,
      document_version_ids: [],
    })
    let workspace = await repository.getProjectWorkspace('SY-2026-001')
    expect(workspace.data.procurement_lists[0]?.lines[0]?.order_status).toBe('ordered')
    const createdOrder = workspace.data.purchase_orders[0]!

    await repository.cancelPurchaseOrder('SY-2026-001', createdOrder.id, {
      reason: '需求撤回',
      expected_revision: createdOrder.revision,
    })
    workspace = await repository.getProjectWorkspace('SY-2026-001')
    expect(workspace.data.procurement_lists[0]?.lines[0]?.order_status).toBe('partial')
  })

  it('新增采购行只接收冻结核心字段并保持数量字符串', async () => {
    const repository = new MockProcurementRepository()
    const before = await repository.getProjectWorkspace('SY-2026-001')
    const list = before.data.procurement_lists[0]!

    await repository.createProcurementLine('SY-2026-001', list.id, {
      sequence_no: 2,
      category: '气动元件',
      name: '气缸',
      specification: '32×50',
      brand: 'SMC',
      model: 'CDQ2B',
      quantity: '2.500',
      unit: '只',
      unit_cost_cents: 86500,
      quoted_unit_price_cents: 102000,
    })

    const lines = (await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]!.lines
    const created = lines[lines.length - 1]!
    expect(created).toMatchObject({
      name: '气缸',
      quantity: '2.500',
      order_status: 'not_ordered',
      payment_status: 'unpaid',
      receipt_status: 'not_received',
      invoice_status: 'not_invoiced',
      usage_status: 'unused',
    })
  })

  it('新增采购行拒绝非正数数量和非法金额，空清单不能确认', async () => {
    const repository = new MockProcurementRepository()
    await repository.createProcurementList('SY-BOUNDARY', { name: '空清单', notes: null })
    const emptyList = (await repository.getProjectWorkspace('SY-BOUNDARY')).data.procurement_lists[0]!
    await expect(repository.confirmProcurementList('SY-BOUNDARY', emptyList.id, emptyList.revision))
      .rejects.toThrow('至少需要一条明细')

    const before = await repository.getProjectWorkspace('SY-BOUNDARY')
    const baseInput = {
      sequence_no: 1,
      category: '测试',
      name: '越界物料',
      specification: '',
      brand: '',
      model: '',
      quantity: '1.000',
      unit: '件',
      unit_cost_cents: 1,
      quoted_unit_price_cents: 1,
    }
    await expect(repository.createProcurementLine('SY-BOUNDARY', emptyList.id, {
      ...baseInput,
      quantity: '0.000',
    })).rejects.toThrow('采购数量必须大于零')
    await expect(repository.createProcurementLine('SY-BOUNDARY', emptyList.id, {
      ...baseInput,
      quantity: '-1.000',
    })).rejects.toThrow('采购数量必须大于零')
    await expect(repository.createProcurementLine('SY-BOUNDARY', emptyList.id, {
      ...baseInput,
      unit_cost_cents: -1,
    })).rejects.toThrow('金额超出可保存范围')
    expect(await repository.getProjectWorkspace('SY-BOUNDARY')).toEqual(before)
  })

  it('采购单事件只允许合法状态，且有业务事实后不能取消', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-STATE')
    const procurementLine = workspace.data.procurement_lists[0]!.lines[0]!
    await repository.createPurchaseOrder('SY-STATE', {
      order_no: 'PO-STATE',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{ procurement_line_id: procurementLine.id, quantity: '1.000', unit_cost_cents: 100, overage_reason: null }],
      notes: null,
      document_version_ids: [],
    })
    let order = (await repository.getProjectWorkspace('SY-STATE')).data.purchase_orders[0]!
    const payment = {
      paid_on: '2026-08-29',
      amount_cents: 100,
      payment_method: 'bank_transfer',
      reference_no: null,
      allocations: [{ purchase_order_line_id: order.lines[0]!.id, amount_cents: 100 }],
      notes: null,
    }
    await expect(repository.recordSupplierPayment('SY-STATE', order.id, payment)).rejects.toThrow('当前采购单状态不允许付款')
    await expect(repository.recordGoodsReceipt('SY-STATE', order.id, {
      received_on: '2026-08-29', warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '1.000' }], notes: null,
    })).rejects.toThrow('只有已确认或部分到货')

    await repository.confirmPurchaseOrder('SY-STATE', order.id, order.revision)
    order = (await repository.getProjectWorkspace('SY-STATE')).data.purchase_orders[0]!
    await repository.recordSupplierPayment('SY-STATE', order.id, payment)
    await expect(repository.cancelPurchaseOrder('SY-STATE', order.id, {
      reason: '不应取消', expected_revision: order.revision,
    })).rejects.toThrow('已有到货、付款或开票记录')
    await expect(repository.confirmPurchaseOrder('SY-STATE', order.id, order.revision))
      .rejects.toThrow('只有草稿采购单')
  })

  it('库存数量始终保持十进制字符串，金额保持整数分', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new MockProcurementRepository()

    await repository.createInventoryItem({
      brand: 'SMC',
      name: '气缸',
      model: 'CDQ2B',
      specification: '32×50',
      unit: '只',
      opening_quantity: '2.500',
      opening_unit_cost_cents: 86500,
      notes: null,
    })
    const created = (await repository.getInventory()).data.items.find((item) => item.name === '气缸')!

    expect(created.quantity).toBe('2.500')
    expect(created.average_unit_cost_cents).toBe(86500)
    expect(Number.isInteger(created.inventory_value_cents)).toBe(true)

    await repository.adjustInventory({
      item_id: created.id,
      quantity_delta: '-0.500',
      unit_cost_cents: null,
      reason: '盘亏复核',
      occurred_on: '2026-08-28',
    })
    const adjusted = (await repository.getInventory()).data.items.find((item) => item.id === created.id)!
    expect(adjusted.quantity).toBe('2.000')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('多行项目领用在任一行库存不足时不产生部分扣减', async () => {
    const repository = new MockProcurementRepository()
    const initialItem = (await repository.getInventory()).data.items[0]!
    await repository.createInventoryItem({
      brand: 'SMC',
      name: '气缸',
      model: 'CDQ2B',
      specification: '32×50',
      unit: '只',
      opening_quantity: '1.000',
      opening_unit_cost_cents: 86500,
      notes: null,
    })
    const secondItem = (await repository.getInventory()).data.items.find((item) => item.name === '气缸')!

    await expect(repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-28',
      worker_id: 9,
      lines: [
        { inventory_item_id: initialItem.id, procurement_line_id: 101, quantity: '1.000' },
        { inventory_item_id: secondItem.id, procurement_line_id: null, quantity: '2.000' },
      ],
      notes: null,
    })).rejects.toThrow('库存不得为负数')

    const after = (await repository.getInventory()).data.items
    expect(after.find((item) => item.id === initialItem.id)?.quantity).toBe('4.500')
    expect(after.find((item) => item.id === secondItem.id)?.quantity).toBe('1.000')
  })

  it('共享上下文复用同一采购与施工仓储，reset 后得到全新演示状态', async () => {
    const first = useDemoBusinessContext()
    expect(useDemoBusinessContext()).toBe(first)
    expect(createDemoBusinessContext().procurement).not.toBe(first.procurement)

    await first.procurement.adjustInventory({
      item_id: 301,
      quantity_delta: '-1.000',
      unit_cost_cents: null,
      reason: '上下文隔离验证',
      occurred_on: '2026-08-29',
    })
    expect((await useDemoBusinessContext().procurement.getInventory()).data.items[0]?.quantity).toBe('3.500')

    const reset = resetDemoBusinessContext()
    expect(reset).not.toBe(first)
    expect((await reset.procurement.getInventory()).data.items[0]?.quantity).toBe('4.500')
  })

  it('采购到货原子增加库存并同步采购行和采购单到货状态', async () => {
    const repository = new MockProcurementRepository()
    const before = await repository.getProjectWorkspace('SY-2026-001')
    const order = before.data.purchase_orders[0]!

    await repository.recordGoodsReceipt('SY-2026-001', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '3.500' }],
      notes: null,
    })

    const inventory = await repository.getInventory()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    expect(inventory.data.items.find((item) => item.id === 301)).toMatchObject({
      quantity: '8.000',
      inventory_value_cents: 1031200,
    })
    expect(workspace.data.purchase_orders[0]).toMatchObject({ status: 'received', revision: order.revision + 1 })
    expect(workspace.data.procurement_lists[0]?.lines[0]?.receipt_status).toBe('received')
  })

  it('到货加权平均只用于展示，库存价值保留精确累计金额', async () => {
    const repository = new MockProcurementRepository()
    await repository.createInventoryItem({
      brand: 'TEST',
      name: '加权物料',
      model: 'W-1',
      specification: '测试',
      unit: '件',
      opening_quantity: '1.000',
      opening_unit_cost_cents: 1,
      notes: null,
    })
    const workspace = await repository.getProjectWorkspace('SY-WEIGHTED')
    const list = workspace.data.procurement_lists[0]!
    await repository.createProcurementLine('SY-WEIGHTED', list.id, {
      sequence_no: 2,
      category: '测试',
      name: '加权物料',
      specification: '测试',
      brand: 'TEST',
      model: 'W-1',
      quantity: '1.000',
      unit: '件',
      unit_cost_cents: 2,
      quoted_unit_price_cents: 2,
    })
    const lines = (await repository.getProjectWorkspace('SY-WEIGHTED')).data.procurement_lists[0]!.lines
    const procurementLine = lines[lines.length - 1]!
    await repository.createPurchaseOrder('SY-WEIGHTED', {
      order_no: 'PO-WEIGHTED',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{ procurement_line_id: procurementLine.id, quantity: '1.000', unit_cost_cents: 2, overage_reason: null }],
      notes: null,
      document_version_ids: [],
    })
    const order = (await repository.getProjectWorkspace('SY-WEIGHTED')).data.purchase_orders[0]!
    await repository.confirmPurchaseOrder('SY-WEIGHTED', order.id, order.revision)
    await repository.recordGoodsReceipt('SY-WEIGHTED', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '1.000' }],
      notes: null,
    })

    const item = (await repository.getInventory()).data.items.find((candidate) => candidate.name === '加权物料')!
    expect(item.quantity).toBe('2.000')
    expect(item.inventory_value_cents).toBe(3)
  })

  it('舍入平均价不改写库存精确价值，领用后冲销完全回到原金额', async () => {
    const repository = new MockProcurementRepository()
    await repository.createInventoryItem({
      brand: 'ROUND', name: '舍入物料', model: 'R-1', specification: '', unit: '件',
      opening_quantity: '2.000', opening_unit_cost_cents: 1, notes: null,
    })
    const item = (await repository.getInventory()).data.items.find((candidate) => candidate.name === '舍入物料')!
    await repository.adjustInventory({
      item_id: item.id, quantity_delta: '1.000', unit_cost_cents: 2,
      reason: '盘盈', occurred_on: '2026-08-29',
    })
    const beforeIssue = (await repository.getInventory()).data.items.find((candidate) => candidate.id === item.id)!
    expect(beforeIssue).toMatchObject({ quantity: '3.000', inventory_value_cents: 4 })

    await repository.issueInventory('SY-ROUND', {
      issued_on: '2026-08-30', worker_id: 101,
      lines: [{ inventory_item_id: item.id, procurement_line_id: null, quantity: '1.000' }], notes: null,
    })
    const issued = await repository.getInventory()
    const issueMovement = issued.data.movements.find((movement) => movement.inventory_item_id === item.id && movement.kind === 'issue')!
    await repository.reverseInventoryIssue(issueMovement.id, { reversed_on: '2026-08-31', reason: '测试冲销' })

    const reversed = (await repository.getInventory()).data.items.find((candidate) => candidate.id === item.id)!
    expect(reversed).toMatchObject({ quantity: '3.000', inventory_value_cents: 4 })
  })

  it('同次到货的重复采购单行先合并校验再一次写入', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    const list = workspace.data.procurement_lists[0]!
    await repository.createProcurementLine('SY-2026-001', list.id, {
      sequence_no: 2,
      category: '气动元件',
      name: '气缸',
      specification: '32×50',
      brand: 'SMC',
      model: 'CDQ2B',
      quantity: '3.500',
      unit: '只',
      unit_cost_cents: 86500,
      quoted_unit_price_cents: 102000,
    })
    const procurementLines = (await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]!.lines
    const procurementLine = procurementLines[procurementLines.length - 1]!
    await repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-2026-019',
      supplier_company_id: 9,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: procurementLine.id,
        quantity: '3.500',
        unit_cost_cents: 86500,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    })
    const order = (await repository.getProjectWorkspace('SY-2026-001')).data.purchase_orders[0]!
    await repository.confirmPurchaseOrder('SY-2026-001', order.id, order.revision)

    await repository.recordGoodsReceipt('SY-2026-001', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [
        { purchase_order_line_id: order.lines[0]!.id, quantity: '1.500' },
        { purchase_order_line_id: order.lines[0]!.id, quantity: '2.000' },
      ],
      notes: null,
    })

    expect((await repository.getInventory()).data.items.find((item) => item.name === '气缸')?.quantity).toBe('3.500')
    expect((await repository.getProjectWorkspace('SY-2026-001')).data.purchase_orders[0]?.status).toBe('received')
  })

  it('项目领用可按库存来源映射采购行并同步使用状态', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    const order = workspace.data.purchase_orders[0]!
    await repository.recordGoodsReceipt('SY-2026-001', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '3.500' }],
      notes: null,
    })

    await repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-29',
      worker_id: 101,
      lines: [{ inventory_item_id: 301, procurement_line_id: null, quantity: '1.000' }],
      notes: null,
    })

    expect((await repository.getInventory()).data.items.find((item) => item.id === 301)?.quantity).toBe('7.000')
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.lines[0]?.usage_status).toBe('partial')
  })

  it('显式采购来源必须属于当前项目和当前库存物料', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    const list = workspace.data.procurement_lists[0]!
    await repository.createProcurementLine('SY-2026-001', list.id, {
      sequence_no: 2,
      category: '气动元件',
      name: '气缸',
      specification: '32×50',
      brand: 'SMC',
      model: 'CDQ2B',
      quantity: '1.000',
      unit: '只',
      unit_cost_cents: 86500,
      quoted_unit_price_cents: 102000,
    })
    const lines = (await repository.getProjectWorkspace('SY-2026-001')).data.procurement_lists[0]!.lines
    const unrelatedLine = lines[lines.length - 1]!
    const beforeInventory = await repository.getInventory()
    const beforeWorkspace = await repository.getProjectWorkspace('SY-2026-001')

    await expect(repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-29',
      worker_id: 101,
      lines: [{ inventory_item_id: 301, procurement_line_id: unrelatedLine.id, quantity: '1.000' }],
      notes: null,
    })).rejects.toThrow('采购来源与库存物料不匹配')
    expect(await repository.getInventory()).toEqual(beforeInventory)
    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(beforeWorkspace)
  })

  it('显式采购来源超出累计到货量时整批拒绝且状态不变', async () => {
    const repository = new MockProcurementRepository()
    await repository.getProjectWorkspace('SY-2026-001')
    await repository.adjustInventory({
      item_id: 301,
      quantity_delta: '2.000',
      unit_cost_cents: null,
      reason: '无来源期初盘盈',
      occurred_on: '2026-08-29',
    })
    const beforeInventory = await repository.getInventory()
    const beforeWorkspace = await repository.getProjectWorkspace('SY-2026-001')

    await expect(repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-29',
      worker_id: 101,
      lines: [{ inventory_item_id: 301, procurement_line_id: 101, quantity: '5.000' }],
      notes: null,
    })).rejects.toThrow('领用归集数量不能超过该采购行累计到货量')
    expect(await repository.getInventory()).toEqual(beforeInventory)
    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(beforeWorkspace)
  })

  it('同规格库存的采购来源按项目隔离，不跨项目回写使用状态', async () => {
    const repository = new MockProcurementRepository()
    await repository.getProjectWorkspace('SY-PROJECT-A')
    await repository.getProjectWorkspace('SY-PROJECT-B')

    await repository.issueInventory('SY-PROJECT-B', {
      issued_on: '2026-08-29',
      worker_id: 101,
      lines: [{ inventory_item_id: 301, procurement_line_id: null, quantity: '1.000' }],
      notes: null,
    })

    expect((await repository.getProjectWorkspace('SY-PROJECT-A'))
      .data.procurement_lists[0]?.lines[0]?.usage_status).toBe('unused')
    expect((await repository.getProjectWorkspace('SY-PROJECT-B'))
      .data.procurement_lists[0]?.lines[0]?.usage_status).toBe('partial')
  })

  it('无采购行输入时按当前项目库存来源 FIFO 分配可用到货量', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    const list = workspace.data.procurement_lists[0]!
    await repository.createProcurementLine('SY-2026-001', list.id, {
      sequence_no: 2,
      category: '驱动与控制',
      name: '伺服电机',
      specification: '1.5 kW',
      brand: '汇川',
      model: 'MS1H2',
      quantity: '2.000',
      unit: '台',
      unit_cost_cents: 128900,
      quoted_unit_price_cents: 158000,
    })
    const lines = (await repository.getProjectWorkspace('SY-2026-001')).data.procurement_lists[0]!.lines
    const secondLine = lines[lines.length - 1]!
    await repository.createPurchaseOrder('SY-2026-001', {
      order_no: 'PO-SECOND-SOURCE',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{ procurement_line_id: secondLine.id, quantity: '2.000', unit_cost_cents: 128900, overage_reason: null }],
      notes: null,
      document_version_ids: [],
    })
    const order = (await repository.getProjectWorkspace('SY-2026-001')).data.purchase_orders[0]!
    await repository.confirmPurchaseOrder('SY-2026-001', order.id, order.revision)
    await repository.recordGoodsReceipt('SY-2026-001', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '2.000' }],
      notes: null,
    })

    await repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-29',
      worker_id: 101,
      lines: [{ inventory_item_id: 301, procurement_line_id: null, quantity: '5.000' }],
      notes: null,
    })

    const after = await repository.getProjectWorkspace('SY-2026-001')
    expect(after.data.procurement_lists[0]?.lines.find((line) => line.id === 101)?.usage_status).toBe('used')
    expect(after.data.procurement_lists[0]?.lines.find((line) => line.id === secondLine.id)?.usage_status).toBe('partial')
  })

  it('供应商付款和发票累计后同步采购行业务状态', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-2026-001')
    const order = workspace.data.purchase_orders[0]!
    const orderLine = order.lines[0]!
    const orderAmount = 8 * orderLine.unit_cost_cents

    await repository.recordSupplierPayment('SY-2026-001', order.id, {
      paid_on: '2026-08-29',
      amount_cents: orderAmount,
      payment_method: 'bank_transfer',
      reference_no: null,
      allocations: [{ purchase_order_line_id: orderLine.id, amount_cents: orderAmount }],
      notes: null,
    })
    await repository.recordSupplierInvoice('SY-2026-001', order.id, {
      invoice_no: 'INV-2026-001',
      invoiced_on: '2026-08-29',
      amount_cents: orderAmount,
      allocations: [{ purchase_order_line_id: orderLine.id, amount_cents: orderAmount }],
      document_version_ids: [],
    })

    const line = (await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]!.lines[0]!
    expect(line.payment_status).toBe('paid')
    expect(line.invoice_status).toBe('invoiced')
  })

  it('库存金额越界时新增与调整均原子拒绝且状态不变', async () => {
    const repository = new MockProcurementRepository()
    const before = await repository.getInventory()

    await expect(repository.createInventoryItem({
      brand: '',
      name: '超额库存',
      model: '',
      specification: '',
      unit: '件',
      opening_quantity: '9007199254740.992',
      opening_unit_cost_cents: 1000,
      notes: null,
    })).rejects.toThrow('库存价值超出可保存范围')
    expect(await repository.getInventory()).toEqual(before)

    await expect(repository.adjustInventory({
      item_id: 301,
      quantity_delta: '9007199254740.992',
      unit_cost_cents: null,
      reason: '越界调整',
      occurred_on: '2026-08-29',
    })).rejects.toThrow('库存价值超出可保存范围')
    expect(await repository.getInventory()).toEqual(before)
  })

  it('到货金额越界时采购单和库存均保持原状', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-LARGE')
    await repository.createPurchaseOrder('SY-LARGE', {
      order_no: 'PO-LARGE',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: 101,
        quantity: '9007199254740.992',
        unit_cost_cents: Number.MAX_SAFE_INTEGER,
        overage_reason: '金额安全测试',
      }],
      notes: null,
      document_version_ids: [],
    })
    const beforeWorkspace = await repository.getProjectWorkspace('SY-LARGE')
    const beforeInventory = await repository.getInventory()
    const order = beforeWorkspace.data.purchase_orders[0]!
    await repository.confirmPurchaseOrder('SY-LARGE', order.id, order.revision)
    const confirmedWorkspace = await repository.getProjectWorkspace('SY-LARGE')

    await expect(repository.recordGoodsReceipt('SY-LARGE', order.id, {
      received_on: '2026-08-29',
      warehouse_name: '主仓库',
      lines: [{ purchase_order_line_id: order.lines[0]!.id, quantity: '1.000' }],
      notes: null,
    })).rejects.toThrow('库存价值超出可保存范围')

    expect(await repository.getProjectWorkspace('SY-LARGE')).toEqual(confirmedWorkspace)
    expect(await repository.getInventory()).toEqual(beforeInventory)
  })

  it('采购清单确认与采购行编辑使用 revision 并保持失败原子性', async () => {
    const repository = new MockProcurementRepository()
    const before = await repository.getProjectWorkspace('SY-2026-001')
    const list = before.data.procurement_lists[0]!
    const line = list.lines[0]!

    await repository.updateProcurementLine('SY-2026-001', list.id, line.id, line.revision, {
      sequence_no: line.sequence_no,
      category: line.category,
      name: line.name,
      specification: line.specification,
      brand: line.brand,
      model: line.model,
      quantity: '13.000',
      unit: line.unit,
      unit_cost_cents: line.unit_cost_cents,
      quoted_unit_price_cents: 160000,
    })

    const edited = await repository.getProjectWorkspace('SY-2026-001')
    expect(edited.data.procurement_lists[0]?.lines[0]).toMatchObject({
      quantity: '13.000',
      quoted_unit_price_cents: 160000,
      revision: line.revision + 1,
      order_status: 'partial',
    })
    const editedList = edited.data.procurement_lists[0]!
    const snapshot = await repository.getProjectWorkspace('SY-2026-001')
    await expect(repository.updateProcurementLine(
      'SY-2026-001',
      editedList.id,
      editedList.lines[0]!.id,
      line.revision,
      { ...editedList.lines[0]!, quantity: '99.000' },
    )).rejects.toThrow('REVISION_CONFLICT')
    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(snapshot)

    await repository.confirmProcurementList('SY-2026-001', editedList.id, editedList.revision)
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.status).toBe('confirmed')
    const confirmed = await repository.getProjectWorkspace('SY-2026-001')
    const confirmedLine = confirmed.data.procurement_lists[0]!.lines[0]!
    await expect(repository.updateProcurementLine(
      'SY-2026-001',
      editedList.id,
      confirmedLine.id,
      confirmedLine.revision,
      { ...confirmedLine, quantity: '14.000' },
    )).rejects.toThrow('已确认采购清单不能编辑')
    expect(await repository.getProjectWorkspace('SY-2026-001')).toEqual(confirmed)
  })

  it('草稿采购单可原子编辑并保留订单身份', async () => {
    const repository = new MockProcurementRepository()
    const workspace = await repository.getProjectWorkspace('SY-ORDER-EDIT')
    await repository.createPurchaseOrder('SY-ORDER-EDIT', {
      order_no: 'PO-EDIT-001',
      supplier_company_id: 8,
      ordered_on: '2026-08-29',
      expected_delivery_on: null,
      lines: [{
        procurement_line_id: 101,
        quantity: '4.000',
        unit_cost_cents: 128900,
        overage_reason: null,
      }],
      notes: null,
      document_version_ids: [],
    })
    const created = (await repository.getProjectWorkspace('SY-ORDER-EDIT')).data.purchase_orders[0]!

    await repository.updatePurchaseOrder('SY-ORDER-EDIT', created.id, created.revision, {
      order_no: 'PO-EDIT-002',
      supplier_company_id: 9,
      ordered_on: '2026-08-30',
      expected_delivery_on: '2026-09-15',
      lines: [{
        procurement_line_id: workspace.data.procurement_lists[0]!.lines[0]!.id,
        quantity: '4.500',
        unit_cost_cents: 127500,
        overage_reason: null,
      }],
      notes: '供应商改为分批交货',
      document_version_ids: [],
    })

    const edited = (await repository.getProjectWorkspace('SY-ORDER-EDIT')).data.purchase_orders[0]!
    expect(edited).toMatchObject({
      id: created.id,
      order_no: 'PO-EDIT-002',
      supplier_company_id: 9,
      revision: created.revision + 1,
    })
    expect(edited.lines[0]).toMatchObject({ quantity: '4.500', unit_cost_cents: 127500 })

    const snapshot = await repository.getProjectWorkspace('SY-ORDER-EDIT')
    await expect(repository.updatePurchaseOrder(
      'SY-ORDER-EDIT',
      edited.id,
      created.revision,
      { ...edited, order_no: 'PO-STALE' },
    )).rejects.toThrow('REVISION_CONFLICT')
    expect(await repository.getProjectWorkspace('SY-ORDER-EDIT')).toEqual(snapshot)
  })

  it('库存元数据编辑不改数量，领用冲销追加反向流水并回退使用状态', async () => {
    const repository = new MockProcurementRepository()
    await repository.getProjectWorkspace('SY-2026-001')
    const initialInventory = await repository.getInventory()
    const item = initialInventory.data.items.find((candidate) => candidate.id === 301)!

    await repository.updateInventoryItem(item.id, item.revision, {
      brand: item.brand,
      name: item.name,
      model: 'MS1H2-A',
      specification: item.specification,
      unit: item.unit,
    })
    await repository.adjustInventory({
      item_id: item.id,
      quantity_delta: '0.500',
      unit_cost_cents: null,
      reason: '盘盈复核',
      occurred_on: '2026-08-29',
    })
    await repository.issueInventory('SY-2026-001', {
      issued_on: '2026-08-30',
      worker_id: 101,
      lines: [{ inventory_item_id: item.id, procurement_line_id: 101, quantity: '1.000' }],
      notes: '现场安装',
    })

    const issued = await repository.getInventory()
    const issueMovement = issued.data.movements.find((movement) => movement.kind === 'issue')!
    expect(issued.data.items.find((candidate) => candidate.id === item.id)).toMatchObject({
      model: 'MS1H2-A',
      quantity: '4.000',
    })
    expect(issued.data.movements.filter((movement) => movement.inventory_item_id === item.id)
      .map((movement) => movement.kind)).toEqual(expect.arrayContaining(['adjustment', 'issue']))
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.lines[0]?.usage_status).toBe('partial')

    await repository.reverseInventoryIssue(issueMovement.id, {
      reversed_on: '2026-08-31',
      reason: '领用单录错项目',
    })
    const reversed = await repository.getInventory()
    expect(reversed.data.items.find((candidate) => candidate.id === item.id)?.quantity).toBe('5.000')
    expect(reversed.data.movements.find((movement) => movement.id === issueMovement.id)).toEqual(issueMovement)
    expect(reversed.data.movements).toContainEqual(expect.objectContaining({
      kind: 'issue_reversal',
      reversal_of_movement_id: issueMovement.id,
      quantity_delta: '1.000',
      reason: '领用单录错项目',
    }))
    expect((await repository.getProjectWorkspace('SY-2026-001'))
      .data.procurement_lists[0]?.lines[0]?.usage_status).toBe('unused')

    const beforeRepeat = await repository.getInventory()
    await expect(repository.reverseInventoryIssue(issueMovement.id, {
      reversed_on: '2026-09-01',
      reason: '重复冲销',
    })).rejects.toThrow('该领用记录已经冲销')
    expect(await repository.getInventory()).toEqual(beforeRepeat)
  })
})
