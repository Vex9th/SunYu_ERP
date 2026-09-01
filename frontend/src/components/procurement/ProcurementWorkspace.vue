<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import type { CompanyRecord, PagedResult } from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { centsToYuan, yuanToCents } from '../../domain/formatters'
import type {
  GoodsReceiptInput,
  ProcurementLineInput,
  ProcurementLineUpdateInput,
  ProcurementListDetailDto,
  ProcurementListInput,
  ProcurementListSummaryDto,
  ProcurementOverviewDto,
  PurchaseOrderDto,
  PurchaseOrderInput,
} from '../../domain/operations-api'
import type {
  ProcurementImportPreviewDto,
  PurchaseOrderRecordDto,
  PurchaseOrderUpdateInput,
  QuoteExportInput,
  SupplierInvoiceInput,
  SupplierPaymentInput,
} from '../../domain/procurement-extensions'
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
const procurementListPagination = reactive({ page: 1, pageSize: 100 })
const purchaseOrderPagination = reactive({ page: 1, pageSize: 100 })
const overview = ref<ProcurementOverviewDto | null>(null)
const actionError = ref<string | null>(null)
const actionBusy = ref(false)
const listDialogVisible = ref(false)
const lineDialogVisible = ref(false)
const orderDialogVisible = ref(false)
const orderDrawerVisible = ref(false)
const receiptDialogVisible = ref(false)
const importPreview = ref<ProcurementImportPreviewDto | null>(null)
const importFile = ref<File | null>(null)
const importProjectCode = ref<string | null>(null)
let importRepository: ProcurementHttpRepository | null = null
const importListName = ref('')
const editOrderDialogVisible = ref(false)
const cancelOrderDialogVisible = ref(false)
const paymentDialogVisible = ref(false)
const invoiceDialogVisible = ref(false)
const quoteDialogVisible = ref(false)
const importInput = ref<HTMLInputElement | null>(null)
const selectedLineListId = ref(0)
const selectedLineId = ref<number | null>(null)
const selectedOrderLine = ref<ProcurementListDetailDto['lines'][number] | null>(null)
const selectedOrder = ref<PurchaseOrderDto | null>(null)
const selectedOrderFacts = computed(() => selectedOrder.value as PurchaseOrderRecordDto | null)
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
interface PurchaseOrderLineEditDraft {
  id: number
  procurementLineId: number
  quantity: string
  unitCostYuan: string
  overageReason: string
  requirementQuantity: string | null
}

const editOrderForm = reactive({
  orderNo: '',
  supplierCompanyId: 0,
  orderedOn: '',
  expectedDeliveryOn: '',
  notes: '',
  lines: [] as PurchaseOrderLineEditDraft[],
})
const cancelOrderReason = ref('')
const paymentForm = reactive({ paidOn: localISODate(), amountYuan: '', paymentMethod: '银行转账', referenceNo: '', notes: '' })
const invoiceForm = reactive({ invoiceNo: '', invoicedOn: localISODate(), amountYuan: '', documentVersionIds: '' })
const quoteForm = reactive({ listId: 0, title: '', customerCompanyId: 0, notes: '' })
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
const procurementListPageCount = computed(() => pageCount(procurementListPage.value))
const purchaseOrderPageCount = computed(() => pageCount(purchaseOrderPage.value))

function pageCount(page: PagedResult<unknown> | null): number {
  if (!page || page.page_size <= 0) return 1
  return Math.max(1, Math.ceil(page.total / page.page_size))
}

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

function isSameActionTarget(context: ActionContext): boolean {
  return mounted
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

async function refreshAfterCommittedAction(
  context: ActionContext,
  refresh: () => Promise<void>,
  committedMessage = '操作已保存',
): Promise<void> {
  try {
    await refresh()
    if (isSameActionTarget(context) && loadError.value) {
      actionError.value = `${committedMessage}，但刷新失败：${loadError.value}`
    }
  } catch (error) {
    if (isSameActionTarget(context)) {
      actionError.value = `${committedMessage}，但刷新失败：${actionErrorMessage(error)}`
    }
  }
}

async function loadWorkspace(
  projectCode: string,
  repository: ProcurementHttpRepository = currentRepository(),
): Promise<void> {
  const currentGeneration = ++generation
  const listQuery = {
    page: procurementListPagination.page,
    page_size: procurementListPagination.pageSize,
  }
  const orderQuery = {
    page: purchaseOrderPagination.page,
    page_size: purchaseOrderPagination.pageSize,
  }
  clearWorkspace()
  loading.value = true
  try {
    const [companyResult, listResult, orderResult, overviewResult] = await Promise.all([
      repository.listSupplierCompanies(),
      repository.listProcurementLists(projectCode, listQuery),
      repository.listPurchaseOrders(projectCode, orderQuery),
      repository.getProcurementOverview(projectCode),
    ])
    if (!isCurrent(currentGeneration)) return
    const detailResults = await Promise.all(
      listResult.data.items.map((item) => repository.getProcurementList(projectCode, item.id)),
    )
    if (!isCurrent(currentGeneration)) return
    companies.value = companyResult.data
    procurementListPage.value = listResult.data
    procurementListPagination.page = listResult.data.page
    procurementListPagination.pageSize = listResult.data.page_size
    procurementLists.value = detailResults.map((result) => result.data)
    purchaseOrderPage.value = orderResult.data
    purchaseOrderPagination.page = orderResult.data.page
    purchaseOrderPagination.pageSize = orderResult.data.page_size
    overview.value = overviewResult.data
  } catch (error) {
    if (isCurrent(currentGeneration)) {
      loadError.value = error instanceof Error ? error.message : '采购数据读取失败'
    }
  } finally {
    if (isCurrent(currentGeneration)) loading.value = false
  }
}

function changeProcurementListPage(page: number): void {
  if (loading.value || page < 1 || page === procurementListPagination.page) return
  procurementListPagination.page = page
  void loadWorkspace(props.projectCode, currentRepository())
}

function changeProcurementListPageSize(pageSize: number): void {
  if (loading.value || pageSize < 1 || pageSize === procurementListPagination.pageSize) return
  procurementListPagination.page = 1
  procurementListPagination.pageSize = pageSize
  void loadWorkspace(props.projectCode, currentRepository())
}

function changePurchaseOrderPage(page: number): void {
  if (loading.value || page < 1 || page === purchaseOrderPagination.page) return
  purchaseOrderPagination.page = page
  void loadWorkspace(props.projectCode, currentRepository())
}

function changePurchaseOrderPageSize(pageSize: number): void {
  if (loading.value || pageSize < 1 || pageSize === purchaseOrderPagination.pageSize) return
  purchaseOrderPagination.page = 1
  purchaseOrderPagination.pageSize = pageSize
  void loadWorkspace(props.projectCode, currentRepository())
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
  editOrderDialogVisible.value = false
  cancelOrderDialogVisible.value = false
  paymentDialogVisible.value = false
  invoiceDialogVisible.value = false
  quoteDialogVisible.value = false
  if (importFile.value && importProjectCode.value && importRepository) {
    importRepository.discardPreviewProcurementImport(importProjectCode.value, importFile.value)
  }
  importFile.value = null
  importProjectCode.value = null
  importRepository = null
  importPreview.value = null
  importListName.value = ''
  selectedLineListId.value = 0
  selectedLineId.value = null
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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
  selectedLineId.value = null
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

function openEditLine(
  list: ProcurementListDetailDto,
  line: ProcurementListDetailDto['lines'][number],
): void {
  if (!canWrite.value || list.status !== 'draft') return
  lineDialogVersion += 1
  selectedLineListId.value = list.id
  selectedLineId.value = line.id
  Object.assign(lineForm, {
    sequenceNo: line.sequence_no,
    category: line.category,
    name: line.name,
    specification: line.specification ?? '',
    brand: line.brand ?? '',
    model: line.model ?? '',
    quantity: line.quantity,
    unit: line.unit,
    unitCostYuan: centsToYuan(line.unit_cost_cents),
    quotedUnitPriceYuan: centsToYuan(line.quoted_unit_price_cents),
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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

async function updateLine(): Promise<void> {
  if (actionBusy.value || selectedLineId.value === null) return
  const list = draftProcurementLists.value.find((item) => item.id === selectedLineListId.value)
  const line = list?.lines.find((item) => item.id === selectedLineId.value)
  const payload = linePayload()
  if (!list || !line || !payload) {
    if (!list || !line) actionError.value = '采购行已变更，请刷新后重试'
    return
  }
  const input: ProcurementLineUpdateInput = {
    ...payload,
    expected_revision: line.revision,
  }
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.updateProcurementLine(
      context.projectCode,
      list.id,
      line.id,
      input,
    )
    if (!isCurrentAction(context)) return
    lineDialogVisible.value = false
    selectedLineId.value = null
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function saveLine(): Promise<void> {
  return selectedLineId.value === null ? createLine() : updateLine()
}

async function deleteLine(
  list: ProcurementListDetailDto,
  line: ProcurementListDetailDto['lines'][number],
): Promise<void> {
  if (!canWrite.value || list.status !== 'draft') return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await ElMessageBox.confirm(
      `删除后无法恢复，确定删除“${line.name}”吗？`,
      '删除采购行',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
      },
    )
  } catch {
    if (isCurrentAction(context)) actionBusy.value = false
    return
  }
  if (!isCurrentAction(context)) return
  try {
    await context.repository.deleteProcurementLine(context.projectCode, list.id, line.id)
    if (!isCurrentAction(context)) return
    actionBusy.value = false
    await refreshAfterCommittedAction(
      context,
      () => loadWorkspace(context.projectCode, context.repository),
      '操作已删除',
    )
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
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

async function refreshSelectedOrder(context: ActionContext, orderId: number): Promise<void> {
  const detail = await context.repository.getPurchaseOrder(context.projectCode, orderId)
  if (!isCurrentAction(context)) return
  selectedOrder.value = detail.data
  await loadWorkspace(context.projectCode, context.repository)
  if (isSameActionTarget(context)) {
    selectedOrder.value = detail.data
  }
}

function openEditOrder(): void {
  const order = selectedOrder.value
  if (!order || order.status !== 'draft' || !canWrite.value) return
  Object.assign(editOrderForm, {
    orderNo: order.order_no,
    supplierCompanyId: order.supplier_company_id,
    orderedOn: order.ordered_on,
    expectedDeliveryOn: order.expected_delivery_on ?? '',
    notes: order.notes ?? '',
    lines: order.lines.map((line) => ({
      id: line.id,
      procurementLineId: line.procurement_line_id,
      quantity: line.quantity,
      unitCostYuan: centsToYuan(line.unit_cost_cents),
      overageReason: line.overage_reason ?? '',
      requirementQuantity: procurementLine(line.procurement_line_id)?.quantity ?? null,
    })),
  })
  actionError.value = null
  editOrderDialogVisible.value = true
}

function procurementLine(lineId: number): ProcurementListDetailDto['lines'][number] | null {
  for (const list of procurementLists.value) {
    const line = list.lines.find((item) => item.id === lineId)
    if (line) return line
  }
  return null
}

function procurementLineLabel(lineId: number): string {
  const line = procurementLine(lineId)
  return line ? `${line.name}（${line.specification ?? '无规格'}）` : `采购行 #${lineId}`
}

function orderUpdatePayload(order: PurchaseOrderDto): PurchaseOrderUpdateInput | null {
  if (!editOrderForm.orderNo.trim() || !editOrderForm.orderedOn) {
    actionError.value = '请填写采购单号和下单日期'
    return null
  }
  if (!companies.value.some((company) => company.id === editOrderForm.supplierCompanyId)) {
    actionError.value = '请选择有效供应商'
    return null
  }
  const lines: PurchaseOrderUpdateInput['lines'] = []
  for (const [index, draft] of editOrderForm.lines.entries()) {
    let quantityMilli: bigint
    try {
      quantityMilli = decimalToMilli(draft.quantity.trim())
    } catch {
      actionError.value = `第 ${index + 1} 行数量格式不正确`
      return null
    }
    if (quantityMilli <= 0n) {
      actionError.value = `第 ${index + 1} 行数量必须大于 0`
      return null
    }
    let unitCostCents: number
    try {
      unitCostCents = yuanToCents(draft.unitCostYuan)
    } catch {
      actionError.value = `第 ${index + 1} 行成本价必须是非负金额，最多两位小数`
      return null
    }
    const overageReason = optionalText(draft.overageReason)
    if (draft.requirementQuantity !== null
      && quantityMilli > decimalToMilli(draft.requirementQuantity)
      && !overageReason) {
      actionError.value = `第 ${index + 1} 行超采必须填写原因`
      return null
    }
    lines.push({
      procurement_line_id: draft.procurementLineId,
      quantity: milliToDecimal(quantityMilli),
      unit_cost_cents: unitCostCents,
      overage_reason: overageReason,
    })
  }
  return {
    order_no: editOrderForm.orderNo.trim(),
    supplier_company_id: editOrderForm.supplierCompanyId,
    ordered_on: editOrderForm.orderedOn,
    expected_delivery_on: optionalText(editOrderForm.expectedDeliveryOn),
    lines,
    notes: optionalText(editOrderForm.notes),
    document_version_ids: order.document_version_ids,
    expected_revision: order.revision,
  }
}

async function updateOrder(): Promise<void> {
  const order = selectedOrder.value
  if (!order || actionBusy.value) return
  const input = orderUpdatePayload(order)
  if (!input) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.updatePurchaseOrder(context.projectCode, order.id, input)
    if (!isCurrentAction(context)) return
    selectedOrder.value = result.data
    editOrderDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, order.id))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function openCancelOrder(): void {
  if (!selectedOrder.value || !['draft', 'confirmed'].includes(selectedOrder.value.status) || !canWrite.value) return
  cancelOrderReason.value = ''
  actionError.value = null
  cancelOrderDialogVisible.value = true
}

async function cancelOrder(): Promise<void> {
  const order = selectedOrder.value
  const reason = cancelOrderReason.value.trim()
  if (!order || actionBusy.value) return
  if (!reason) { actionError.value = '请填写取消原因'; return }
  const input = { reason, expected_revision: order.revision }
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.cancelPurchaseOrder(context.projectCode, order.id, input)
    if (!isCurrentAction(context)) return
    cancelOrderDialogVisible.value = false
    orderDrawerVisible.value = false
    selectedOrder.value = null
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function activeAllocatedAmount(
  order: PurchaseOrderRecordDto,
  lineId: number,
  fact: 'payment' | 'invoice',
): number {
  const records = fact === 'payment' ? order.supplier_payments ?? [] : order.supplier_invoices ?? []
  return records.filter((record) => record.status === 'active').flatMap((record) => record.allocations)
    .filter((allocation) => allocation.purchase_order_line_id === lineId)
    .reduce((total, allocation) => total + allocation.amount_cents, 0)
}

function allocateAmount(order: PurchaseOrderRecordDto, amount: number, fact: 'payment' | 'invoice') {
  let remaining = amount
  const allocations: Array<{ purchase_order_line_id: number; amount_cents: number }> = []
  for (const line of order.lines) {
    const capacity = Math.max(0, line.line_amount_cents - activeAllocatedAmount(order, line.id, fact))
    const allocated = Math.min(remaining, capacity)
    if (allocated > 0) allocations.push({ purchase_order_line_id: line.id, amount_cents: allocated })
    remaining -= allocated
  }
  if (remaining > 0) throw new Error(fact === 'payment' ? '付款金额超过采购单未付金额' : '开票金额超过采购单未开票金额')
  return allocations
}

function openPayment(): void {
  if (!selectedOrder.value || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.value.status) || !canWrite.value) return
  Object.assign(paymentForm, { paidOn: localISODate(), amountYuan: '', paymentMethod: '银行转账', referenceNo: '', notes: '' })
  actionError.value = null
  paymentDialogVisible.value = true
}

function paymentPayload(order: PurchaseOrderRecordDto): SupplierPaymentInput | null {
  try {
    const amount = yuanToCents(paymentForm.amountYuan)
    if (amount <= 0 || !paymentForm.paidOn || !paymentForm.paymentMethod.trim()) throw new Error('请填写有效的付款日期、金额和方式')
    return {
      paid_on: paymentForm.paidOn,
      amount_cents: amount,
      payment_method: paymentForm.paymentMethod.trim(),
      reference_no: optionalText(paymentForm.referenceNo),
      allocations: allocateAmount(order, amount, 'payment'),
      notes: optionalText(paymentForm.notes),
    }
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
}

async function createPayment(): Promise<void> {
  const order = selectedOrderFacts.value
  if (!order || actionBusy.value) return
  const input = paymentPayload(order)
  if (!input) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.createSupplierPayment(context.projectCode, order.id, input)
    if (!isCurrentAction(context)) return
    paymentDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, order.id))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function openInvoice(): void {
  if (!selectedOrder.value || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.value.status) || !canWrite.value) return
  Object.assign(invoiceForm, { invoiceNo: '', invoicedOn: localISODate(), amountYuan: '', documentVersionIds: '' })
  actionError.value = null
  invoiceDialogVisible.value = true
}

function documentVersionIds(value: string): number[] {
  if (!value.trim()) return []
  const values = value.split(/[,，\s]+/).filter(Boolean).map(Number)
  if (values.some((item) => !Number.isSafeInteger(item) || item <= 0) || new Set(values).size !== values.length) {
    throw new Error('附件版本号格式不正确')
  }
  return values
}

function invoicePayload(order: PurchaseOrderRecordDto): SupplierInvoiceInput | null {
  try {
    const amount = yuanToCents(invoiceForm.amountYuan)
    if (!invoiceForm.invoiceNo.trim() || !invoiceForm.invoicedOn || amount <= 0) throw new Error('请填写有效的发票号、开票日期和金额')
    return {
      invoice_no: invoiceForm.invoiceNo.trim(),
      invoiced_on: invoiceForm.invoicedOn,
      amount_cents: amount,
      allocations: allocateAmount(order, amount, 'invoice'),
      document_version_ids: documentVersionIds(invoiceForm.documentVersionIds),
    }
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
}

async function createInvoice(): Promise<void> {
  const order = selectedOrderFacts.value
  if (!order || actionBusy.value) return
  const input = invoicePayload(order)
  if (!input) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.createSupplierInvoice(context.projectCode, order.id, input)
    if (!isCurrentAction(context)) return
    invoiceDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, order.id))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

async function previewImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || actionBusy.value) {
    input.value = ''
    return
  }
  if (importFile.value && importProjectCode.value && importRepository && importFile.value !== file) {
    importRepository.discardPreviewProcurementImport(importProjectCode.value, importFile.value)
  }
  importFile.value = file
  importPreview.value = null
  importListName.value = file.name.replace(/\.xlsx$/i, '')
  const context = startAction()
  importProjectCode.value = context.projectCode
  importRepository = context.repository
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.previewProcurementImport(context.projectCode, file)
    if (!isCurrentAction(context)) return
    importPreview.value = result.data
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    input.value = ''
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

async function retryImportPreview(): Promise<void> {
  const file = importFile.value
  if (!file || actionBusy.value) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await context.repository.previewProcurementImport(context.projectCode, file)
    if (!isCurrentAction(context)) return
    importPreview.value = result.data
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function openImportPicker(): void {
  if (canWrite.value) importInput.value?.click()
}

async function confirmImport(): Promise<void> {
  const preview = importPreview.value
  if (!preview || preview.errors.length || actionBusy.value) return
  const listName = importListName.value.trim()
  if (!listName) { actionError.value = '请填写导入后的采购清单名称'; return }
  const input = { list_name: listName, expected_revision: preview.revision }
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.confirmProcurementImport(context.projectCode, preview.id, input)
    if (!isCurrentAction(context)) return
    importPreview.value = null
    importFile.value = null
    importProjectCode.value = null
    importRepository = null
    importListName.value = ''
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function openQuote(): void {
  const list = procurementLists.value.find((item) => item.status === 'confirmed')
  if (!list || companies.value.length === 0 || !canWrite.value) return
  Object.assign(quoteForm, {
    listId: list.id,
    title: `${list.name} 报价单`,
    customerCompanyId: companies.value[0]!.id,
    notes: '',
  })
  actionError.value = null
  quoteDialogVisible.value = true
}

async function createQuote(): Promise<void> {
  if (actionBusy.value || !quoteForm.listId || !quoteForm.title.trim() || !quoteForm.customerCompanyId) return
  const input: QuoteExportInput = {
    title: quoteForm.title.trim(), customer_company_id: quoteForm.customerCompanyId,
    notes: optionalText(quoteForm.notes),
  }
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const exported = await context.repository.createQuoteExport(context.projectCode, quoteForm.listId, input)
    const blob = await context.repository.downloadQuoteExport(context.projectCode, exported.data.id)
    if (!isCurrentAction(context)) return
    downloadBlob(blob, `quote-export-${exported.data.id}.xlsx`)
    quoteDialogVisible.value = false
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function downloadTemplate(): Promise<void> {
  if (!canWrite.value) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    const blob = await context.repository.downloadImportTemplate()
    if (!isCurrentAction(context)) return
    downloadBlob(blob, 'procurement-import-template.xlsx')
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
    procurementListPagination.page = 1
    purchaseOrderPagination.page = 1
    void loadWorkspace(projectCode, currentRepository())
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mounted = false
  generation += 1
  actionSequence += 1
  if (importFile.value && importProjectCode.value && importRepository) {
    importRepository.discardPreviewProcurementImport(importProjectCode.value, importFile.value)
  }
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
        <span data-testid="procurement-import-upload">
          <input ref="importInput" class="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="previewImport">
          <el-button data-testid="procurement-excel-import" :loading="actionBusy" :disabled="!canWrite" @click="openImportPicker">导入 Excel</el-button>
        </span>
        <el-button
          data-testid="procurement-quote-action"
          :disabled="!canWrite || !procurementLists.some((list) => list.status === 'confirmed') || companies.length === 0"
          @click="openQuote"
        >生成客户报价单</el-button>
      </div>
    </header>
    <p class="capability-note">Excel 会先预览校验，确认后才写入采购清单。</p>
    <div v-if="importFile && !importPreview && actionError" class="import-retry">
      <span>{{ importFile.name }} 的预览结果未知，可安全复用原请求重试。</span>
      <el-button data-testid="procurement-import-retry" :loading="actionBusy" @click="retryImportPreview">重试预览</el-button>
    </div>

    <el-card v-if="importPreview" shadow="never" class="import-preview" data-testid="procurement-import-preview">
      <template #header><strong>{{ importPreview.filename }} · 识别 {{ importPreview.rows.length }} 行</strong></template>
      <el-alert
        v-if="importPreview.errors.length"
        data-testid="procurement-import-errors"
        type="error"
        :closable="false"
        show-icon
      >
        <template #title>发现 {{ importPreview.errors.length }} 处错误，请修改 Excel 后重新选择文件</template>
        <ul class="import-errors">
          <li v-for="error in importPreview.errors" :key="`${error.row}-${error.column}-${error.field}`">
            第 {{ error.row }} 行，第 {{ error.column }} 列：{{ error.message }}
          </li>
        </ul>
      </el-alert>
      <div v-else class="import-confirm">
        <el-input v-model="importListName" data-testid="procurement-import-list-name" placeholder="导入后的采购清单名称" />
        <el-button data-testid="procurement-import-confirm" type="primary" :loading="actionBusy" @click="confirmImport">确认导入</el-button>
      </div>
    </el-card>

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
                <span v-if="list.status === 'draft'" class="line-actions">
                  <el-button
                    :data-testid="`procurement-line-edit-${line.id}`"
                    link
                    type="primary"
                    :disabled="!canWrite"
                    @click="openEditLine(list, line)"
                  >编辑</el-button>
                  <el-button
                    :data-testid="`procurement-line-delete-${line.id}`"
                    link
                    type="danger"
                    :loading="actionBusy"
                    :disabled="!canWrite"
                    @click="deleteLine(list, line)"
                  >删除</el-button>
                </span>
                <el-button
                  v-else-if="list.status === 'confirmed'"
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
          <footer v-if="procurementListPage" class="pagination-footer">
            <span class="secondary-text" data-testid="procurement-list-page-info">
              第 {{ procurementListPage.page }} / {{ procurementListPageCount }} 页，共 {{ procurementListPage.total }} 条
            </span>
            <el-pagination
              data-testid="procurement-list-pagination"
              background
              size="small"
              layout="sizes, prev, pager, next"
              :current-page="procurementListPage.page"
              :page-size="procurementListPage.page_size"
              :page-sizes="[20, 50, 100]"
              :total="procurementListPage.total"
              :disabled="loading || actionBusy"
              @current-change="changeProcurementListPage"
              @size-change="changeProcurementListPageSize"
            />
          </footer>
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
          <footer v-if="purchaseOrderPage" class="pagination-footer">
            <span class="secondary-text" data-testid="purchase-order-page-info">
              第 {{ purchaseOrderPage.page }} / {{ purchaseOrderPageCount }} 页，共 {{ purchaseOrderPage.total }} 条
            </span>
            <el-pagination
              data-testid="purchase-order-pagination"
              background
              size="small"
              layout="sizes, prev, pager, next"
              :current-page="purchaseOrderPage.page"
              :page-size="purchaseOrderPage.page_size"
              :page-sizes="[20, 50, 100]"
              :total="purchaseOrderPage.total"
              :disabled="loading || actionBusy"
              @current-change="changePurchaseOrderPage"
              @size-change="changePurchaseOrderPageSize"
            />
          </footer>
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
      :title="selectedLineId === null ? '新增采购行' : '编辑采购行'"
      width="min(94vw, 760px)"
      :before-close="beforeLineDialogClose"
    >
      <el-form label-position="top" @submit.prevent="saveLine">
        <el-form-item label="采购清单" required>
          <el-select v-model="selectedLineListId" style="width: 100%" :disabled="actionBusy || selectedLineId !== null">
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
              <el-input-number v-model="lineForm.sequenceNo" data-testid="procurement-line-sequence" :min="1" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="类别" required>
              <el-input v-model="lineForm.category" data-testid="procurement-line-category" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="名称" required>
              <el-input v-model="lineForm.name" data-testid="procurement-line-name" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="规格">
              <el-input v-model="lineForm.specification" data-testid="procurement-line-specification" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="品牌">
              <el-input v-model="lineForm.brand" data-testid="procurement-line-brand" :disabled="actionBusy" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="型号">
              <el-input v-model="lineForm.model" data-testid="procurement-line-model" :disabled="actionBusy" />
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
          >{{ selectedLineId === null ? '加入清单' : '保存修改' }}</el-button>
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
          <el-descriptions-item label="已付款">{{ centsToYuan(selectedOrderFacts?.paid_amount_cents ?? 0) }} 元</el-descriptions-item>
          <el-descriptions-item label="已开票">{{ centsToYuan(selectedOrderFacts?.invoiced_amount_cents ?? 0) }} 元</el-descriptions-item>
          <el-descriptions-item label="已到货">{{ centsToYuan(selectedOrderFacts?.received_amount_cents ?? 0) }} 元</el-descriptions-item>
        </el-descriptions>
        <div class="drawer-actions">
          <el-button
            data-testid="purchase-order-edit"
            :disabled="!canWrite || selectedOrder.status !== 'draft'"
            @click="openEditOrder"
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
            :disabled="!canWrite || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
            @click="openPayment"
          >付款</el-button>
          <el-button
            data-testid="purchase-invoice-open"
            :disabled="!canWrite || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
            @click="openInvoice"
          >发票</el-button>
          <el-button
            data-testid="purchase-order-cancel-open"
            :disabled="!canWrite || !['draft', 'confirmed'].includes(selectedOrder.status)"
            @click="openCancelOrder"
          >取消采购单</el-button>
        </div>
        <el-empty
          v-if="(selectedOrderFacts?.supplier_payments?.length ?? 0) === 0 && (selectedOrderFacts?.supplier_invoices?.length ?? 0) === 0"
          description="暂无付款或进项票记录"
        />
        <ul v-else class="record-list fact-list">
          <li v-for="payment in selectedOrderFacts?.supplier_payments ?? []" :key="`payment-${payment.id}`">
            <span>付款 {{ payment.paid_on }} · {{ centsToYuan(payment.amount_cents) }} 元</span><el-tag :type="payment.status === 'active' ? 'success' : 'info'">{{ payment.status === 'active' ? '有效' : '已冲销' }}</el-tag>
          </li>
          <li v-for="invoice in selectedOrderFacts?.supplier_invoices ?? []" :key="`invoice-${invoice.id}`">
            <span>发票 {{ invoice.invoice_no }} · {{ centsToYuan(invoice.amount_cents) }} 元</span><el-tag :type="invoice.status === 'active' ? 'success' : 'info'">{{ invoice.status === 'active' ? '有效' : '已冲销' }}</el-tag>
          </li>
        </ul>
      </template>
    </el-drawer>

    <el-dialog v-model="editOrderDialogVisible" data-testid="purchase-order-edit-dialog" :teleported="false" title="编辑采购单" width="min(94vw, 760px)">
      <el-form label-position="top" @submit.prevent="updateOrder">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="采购单号" required><el-input v-model="editOrderForm.orderNo" data-testid="purchase-order-edit-number" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="供应商" required><el-select v-model="editOrderForm.supplierCompanyId" style="width: 100%"><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="company.id" /></el-select></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="下单日期" required><el-input v-model="editOrderForm.orderedOn" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="预计到货日期"><el-input v-model="editOrderForm.expectedDeliveryOn" /></el-form-item></el-col>
        </el-row>
        <el-scrollbar max-height="45vh">
          <section v-for="(line, index) in editOrderForm.lines" :key="line.id" class="order-line-editor">
            <strong>{{ index + 1 }}. {{ procurementLineLabel(line.procurementLineId) }}</strong>
            <el-row :gutter="14">
              <el-col :xs="24" :sm="8">
                <el-form-item label="采购数量" required>
                  <el-input v-model="line.quantity" :data-testid="`purchase-order-edit-line-quantity-${line.id}`" inputmode="decimal" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="成本价（元）" required>
                  <el-input v-model="line.unitCostYuan" :data-testid="`purchase-order-edit-line-cost-${line.id}`" inputmode="decimal" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="超采原因">
                  <el-input v-model="line.overageReason" :data-testid="`purchase-order-edit-line-overage-${line.id}`" placeholder="数量超过清单时必填" />
                </el-form-item>
              </el-col>
            </el-row>
          </section>
        </el-scrollbar>
        <el-form-item label="备注"><el-input v-model="editOrderForm.notes" type="textarea" /></el-form-item>
        <el-alert title="只有草稿采购单可编辑；数量超过采购清单时必须填写超采原因。" type="info" :closable="false" />
        <div class="dialog-actions"><el-button @click="editOrderDialogVisible = false">取消</el-button><el-button data-testid="purchase-order-edit-submit" type="primary" native-type="submit" :loading="actionBusy">保存修改</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="cancelOrderDialogVisible" data-testid="purchase-order-cancel-dialog" :teleported="false" title="取消采购单" width="min(92vw, 520px)">
      <el-form label-position="top" @submit.prevent="cancelOrder"><el-alert title="已有付款、发票或到货的采购单不能直接取消。" type="warning" :closable="false" /><el-form-item label="取消原因" required><el-input v-model="cancelOrderReason" data-testid="purchase-cancel-reason" type="textarea" /></el-form-item><div class="dialog-actions"><el-button @click="cancelOrderDialogVisible = false">返回</el-button><el-button data-testid="purchase-cancel-submit" type="danger" native-type="submit" :loading="actionBusy">确认取消</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="paymentDialogVisible" data-testid="purchase-payment-dialog" :teleported="false" title="登记供应商付款" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="createPayment"><el-row :gutter="14">
        <el-col :xs="24" :sm="12"><el-form-item label="付款日期" required><el-date-picker v-model="paymentForm.paidOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="付款金额（元）" required><el-input v-model="paymentForm.amountYuan" data-testid="purchase-payment-amount" inputmode="decimal" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="付款方式" required><el-input v-model="paymentForm.paymentMethod" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="付款参考号"><el-input v-model="paymentForm.referenceNo" /></el-form-item></el-col>
      </el-row><el-form-item label="备注"><el-input v-model="paymentForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button @click="paymentDialogVisible = false">取消</el-button><el-button data-testid="purchase-payment-submit" type="primary" native-type="submit" :loading="actionBusy">保存付款</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="invoiceDialogVisible" data-testid="purchase-invoice-dialog" :teleported="false" title="登记进项发票" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="createInvoice"><el-row :gutter="14">
        <el-col :xs="24" :sm="12"><el-form-item label="发票号" required><el-input v-model="invoiceForm.invoiceNo" data-testid="purchase-invoice-number" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="开票日期" required><el-date-picker v-model="invoiceForm.invoicedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="发票金额（元）" required><el-input v-model="invoiceForm.amountYuan" data-testid="purchase-invoice-amount" inputmode="decimal" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="附件版本号"><el-input v-model="invoiceForm.documentVersionIds" placeholder="多个编号用逗号分隔" /></el-form-item></el-col>
      </el-row><div class="dialog-actions"><el-button @click="invoiceDialogVisible = false">取消</el-button><el-button data-testid="purchase-invoice-submit" type="primary" native-type="submit" :loading="actionBusy">保存发票</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="quoteDialogVisible" data-testid="procurement-quote-dialog" :teleported="false" title="生成隐藏成本价的客户报价单" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="createQuote"><el-form-item label="已确认采购清单" required><el-select v-model="quoteForm.listId" style="width: 100%"><el-option v-for="list in procurementLists.filter((item) => item.status === 'confirmed')" :key="list.id" :label="list.name" :value="list.id" /></el-select></el-form-item><el-form-item label="报价单标题" required><el-input v-model="quoteForm.title" data-testid="procurement-quote-title" /></el-form-item><el-form-item label="客户公司" required><el-select v-model="quoteForm.customerCompanyId" style="width: 100%"><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="company.id" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model="quoteForm.notes" type="textarea" /></el-form-item><el-alert title="导出的 Excel 仅包含报价单价，不包含成本价。" type="success" :closable="false" /><div class="dialog-actions"><el-button @click="quoteDialogVisible = false">取消</el-button><el-button data-testid="procurement-quote-submit" type="primary" native-type="submit" :loading="actionBusy">生成并下载</el-button></div></el-form>
    </el-dialog>

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

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.import-preview { margin-bottom: 16px; }
.import-errors { margin: 8px 0 0; padding-left: 20px; }
.import-confirm { display: flex; align-items: center; gap: 12px; }
.import-retry { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; color: var(--el-text-color-secondary); }
.fact-list { margin-top: 20px; }

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

.line-actions {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
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

.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}

.order-line-editor {
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
}

.order-line-editor strong {
  display: block;
  margin-bottom: 10px;
}

@media (max-width: 640px) {
  .workspace-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .workspace-actions {
    flex-wrap: wrap;
  }

  .pagination-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .import-confirm, .import-retry { align-items: stretch; flex-direction: column; }
}
</style>
