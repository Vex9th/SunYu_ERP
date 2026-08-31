import type {
  GoodsReceiptInput,
  InventoryAdjustmentInput,
  InventoryIssueInput,
  InventoryIssueReversalInput,
  InventoryItem,
  InventoryItemCreateInput,
  InventoryItemUpdateInput,
  InventoryMovement,
  InventorySnapshot,
  ProcurementLineInput,
  ProcurementList,
  ProcurementListInput,
  ProjectProcurementWorkspace,
  PurchaseOrder,
  PurchaseOrderCancelInput,
  PurchaseOrderInput,
  SupplierInvoiceInput,
  SupplierPaymentInput,
} from '../domain/procurement'
import type { DataSource, RepositoryResult } from './common'

export interface ProcurementRepository {
  readonly source: DataSource
  getProjectWorkspace(projectCode: string): Promise<RepositoryResult<ProjectProcurementWorkspace>>
  createProcurementList(projectCode: string, input: ProcurementListInput): Promise<void>
  createProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): Promise<void>
  updateProcurementLine(
    projectCode: string,
    listId: number,
    lineId: number,
    expectedRevision: number,
    input: ProcurementLineInput,
  ): Promise<void>
  confirmProcurementList(projectCode: string, listId: number, expectedRevision: number): Promise<void>
  createPurchaseOrder(projectCode: string, input: PurchaseOrderInput): Promise<void>
  updatePurchaseOrder(
    projectCode: string,
    orderId: number,
    expectedRevision: number,
    input: PurchaseOrderInput,
  ): Promise<void>
  confirmPurchaseOrder(projectCode: string, orderId: number, expectedRevision: number): Promise<void>
  cancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): Promise<void>
  recordSupplierPayment(projectCode: string, orderId: number, input: SupplierPaymentInput): Promise<void>
  recordGoodsReceipt(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<void>
  recordSupplierInvoice(projectCode: string, orderId: number, input: SupplierInvoiceInput): Promise<void>
  getInventory(): Promise<RepositoryResult<InventorySnapshot>>
  createInventoryItem(input: InventoryItemCreateInput): Promise<void>
  updateInventoryItem(itemId: number, expectedRevision: number, input: InventoryItemUpdateInput): Promise<void>
  adjustInventory(input: InventoryAdjustmentInput): Promise<void>
  issueInventory(projectCode: string, input: InventoryIssueInput): Promise<void>
  reverseInventoryIssue(movementId: number, input: InventoryIssueReversalInput): Promise<void>
}

export class MockProcurementRepository implements ProcurementRepository {
  readonly source = 'demo' as const
  private readonly workspaces = new Map<string, ProjectProcurementWorkspace>()
  private readonly inventory: InventoryItem[] = initialInventory()
  private readonly receivedQuantityMilli = new Map<string, bigint>()
  private readonly paidAmountCents = new Map<string, bigint>()
  private readonly invoicedAmountCents = new Map<string, bigint>()
  private readonly usedQuantityMilli = new Map<string, bigint>()
  private readonly inventoryOrigins = new Map<string, Set<number>>()
  private readonly inventoryMovements: InventoryMovement[] = initialInventoryMovements()
  private readonly issueUsageAllocations = new Map<number, Map<string, bigint>>()
  private nextId = 1000

  async getProjectWorkspace(projectCode: string): Promise<RepositoryResult<ProjectProcurementWorkspace>> {
    return { source: this.source, data: clone(this.workspace(projectCode)) }
  }

  async createProcurementList(projectCode: string, input: ProcurementListInput): Promise<void> {
    this.workspace(projectCode).procurement_lists.unshift({
      id: this.nextId++,
      name: input.name,
      notes: input.notes,
      status: 'draft',
      revision: 1,
      lines: [],
    })
  }

  async createProcurementLine(
    projectCode: string,
    listId: number,
    input: ProcurementLineInput,
  ): Promise<void> {
    validateProcurementLineInput(input)
    const list = required(this.workspace(projectCode).procurement_lists, listId, '采购清单')
    if (list.status !== 'draft') throw new Error('已确认采购清单不能编辑')
    list.lines.push({
      ...clone(input),
      id: this.nextId++,
      revision: 1,
      order_status: 'not_ordered',
      payment_status: 'unpaid',
      receipt_status: 'not_received',
      invoice_status: 'not_invoiced',
      usage_status: 'unused',
    })
    list.revision += 1
  }

  async updateProcurementLine(
    projectCode: string,
    listId: number,
    lineId: number,
    expectedRevision: number,
    input: ProcurementLineInput,
  ): Promise<void> {
    const workspace = this.workspace(projectCode)
    const list = required(workspace.procurement_lists, listId, '采购清单')
    const line = required(list.lines, lineId, '采购行')
    assertRevision(line.revision, expectedRevision)
    if (list.status !== 'draft') throw new Error('已确认采购清单不能编辑')
    validateProcurementLineInput(input)
    if (line.receipt_status !== 'not_received' && inventorySignature(line) !== inventorySignature(input)) {
      throw new Error('已有到货记录的采购行不能修改物料身份字段')
    }
    Object.assign(line, clone(input))
    line.revision += 1
    list.revision += 1
    this.updateOrderStatuses(projectCode)
  }

  async confirmProcurementList(projectCode: string, listId: number, expectedRevision: number): Promise<void> {
    const list = required(this.workspace(projectCode).procurement_lists, listId, '采购清单')
    assertRevision(list.revision, expectedRevision)
    if (list.status !== 'draft') throw new Error('只有草稿采购清单可以确认')
    if (list.lines.length === 0) throw new Error('采购清单至少需要一条明细')
    list.status = 'confirmed'
    list.revision += 1
  }

  async createPurchaseOrder(projectCode: string, input: PurchaseOrderInput): Promise<void> {
    const workspace = this.workspace(projectCode)
    validatePurchaseOrderInput(workspace, input)

    let stagedNextId = this.nextId
    const order: PurchaseOrder = {
      ...clone(input),
      id: stagedNextId++,
      status: 'draft',
      revision: 1,
      lines: input.lines.map((line) => ({ ...line, id: stagedNextId++ })),
    }
    workspace.purchase_orders.unshift(order)
    this.nextId = stagedNextId
    this.updateOrderStatuses(projectCode)
  }

  async updatePurchaseOrder(
    projectCode: string,
    orderId: number,
    expectedRevision: number,
    input: PurchaseOrderInput,
  ): Promise<void> {
    const workspace = this.workspace(projectCode)
    const order = required(workspace.purchase_orders, orderId, '采购单')
    assertRevision(order.revision, expectedRevision)
    if (order.status !== 'draft') throw new Error('只有草稿采购单可以编辑')
    validatePurchaseOrderInput(workspace, input, order.id)

    for (const [index, oldLine] of order.lines.entries()) {
      const nextLine = input.lines[index]
      const received = this.receivedQuantityMilli.get(orderLineKey(projectCode, oldLine.id)) ?? 0n
      const paid = this.paidAmountCents.get(orderLineKey(projectCode, oldLine.id)) ?? 0n
      const invoiced = this.invoicedAmountCents.get(orderLineKey(projectCode, oldLine.id)) ?? 0n
      if (received <= 0n && paid <= 0n && invoiced <= 0n) continue
      if (!nextLine || nextLine.procurement_line_id !== oldLine.procurement_line_id) {
        throw new Error('已有业务记录的采购单行不能删除或更换物料')
      }
      if (received > decimalToMilli(nextLine.quantity)) throw new Error('采购数量不能小于累计到货量')
      const nextAmount = orderLineAmountCents({ ...nextLine, id: oldLine.id })
      if (paid > nextAmount || invoiced > nextAmount) throw new Error('采购金额不能小于累计付款或开票金额')
    }

    let stagedNextId = this.nextId
    const stagedLines = input.lines.map((line, index) => {
      const oldLine = order.lines[index]
      return { ...clone(line), id: oldLine?.procurement_line_id === line.procurement_line_id ? oldLine.id : stagedNextId++ }
    })
    Object.assign(order, clone(input), { lines: stagedLines })
    order.revision += 1
    this.nextId = stagedNextId
    this.updateOrderStatuses(projectCode)
  }

  async confirmPurchaseOrder(projectCode: string, orderId: number, expectedRevision: number): Promise<void> {
    const order = required(this.workspace(projectCode).purchase_orders, orderId, '采购单')
    assertRevision(order.revision, expectedRevision)
    if (order.status !== 'draft') throw new Error('只有草稿采购单可以确认')
    order.status = 'confirmed'
    order.revision += 1
  }

  async cancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): Promise<void> {
    const order = required(this.workspace(projectCode).purchase_orders, orderId, '采购单')
    assertRevision(order.revision, input.expected_revision)
    if (!input.reason.trim()) throw new Error('取消原因不能为空')
    if (order.status !== 'draft' && order.status !== 'confirmed') throw new Error('当前采购单状态不允许取消')
    if (this.orderHasBusinessFacts(projectCode, order)) throw new Error('已有到货、付款或开票记录的采购单不能取消')
    order.status = 'cancelled'
    order.revision += 1
    this.updateOrderStatuses(projectCode)
  }

  async recordSupplierPayment(
    projectCode: string,
    orderId: number,
    input: SupplierPaymentInput,
  ): Promise<void> {
    const order = this.requireOrder(projectCode, orderId)
    assertOrderAllowsBusinessEntry(order, '付款')
    const updates = validateMoneyAllocations(
      projectCode,
      order,
      input.amount_cents,
      input.allocations,
      this.paidAmountCents,
    )
    for (const [key, value] of updates) this.paidAmountCents.set(key, value)
    this.updateMoneyStatuses(projectCode, 'payment')
  }

  async recordGoodsReceipt(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<void> {
    const workspace = this.workspace(projectCode)
    const order = this.requireOrder(projectCode, orderId)
    if (order.status !== 'confirmed' && order.status !== 'partially_received') {
      throw new Error('只有已确认或部分到货的采购单可以登记到货')
    }
    if (input.lines.length === 0) throw new Error('到货明细不能为空')

    const receiptUpdates = new Map<string, bigint>()
    const inventoryUpdates = new Map<number, InventoryItem>()
    const newInventory: InventoryItem[] = []
    const newMovements: InventoryMovement[] = []
    const originUpdates = new Map<string, Set<number>>()
    let stagedNextId = this.nextId

    for (const lineInput of input.lines) {
      const orderLine = required(order.lines, lineInput.purchase_order_line_id, '采购单行')
      const quantityMilli = decimalToMilli(lineInput.quantity)
      if (quantityMilli <= 0n) throw new Error('到货数量必须大于零')
      const receiptKey = orderLineKey(projectCode, orderLine.id)
      const received = receiptUpdates.get(receiptKey)
        ?? this.receivedQuantityMilli.get(receiptKey)
        ?? 0n
      const ordered = decimalToMilli(orderLine.quantity)
      const nextReceived = received + quantityMilli
      if (nextReceived > ordered) throw new Error('到货数量不能超过采购数量')
      receiptUpdates.set(receiptKey, nextReceived)

      const procurementLine = findProcurementLine(workspace, orderLine.procurement_line_id)
      const signature = inventorySignature(procurementLine)
      const existing = [...inventoryUpdates.values(), ...newInventory, ...this.inventory]
        .find((item) => inventorySignature(item) === signature)
      const persistedInventory = existing
        ? this.inventory.some((item) => item.id === existing.id)
        : false
      const staged = existing
        ? inventoryUpdates.get(existing.id) ?? newInventory.find((item) => item.id === existing.id) ?? clone(existing)
        : {
            id: stagedNextId++,
            brand: procurementLine.brand,
            name: procurementLine.name,
            model: procurementLine.model,
            specification: procurementLine.specification,
            unit: procurementLine.unit,
            quantity: '0.000',
            average_unit_cost_cents: orderLine.unit_cost_cents,
            inventory_value_cents: 0,
            revision: 0,
          }
      const currentQuantity = decimalToMilli(staged.quantity)
      const additionValue = inventoryValueCents(quantityMilli, orderLine.unit_cost_cents)
      const totalValue = safeMoneyBigInt(BigInt(staged.inventory_value_cents) + BigInt(additionValue))
      const nextQuantity = currentQuantity + quantityMilli
      const averageCost = safeMoneyBigInt(roundPositive(totalValue * 1000n, nextQuantity))
      staged.quantity = milliToDecimal(nextQuantity)
      staged.average_unit_cost_cents = Number(averageCost)
      staged.inventory_value_cents = Number(totalValue)
      staged.revision += 1
      if (persistedInventory) inventoryUpdates.set(staged.id, staged)
      else if (!newInventory.some((item) => item.id === staged.id)) newInventory.push(staged)

      const originKey = inventoryOriginKey(projectCode, staged.id)
      const origins = originUpdates.get(originKey)
        ?? new Set(this.inventoryOrigins.get(originKey) ?? [])
      origins.add(procurementLine.id)
      originUpdates.set(originKey, origins)
      newMovements.push({
        id: stagedNextId++,
        inventory_item_id: staged.id,
        kind: 'receipt',
        quantity_delta: milliToDecimal(quantityMilli),
        value_delta_cents: additionValue,
        occurred_on: input.received_on,
        project_code: projectCode,
        worker_id: null,
        reason: '采购到货',
        notes: input.notes,
        reversal_of_movement_id: null,
      })
    }

    for (const [key, value] of receiptUpdates) this.receivedQuantityMilli.set(key, value)
    for (const [itemId, value] of inventoryUpdates) {
      const target = required(this.inventory, itemId, '库存物品')
      Object.assign(target, value)
    }
    this.inventory.unshift(...newInventory)
    this.inventoryMovements.unshift(...newMovements.reverse())
    for (const [key, value] of originUpdates) this.inventoryOrigins.set(key, value)
    this.nextId = stagedNextId
    order.status = order.lines.every((line) => (
      (this.receivedQuantityMilli.get(orderLineKey(projectCode, line.id)) ?? 0n) >= decimalToMilli(line.quantity)
    )) ? 'received' : 'partially_received'
    order.revision += 1
    this.updateReceiptStatuses(projectCode)
  }

  async recordSupplierInvoice(
    projectCode: string,
    orderId: number,
    input: SupplierInvoiceInput,
  ): Promise<void> {
    const order = this.requireOrder(projectCode, orderId)
    assertOrderAllowsBusinessEntry(order, '开票')
    const updates = validateMoneyAllocations(
      projectCode,
      order,
      input.amount_cents,
      input.allocations,
      this.invoicedAmountCents,
    )
    for (const [key, value] of updates) this.invoicedAmountCents.set(key, value)
    this.updateMoneyStatuses(projectCode, 'invoice')
  }

  async getInventory(): Promise<RepositoryResult<InventorySnapshot>> {
    return {
      source: this.source,
      data: { items: clone(this.inventory), movements: clone(this.inventoryMovements) },
    }
  }

  async createInventoryItem(input: InventoryItemCreateInput): Promise<void> {
    const quantityMilli = decimalToMilli(input.opening_quantity)
    if (quantityMilli < 0n) throw new Error('期初数量不能为负数')
    if (quantityMilli > 0n && input.opening_unit_cost_cents === null) {
      throw new Error('有期初数量时必须填写期初单位成本')
    }
    const unitCost = input.opening_unit_cost_cents ?? 0
    assertMoneyCents(unitCost)
    const inventoryValue = inventoryValueCents(quantityMilli, unitCost)
    const itemId = this.nextId++
    this.inventory.unshift({
      id: itemId,
      brand: input.brand,
      name: input.name,
      model: input.model,
      specification: input.specification,
      unit: input.unit,
      quantity: milliToDecimal(quantityMilli),
      average_unit_cost_cents: unitCost,
      inventory_value_cents: inventoryValue,
      revision: 1,
    })
    if (quantityMilli > 0n) {
      this.inventoryMovements.unshift({
        id: this.nextId++,
        inventory_item_id: itemId,
        kind: 'opening',
        quantity_delta: milliToDecimal(quantityMilli),
        value_delta_cents: inventoryValue,
        occurred_on: localISODate(),
        project_code: null,
        worker_id: null,
        reason: '期初库存',
        notes: input.notes,
        reversal_of_movement_id: null,
      })
    }
  }

  async updateInventoryItem(
    itemId: number,
    expectedRevision: number,
    input: InventoryItemUpdateInput,
  ): Promise<void> {
    const item = required(this.inventory, itemId, '库存物品')
    assertRevision(item.revision, expectedRevision)
    if (!input.name.trim()) throw new Error('库存名称不能为空')
    if (!input.unit.trim()) throw new Error('库存单位不能为空')
    Object.assign(item, clone(input))
    item.revision += 1
  }

  async adjustInventory(input: InventoryAdjustmentInput): Promise<void> {
    const item = required(this.inventory, input.item_id, '库存物品')
    const currentQuantity = decimalToMilli(item.quantity)
    const quantityDelta = decimalToMilli(input.quantity_delta)
    if (quantityDelta === 0n) throw new Error('库存调整数量不能为零')
    if (!input.reason.trim()) throw new Error('库存调整原因不能为空')
    const nextQuantity = currentQuantity + quantityDelta
    if (nextQuantity < 0n) throw new Error('库存不得为负数')
    const unitCost = input.unit_cost_cents ?? item.average_unit_cost_cents
    assertMoneyCents(unitCost)
    const valueDelta = quantityDelta > 0n
      ? inventoryValueCents(quantityDelta, unitCost)
      : -inventoryValueShareCents(item.inventory_value_cents, currentQuantity, -quantityDelta)
    const nextValue = Number(safeMoneyBigInt(BigInt(item.inventory_value_cents) + BigInt(valueDelta)))
    const movement: InventoryMovement = {
      id: this.nextId,
      inventory_item_id: item.id,
      kind: 'adjustment',
      quantity_delta: milliToDecimal(decimalToMilli(input.quantity_delta)),
      value_delta_cents: valueDelta,
      occurred_on: input.occurred_on,
      project_code: null,
      worker_id: null,
      reason: input.reason,
      notes: null,
      reversal_of_movement_id: null,
    }
    item.quantity = milliToDecimal(nextQuantity)
    item.average_unit_cost_cents = averageUnitCostCents(nextValue, nextQuantity)
    item.inventory_value_cents = nextValue
    item.revision += 1
    this.nextId += 1
    this.inventoryMovements.unshift(movement)
  }

  async issueInventory(projectCode: string, input: InventoryIssueInput): Promise<void> {
    if (!projectCode.trim()) throw new Error('项目编号不能为空')
    const workspace = this.workspace(projectCode)
    const nextQuantities = new Map<number, { item: InventoryItem; quantityMilli: bigint; valueCents: number }>()
    const usageUpdates = new Map<string, bigint>()
    const newMovements: InventoryMovement[] = []
    const newUsageAllocations = new Map<number, Map<string, bigint>>()
    let stagedNextId = this.nextId
    for (const line of input.lines) {
      const item = required(this.inventory, line.inventory_item_id, '库存物品')
      const issueQuantity = decimalToMilli(line.quantity)
      if (issueQuantity <= 0n) throw new Error('领用数量必须大于零')
      const stagedItem = nextQuantities.get(item.id)
      const currentQuantity = stagedItem?.quantityMilli ?? decimalToMilli(item.quantity)
      const currentValue = stagedItem?.valueCents ?? item.inventory_value_cents
      const nextQuantity = currentQuantity - issueQuantity
      if (nextQuantity < 0n) throw new Error('库存不得为负数')
      const issuedValue = inventoryValueShareCents(currentValue, currentQuantity, issueQuantity)
      const valueCents = currentValue - issuedValue
      nextQuantities.set(item.id, { item, quantityMilli: nextQuantity, valueCents })

      const usageAllocations = allocateProcurementUsage(
        projectCode,
        item.id,
        line.procurement_line_id,
        issueQuantity,
        this.inventoryOrigins,
        workspace,
        this.receivedQuantityMilli,
        this.usedQuantityMilli,
        usageUpdates,
      )
      for (const [procurementLineId, allocatedQuantity] of usageAllocations) {
        const key = procurementLineKey(projectCode, procurementLineId)
        const currentUsed = usageUpdates.get(key) ?? this.usedQuantityMilli.get(key) ?? 0n
        usageUpdates.set(key, currentUsed + allocatedQuantity)
      }
      const movementId = stagedNextId++
      newMovements.push({
        id: movementId,
        inventory_item_id: item.id,
        kind: 'issue',
        quantity_delta: milliToDecimal(-issueQuantity),
        value_delta_cents: -issuedValue,
        occurred_on: input.issued_on,
        project_code: projectCode,
        worker_id: input.worker_id,
        reason: '项目领用',
        notes: input.notes,
        reversal_of_movement_id: null,
      })
      newUsageAllocations.set(movementId, new Map([...usageAllocations].map(([lineId, quantity]) => [
        procurementLineKey(projectCode, lineId),
        quantity,
      ])))
    }
    for (const { item, quantityMilli, valueCents } of nextQuantities.values()) {
      item.quantity = milliToDecimal(quantityMilli)
      item.inventory_value_cents = valueCents
      item.revision += 1
    }
    for (const [key, value] of usageUpdates) this.usedQuantityMilli.set(key, value)
    this.inventoryMovements.unshift(...newMovements.reverse())
    for (const [movementId, allocations] of newUsageAllocations) {
      this.issueUsageAllocations.set(movementId, allocations)
    }
    this.nextId = stagedNextId
    this.updateUsageStatuses(projectCode)
  }

  async reverseInventoryIssue(movementId: number, input: InventoryIssueReversalInput): Promise<void> {
    const movement = required(this.inventoryMovements, movementId, '库存流水')
    if (movement.kind !== 'issue') throw new Error('只有项目领用记录可以冲销')
    if (!input.reason.trim()) throw new Error('冲销原因不能为空')
    if (this.inventoryMovements.some((candidate) => candidate.reversal_of_movement_id === movementId)) {
      throw new Error('该领用记录已经冲销')
    }
    const item = required(this.inventory, movement.inventory_item_id, '库存物品')
    const quantityMilli = -decimalToMilli(movement.quantity_delta)
    const nextQuantity = decimalToMilli(item.quantity) + quantityMilli
    const nextValue = Number(safeMoneyBigInt(BigInt(item.inventory_value_cents) - BigInt(movement.value_delta_cents)))
    const allocations = this.issueUsageAllocations.get(movementId) ?? new Map<string, bigint>()
    const usageUpdates = new Map<string, bigint>()
    for (const [key, quantity] of allocations) {
      const used = this.usedQuantityMilli.get(key) ?? 0n
      if (used < quantity) throw new Error('采购使用状态与领用记录不一致')
      usageUpdates.set(key, used - quantity)
    }
    const reversal: InventoryMovement = {
      id: this.nextId,
      inventory_item_id: item.id,
      kind: 'issue_reversal',
      quantity_delta: milliToDecimal(quantityMilli),
      value_delta_cents: -movement.value_delta_cents,
      occurred_on: input.reversed_on,
      project_code: movement.project_code,
      worker_id: movement.worker_id,
      reason: input.reason.trim(),
      notes: null,
      reversal_of_movement_id: movement.id,
    }

    item.quantity = milliToDecimal(nextQuantity)
    item.inventory_value_cents = nextValue
    item.average_unit_cost_cents = averageUnitCostCents(nextValue, nextQuantity)
    item.revision += 1
    for (const [key, value] of usageUpdates) this.usedQuantityMilli.set(key, value)
    this.inventoryMovements.unshift(reversal)
    this.nextId += 1
    if (movement.project_code) this.updateUsageStatuses(movement.project_code)
  }

  private workspace(projectCode: string): ProjectProcurementWorkspace {
    let workspace = this.workspaces.get(projectCode)
    if (!workspace) {
      workspace = initialWorkspace(projectCode)
      this.workspaces.set(projectCode, workspace)
      const initialOrderLine = workspace.purchase_orders[0]?.lines[0]
      if (initialOrderLine) {
        this.receivedQuantityMilli.set(orderLineKey(projectCode, initialOrderLine.id), 4500n)
        this.inventoryOrigins.set(inventoryOriginKey(projectCode, 301), new Set([initialOrderLine.procurement_line_id]))
      }
    }
    return workspace
  }

  private requireOrder(projectCode: string, orderId: number): PurchaseOrder {
    return required(this.workspace(projectCode).purchase_orders, orderId, '采购单')
  }

  private orderHasBusinessFacts(projectCode: string, order: PurchaseOrder): boolean {
    return order.lines.some((line) => {
      const key = orderLineKey(projectCode, line.id)
      return (this.receivedQuantityMilli.get(key) ?? 0n) > 0n
        || (this.paidAmountCents.get(key) ?? 0n) > 0n
        || (this.invoicedAmountCents.get(key) ?? 0n) > 0n
    })
  }

  private updateReceiptStatuses(projectCode: string): void {
    const workspace = this.workspace(projectCode)
    for (const line of allProcurementLines(workspace)) {
      const orderLines = allOrderLines(workspace).filter((candidate) => candidate.procurement_line_id === line.id)
      const ordered = sumBigInt(orderLines.map((candidate) => decimalToMilli(candidate.quantity)))
      const received = sumBigInt(orderLines.map((candidate) => (
        this.receivedQuantityMilli.get(orderLineKey(projectCode, candidate.id)) ?? 0n
      )))
      line.receipt_status = progressStatus(received, ordered, 'not_received', 'partial', 'received')
      line.revision += 1
    }
  }

  private updateOrderStatuses(projectCode: string): void {
    const workspace = this.workspace(projectCode)
    for (const line of allProcurementLines(workspace)) {
      const ordered = sumBigInt(allOrderLines(workspace)
        .filter((candidate) => candidate.procurement_line_id === line.id)
        .map((candidate) => decimalToMilli(candidate.quantity)))
      const requested = decimalToMilli(line.quantity)
      const nextStatus = ordered <= 0n
        ? 'not_ordered'
        : ordered < requested
          ? 'partial'
          : ordered === requested
            ? 'ordered'
            : 'over_ordered'
      if (line.order_status !== nextStatus) {
        line.order_status = nextStatus
        line.revision += 1
      }
    }
  }

  private updateMoneyStatuses(projectCode: string, kind: 'payment' | 'invoice'): void {
    const workspace = this.workspace(projectCode)
    const totals = kind === 'payment' ? this.paidAmountCents : this.invoicedAmountCents
    for (const line of allProcurementLines(workspace)) {
      const orderLines = allOrderLines(workspace).filter((candidate) => candidate.procurement_line_id === line.id)
      const target = sumBigInt(orderLines.map(orderLineAmountCents))
      const actual = sumBigInt(orderLines.map((candidate) => (
        totals.get(orderLineKey(projectCode, candidate.id)) ?? 0n
      )))
      if (kind === 'payment') {
        line.payment_status = progressStatus(actual, target, 'unpaid', 'partial', 'paid')
      } else {
        line.invoice_status = progressStatus(actual, target, 'not_invoiced', 'partial', 'invoiced')
      }
      line.revision += 1
    }
  }

  private updateUsageStatuses(projectCode: string): void {
    const workspace = this.workspace(projectCode)
    for (const line of allProcurementLines(workspace)) {
      const orderLines = allOrderLines(workspace).filter((candidate) => candidate.procurement_line_id === line.id)
      const received = sumBigInt(orderLines.map((candidate) => (
        this.receivedQuantityMilli.get(orderLineKey(projectCode, candidate.id)) ?? 0n
      )))
      const used = this.usedQuantityMilli.get(procurementLineKey(projectCode, line.id)) ?? 0n
      line.usage_status = progressStatus(used, received, 'unused', 'partial', 'used')
      line.revision += 1
    }
  }
}

function initialWorkspace(projectCode: string): ProjectProcurementWorkspace {
  const line = {
    id: 101,
    sequence_no: 1,
    category: '驱动与控制',
    name: '伺服电机',
    specification: '1.5 kW',
    brand: '汇川',
    model: 'MS1H2',
    quantity: '12.500',
    unit: '台',
    unit_cost_cents: 128900,
    quoted_unit_price_cents: 158000,
    revision: 2,
    order_status: 'partial' as const,
    payment_status: 'partial' as const,
    receipt_status: 'partial' as const,
    invoice_status: 'not_invoiced' as const,
    usage_status: 'unused' as const,
  }
  const list: ProcurementList = {
    id: 11,
    name: '装配线电气采购清单',
    notes: 'P1 契约演示',
    status: 'draft',
    revision: 3,
    lines: [line],
  }
  const order: PurchaseOrder = {
    id: 21,
    order_no: 'PO-2026-018',
    supplier_company_id: 8,
    ordered_on: '2026-08-22',
    expected_delivery_on: '2026-09-12',
    status: 'partially_received',
    revision: 2,
    notes: null,
    document_version_ids: [],
    lines: [{
      id: 201,
      procurement_line_id: line.id,
      quantity: '8.000',
      unit_cost_cents: 128900,
      overage_reason: null,
    }],
  }
  return { project_code: projectCode, procurement_lists: [list], purchase_orders: [order] }
}

function initialInventory(): InventoryItem[] {
  return [{
    id: 301,
    brand: '汇川',
    name: '伺服电机',
    model: 'MS1H2',
    specification: '1.5 kW',
    unit: '台',
    quantity: '4.500',
    average_unit_cost_cents: 128900,
    inventory_value_cents: 580050,
    revision: 4,
  }]
}

function initialInventoryMovements(): InventoryMovement[] {
  return [{
    id: 401,
    inventory_item_id: 301,
    kind: 'opening',
    quantity_delta: '4.500',
    value_delta_cents: 580050,
    occurred_on: '2026-08-22',
    project_code: null,
    worker_id: null,
    reason: '期初库存',
    notes: '演示库存初始化',
    reversal_of_movement_id: null,
  }]
}

function localISODate(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function required<T extends { id: number }>(items: T[], id: number, label: string): T {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`${label}不存在`)
  return item
}

function assertRevision(current: number, expected: number): void {
  if (current !== expected) throw new Error('REVISION_CONFLICT')
}

function decimalToMilli(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(value)) throw new Error('数量格式不正确，请最多填写三位小数')
  const negative = value.startsWith('-')
  const normalized = negative ? value.slice(1) : value
  const [whole, fraction = ''] = normalized.split('.')
  const milli = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'))
  return negative ? -milli : milli
}

function milliToDecimal(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`
}

function assertMoneyCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('金额超出可保存范围')
}

function validateProcurementLineInput(input: ProcurementLineInput): void {
  if (decimalToMilli(input.quantity) <= 0n) throw new Error('采购数量必须大于零')
  assertMoneyCents(input.unit_cost_cents)
  assertMoneyCents(input.quoted_unit_price_cents)
}

function assertOrderAllowsBusinessEntry(order: PurchaseOrder, action: '付款' | '开票'): void {
  if (!['confirmed', 'partially_received', 'received'].includes(order.status)) {
    throw new Error(`当前采购单状态不允许${action}`)
  }
}

function safeMoneyBigInt(value: bigint): bigint {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('库存价值超出可保存范围')
  }
  return value
}

function inventoryValueCents(quantityMilli: bigint, unitCostCents: number): number {
  assertMoneyCents(unitCostCents)
  return Number(safeMoneyBigInt(roundPositive(quantityMilli * BigInt(unitCostCents), 1000n)))
}

function inventoryValueShareCents(totalValueCents: number, totalQuantityMilli: bigint, quantityMilli: bigint): number {
  assertMoneyCents(totalValueCents)
  if (quantityMilli < 0n || quantityMilli > totalQuantityMilli || totalQuantityMilli <= 0n) {
    throw new Error('库存金额分摊参数不正确')
  }
  return Number(roundPositive(BigInt(totalValueCents) * quantityMilli, totalQuantityMilli))
}

function averageUnitCostCents(totalValueCents: number, totalQuantityMilli: bigint): number {
  if (totalQuantityMilli === 0n) return 0
  return Number(safeMoneyBigInt(roundPositive(BigInt(totalValueCents) * 1000n, totalQuantityMilli)))
}

function roundPositive(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('库存金额计算参数不正确')
  return (numerator + denominator / 2n) / denominator
}

function orderLineKey(projectCode: string, orderLineId: number): string {
  return `${projectCode}:order-line:${orderLineId}`
}

function procurementLineKey(projectCode: string, procurementLineId: number): string {
  return `${projectCode}:procurement-line:${procurementLineId}`
}

function inventoryOriginKey(projectCode: string, inventoryItemId: number): string {
  return `${projectCode}:inventory:${inventoryItemId}`
}

function inventorySignature(item: Pick<InventoryItem, 'brand' | 'name' | 'model' | 'specification' | 'unit'>): string {
  return [item.brand, item.name, item.model, item.specification, item.unit].join('\u0000')
}

function allProcurementLines(workspace: ProjectProcurementWorkspace) {
  return workspace.procurement_lists.flatMap((list) => list.lines)
}

function allOrderLines(workspace: ProjectProcurementWorkspace) {
  return workspace.purchase_orders
    .filter((order) => order.status !== 'cancelled')
    .flatMap((order) => order.lines)
}

function findProcurementLine(workspace: ProjectProcurementWorkspace, lineId: number) {
  const line = allProcurementLines(workspace).find((candidate) => candidate.id === lineId)
  if (!line) throw new Error('采购行不存在')
  return line
}

function sumBigInt(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n)
}

function orderLineAmountCents(line: PurchaseOrder['lines'][number]): bigint {
  assertMoneyCents(line.unit_cost_cents)
  return roundPositive(decimalToMilli(line.quantity) * BigInt(line.unit_cost_cents), 1000n)
}

function progressStatus<Empty extends string, Partial extends string, Complete extends string>(
  actual: bigint,
  target: bigint,
  empty: Empty,
  partial: Partial,
  complete: Complete,
): Empty | Partial | Complete {
  if (actual <= 0n || target <= 0n) return empty
  return actual >= target ? complete : partial
}

function validatePurchaseOrderInput(
  workspace: ProjectProcurementWorkspace,
  input: PurchaseOrderInput,
  excludedOrderId?: number,
): void {
  if (input.lines.length === 0) throw new Error('采购单明细不能为空')
  const groupedLines = new Map<number, { quantityMilli: bigint; lines: PurchaseOrderInput['lines'] }>()
  for (const line of input.lines) {
    const procurementLine = findProcurementLine(workspace, line.procurement_line_id)
    const quantityMilli = decimalToMilli(line.quantity)
    if (quantityMilli <= 0n) throw new Error('采购数量必须大于零')
    assertMoneyCents(line.unit_cost_cents)
    const grouped = groupedLines.get(procurementLine.id) ?? { quantityMilli: 0n, lines: [] }
    grouped.quantityMilli += quantityMilli
    grouped.lines.push(line)
    groupedLines.set(procurementLine.id, grouped)
  }

  const existingOrderLines = workspace.purchase_orders
    .filter((order) => order.status !== 'cancelled' && order.id !== excludedOrderId)
    .flatMap((order) => order.lines)
  for (const [procurementLineId, grouped] of groupedLines) {
    const procurementLine = findProcurementLine(workspace, procurementLineId)
    const alreadyOrdered = sumBigInt(existingOrderLines
      .filter((line) => line.procurement_line_id === procurementLineId)
      .map((line) => decimalToMilli(line.quantity)))
    if (alreadyOrdered + grouped.quantityMilli > decimalToMilli(procurementLine.quantity)
      && grouped.lines.some((line) => !line.overage_reason?.trim())) {
      throw new Error('超采必须填写原因')
    }
  }
}

function validateMoneyAllocations(
  projectCode: string,
  order: PurchaseOrder,
  total: number,
  allocations: Array<{ purchase_order_line_id: number; amount_cents: number }>,
  existingTotals: Map<string, bigint>,
): Map<string, bigint> {
  assertMoneyCents(total)
  if (allocations.length === 0) throw new Error('分摊明细不能为空')
  const allocated = sumBigInt(allocations.map((allocation) => {
    assertMoneyCents(allocation.amount_cents)
    return BigInt(allocation.amount_cents)
  }))
  if (allocated !== BigInt(total)) throw new Error('分摊合计必须等于单据金额')

  const updates = new Map<string, bigint>()
  for (const allocation of allocations) {
    if (allocation.amount_cents <= 0) throw new Error('分摊金额必须大于零')
    const orderLine = required(order.lines, allocation.purchase_order_line_id, '采购单行')
    const key = orderLineKey(projectCode, orderLine.id)
    const current = updates.get(key) ?? existingTotals.get(key) ?? 0n
    const next = current + BigInt(allocation.amount_cents)
    if (next > orderLineAmountCents(orderLine)) throw new Error('累计金额不能超过采购单行金额')
    updates.set(key, next)
  }
  return updates
}

function receivedQuantityForProcurementLine(
  projectCode: string,
  procurementLineId: number,
  workspace: ProjectProcurementWorkspace,
  receivedQuantityMilli: Map<string, bigint>,
): bigint {
  return sumBigInt(allOrderLines(workspace)
    .filter((line) => line.procurement_line_id === procurementLineId)
    .map((line) => receivedQuantityMilli.get(orderLineKey(projectCode, line.id)) ?? 0n))
}

function allocateProcurementUsage(
  projectCode: string,
  inventoryItemId: number,
  explicitLineId: number | null,
  issueQuantityMilli: bigint,
  origins: Map<string, Set<number>>,
  workspace: ProjectProcurementWorkspace,
  receivedQuantityMilli: Map<string, bigint>,
  usedQuantityMilli: Map<string, bigint>,
  stagedUsage: Map<string, bigint>,
): Map<number, bigint> {
  const candidates = [...(origins.get(inventoryOriginKey(projectCode, inventoryItemId)) ?? [])]
  if (explicitLineId !== null) {
    findProcurementLine(workspace, explicitLineId)
    if (!candidates.includes(explicitLineId)) throw new Error('采购来源与库存物料不匹配')
    const key = procurementLineKey(projectCode, explicitLineId)
    const used = stagedUsage.get(key) ?? usedQuantityMilli.get(key) ?? 0n
    const received = receivedQuantityForProcurementLine(
      projectCode,
      explicitLineId,
      workspace,
      receivedQuantityMilli,
    )
    if (used + issueQuantityMilli > received) {
      throw new Error('领用归集数量不能超过该采购行累计到货量')
    }
    return new Map([[explicitLineId, issueQuantityMilli]])
  }

  const allocations = new Map<number, bigint>()
  let remaining = issueQuantityMilli
  for (const procurementLineId of candidates) {
    if (remaining <= 0n) break
    findProcurementLine(workspace, procurementLineId)
    const key = procurementLineKey(projectCode, procurementLineId)
    const used = stagedUsage.get(key) ?? usedQuantityMilli.get(key) ?? 0n
    const received = receivedQuantityForProcurementLine(
      projectCode,
      procurementLineId,
      workspace,
      receivedQuantityMilli,
    )
    const available = received > used ? received - used : 0n
    const allocated = remaining < available ? remaining : available
    if (allocated > 0n) {
      allocations.set(procurementLineId, allocated)
      remaining -= allocated
    }
  }
  return allocations
}
