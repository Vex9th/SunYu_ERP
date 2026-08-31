<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import type { CompanyRecord, PagedResult } from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { centsToYuan, yuanToCents } from '../../domain/formatters'
import type {
  GoodsReceiptInput,
  ProcurementLineInput,
  ProcurementListDetailDto,
  ProcurementListInput,
  ProcurementListSummaryDto,
  ProcurementOverviewDto,
  PurchaseOrderDto,
  PurchaseOrderInput,
} from '../../domain/operations-api'
import {
  createHttpProcurementRepository,
  type ProcurementHttpRepository,
} from '../../repositories/procurement.live'

const props = defineProps<{
  projectCode: string
  repository?: ProcurementHttpRepository
}>()

const defaultRepository = createHttpProcurementRepository()
const loading = ref(false)
const loadError = ref<string | null>(null)
const companies = ref<CompanyRecord[]>([])
const procurementLists = ref<ProcurementListDetailDto[]>([])
const procurementListPage = ref<PagedResult<ProcurementListSummaryDto> | null>(null)
const purchaseOrderPage = ref<PagedResult<PurchaseOrderDto> | null>(null)
const overview = ref<ProcurementOverviewDto | null>(null)
const actionError = ref<string | null>(null)
const actionBusy = ref(false)
const listDialogVisible = ref(false)
const lineDialogVisible = ref(false)
const orderDialogVisible = ref(false)
const orderDrawerVisible = ref(false)
const receiptDialogVisible = ref(false)
const selectedLineListId = ref(0)
const selectedOrderLine = ref<ProcurementListDetailDto['lines'][number] | null>(null)
const selectedOrder = ref<PurchaseOrderDto | null>(null)
const listForm = reactive({ name: '', notes: '' })
const lineForm = reactive({
  sequenceNo: 1,
  category: '其他',
  name: '',
  specification: '',
  brand: '',
  model: '',
  quantity: '',
  unit: '',
  unitCostYuan: '',
  quotedUnitPriceYuan: '',
})
const orderForm = reactive({
  orderNo: '',
  supplierCompanyId: 0,
  orderedOn: localISODate(),
  expectedDeliveryOn: '',
  quantity: '',
  unitCostYuan: '',
  overageReason: '',
  notes: '',
})
const receiptForm = reactive({
  receivedOn: localISODate(),
  warehouseName: '',
  notes: '',
})
const receiptQuantities = reactive<Record<number, string>>({})
let generation = 0
let mounted = true
let actionSequence = 0
let listDialogVersion = 0
let lineDialogVersion = 0
let orderDialogVersion = 0
let receiptDialogVersion = 0

interface ActionContext {
  sequence: number
  generation: number
  projectCode: string
  repository: ProcurementHttpRepository
}

interface PendingListCreate {
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  input: ProcurementListInput
  inFlight: boolean
}

interface PendingLineCreate {
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  listId: number
  input: ProcurementLineInput
  inFlight: boolean
}

interface PendingOrderCreate {
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  input: PurchaseOrderInput
  inFlight: boolean
}

interface PendingReceiptCreate {
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  orderId: number
  input: GoodsReceiptInput
  inFlight: boolean
}

const pendingListCreates = new Set<PendingListCreate>()
const pendingLineCreates = new Set<PendingLineCreate>()
const pendingOrderCreates = new Set<PendingOrderCreate>()
const pendingReceiptCreates = new Set<PendingReceiptCreate>()

const purchaseOrders = computed(() => purchaseOrderPage.value?.items ?? [])
const draftProcurementLists = computed(() => procurementLists.value.filter((list) => list.status === 'draft'))
const canWrite = computed(() => !loading.value && !loadError.value && !actionBusy.value)
const paginationWarnings = computed(() => {
  const warnings: string[] = []
  if (procurementListPage.value && procurementListPage.value.total > procurementListPage.value.page_size) {
    warnings.push(`采购清单共 ${procurementListPage.value.total} 条，当前仅展示前 ${procurementListPage.value.page_size} 条`)
  }
  if (purchaseOrderPage.value && purchaseOrderPage.value.total > purchaseOrderPage.value.page_size) {
    warnings.push(`采购单共 ${purchaseOrderPage.value.total} 条，当前仅展示前 ${purchaseOrderPage.value.page_size} 条`)
  }
  return warnings
})

function clearWorkspace(): void {
  companies.value = []
  procurementLists.value = []
  procurementListPage.value = null
  purchaseOrderPage.value = null
  overview.value = null
  loadError.value = null
}

function isCurrent(value: number): boolean {
  return mounted && value === generation
}

function currentRepository(): ProcurementHttpRepository {
  return props.repository ?? defaultRepository
}

function isCurrentAction(context: ActionContext): boolean {
  return isCurrent(context.generation)
    && context.sequence === actionSequence
    && context.projectCode === props.projectCode
    && context.repository === currentRepository()
}

function startAction(): ActionContext {
  return {
    sequence: ++actionSequence,
    generation,
    projectCode: props.projectCode,
    repository: currentRepository(),
  }
}

function optionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

function actionErrorMessage(error: unknown): string {
  if (error instanceof TypeError && /failed to fetch|networkerror/i.test(error.message)) {
    return '无法连接本地服务，请确认服务仍在运行'
  }
  return error instanceof Error ? error.message : '采购操作失败，请重试'
}

async function loadWorkspace(
  projectCode: string,
  repository: ProcurementHttpRepository = currentRepository(),
): Promise<void> {
  const currentGeneration = ++generation
  clearWorkspace()
  loading.value = true
  try {
    const [companyResult, listResult, orderResult, overviewResult] = await Promise.all([
      repository.listSupplierCompanies(),
      repository.listProcurementLists(projectCode, { page: 1, page_size: 100 }),
      repository.listPurchaseOrders(projectCode, { page: 1, page_size: 100 }),
      repository.getProcurementOverview(projectCode),
    ])
    if (!isCurrent(currentGeneration)) return
    const detailResults = await Promise.all(
      listResult.data.items.map((item) => repository.getProcurementList(projectCode, item.id)),
    )
    if (!isCurrent(currentGeneration)) return
    companies.value = companyResult.data
    procurementListPage.value = listResult.data
    procurementLists.value = detailResults.map((result) => result.data)
    purchaseOrderPage.value = orderResult.data
    overview.value = overviewResult.data
  } catch (error) {
    if (isCurrent(currentGeneration)) {
      loadError.value = error instanceof Error ? error.message : '采购数据读取失败'
    }
  } finally {
    if (isCurrent(currentGeneration)) loading.value = false
  }
}

function abandonListCreate(pending: PendingListCreate): void {
  const discarded = pending.repository.discardCreateProcurementList(pending.projectCode, pending.input)
  if (discarded || !pending.inFlight) pendingListCreates.delete(pending)
}

function abandonLineCreate(pending: PendingLineCreate): void {
  const discarded = pending.repository.discardCreateProcurementLine(
    pending.projectCode,
    pending.listId,
    pending.input,
  )
  if (discarded || !pending.inFlight) pendingLineCreates.delete(pending)
}

function abandonOrderCreate(pending: PendingOrderCreate): void {
  const discarded = pending.repository.discardCreatePurchaseOrder(pending.projectCode, pending.input)
  if (discarded || !pending.inFlight) pendingOrderCreates.delete(pending)
}

function abandonReceiptCreate(pending: PendingReceiptCreate): void {
  const discarded = pending.repository.discardReceiveGoods(
    pending.projectCode,
    pending.orderId,
    pending.input,
  )
  if (discarded || !pending.inFlight) pendingReceiptCreates.delete(pending)
}

function abandonListDialogPendingCreates(): void {
  for (const pending of pendingListCreates) {
    if (pending.dialogVersion === listDialogVersion) abandonListCreate(pending)
  }
}

function abandonLineDialogPendingCreates(): void {
  for (const pending of pendingLineCreates) {
    if (pending.dialogVersion === lineDialogVersion) abandonLineCreate(pending)
  }
}

function abandonOrderDialogPendingCreates(): void {
  for (const pending of pendingOrderCreates) {
    if (pending.dialogVersion === orderDialogVersion) abandonOrderCreate(pending)
  }
}

function abandonReceiptDialogPendingCreates(): void {
  for (const pending of pendingReceiptCreates) {
    if (pending.dialogVersion === receiptDialogVersion) abandonReceiptCreate(pending)
  }
}

function resetActionsForContextChange(): void {
  actionSequence += 1
  actionBusy.value = false
  actionError.value = null
  listDialogVisible.value = false
  lineDialogVisible.value = false
  orderDialogVisible.value = false
  orderDrawerVisible.value = false
  receiptDialogVisible.value = false
  selectedLineListId.value = 0
  selectedOrderLine.value = null
  selectedOrder.value = null
  for (const pending of pendingListCreates) abandonListCreate(pending)
  for (const pending of pendingLineCreates) abandonLineCreate(pending)
  for (const pending of pendingOrderCreates) abandonOrderCreate(pending)
  for (const pending of pendingReceiptCreates) abandonReceiptCreate(pending)
}

function openListDialog(): void {
  if (!canWrite.value) return
  listDialogVersion += 1
  listForm.name = ''
  listForm.notes = ''
  actionError.value = null
  listDialogVisible.value = true
}

function listPayload(): ProcurementListInput | null {
  const name = listForm.name.trim()
  if (!name) {
    actionError.value = '请填写采购清单名称'
    return null
  }
  return { name, notes: optionalText(listForm.notes) }
}

function sameListInput(left: ProcurementListInput, right: ProcurementListInput): boolean {
  return left.name === right.name && left.notes === right.notes
}

function pendingListCreate(input: ProcurementListInput, context: ActionContext): PendingListCreate {
  const existing = [...pendingListCreates].find((pending) => (
    pending.dialogVersion === listDialogVersion
      && pending.projectCode === context.projectCode
      && pending.repository === context.repository
  ))
  if (existing && sameListInput(existing.input, input)) return existing
  if (existing) abandonListCreate(existing)
  const pending: PendingListCreate = {
    dialogVersion: listDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    inFlight: false,
  }
  pendingListCreates.add(pending)
  return pending
}

async function createList(): Promise<void> {
  if (actionBusy.value) return
  const input = listPayload()
  if (!input) return
  const context = startAction()
  const pending = pendingListCreate(input, context)
  pending.inFlight = true
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.createProcurementList(context.projectCode, pending.input)
    pending.inFlight = false
    pendingListCreates.delete(pending)
    if (!isCurrentAction(context)) return
    listDialogVisible.value = false
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    pending.inFlight = false
    if (!isCurrentAction(context)) {
      abandonListCreate(pending)
      return
    }
    actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelListDialog(): void {
  if (actionBusy.value) return
  abandonListDialogPendingCreates()
  listDialogVisible.value = false
}

function beforeListDialogClose(done: () => void): void {
  if (actionBusy.value) return
  abandonListDialogPendingCreates()
  done()
}

function openLineDialog(): void {
  if (!canWrite.value) return
  const list = draftProcurementLists.value[0]
  if (!list) return
  lineDialogVersion += 1
  selectedLineListId.value = list.id
  Object.assign(lineForm, {
    sequenceNo: Math.max(0, ...list.lines.map((line) => line.sequence_no)) + 1,
    category: '其他',
    name: '',
    specification: '',
    brand: '',
    model: '',
    quantity: '',
    unit: '',
    unitCostYuan: '',
    quotedUnitPriceYuan: '',
  })
  actionError.value = null
  lineDialogVisible.value = true
}

function linePayload(): ProcurementLineInput | null {
  const category = lineForm.category.trim()
  const name = lineForm.name.trim()
  const quantity = lineForm.quantity.trim()
  const unit = lineForm.unit.trim()
  if (!category || !name || !quantity || !unit) {
    actionError.value = '请填写类别、名称、数量和单位'
    return null
  }
  try {
    return {
      sequence_no: lineForm.sequenceNo,
      category,
      name,
      specification: optionalText(lineForm.specification),
      brand: optionalText(lineForm.brand),
      model: optionalText(lineForm.model),
      quantity,
      unit,
      unit_cost_cents: yuanToCents(lineForm.unitCostYuan),
      quoted_unit_price_cents: yuanToCents(lineForm.quotedUnitPriceYuan),
    }
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
}

function sameLineInput(left: ProcurementLineInput, right: ProcurementLineInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pendingLineCreate(
  listId: number,
  input: ProcurementLineInput,
  context: ActionContext,
): PendingLineCreate {
  const existing = [...pendingLineCreates].find((pending) => (
    pending.dialogVersion === lineDialogVersion
      && pending.projectCode === context.projectCode
      && pending.repository === context.repository
      && pending.listId === listId
  ))
  if (existing && sameLineInput(existing.input, input)) return existing
  if (existing) abandonLineCreate(existing)
  const pending: PendingLineCreate = {
    dialogVersion: lineDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    listId,
    input,
    inFlight: false,
  }
  pendingLineCreates.add(pending)
  return pending
}

async function createLine(): Promise<void> {
  if (actionBusy.value) return
  const list = draftProcurementLists.value.find((item) => item.id === selectedLineListId.value)
  const input = linePayload()
  if (!list || !input) {
    if (!list) actionError.value = '请选择草稿采购清单'
    return
  }
  const context = startAction()
  const pending = pendingLineCreate(list.id, input, context)
  pending.inFlight = true
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.createProcurementLine(
      context.projectCode,
      pending.listId,
      pending.input,
    )
    pending.inFlight = false
    pendingLineCreates.delete(pending)
    if (!isCurrentAction(context)) return
    lineDialogVisible.value = false
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    pending.inFlight = false
    if (!isCurrentAction(context)) {
      abandonLineCreate(pending)
      return
    }
    actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelLineDialog(): void {
  if (actionBusy.value) return
  abandonLineDialogPendingCreates()
  lineDialogVisible.value = false
}

function beforeLineDialogClose(done: () => void): void {
  if (actionBusy.value) return
  abandonLineDialogPendingCreates()
  done()
}

async function confirmList(list: ProcurementListDetailDto): Promise<void> {
  if (!canWrite.value || list.status !== 'draft') return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.confirmProcurementList(context.projectCode, list.id, {
      expected_revision: list.revision,
    })
    if (!isCurrentAction(context)) return
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function orderForLine(lineId: number): PurchaseOrderDto | null {
  return purchaseOrders.value.find((order) => (
    order.lines.some((line) => line.procurement_line_id === lineId)
  )) ?? null
}

function remainingProcurementQuantity(line: ProcurementListDetailDto['lines'][number]): string {
  const remaining = decimalToMilli(line.quantity) - decimalToMilli(line.ordered_quantity)
  return milliToDecimal(remaining > 0n ? remaining : 0n)
}

function hasRemainingProcurementQuantity(line: ProcurementListDetailDto['lines'][number]): boolean {
  return decimalToMilli(remainingProcurementQuantity(line)) > 0n
}

function openCreateOrder(line: ProcurementListDetailDto['lines'][number]): void {
  if (!canWrite.value || !hasRemainingProcurementQuantity(line)) return
  orderDialogVersion += 1
  selectedOrderLine.value = line
  Object.assign(orderForm, {
    orderNo: '',
    supplierCompanyId: companies.value[0]?.id ?? 0,
    orderedOn: localISODate(),
    expectedDeliveryOn: '',
    quantity: remainingProcurementQuantity(line),
    unitCostYuan: centsToYuan(line.unit_cost_cents),
    overageReason: '',
    notes: '',
  })
  actionError.value = null
  orderDialogVisible.value = true
}

function orderPayload(): PurchaseOrderInput | null {
  const line = selectedOrderLine.value
  const orderNo = orderForm.orderNo.trim()
  const quantity = orderForm.quantity.trim()
  if (!line || !orderNo || !orderForm.orderedOn || !quantity) {
    actionError.value = '请填写采购单号、下单日期和采购数量'
    return null
  }
  if (!companies.value.some((company) => company.id === orderForm.supplierCompanyId)) {
    actionError.value = '暂无可选供应商，无法建立采购单'
    return null
  }
  try {
    const quantityMilli = decimalToMilli(quantity)
    if (quantityMilli <= 0n) {
      actionError.value = '采购数量必须大于 0'
      return null
    }
    const overageReason = optionalText(orderForm.overageReason)
    if (quantityMilli > decimalToMilli(remainingProcurementQuantity(line)) && !overageReason) {
      actionError.value = '采购数量超过清单剩余数量，必须填写超采原因'
      return null
    }
    return {
      order_no: orderNo,
      supplier_company_id: orderForm.supplierCompanyId,
      ordered_on: orderForm.orderedOn,
      expected_delivery_on: optionalText(orderForm.expectedDeliveryOn),
      lines: [{
        procurement_line_id: line.id,
        quantity,
        unit_cost_cents: yuanToCents(orderForm.unitCostYuan),
        overage_reason: overageReason,
      }],
      notes: optionalText(orderForm.notes),
      document_version_ids: [],
    }
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
}

function pendingOrderCreate(input: PurchaseOrderInput, context: ActionContext): PendingOrderCreate {
  const existing = [...pendingOrderCreates].find((pending) => (
    pending.dialogVersion === orderDialogVersion
      && pending.projectCode === context.projectCode
      && pending.repository === context.repository
  ))
  if (existing && JSON.stringify(existing.input) === JSON.stringify(input)) return existing
  if (existing) abandonOrderCreate(existing)
  const pending: PendingOrderCreate = {
    dialogVersion: orderDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    inFlight: false,
  }
  pendingOrderCreates.add(pending)
  return pending
}

async function createOrder(): Promise<void> {
  if (actionBusy.value) return
  const input = orderPayload()
  if (!input) return
  const context = startAction()
  const pending = pendingOrderCreate(input, context)
  pending.inFlight = true
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.createPurchaseOrder(context.projectCode, pending.input)
    pending.inFlight = false
    pendingOrderCreates.delete(pending)
    if (!isCurrentAction(context)) return
    selectedOrder.value = result.data
    orderDialogVisible.value = false
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    pending.inFlight = false
    if (!isCurrentAction(context)) {
      abandonOrderCreate(pending)
      return
    }
    actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelOrderDialog(): void {
  if (actionBusy.value) return
  abandonOrderDialogPendingCreates()
  orderDialogVisible.value = false
}

function beforeOrderDialogClose(done: () => void): void {
  if (actionBusy.value) return
  abandonOrderDialogPendingCreates()
  done()
}

async function openOrderDetail(order: PurchaseOrderDto): Promise<void> {
  const retained = selectedOrder.value
  if (retained?.id === order.id && retained.revision >= order.revision
    && retained.status !== 'draft' && order.status === 'draft') {
    orderDrawerVisible.value = true
    return
  }
  if (!canWrite.value) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.getPurchaseOrder(context.projectCode, order.id)
    if (!isCurrentAction(context)) return
    selectedOrder.value = result.data
    orderDrawerVisible.value = true
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

async function confirmOrder(): Promise<void> {
  const order = selectedOrder.value
  if (!order || !canWrite.value || order.status !== 'draft') return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.confirmPurchaseOrder(context.projectCode, order.id, {
      expected_revision: order.revision,
    })
    if (!isCurrentAction(context)) return
    selectedOrder.value = result.data
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function decimalToMilli(value: string): bigint {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error('数量格式不正确')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'))
}

function milliToDecimal(value: bigint): string {
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`
}

function remainingQuantity(line: PurchaseOrderDto['lines'][number]): string {
  const remaining = decimalToMilli(line.quantity) - decimalToMilli(line.received_quantity)
  return milliToDecimal(remaining > 0n ? remaining : 0n)
}

function openReceiptDialog(): void {
  const order = selectedOrder.value
  if (!order || !canWrite.value
    || !['confirmed', 'partially_received'].includes(order.status)) return
  receiptDialogVersion += 1
  Object.assign(receiptForm, {
    receivedOn: localISODate(),
    warehouseName: '',
    notes: '',
  })
  for (const key of Object.keys(receiptQuantities)) delete receiptQuantities[Number(key)]
  for (const line of order.lines) receiptQuantities[line.id] = remainingQuantity(line)
  actionError.value = null
  receiptDialogVisible.value = true
}

function receiptPayload(): GoodsReceiptInput | null {
  const order = selectedOrder.value
  const warehouseName = receiptForm.warehouseName.trim()
  if (!order || !receiptForm.receivedOn || !warehouseName) {
    actionError.value = '请填写到货日期和仓库名称'
    return null
  }
  let lines: GoodsReceiptInput['lines']
  try {
    lines = order.lines.flatMap((line) => {
      const quantity = receiptQuantities[line.id]?.trim() ?? ''
      return quantity && decimalToMilli(quantity) > 0n
        ? [{ purchase_order_line_id: line.id, quantity }]
        : []
    })
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
  if (lines.length === 0) {
    actionError.value = '请填写本次到货数量'
    return null
  }
  return {
    received_on: receiptForm.receivedOn,
    warehouse_name: warehouseName,
    lines,
    notes: optionalText(receiptForm.notes),
  }
}

function pendingReceiptCreate(
  orderId: number,
  input: GoodsReceiptInput,
  context: ActionContext,
): PendingReceiptCreate {
  const existing = [...pendingReceiptCreates].find((pending) => (
    pending.dialogVersion === receiptDialogVersion
      && pending.projectCode === context.projectCode
      && pending.repository === context.repository
      && pending.orderId === orderId
  ))
  if (existing && JSON.stringify(existing.input) === JSON.stringify(input)) return existing
  if (existing) abandonReceiptCreate(existing)
  const pending: PendingReceiptCreate = {
    dialogVersion: receiptDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    orderId,
    input,
    inFlight: false,
  }
  pendingReceiptCreates.add(pending)
  return pending
}

async function receiveGoods(): Promise<void> {
  if (actionBusy.value) return
  const order = selectedOrder.value
  const input = receiptPayload()
  if (!order || !input) return
  const context = startAction()
  const pending = pendingReceiptCreate(order.id, input, context)
  pending.inFlight = true
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.receiveGoods(context.projectCode, pending.orderId, pending.input)
    pending.inFlight = false
    pendingReceiptCreates.delete(pending)
    if (!isCurrentAction(context)) return
    receiptDialogVisible.value = false
    orderDrawerVisible.value = false
    selectedOrder.value = null
    actionBusy.value = false
    await loadWorkspace(context.projectCode, context.repository)
  } catch (error) {
    pending.inFlight = false
    if (!isCurrentAction(context)) {
      abandonReceiptCreate(pending)
      return
    }
    actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelReceiptDialog(): void {
  if (actionBusy.value) return
  abandonReceiptDialogPendingCreates()
  receiptDialogVisible.value = false
}

function beforeReceiptDialogClose(done: () => void): void {
  if (actionBusy.value) return
  abandonReceiptDialogPendingCreates()
  done()
}

async function downloadTemplate(): Promise<void> {
  if (!canWrite.value) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const blob = await context.repository.downloadImportTemplate()
    if (!isCurrentAction(context)) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'procurement-import-template.xlsx'
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

watch(
  [() => props.projectCode, () => props.repository],
  ([projectCode]) => {
    resetActionsForContextChange()
    void loadWorkspace(projectCode, currentRepository())
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mounted = false
  generation += 1
  actionSequence += 1
  for (const pending of pendingListCreates) abandonListCreate(pending)
  for (const pending of pendingLineCreates) abandonLineCreate(pending)
  for (const pending of pendingOrderCreates) abandonOrderCreate(pending)
  for (const pending of pendingReceiptCreates) abandonReceiptCreate(pending)
})
</script>

<template>
  <section class="procurement-workspace" data-testid="procurement-workspace">
    <header class="workspace-header">
      <div>
        <p class="eyebrow">真实数据</p>
        <h2>采购工作台</h2>
      </div>
      <div class="workspace-actions">
        <el-button
          data-testid="procurement-list-create-open"
          type="primary"
          :disabled="!canWrite"
          @click="openListDialog"
        >新建采购清单</el-button>
        <el-button
          data-testid="procurement-line-open"
          :disabled="!canWrite || draftProcurementLists.length === 0"
          @click="openLineDialog"
        >新增物料</el-button>
        <el-button
          data-testid="procurement-template-download"
          :loading="actionBusy"
          :disabled="!canWrite"
          @click="downloadTemplate"
        >下载采购模板</el-button>
        <el-button data-testid="procurement-excel-import" disabled>导入 Excel</el-button>
      </div>
    </header>
    <p class="capability-note">Excel 自动识别导入：后端尚未接入，不会保存</p>

    <el-alert
      v-if="actionError"
      :title="actionError"
      type="error"
      :closable="false"
      show-icon
      data-testid="procurement-action-error"
    />
    <p v-if="loading" class="state-message" role="status">正在读取采购数据…</p>
    <el-alert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      data-testid="procurement-load-error"
    />
    <template v-else>
      <el-alert
        v-for="warning in paginationWarnings"
        :key="warning"
        :title="warning"
        type="warning"
        :closable="false"
        show-icon
        data-testid="procurement-pagination-warning"
      />
      <div class="workspace-grid">
        <article class="workspace-panel">
          <h3>采购清单</h3>
          <p v-if="procurementLists.length === 0" class="secondary-text" data-testid="procurement-list-empty">暂无采购清单</p>
          <section v-for="list in procurementLists" :key="list.id" class="record-block">
            <div class="record-heading">
              <h4>{{ list.name }}</h4>
              <el-button
                v-if="list.status === 'draft'"
                :data-testid="`procurement-list-confirm-${list.id}`"
                link
                type="primary"
                :loading="actionBusy"
                :disabled="!canWrite"
                @click="confirmList(list)"
              >确认清单</el-button>
            </div>
            <p v-if="list.notes" class="secondary-text">{{ list.notes }}</p>
            <ul v-if="list.lines.length" class="record-list">
              <li v-for="line in list.lines" :key="line.id">
                <div>
                  <span>{{ line.name }}</span>
                  <span class="secondary-text">{{ line.quantity }} {{ line.unit }}</span>
                  <span v-if="orderForLine(line.id)" class="secondary-text">
                    {{ orderForLine(line.id)?.order_no }}
                  </span>
                </div>
                <el-button
                  v-if="list.status === 'confirmed'"
                  :data-testid="`purchase-order-create-${line.id}`"
                  link
                  type="primary"
                  :disabled="!canWrite || !hasRemainingProcurementQuantity(line)"
                  @click="openCreateOrder(line)"
                >创建采购单</el-button>
              </li>
            </ul>
            <p v-else class="secondary-text">清单内暂无物料</p>
          </section>
        </article>
        <article class="workspace-panel">
          <h3>采购单</h3>
          <ul v-if="purchaseOrders.length" class="record-list">
            <li v-for="order in purchaseOrders" :key="order.id">
              <div>
                <span>{{ order.order_no }}</span>
                <span class="secondary-text">{{ order.supplier_company_name ?? '未指定供应商' }}</span>
              </div>
              <el-button
                data-testid="purchase-order-detail-open"
                link
                type="primary"
                :disabled="!canWrite"
                @click="openOrderDetail(order)"
              >订单详情</el-button>
            </li>
          </ul>
          <p v-else class="secondary-text" data-testid="purchase-order-empty">暂无采购单</p>
        </article>
        <article v-if="overview" class="workspace-panel" data-testid="procurement-overview">
          <h3>采购概览</h3>
          <dl class="overview-list">
            <div><dt>物料行</dt><dd>{{ overview.line_count }}</dd></div>
            <div><dt>已承诺金额</dt><dd>{{ overview.procurement_committed_cents / 100 }} 元</dd></div>
            <div><dt>已到货金额</dt><dd>{{ overview.procurement_received_cents / 100 }} 元</dd></div>
            <div><dt>已付款金额</dt><dd>{{ overview.procurement_paid_cents / 100 }} 元</dd></div>
          </dl>
        </article>
        <article class="workspace-panel" data-testid="procurement-suppliers">
          <h3>供应商</h3>
          <ul v-if="companies.length" class="record-list">
            <li v-for="company in companies" :key="company.id">{{ company.name }}</li>
          </ul>
          <p v-else class="secondary-text">暂无供应商</p>
        </article>
      </div>
    </template>

    <el-dialog
      v-model="listDialogVisible"
      :teleported="false"
      title="新建采购清单"
      width="min(92vw, 520px)"
      :before-close="beforeListDialogClose"
    >
      <el-form label-position="top" @submit.prevent="createList">
        <el-form-item label="清单名称" required>
          <el-input
            v-model="listForm.name"
            data-testid="procurement-list-name"
            :disabled="actionBusy"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="listForm.notes" type="textarea" :disabled="actionBusy" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button
            data-testid="procurement-list-cancel"
            :disabled="actionBusy"
            @click="cancelListDialog"
          >取消</el-button>
          <el-button
            data-testid="procurement-list-create-submit"
            type="primary"
            native-type="submit"
            :loading="actionBusy"
            :disabled="actionBusy"
          >建立清单</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="lineDialogVisible"
      data-testid="procurement-line-dialog"
      :teleported="false"
      title="新增采购行"
      width="min(94vw, 760px)"
      :before-close="beforeLineDialogClose"
    >
      <el-form label-position="top" @submit.prevent="createLine">
        <el-form-item label="采购清单" required>
          <el-select v-model="selectedLineListId" style="width: 100%" :disabled="actionBusy">
            <el-option
              v-for="list in draftProcurementLists"
              :key="list.id"
              :label="list.name"
              :value="list.id"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="14">
          <el-col :xs="24" :sm="8">
            <el-form-item label="序号" required>
              <el-input-number v-model="lineForm.sequenceNo" :min="1" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="类别" required>
              <el-input v-model="lineForm.category" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="名称" required>
              <el-input v-model="lineForm.name" data-testid="procurement-line-name" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="规格">
              <el-input v-model="lineForm.specification" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="品牌">
              <el-input v-model="lineForm.brand" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="型号">
              <el-input v-model="lineForm.model" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="数量" required>
              <el-input
                v-model="lineForm.quantity"
                data-testid="procurement-line-quantity"
                inputmode="decimal"
                placeholder="例如 2.500"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="单位" required>
              <el-input v-model="lineForm.unit" data-testid="procurement-line-unit" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="成本单价（元）" required>
              <el-input
                v-model="lineForm.unitCostYuan"
                data-testid="procurement-line-cost-price"
                inputmode="decimal"
                placeholder="0.00"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="报价单价（元）" required>
              <el-input
                v-model="lineForm.quotedUnitPriceYuan"
                data-testid="procurement-line-quote-price"
                inputmode="decimal"
                placeholder="0.00"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <div class="dialog-actions">
          <el-button
            data-testid="procurement-line-cancel"
            :disabled="actionBusy"
            @click="cancelLineDialog"
          >取消</el-button>
          <el-button
            data-testid="procurement-line-submit"
            type="primary"
            native-type="submit"
            :loading="actionBusy"
            :disabled="actionBusy"
          >加入清单</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="orderDialogVisible"
      data-testid="purchase-order-dialog"
      :teleported="false"
      title="新建采购单"
      width="min(94vw, 720px)"
      :before-close="beforeOrderDialogClose"
    >
      <el-alert
        v-if="companies.length === 0"
        title="暂无可选供应商，请先在公司资料中维护供应商"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-form label-position="top" @submit.prevent="createOrder">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12">
            <el-form-item label="采购单号" required>
              <el-input
                v-model="orderForm.orderNo"
                data-testid="purchase-order-number"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="供应商" required>
              <el-select
                v-model="orderForm.supplierCompanyId"
                data-testid="purchase-order-supplier"
                style="width: 100%"
                :disabled="actionBusy || companies.length === 0"
              >
                <el-option
                  v-for="company in companies"
                  :key="company.id"
                  :label="company.name"
                  :value="company.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="下单日期" required>
              <el-input v-model="orderForm.orderedOn" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="预计到货日期">
              <el-input v-model="orderForm.expectedDeliveryOn" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="采购数量" required>
              <el-input
                v-model="orderForm.quantity"
                data-testid="purchase-order-quantity"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="成本单价（元）" required>
              <el-input
                v-model="orderForm.unitCostYuan"
                data-testid="purchase-order-unit-cost"
                inputmode="decimal"
                :disabled="actionBusy"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="超采原因">
          <el-input
            v-model="orderForm.overageReason"
            data-testid="purchase-order-overage-reason"
            :disabled="actionBusy"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="orderForm.notes" type="textarea" :disabled="actionBusy" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="actionBusy" @click="cancelOrderDialog">取消</el-button>
          <el-button
            data-testid="purchase-order-submit"
            type="primary"
            native-type="submit"
            :loading="actionBusy"
            :disabled="actionBusy || companies.length === 0"
          >保存采购单</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-drawer
      v-model="orderDrawerVisible"
      data-testid="purchase-order-drawer"
      :teleported="false"
      title="采购单详情"
      size="min(92vw, 560px)"
    >
      <template v-if="selectedOrder">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="采购单号">{{ selectedOrder.order_no }}</el-descriptions-item>
          <el-descriptions-item label="供应商">
            {{ selectedOrder.supplier_company_name ?? '未指定供应商' }}
          </el-descriptions-item>
          <el-descriptions-item label="下单日期">{{ selectedOrder.ordered_on }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ selectedOrder.status }}</el-descriptions-item>
        </el-descriptions>
        <div class="drawer-actions">
          <el-button
            data-testid="purchase-order-edit"
            disabled
            title="采购单编辑后端尚未接入"
          >编辑</el-button>
          <el-button
            v-if="selectedOrder.status === 'draft'"
            data-testid="purchase-order-confirm"
            type="primary"
            :loading="actionBusy"
            :disabled="!canWrite"
            @click="confirmOrder"
          >确认采购单</el-button>
          <el-button
            data-testid="purchase-receipt-open"
            :disabled="!canWrite || !['confirmed', 'partially_received'].includes(selectedOrder.status)"
            @click="openReceiptDialog"
          >到货</el-button>
          <el-button
            data-testid="purchase-payment-open"
            disabled
            title="供应商付款后端尚未接入"
          >付款</el-button>
          <el-button
            data-testid="purchase-invoice-open"
            disabled
            title="进项发票后端尚未接入"
          >发票</el-button>
          <el-button
            data-testid="purchase-order-cancel-open"
            disabled
            title="采购单取消后端尚未接入"
          >取消采购单</el-button>
        </div>
        <p class="capability-note">编辑、付款、发票和取消尚未接入后端，当前不会保存。</p>
      </template>
    </el-drawer>

    <el-dialog
      v-model="receiptDialogVisible"
      data-testid="purchase-event-dialog"
      :teleported="false"
      title="确认到货"
      width="min(94vw, 640px)"
      :before-close="beforeReceiptDialogClose"
    >
      <el-form label-position="top" @submit.prevent="receiveGoods">
        <el-form-item label="到货日期" required>
          <el-input v-model="receiptForm.receivedOn" :disabled="actionBusy" />
        </el-form-item>
        <el-form-item label="仓库名称" required>
          <el-input
            v-model="receiptForm.warehouseName"
            data-testid="purchase-event-warehouse"
            :disabled="actionBusy"
          />
        </el-form-item>
        <el-form-item
          v-for="line in selectedOrder?.lines ?? []"
          :key="line.id"
          :label="`到货数量（采购单行 ${line.id}）`"
          required
        >
          <el-input
            v-model="receiptQuantities[line.id]"
            :data-testid="`purchase-event-quantity-${line.id}`"
            :disabled="actionBusy"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="receiptForm.notes" type="textarea" :disabled="actionBusy" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="actionBusy" @click="cancelReceiptDialog">取消</el-button>
          <el-button
            data-testid="purchase-event-submit"
            type="primary"
            native-type="submit"
            :loading="actionBusy"
            :disabled="actionBusy"
          >确认到货</el-button>
        </div>
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.procurement-workspace,
.record-block,
.record-list,
.overview-list {
  display: grid;
  gap: 16px;
}

.workspace-header,
.workspace-actions,
.record-heading,
.record-list li,
.overview-list div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-header h2,
.workspace-panel h3,
.record-block h4,
.eyebrow,
.state-message,
.secondary-text,
.overview-list {
  margin: 0;
}

.eyebrow {
  color: var(--el-color-success);
  font-size: 12px;
  font-weight: 700;
}

.workspace-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.workspace-panel {
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
}

.record-block {
  margin-top: 12px;
  gap: 10px;
}

.record-list {
  margin: 12px 0 0;
  padding: 0;
  gap: 10px;
  list-style: none;
}

.overview-list div {
  padding-block: 6px;
}

.overview-list dd {
  margin: 0;
  font-weight: 600;
}

.secondary-text,
.state-message,
.capability-note {
  color: var(--el-text-color-secondary);
}

.state-message {
  padding: 24px;
  text-align: center;
}

.capability-note {
  margin: 0;
  font-size: 13px;
}

.record-list li > div {
  display: grid;
  gap: 4px;
}

.dialog-actions,
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}

.drawer-actions {
  margin-top: 16px;
}

@media (max-width: 640px) {
  .workspace-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .workspace-actions {
    flex-wrap: wrap;
  }
}
</style>
