<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, reactive, ref, shallowRef, triggerRef, watch } from 'vue'

import DragUploadField from '../common/DragUploadField.vue'
import BusinessAttachmentLinks from '../common/BusinessAttachmentLinks.vue'
import BusinessAttachmentUpload from '../common/BusinessAttachmentUpload.vue'
import { ApiError } from '../../api'
import type { CompanyRecord, PagedResult } from '../../domain/contracts'
import { formatChineseDateTime, localISODate } from '../../domain/dates'
import { centsToYuan, formatMoney, yuanToCents } from '../../domain/formatters'
import type {
  GoodsReceiptInput,
  GoodsReceiptReversalInput,
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
  QuoteExportDto,
  QuoteExportInput,
  SupplierInvoiceDto,
  SupplierInvoiceInput,
  SupplierPaymentDto,
  SupplierPaymentInput,
  SupplierRecordReversalInput,
} from '../../domain/procurement-extensions'
import {
  createHttpProcurementRepository,
  type ProcurementHttpRepository,
} from '../../repositories/procurement.live'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'
import {
  clearPendingWrite,
  defaultProcurementPendingOwner,
  getPendingWrite,
  procurementPendingKey,
  setPendingWrite,
} from '../../pendingWriteRegistry'

const props = withDefaults(defineProps<{
  projectCode: string
  customerCompany?: { id: number; name: string }
  repository?: ProcurementHttpRepository
  readonly?: boolean
}>(), {
  readonly: false,
})
const emit = defineEmits<{ changed: [] }>()

const defaultRepository = createHttpProcurementRepository()
const pendingOwner = shallowRef<object>(props.repository ?? defaultProcurementPendingOwner)
const loading = ref(false)
const loadError = ref<string | null>(null)
const companiesLoadError = ref<string | null>(null)
const procurementListsLoadError = ref<string | null>(null)
const purchaseOrdersLoadError = ref<string | null>(null)
const overviewLoadError = ref<string | null>(null)
const companies = ref<CompanyRecord[]>([])
const procurementLists = ref<ProcurementListDetailDto[]>([])
const procurementListPage = ref<PagedResult<ProcurementListSummaryDto> | null>(null)
const purchaseOrderPage = ref<PagedResult<PurchaseOrderDto> | null>(null)
const procurementListPagination = reactive({ page: 1, pageSize: 100 })
const purchaseOrderPagination = reactive({ page: 1, pageSize: 100 })
const overview = ref<ProcurementOverviewDto | null>(null)
const documentOptions = ref<DocumentVersionOption[]>([])
const documentOptionsError = ref<string | null>(null)
const quoteExports = ref<QuoteExportDto[]>([])
const quoteExportsError = ref<string | null>(null)
const quoteExportsLoading = ref(false)
const quoteDownloadBusyId = ref<number | null>(null)
const actionError = ref<string | null>(null)
const invoiceError = ref<string | null>(null)
const actionBusy = ref(false)
const listDialogVisible = ref(false)
const lineDialogVisible = ref(false)
const orderDialogVisible = ref(false)
const orderDrawerVisible = ref(false)
const receiptDialogVisible = ref(false)
const receiptReverseDialogVisible = ref(false)
const supplierFactReverseDialogVisible = ref(false)
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
const selectedLineListId = ref(0)
const selectedLineId = ref<number | null>(null)
const selectedOrderLine = ref<ProcurementListDetailDto['lines'][number] | null>(null)
const selectedOrderLineIds = ref<number[]>([])
const selectedOrder = ref<PurchaseOrderDto | null>(null)
const selectedReceipt = ref<NonNullable<PurchaseOrderRecordDto['goods_receipts']>[number] | null>(null)
type SupplierFactReverseTarget =
  | { kind: 'payment'; record: SupplierPaymentDto }
  | { kind: 'invoice'; record: SupplierInvoiceDto }
const selectedSupplierFact = ref<SupplierFactReverseTarget | null>(null)
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
const orderForm = reactive<{
  orderNo: string
  supplierCompanyId: number | null
  orderedOn: string
  expectedDeliveryOn: string
  notes: string
  documentVersionIds: number[]
}>({
  orderNo: '',
  supplierCompanyId: null,
  orderedOn: localISODate(),
  expectedDeliveryOn: '',
  notes: '',
  documentVersionIds: [] as number[],
})
const orderFiles = ref<File[]>([])
interface PurchaseOrderLineCreateDraft {
  quantity: string
  unitCostYuan: string
  overageReason: string
}
const orderLineDrafts = reactive<Record<number, PurchaseOrderLineCreateDraft>>({})
const receiptForm = reactive({
  receivedOn: localISODate(),
  warehouseName: '',
  notes: '',
})
const receiptQuantities = reactive<Record<number, string>>({})
const receiptReverseReason = ref('')
const supplierFactReverseReason = ref('')
interface PendingQuoteDownload {
  projectCode: string
  exportId: number
  listId: number
  listName: string
  customerName: string
  input: QuoteExportInput
}
const pendingQuoteDownload = ref<PendingQuoteDownload | null>(null)
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
const invoiceForm = reactive({ invoiceNo: '', invoicedOn: localISODate(), amountYuan: '' })
const invoiceFiles = ref<File[]>([])
const quoteForm = reactive({ listId: 0, title: '', customerCompanyId: 0, notes: '' })
let generation = 0
let mounted = true
let actionSequence = 0
let loadedProjectCode: string | null = null
let loadedRepository: ProcurementHttpRepository | null = null
let listDialogVersion = 0
let lineDialogVersion = 0
let orderDialogVersion = 0
let receiptDialogVersion = 0
let paymentDialogVersion = 0

interface ActionContext {
  sequence: number
  generation: number
  projectCode: string
  repository: ProcurementHttpRepository
  owner: object
}

interface PendingInvoiceSubmission {
  owner: object
  key: string
  projectCode: string
  repository: ProcurementHttpRepository
  orderId: number
  input: SupplierInvoiceInput
  files: File[]
  inFlight: boolean
  committed: boolean
}

const pendingInvoiceSubmission = shallowRef<PendingInvoiceSubmission | null>(null)

interface PendingPaymentSubmission {
  owner: object
  key: string
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  orderId: number
  input: SupplierPaymentInput
  inFlight: boolean
  committed: boolean
}

const pendingPaymentSubmission = shallowRef<PendingPaymentSubmission | null>(null)

interface PendingListCreate {
  owner: object
  key: string
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  input: ProcurementListInput
  inFlight: boolean
  committed: boolean
}

interface PendingLineCreate {
  owner: object
  key: string
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  listId: number
  input: ProcurementLineInput
  inFlight: boolean
  committed: boolean
}

interface PendingOrderCreate {
  owner: object
  key: string
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  input: PurchaseOrderInput
  files: readonly File[]
  inFlight: boolean
  committed: boolean
}

interface PendingReceiptCreate {
  owner: object
  key: string
  dialogVersion: number
  projectCode: string
  repository: ProcurementHttpRepository
  orderId: number
  input: GoodsReceiptInput
  inFlight: boolean
  committed: boolean
}

const pendingListCreates = new Set<PendingListCreate>()
const pendingLineCreates = new Set<PendingLineCreate>()
const pendingOrderCreates = new Set<PendingOrderCreate>()
const pendingReceiptCreates = new Set<PendingReceiptCreate>()
const recoverableListCreate = shallowRef<PendingListCreate | null>(null)
const recoverableLineCreate = shallowRef<PendingLineCreate | null>(null)
const recoverableOrderCreate = shallowRef<PendingOrderCreate | null>(null)
const recoverableReceiptCreate = shallowRef<PendingReceiptCreate | null>(null)

const purchaseOrders = computed(() => purchaseOrderPage.value?.items ?? [])
const projectCustomer = computed(() => props.customerCompany ?? null)
const currentListCreate = computed(pendingListForCurrentContext)
const currentLineCreate = computed(pendingLineForCurrentContext)
const currentOrderCreate = computed(pendingOrderForCurrentContext)
const currentReceiptCreate = computed(pendingReceiptForCurrentContext)
const currentPaymentSubmission = computed(pendingPaymentForCurrentContext)
const currentInvoiceSubmission = computed(pendingInvoiceForCurrentContext)
const listCreateBusy = computed(() => Boolean(pendingListForCurrentContext()?.inFlight))
const lineCreateBusy = computed(() => Boolean(pendingLineForCurrentContext()?.inFlight))
const orderCreateBusy = computed(() => Boolean(pendingOrderForCurrentContext()?.inFlight))
const receiptCreateBusy = computed(() => Boolean(pendingReceiptForCurrentContext()?.inFlight))
const paymentSubmissionBusy = computed(() => Boolean(pendingPaymentForCurrentContext()?.inFlight))
const invoiceSubmissionBusy = computed(() => Boolean(pendingInvoiceForCurrentContext()?.inFlight))
const recoverablePaymentSubmission = computed(() => {
  const pending = pendingPaymentForCurrentContext()
  return pending
    && pending.projectCode === props.projectCode
    && pending.owner === pendingOwner.value
    && !pending.inFlight
    && !pending.committed
    ? pending
    : null
})
const recoverableInvoiceSubmission = computed(() => {
  const pending = pendingInvoiceForCurrentContext()
  return pending
    && pending.projectCode === props.projectCode
    && pending.owner === pendingOwner.value
    && !pending.inFlight
    && !pending.committed
    ? pending
    : null
})
const recoverableQuoteDownload = computed(() => (
  pendingQuoteDownload.value?.projectCode === props.projectCode
    ? pendingQuoteDownload.value
    : null
))
const draftProcurementLists = computed(() => procurementLists.value.filter((list) => list.status === 'draft'))
const availableOrderLines = computed(() => procurementLists.value.flatMap((list) => (
  list.status === 'confirmed'
    ? list.lines.filter(hasRemainingProcurementQuantity).map((line) => ({ list, line }))
    : []
)))
const canWrite = computed(() => !props.readonly && !loading.value && !loadError.value && !actionBusy.value)
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
  documentOptions.value = []
  documentOptionsError.value = null
  quoteExports.value = []
  quoteExportsError.value = null
  quoteExportsLoading.value = false
  quoteDownloadBusyId.value = null
  loadError.value = null
  companiesLoadError.value = null
  procurementListsLoadError.value = null
  purchaseOrdersLoadError.value = null
  overviewLoadError.value = null
}

function clearWorkspaceErrors(): void {
  loadError.value = null
  companiesLoadError.value = null
  procurementListsLoadError.value = null
  purchaseOrdersLoadError.value = null
  overviewLoadError.value = null
  documentOptionsError.value = null
  quoteExportsError.value = null
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
    && context.owner === pendingOwner.value
}

function isSameActionTarget(context: ActionContext): boolean {
  return mounted
    && context.sequence === actionSequence
    && context.projectCode === props.projectCode
    && context.owner === pendingOwner.value
}

function startAction(): ActionContext {
  return {
    sequence: ++actionSequence,
    generation,
    projectCode: props.projectCode,
    repository: currentRepository(),
    owner: pendingOwner.value,
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

function isDefinitiveClientRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function pendingListForCurrentContext(): PendingListCreate | null {
  return getPendingWrite<PendingListCreate>(pendingOwner.value, procurementPendingKey('list', props.projectCode))
}

function pendingLineForCurrentContext(): PendingLineCreate | null {
  return getPendingWrite<PendingLineCreate>(pendingOwner.value, procurementPendingKey('line', props.projectCode))
}

function pendingOrderForCurrentContext(): PendingOrderCreate | null {
  return getPendingWrite<PendingOrderCreate>(pendingOwner.value, procurementPendingKey('order', props.projectCode))
}

function pendingReceiptForCurrentContext(): PendingReceiptCreate | null {
  return getPendingWrite<PendingReceiptCreate>(pendingOwner.value, procurementPendingKey('receipt', props.projectCode))
}

function pendingPaymentForCurrentContext(): PendingPaymentSubmission | null {
  return getPendingWrite<PendingPaymentSubmission>(pendingOwner.value, procurementPendingKey('payment', props.projectCode))
}

function pendingInvoiceForCurrentContext(): PendingInvoiceSubmission | null {
  return getPendingWrite<PendingInvoiceSubmission>(pendingOwner.value, procurementPendingKey('invoice', props.projectCode))
}

function syncCurrentPendingRefs(): void {
  const list = pendingListForCurrentContext()
  const line = pendingLineForCurrentContext()
  const order = pendingOrderForCurrentContext()
  const receipt = pendingReceiptForCurrentContext()
  const payment = pendingPaymentForCurrentContext()
  const invoice = pendingInvoiceForCurrentContext()
  recoverableListCreate.value = list && !list.inFlight && !list.committed ? list : null
  recoverableLineCreate.value = line && !line.inFlight && !line.committed ? line : null
  recoverableOrderCreate.value = order && !order.inFlight && !order.committed ? order : null
  recoverableReceiptCreate.value = receipt && !receipt.inFlight && !receipt.committed ? receipt : null
  pendingPaymentSubmission.value = payment
  pendingInvoiceSubmission.value = invoice
}

function restoreListSubmission(pending: PendingListCreate): void {
  listDialogVersion = pending.dialogVersion
  Object.assign(listForm, { name: pending.input.name, notes: pending.input.notes ?? '' })
  listDialogVisible.value = true
}

function restoreLineSubmission(pending: PendingLineCreate): void {
  lineDialogVersion = pending.dialogVersion
  selectedLineListId.value = pending.listId
  selectedLineId.value = null
  Object.assign(lineForm, {
    sequenceNo: pending.input.sequence_no,
    category: pending.input.category,
    name: pending.input.name,
    specification: pending.input.specification ?? '',
    brand: pending.input.brand ?? '',
    model: pending.input.model ?? '',
    quantity: pending.input.quantity,
    unit: pending.input.unit,
    unitCostYuan: centsToYuan(pending.input.unit_cost_cents),
    quotedUnitPriceYuan: centsToYuan(pending.input.quoted_unit_price_cents),
  })
  lineDialogVisible.value = true
}

function restoreOrderSubmission(pending: PendingOrderCreate): void {
  orderDialogVersion = pending.dialogVersion
  Object.assign(orderForm, {
    orderNo: pending.input.order_no,
    supplierCompanyId: pending.input.supplier_company_id,
    orderedOn: pending.input.ordered_on,
    expectedDeliveryOn: pending.input.expected_delivery_on ?? '',
    notes: pending.input.notes ?? '',
    documentVersionIds: [...pending.input.document_version_ids],
  })
  selectedOrderLineIds.value = pending.input.lines.map((line) => line.procurement_line_id)
  for (const key of Object.keys(orderLineDrafts)) delete orderLineDrafts[Number(key)]
  for (const line of pending.input.lines) {
    orderLineDrafts[line.procurement_line_id] = {
      quantity: line.quantity,
      unitCostYuan: centsToYuan(line.unit_cost_cents),
      overageReason: line.overage_reason ?? '',
    }
  }
  orderFiles.value = pending.files as File[]
  orderDialogVisible.value = true
}

function restoreReceiptSubmission(pending: PendingReceiptCreate): void {
  receiptDialogVersion = pending.dialogVersion
  Object.assign(receiptForm, {
    receivedOn: pending.input.received_on,
    warehouseName: pending.input.warehouse_name,
    notes: pending.input.notes ?? '',
  })
  for (const key of Object.keys(receiptQuantities)) delete receiptQuantities[Number(key)]
  for (const line of pending.input.lines) receiptQuantities[line.purchase_order_line_id] = line.quantity
  receiptDialogVisible.value = true
}

function restorePaymentSubmission(pending: PendingPaymentSubmission): void {
  paymentDialogVersion = pending.dialogVersion
  Object.assign(paymentForm, {
    paidOn: pending.input.paid_on,
    amountYuan: centsToYuan(pending.input.amount_cents),
    paymentMethod: pending.input.payment_method,
    referenceNo: pending.input.reference_no ?? '',
    notes: pending.input.notes ?? '',
  })
  paymentDialogVisible.value = true
}

function restoreInvoiceSubmission(pending: PendingInvoiceSubmission): void {
  Object.assign(invoiceForm, {
    invoiceNo: pending.input.invoice_no,
    invoicedOn: pending.input.invoiced_on,
    amountYuan: centsToYuan(pending.input.amount_cents),
  })
  invoiceFiles.value = pending.files
  invoiceDialogVisible.value = true
}

function consumeCommittedPendingWrites(): boolean {
  const committed = [
    pendingListForCurrentContext(),
    pendingLineForCurrentContext(),
    pendingOrderForCurrentContext(),
    pendingReceiptForCurrentContext(),
    pendingPaymentForCurrentContext(),
    pendingInvoiceForCurrentContext(),
  ].filter((pending) => pending?.committed)
  if (committed.length === 0) return false
  for (const pending of committed) {
    if (pending) clearPendingWrite(pending.owner, pending.key, pending)
  }
  syncCurrentPendingRefs()
  listDialogVisible.value = false
  lineDialogVisible.value = false
  orderDialogVisible.value = false
  receiptDialogVisible.value = false
  paymentDialogVisible.value = false
  invoiceDialogVisible.value = false
  emit('changed')
  void loadWorkspace(props.projectCode, currentRepository())
  return true
}

async function restoreOrderBoundPendingWrites(): Promise<void> {
  const owner = pendingOwner.value
  const projectCode = props.projectCode
  const candidates = [
    pendingReceiptForCurrentContext(),
    pendingPaymentForCurrentContext(),
    pendingInvoiceForCurrentContext(),
  ].filter((pending) => pending && !pending.committed)
  for (const pending of candidates) {
    if (!pending) continue
    try {
      const detail = await pending.repository.getPurchaseOrder(pending.projectCode, pending.orderId)
      if (!mounted || owner !== pendingOwner.value || projectCode !== props.projectCode) return
      if (getPendingWrite(pending.owner, pending.key) !== pending || pending.committed) continue
      selectedOrder.value = detail.data
      orderDrawerVisible.value = true
      if ('received_on' in pending.input) {
        restoreReceiptSubmission(pending as PendingReceiptCreate)
      } else if ('paid_on' in pending.input) {
        restorePaymentSubmission(pending as PendingPaymentSubmission)
      } else {
        restoreInvoiceSubmission(pending as PendingInvoiceSubmission)
      }
    } catch (error) {
      if (owner === pendingOwner.value && projectCode === props.projectCode) {
        actionError.value = `原请求仍已保留，但采购单详情恢复失败：${actionErrorMessage(error)}`
      }
    }
  }
}

function restoreCurrentPendingWrites(): void {
  syncCurrentPendingRefs()
  if (actionBusy.value || consumeCommittedPendingWrites()) return
  const list = pendingListForCurrentContext()
  const line = pendingLineForCurrentContext()
  const order = pendingOrderForCurrentContext()
  if (list && !list.committed) restoreListSubmission(list)
  if (line && !line.committed) restoreLineSubmission(line)
  if (order && !order.committed) restoreOrderSubmission(order)
  void restoreOrderBoundPendingWrites()
}

async function loadDocumentOptions(
  projectCode: string,
  repository: ProcurementHttpRepository,
  targetGeneration: number,
): Promise<void> {
  if (!repository.listDocumentVersionOptions) return
  try {
    const options = await repository.listDocumentVersionOptions(projectCode)
    if (!isCurrent(targetGeneration)) return
    documentOptions.value = options
    documentOptionsError.value = null
  } catch (error) {
    if (!isCurrent(targetGeneration)) return
    documentOptionsError.value = `已有资料读取失败，当前显示上次结果：${actionErrorMessage(error)}`
  }
}

async function loadQuoteExports(
  projectCode: string,
  repository: ProcurementHttpRepository,
  targetGeneration: number,
): Promise<void> {
  if (!repository.listQuoteExports) return
  quoteExportsLoading.value = true
  try {
    const result = await repository.listQuoteExports(projectCode, { page: 1, page_size: 50 })
    if (!isCurrent(targetGeneration)) return
    quoteExports.value = result.data.items
    quoteExportsError.value = null
  } catch (error) {
    if (!isCurrent(targetGeneration)) return
    quoteExportsError.value = `报价单历史读取失败，当前显示上次结果：${actionErrorMessage(error)}`
  } finally {
    if (isCurrent(targetGeneration)) quoteExportsLoading.value = false
  }
}

async function refreshAfterCommittedAction(
  context: ActionContext,
  refresh: () => Promise<void>,
  committedMessage = '操作已保存',
): Promise<void> {
  emit('changed')
  try {
    await refresh()
    const refreshError = loadError.value
      ?? procurementListsLoadError.value
      ?? purchaseOrdersLoadError.value
      ?? overviewLoadError.value
      ?? companiesLoadError.value
    if (isSameActionTarget(context) && refreshError) {
      actionError.value = `${committedMessage}，但刷新失败：${refreshError}`
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
  const sameWorkspace = projectCode === loadedProjectCode && repository === loadedRepository
  if (sameWorkspace) clearWorkspaceErrors()
  else clearWorkspace()
  loadedProjectCode = projectCode
  loadedRepository = repository
  loading.value = true
  void loadDocumentOptions(projectCode, repository, currentGeneration)
  void loadQuoteExports(projectCode, repository, currentGeneration)
  try {
    const results = await Promise.allSettled([
      repository.listSupplierCompanies(),
      repository.listProcurementLists(projectCode, listQuery),
      repository.listPurchaseOrders(projectCode, orderQuery),
      repository.getProcurementOverview(projectCode),
    ])
    if (!isCurrent(currentGeneration)) return
    const errorText = (result: PromiseRejectedResult, label: string) => (
      `${label}读取失败：${actionErrorMessage(result.reason)}`
    )

    const companyResult = results[0]
    if (companyResult?.status === 'fulfilled') companies.value = companyResult.value.data
    else if (companyResult) companiesLoadError.value = errorText(companyResult, sameWorkspace ? '往来单位（当前显示上次结果）' : '往来单位')

    const orderResult = results[2]
    if (orderResult?.status === 'fulfilled') {
      purchaseOrderPage.value = orderResult.value.data
      purchaseOrderPagination.page = orderResult.value.data.page
      purchaseOrderPagination.pageSize = orderResult.value.data.page_size
    } else if (orderResult) purchaseOrdersLoadError.value = errorText(orderResult, sameWorkspace ? '采购单（当前显示上次结果）' : '采购单')

    const overviewResult = results[3]
    if (overviewResult?.status === 'fulfilled') overview.value = overviewResult.value.data
    else if (overviewResult) overviewLoadError.value = errorText(overviewResult, sameWorkspace ? '采购概览（当前显示上次结果）' : '采购概览')

    const listResult = results[1]
    if (listResult?.status === 'fulfilled') {
      procurementListPage.value = listResult.value.data
      procurementListPagination.page = listResult.value.data.page
      procurementListPagination.pageSize = listResult.value.data.page_size
      const detailResults = await Promise.allSettled(
        listResult.value.data.items.map((item) => repository.getProcurementList(projectCode, item.id)),
      )
      if (!isCurrent(currentGeneration)) return
      const previousLists = new Map(procurementLists.value.map((list) => [list.id, list]))
      procurementLists.value = detailResults.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [result.value.data]
        const summary = listResult.value.data.items[index]
        const previous = summary ? previousLists.get(summary.id) : undefined
        return previous ? [previous] : []
      })
      const failedDetail = detailResults.find((result) => result.status === 'rejected')
      if (failedDetail?.status === 'rejected') {
        procurementListsLoadError.value = errorText(
          failedDetail,
          sameWorkspace ? '部分采购清单详情（当前显示上次结果）' : '部分采购清单详情',
        )
      }
    } else if (listResult) procurementListsLoadError.value = errorText(listResult, sameWorkspace ? '采购清单（当前显示上次结果）' : '采购清单')

    if (results.every((result) => result.status === 'rejected')) {
      loadError.value = '采购数据全部读取失败，请检查本地服务后重试'
    }
  } catch (error) {
    if (isCurrent(currentGeneration)) {
      loadError.value = error instanceof Error ? error.message : '采购数据读取失败'
    }
  } finally {
    if (isCurrent(currentGeneration)) {
      loading.value = false
      restoreCurrentPendingWrites()
    }
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

function abandonListCreate(pending: PendingListCreate): boolean {
  const discarded = pending.repository.discardCreateProcurementList(pending.projectCode, pending.input)
  if (discarded) {
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingListCreates.delete(pending)
  }
  if (recoverableListCreate.value === pending && discarded) {
    recoverableListCreate.value = null
  }
  return discarded
}

function abandonLineCreate(pending: PendingLineCreate): boolean {
  const discarded = pending.repository.discardCreateProcurementLine(
    pending.projectCode,
    pending.listId,
    pending.input,
  )
  if (discarded) {
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingLineCreates.delete(pending)
  }
  if (recoverableLineCreate.value === pending && discarded) {
    recoverableLineCreate.value = null
  }
  return discarded
}

function abandonOrderCreate(pending: PendingOrderCreate): boolean {
  const discarded = pending.files.length > 0
    ? pending.repository.discardCreatePurchaseOrder(
        pending.projectCode,
        pending.input,
        pending.files,
      )
    : pending.repository.discardCreatePurchaseOrder(pending.projectCode, pending.input)
  if (discarded) {
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingOrderCreates.delete(pending)
  }
  if (recoverableOrderCreate.value === pending && discarded) {
    recoverableOrderCreate.value = null
  }
  return discarded
}

function abandonReceiptCreate(pending: PendingReceiptCreate): boolean {
  const discarded = pending.repository.discardReceiveGoods(
    pending.projectCode,
    pending.orderId,
    pending.input,
  )
  if (discarded) {
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingReceiptCreates.delete(pending)
  }
  if (recoverableReceiptCreate.value === pending && discarded) {
    recoverableReceiptCreate.value = null
  }
  return discarded
}

type RecoverableProcurementCreate = 'list' | 'line' | 'order' | 'receipt'

function abandonRecoverableProcurementCreate(kind: RecoverableProcurementCreate): void {
  const pending = kind === 'list'
    ? recoverableListCreate.value
    : kind === 'line'
      ? recoverableLineCreate.value
      : kind === 'order'
        ? recoverableOrderCreate.value
        : recoverableReceiptCreate.value
  if (!pending || pending.inFlight) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的新增记录',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    const discarded = kind === 'list'
      ? abandonListCreate(pending as PendingListCreate)
      : kind === 'line'
        ? abandonLineCreate(pending as PendingLineCreate)
        : kind === 'order'
          ? abandonOrderCreate(pending as PendingOrderCreate)
          : abandonReceiptCreate(pending as PendingReceiptCreate)
    if (!discarded) actionError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function discardPaymentSubmission(pending: PendingPaymentSubmission): boolean {
  const discarded = pending.repository.discardCreateSupplierPayment(
    pending.projectCode,
    pending.orderId,
    pending.input,
  )
  if (discarded) clearPendingWrite(pending.owner, pending.key, pending)
  if (pendingPaymentSubmission.value === pending && discarded) {
    pendingPaymentSubmission.value = null
  }
  return discarded
}

function abandonListDialogPendingCreates(): boolean {
  const pending = pendingListForCurrentContext()
  return pending && !pending.inFlight ? abandonListCreate(pending) : !pending
}

function abandonLineDialogPendingCreates(): boolean {
  const pending = pendingLineForCurrentContext()
  return pending && !pending.inFlight ? abandonLineCreate(pending) : !pending
}

function abandonOrderDialogPendingCreates(): boolean {
  const pending = pendingOrderForCurrentContext()
  return pending && !pending.inFlight ? abandonOrderCreate(pending) : !pending
}

function abandonReceiptDialogPendingCreates(): boolean {
  const pending = pendingReceiptForCurrentContext()
  return pending && !pending.inFlight ? abandonReceiptCreate(pending) : !pending
}

function resetActionsForContextChange(): void {
  actionSequence += 1
  actionBusy.value = false
  actionError.value = null
  listDialogVisible.value = false
  lineDialogVisible.value = false
  orderDialogVisible.value = false
  orderFiles.value = []
  orderDrawerVisible.value = false
  receiptDialogVisible.value = false
  receiptReverseDialogVisible.value = false
  supplierFactReverseDialogVisible.value = false
  editOrderDialogVisible.value = false
  cancelOrderDialogVisible.value = false
  paymentDialogVisible.value = false
  invoiceDialogVisible.value = false
  invoiceFiles.value = []
  invoiceError.value = null
  quoteDialogVisible.value = false
  pendingQuoteDownload.value = null
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
  selectedOrderLineIds.value = []
  selectedOrder.value = null
  selectedReceipt.value = null
  selectedSupplierFact.value = null
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

function pendingListCreate(input: ProcurementListInput, context: ActionContext): PendingListCreate {
  const key = procurementPendingKey('list', context.projectCode)
  const existing = getPendingWrite<PendingListCreate>(context.owner, key)
  if (existing) return existing
  const pending: PendingListCreate = {
    owner: context.owner,
    key,
    dialogVersion: listDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    inFlight: false,
    committed: false,
  }
  pendingListCreates.add(pending)
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

async function createList(): Promise<void> {
  if (props.readonly || actionBusy.value || listCreateBusy.value) return
  const input = recoverableListCreate.value?.input ?? listPayload()
  if (!input) return
  const context = startAction()
  const pending = pendingListCreate(input, context)
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  actionBusy.value = true
  actionError.value = null
  try {
    await pending.repository.createProcurementList(pending.projectCode, pending.input)
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingListCreates.delete(pending)
    recoverableListCreate.value = null
    listDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      recoverableListCreate.value = isDefinitiveClientRejection(error) ? null : pending
      actionError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelListDialog(): void {
  beforeListDialogClose(() => { listDialogVisible.value = false })
}

function beforeListDialogClose(done: () => void): void {
  if (actionBusy.value || listCreateBusy.value) return
  confirmDiscardAndClose(done, abandonListDialogPendingCreates)
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

function pendingLineCreate(
  listId: number,
  input: ProcurementLineInput,
  context: ActionContext,
): PendingLineCreate {
  const key = procurementPendingKey('line', context.projectCode)
  const existing = getPendingWrite<PendingLineCreate>(context.owner, key)
  if (existing) return existing
  const pending: PendingLineCreate = {
    owner: context.owner,
    key,
    dialogVersion: lineDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    listId,
    input,
    inFlight: false,
    committed: false,
  }
  pendingLineCreates.add(pending)
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

async function createLine(): Promise<void> {
  if (props.readonly || actionBusy.value || lineCreateBusy.value) return
  const recoverable = recoverableLineCreate.value
  const list = draftProcurementLists.value.find((item) => item.id === selectedLineListId.value)
  const input = recoverable?.input ?? linePayload()
  const listId = recoverable?.listId ?? list?.id
  if (!listId || !input) {
    if (!listId) actionError.value = '请选择草稿采购清单'
    return
  }
  const context = startAction()
  const pending = pendingLineCreate(listId, input, context)
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  actionBusy.value = true
  actionError.value = null
  try {
    await pending.repository.createProcurementLine(
      pending.projectCode,
      pending.listId,
      pending.input,
    )
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingLineCreates.delete(pending)
    recoverableLineCreate.value = null
    lineDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      recoverableLineCreate.value = isDefinitiveClientRejection(error) ? null : pending
      actionError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

async function updateLine(): Promise<void> {
  if (props.readonly || actionBusy.value || selectedLineId.value === null) return
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
  beforeLineDialogClose(() => { lineDialogVisible.value = false })
}

function beforeLineDialogClose(done: () => void): void {
  if (actionBusy.value || lineCreateBusy.value) return
  confirmDiscardAndClose(done, abandonLineDialogPendingCreates)
}

async function confirmList(list: ProcurementListDetailDto): Promise<void> {
  if (!canWrite.value || list.status !== 'draft') return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await ElMessageBox.confirm(
      `清单“${list.name}”共 ${list.line_count} 行，成本金额 ${formatMoney(list.cost_total_cents)} 元。确认后不可再编辑，只能复制为新草稿继续修订。`,
      '确认采购清单',
      {
        type: 'warning',
        confirmButtonText: '确认并锁定',
        cancelButtonText: '返回检查',
      },
    )
  } catch {
    if (isCurrentAction(context)) actionBusy.value = false
    return
  }
  if (!isCurrentAction(context)) return
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

async function copyListAsDraft(list: ProcurementListDetailDto): Promise<void> {
  if (!canWrite.value || list.status !== 'confirmed') return
  const context = startAction()
  const input = { expected_revision: list.revision }
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.copyProcurementListAsDraft(
      context.projectCode,
      list.id,
      input,
    )
    if (!isCurrentAction(context)) return
    actionBusy.value = false
    await refreshAfterCommittedAction(
      context,
      () => loadWorkspace(context.projectCode, context.repository),
      '修订草稿已创建',
    )
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
  selectedOrderLineIds.value = [line.id]
  for (const key of Object.keys(orderLineDrafts)) delete orderLineDrafts[Number(key)]
  for (const candidate of availableOrderLines.value) {
    orderLineDrafts[candidate.line.id] = {
      quantity: remainingProcurementQuantity(candidate.line),
      unitCostYuan: centsToYuan(candidate.line.unit_cost_cents),
      overageReason: '',
    }
  }
  Object.assign(orderForm, {
    orderNo: '',
    supplierCompanyId: null,
    orderedOn: localISODate(),
    expectedDeliveryOn: '',
    notes: '',
    documentVersionIds: [],
  })
  orderFiles.value = []
  actionError.value = null
  orderDialogVisible.value = true
}

function toggleOrderLine(lineId: number, selected: boolean): void {
  if (selected) {
    if (!selectedOrderLineIds.value.includes(lineId)) selectedOrderLineIds.value.push(lineId)
    return
  }
  selectedOrderLineIds.value = selectedOrderLineIds.value.filter((id) => id !== lineId)
}

function orderLineTestId(lineId: number, suffix: 'quantity' | 'unit-cost' | 'overage-reason'): string {
  return lineId === selectedOrderLine.value?.id
    ? `purchase-order-${suffix}`
    : `purchase-order-line-${suffix}-${lineId}`
}

function orderPayload(): PurchaseOrderInput | null {
  const orderNo = orderForm.orderNo.trim()
  if (!orderNo || !orderForm.orderedOn || selectedOrderLineIds.value.length === 0) {
    actionError.value = '请填写采购单号、下单日期并至少勾选一项物料'
    return null
  }
  const supplierCompanyId = orderForm.supplierCompanyId
  if (supplierCompanyId === null
    || !companies.value.some((company) => company.id === supplierCompanyId)) {
    actionError.value = companies.value.length === 0
      ? '暂无可选供应商，无法建立采购单'
      : '请选择供应商'
    return null
  }
  try {
    const lines = selectedOrderLineIds.value.map((lineId) => {
      const entry = availableOrderLines.value.find(({ line }) => line.id === lineId)
      const draft = orderLineDrafts[lineId]
      if (!entry || !draft) throw new Error('采购清单已变化，请关闭后重新选择')
      const quantity = draft.quantity.trim()
      const quantityMilli = decimalToMilli(quantity)
      if (quantityMilli <= 0n) throw new Error(`${entry.line.name}的采购数量必须大于 0`)
      const overageReason = optionalText(draft.overageReason)
      if (quantityMilli > decimalToMilli(remainingProcurementQuantity(entry.line)) && !overageReason) {
        throw new Error(`${entry.line.name}的采购数量超过清单剩余数量，必须填写超采原因`)
      }
      return {
        procurement_line_id: entry.line.id,
        quantity,
        unit_cost_cents: yuanToCents(draft.unitCostYuan),
        overage_reason: overageReason,
      }
    })
    return {
      order_no: orderNo,
      supplier_company_id: supplierCompanyId,
      ordered_on: orderForm.orderedOn,
      expected_delivery_on: optionalText(orderForm.expectedDeliveryOn),
      lines,
      notes: optionalText(orderForm.notes),
      document_version_ids: [...orderForm.documentVersionIds],
    }
  } catch (error) {
    actionError.value = actionErrorMessage(error)
    return null
  }
}

function pendingOrderCreate(
  input: PurchaseOrderInput,
  files: readonly File[],
  context: ActionContext,
): PendingOrderCreate {
  const key = procurementPendingKey('order', context.projectCode)
  const existing = getPendingWrite<PendingOrderCreate>(context.owner, key)
  if (
    existing
    && JSON.stringify(existing.input) === JSON.stringify(input)
    && existing.files.length === files.length
    && existing.files.every((file, index) => file === files[index])
  ) return existing
  if (existing) return existing
  const pending: PendingOrderCreate = {
    owner: context.owner,
    key,
    dialogVersion: orderDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    files,
    inFlight: false,
    committed: false,
  }
  pendingOrderCreates.add(pending)
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

async function createOrder(): Promise<void> {
  if (props.readonly || actionBusy.value || orderCreateBusy.value) return
  const input = recoverableOrderCreate.value?.input ?? orderPayload()
  if (!input) return
  const context = startAction()
  const files = recoverableOrderCreate.value?.files ?? [...orderFiles.value]
  const pending = pendingOrderCreate(input, files, context)
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  actionBusy.value = true
  actionError.value = null
  try {
    const result = pending.files.length > 0
      ? await pending.repository.createPurchaseOrder(
          pending.projectCode,
          pending.input,
          pending.files,
        )
      : await pending.repository.createPurchaseOrder(pending.projectCode, pending.input)
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingOrderCreates.delete(pending)
    recoverableOrderCreate.value = null
    selectedOrder.value = result.data
    orderDialogVisible.value = false
    orderFiles.value = []
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      recoverableOrderCreate.value = isDefinitiveClientRejection(error) ? null : pending
      actionError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelOrderDialog(): void {
  beforeOrderDialogClose(() => { orderDialogVisible.value = false })
}

function resetOrderAttachments(): void {
  if (actionBusy.value) return
  orderFiles.value = []
}

function beforeOrderDialogClose(done: () => void): void {
  if (actionBusy.value || orderCreateBusy.value) return
  confirmDiscardAndClose(done, abandonOrderDialogPendingCreates)
}

async function openOrderDetail(order: PurchaseOrderDto): Promise<void> {
  const retained = selectedOrder.value
  if (retained?.id === order.id && retained.revision >= order.revision
    && retained.status !== 'draft' && order.status === 'draft') {
    orderDrawerVisible.value = true
    return
  }
  if (loading.value || loadError.value || actionBusy.value) return
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
  for (const line of order.lines) receiptQuantities[line.id] = '0.000'
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
  const key = procurementPendingKey('receipt', context.projectCode)
  const existing = getPendingWrite<PendingReceiptCreate>(context.owner, key)
  if (existing) return existing
  const pending: PendingReceiptCreate = {
    owner: context.owner,
    key,
    dialogVersion: receiptDialogVersion,
    projectCode: context.projectCode,
    repository: context.repository,
    orderId,
    input,
    inFlight: false,
    committed: false,
  }
  pendingReceiptCreates.add(pending)
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

async function receiveGoods(): Promise<void> {
  if (props.readonly || actionBusy.value || receiptCreateBusy.value) return
  const order = selectedOrder.value
  const input = recoverableReceiptCreate.value?.input ?? receiptPayload()
  if (!order || !input) return
  const context = startAction()
  const pending = pendingReceiptCreate(order.id, input, context)
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  actionBusy.value = true
  actionError.value = null
  try {
    await pending.repository.receiveGoods(pending.projectCode, pending.orderId, pending.input)
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    pendingReceiptCreates.delete(pending)
    recoverableReceiptCreate.value = null
    receiptDialogVisible.value = false
    orderDrawerVisible.value = false
    selectedOrder.value = null
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => loadWorkspace(context.projectCode, context.repository))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      recoverableReceiptCreate.value = isDefinitiveClientRejection(error) ? null : pending
      actionError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelReceiptDialog(): void {
  beforeReceiptDialogClose(() => { receiptDialogVisible.value = false })
}

function beforeReceiptDialogClose(done: () => void): void {
  if (actionBusy.value || receiptCreateBusy.value) return
  confirmDiscardAndClose(done, abandonReceiptDialogPendingCreates)
}

function openReceiptReverse(receipt: NonNullable<PurchaseOrderRecordDto['goods_receipts']>[number]): void {
  if (!canWrite.value || receipt.status !== 'active') return
  selectedReceipt.value = receipt
  receiptReverseReason.value = ''
  actionError.value = null
  receiptReverseDialogVisible.value = true
}

function receiptReversalPayload(): GoodsReceiptReversalInput | null {
  const receipt = selectedReceipt.value
  const reason = receiptReverseReason.value.trim()
  if (!receipt) return null
  if (!reason) {
    actionError.value = '请填写到货冲销原因'
    return null
  }
  return { reason, expected_revision: receipt.revision }
}

async function reverseReceipt(): Promise<void> {
  const order = selectedOrder.value
  const receipt = selectedReceipt.value
  const input = receiptReversalPayload()
  if (props.readonly || !order || !receipt || !input || actionBusy.value) return
  const context = startAction()
  actionBusy.value = true
  actionError.value = null
  try {
    await context.repository.reverseGoodsReceipt(context.projectCode, receipt.id, input)
    if (!isCurrentAction(context)) return
    receiptReverseDialogVisible.value = false
    selectedReceipt.value = null
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, order.id))
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelReceiptReverse(): void {
  if (actionBusy.value) return
  const receipt = selectedReceipt.value
  const reason = receiptReverseReason.value.trim()
  if (receipt && reason) {
    currentRepository().discardReverseGoodsReceipt(props.projectCode, receipt.id, {
      reason,
      expected_revision: receipt.revision,
    })
  }
  receiptReverseDialogVisible.value = false
  selectedReceipt.value = null
}

function beforeReceiptReverseDialogClose(done: () => void): void {
  if (actionBusy.value) return
  confirmDiscardAndClose(() => {
    cancelReceiptReverse()
    done()
  })
}

function closeReceiptReverseDialog(): void {
  beforeReceiptReverseDialogClose(() => { receiptReverseDialogVisible.value = false })
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
  if (props.readonly || !order || actionBusy.value) return
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

function closeEditOrderDialog(): void {
  preventBusyClose(() => { editOrderDialogVisible.value = false })
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
  if (props.readonly || !order || actionBusy.value) return
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

function closeCancelOrderDialog(): void {
  preventBusyClose(() => { cancelOrderDialogVisible.value = false })
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
  const retained = pendingPaymentForCurrentContext()
  if (retained) {
    restorePaymentSubmission(retained)
    return
  }
  paymentDialogVersion += 1
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
  if (props.readonly || actionBusy.value || paymentSubmissionBusy.value) return
  let pending = recoverablePaymentSubmission.value
  if (!pending) {
    const order = selectedOrderFacts.value
    if (!order) return
    const input = paymentPayload(order)
    if (!input) return
    pending = {
      owner: pendingOwner.value,
      key: procurementPendingKey('payment', props.projectCode),
      dialogVersion: paymentDialogVersion,
      projectCode: props.projectCode,
      repository: currentRepository(),
      orderId: order.id,
      input,
      inFlight: false,
      committed: false,
    }
    pendingPaymentSubmission.value = pending
    setPendingWrite(pending.owner, pending.key, pending)
  }
  const context = startAction()
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  actionBusy.value = true
  actionError.value = null
  try {
    await pending.repository.createSupplierPayment(
      pending.projectCode,
      pending.orderId,
      pending.input,
    )
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    if (pendingPaymentSubmission.value === pending) pendingPaymentSubmission.value = null
    paymentDialogVisible.value = false
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, pending.orderId))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      if (isDefinitiveClientRejection(error) && pendingPaymentSubmission.value === pending) {
        pendingPaymentSubmission.value = null
      }
      actionError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function beforePaymentDialogClose(done: () => void): void {
  if (actionBusy.value || paymentSubmissionBusy.value) return
  const dialogVersion = paymentDialogVersion
  const pending = recoverablePaymentSubmission.value
  if (!pending) {
    confirmDiscardAndClose(() => {
      if (dialogVersion === paymentDialogVersion) done()
    })
    return
  }
  void ElMessageBox.confirm(
    '本次付款结果未知。放弃后将不能使用原幂等键安全重试，确定关闭吗？',
    '放弃结果未知的供应商付款',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (dialogVersion !== paymentDialogVersion) return
    if (discardPaymentSubmission(pending)) done()
    else actionError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function closePaymentDialog(): void {
  beforePaymentDialogClose(() => { paymentDialogVisible.value = false })
}

function openSupplierFactReverse(target: SupplierFactReverseTarget): void {
  if (!canWrite.value || target.record.status !== 'active') return
  selectedSupplierFact.value = target
  supplierFactReverseReason.value = ''
  actionError.value = null
  supplierFactReverseDialogVisible.value = true
}

function supplierFactReversalPayload(): SupplierRecordReversalInput | null {
  const reason = supplierFactReverseReason.value.trim()
  if (!selectedSupplierFact.value) return null
  if (!reason) {
    actionError.value = '请填写冲销原因'
    return null
  }
  return {
    reason,
    expected_revision: selectedSupplierFact.value.record.revision,
  }
}

async function reverseSupplierFact(): Promise<void> {
  const target = selectedSupplierFact.value
  const order = selectedOrder.value
  const input = supplierFactReversalPayload()
  if (props.readonly || !target || !order || !input || actionBusy.value) return
  const context = startAction()
  const factName = target.kind === 'payment' ? '付款' : '进项发票'
  actionBusy.value = true
  actionError.value = null
  try {
    await ElMessageBox.confirm(
      `将冲销原${factName}流水 #${target.record.id}，原记录与冲销原因都会保留。确定继续吗？`,
      `确认冲销${factName}`,
      {
        type: 'warning',
        confirmButtonText: '确认冲销',
        cancelButtonText: '取消',
      },
    )
  } catch {
    if (isCurrentAction(context)) actionBusy.value = false
    return
  }
  if (!isCurrentAction(context)) return
  try {
    if (target.kind === 'payment') {
      await context.repository.reverseSupplierPayment(
        context.projectCode,
        target.record.id,
        input,
      )
    } else {
      await context.repository.reverseSupplierInvoice(
        context.projectCode,
        target.record.id,
        input,
      )
    }
    if (!isCurrentAction(context)) return
    supplierFactReverseDialogVisible.value = false
    selectedSupplierFact.value = null
    actionBusy.value = false
    await refreshAfterCommittedAction(
      context,
      () => refreshSelectedOrder(context, order.id),
      `${factName}已冲销`,
    )
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function cancelSupplierFactReverse(): void {
  if (actionBusy.value) return
  const target = selectedSupplierFact.value
  const input = supplierFactReversalPayload()
  if (target && input) {
    if (target.kind === 'payment') {
      currentRepository().discardReverseSupplierPayment(
        props.projectCode,
        target.record.id,
        input,
      )
    } else {
      currentRepository().discardReverseSupplierInvoice(
        props.projectCode,
        target.record.id,
        input,
      )
    }
  }
  supplierFactReverseDialogVisible.value = false
  selectedSupplierFact.value = null
  actionError.value = null
}

function beforeSupplierFactReverseDialogClose(done: () => void): void {
  if (actionBusy.value) return
  confirmDiscardAndClose(() => {
    cancelSupplierFactReverse()
    done()
  })
}

function closeSupplierFactReverseDialog(): void {
  beforeSupplierFactReverseDialogClose(() => { supplierFactReverseDialogVisible.value = false })
}

function openInvoice(): void {
  if (!selectedOrder.value || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.value.status) || !canWrite.value) return
  const retained = pendingInvoiceForCurrentContext()
  if (retained) {
    restoreInvoiceSubmission(retained)
    return
  }
  Object.assign(invoiceForm, { invoiceNo: '', invoicedOn: localISODate(), amountYuan: '' })
  invoiceFiles.value = []
  invoiceError.value = null
  actionError.value = null
  invoiceDialogVisible.value = true
}

function invoicePayload(order: PurchaseOrderRecordDto): SupplierInvoiceInput | null {
  try {
    if (!invoiceForm.invoiceNo.trim() || !invoiceForm.invoicedOn || !invoiceForm.amountYuan.trim()) {
      throw new Error('请填写有效的发票号、开票日期和金额')
    }
    const amount = yuanToCents(invoiceForm.amountYuan)
    if (amount <= 0) throw new Error('请填写有效的发票号、开票日期和金额')
    return {
      invoice_no: invoiceForm.invoiceNo.trim(),
      invoiced_on: invoiceForm.invoicedOn,
      amount_cents: amount,
      allocations: allocateAmount(order, amount, 'invoice'),
      document_version_ids: [],
    }
  } catch (error) {
    invoiceError.value = actionErrorMessage(error)
    return null
  }
}

async function createInvoice(): Promise<void> {
  if (props.readonly || actionBusy.value || invoiceSubmissionBusy.value) return
  let pending = recoverableInvoiceSubmission.value
  if (!pending) {
    const order = selectedOrderFacts.value
    if (!order) return
    const input = invoicePayload(order)
    if (!input) return
    pending = {
      owner: pendingOwner.value,
      key: procurementPendingKey('invoice', props.projectCode),
      projectCode: props.projectCode,
      repository: currentRepository(),
      orderId: order.id,
      input,
      files: [...invoiceFiles.value],
      inFlight: false,
      committed: false,
    }
    pendingInvoiceSubmission.value = pending
    setPendingWrite(pending.owner, pending.key, pending)
  }
  const context = startAction()
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  triggerRef(pendingInvoiceSubmission)
  actionBusy.value = true
  invoiceError.value = null
  try {
    await pending.repository.createSupplierInvoice(
      pending.projectCode,
      pending.orderId,
      pending.input,
      pending.files,
    )
    pending.inFlight = false
    pending.committed = true
    setPendingWrite(pending.owner, pending.key, pending)
    if (!isCurrentAction(context)) return
    clearPendingWrite(pending.owner, pending.key, pending)
    if (pendingInvoiceSubmission.value === pending) pendingInvoiceSubmission.value = null
    invoiceDialogVisible.value = false
    invoiceFiles.value = []
    actionBusy.value = false
    await refreshAfterCommittedAction(context, () => refreshSelectedOrder(context, pending.orderId))
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveClientRejection(error)) clearPendingWrite(pending.owner, pending.key, pending)
    else setPendingWrite(pending.owner, pending.key, pending)
    if (isCurrentAction(context)) {
      if (isDefinitiveClientRejection(error) && pendingInvoiceSubmission.value === pending) {
        pendingInvoiceSubmission.value = null
      } else triggerRef(pendingInvoiceSubmission)
      invoiceError.value = actionErrorMessage(error)
    }
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function discardInvoiceSubmission(pending: PendingInvoiceSubmission): boolean {
  const discarded = pending.repository.discardCreateSupplierInvoice(
    pending.projectCode,
    pending.orderId,
    pending.input,
    pending.files,
  )
  if (pendingInvoiceSubmission.value === pending && discarded) {
    pendingInvoiceSubmission.value = null
  }
  if (discarded) clearPendingWrite(pending.owner, pending.key, pending)
  return discarded
}

function abandonRecoverableInvoiceSubmission(): void {
  const pending = recoverableInvoiceSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的进项发票',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (!discardInvoiceSubmission(pending)) {
      invoiceError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
    }
  }).catch(() => undefined)
}

function resetInvoiceFiles(): void {
  if (actionBusy.value) return
  invoiceFiles.value = []
  invoiceError.value = null
}

function closeInvoiceDialog(): void {
  beforeInvoiceDialogClose(() => { invoiceDialogVisible.value = false })
}

function beforeInvoiceDialogClose(done: () => void): void {
  if (actionBusy.value || invoiceSubmissionBusy.value) return
  const pending = recoverableInvoiceSubmission.value
  if (!pending) {
    confirmDiscardAndClose(done)
    return
  }
  void ElMessageBox.confirm(
    '本次发票登记结果未知。放弃后将不能使用原请求安全重试，确定关闭吗？',
    '放弃结果未知的进项发票',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (discardInvoiceSubmission(pending)) done()
    else invoiceError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function confirmDiscardAndClose(
  done: () => void,
  discard?: () => boolean | void,
  message = '关闭后未保存的内容会丢失，确定关闭吗？',
): void {
  void ElMessageBox.confirm(
    message,
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => {
    const discarded = discard?.()
    if (discarded === false) {
      actionError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
      return
    }
    done()
  }).catch(() => undefined)
}

function preventBusyClose(done: () => void): void {
  if (actionBusy.value) return
  confirmDiscardAndClose(done)
}

async function previewImport(file: File | null): Promise<void> {
  if (props.readonly || actionBusy.value) return
  if (!file) {
    if (importFile.value && importProjectCode.value && importRepository) {
      importRepository.discardPreviewProcurementImport(importProjectCode.value, importFile.value)
    }
    importFile.value = null
    importPreview.value = null
    importProjectCode.value = null
    importRepository = null
    importListName.value = ''
    actionError.value = null
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
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

async function retryImportPreview(): Promise<void> {
  const file = importFile.value
  if (props.readonly || !file || actionBusy.value) return
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

async function confirmImport(): Promise<void> {
  const preview = importPreview.value
  if (props.readonly || !preview || preview.errors.length || actionBusy.value) return
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
  if (!canWrite.value) return
  const pending = recoverableQuoteDownload.value
  if (pending) {
    Object.assign(quoteForm, {
      listId: pending.listId,
      title: pending.input.title,
      customerCompanyId: pending.input.customer_company_id,
      notes: pending.input.notes ?? '',
    })
    actionError.value = null
    quoteDialogVisible.value = true
    return
  }
  const list = procurementLists.value.find((item) => item.status === 'confirmed')
  if (!list) return
  Object.assign(quoteForm, {
    listId: list.id,
    title: `${list.name} 报价单`,
    customerCompanyId: projectCustomer.value?.id ?? 0,
    notes: '',
  })
  actionError.value = projectCustomer.value ? null : '项目未绑定可用客户，无法生成报价单'
  quoteDialogVisible.value = true
}

async function createQuote(): Promise<void> {
  if (props.readonly || actionBusy.value) return
  const context = startAction()
  const pending = pendingQuoteDownload.value?.projectCode === context.projectCode
    ? pendingQuoteDownload.value
    : null
  let listId: number
  let listName: string
  let customerName: string
  let input: QuoteExportInput
  if (pending) {
    listId = pending.listId
    listName = pending.listName
    customerName = pending.customerName
    input = pending.input
  } else {
    if (!quoteForm.listId || !quoteForm.title.trim() || !projectCustomer.value
      || quoteForm.customerCompanyId !== projectCustomer.value.id) {
      actionError.value = '请先确认项目绑定的客户公司'
      return
    }
    const selectedList = procurementLists.value.find((item) => item.id === quoteForm.listId)
    if (!selectedList || selectedList.status !== 'confirmed') {
      actionError.value = '请选择已确认的采购清单'
      return
    }
    listId = quoteForm.listId
    listName = selectedList.name
    customerName = projectCustomer.value.name
    input = {
      title: quoteForm.title.trim(), customer_company_id: quoteForm.customerCompanyId,
      notes: optionalText(quoteForm.notes),
    }
  }
  actionBusy.value = true
  actionError.value = null
  try {
    let exportId = pending?.exportId ?? null
    if (exportId === null) {
      const exported = await context.repository.createQuoteExport(context.projectCode, listId, input)
      if (!isCurrentAction(context)) return
      exportId = exported.data.id
      pendingQuoteDownload.value = {
        projectCode: context.projectCode,
        exportId,
        listId,
        listName,
        customerName,
        input,
      }
      emit('changed')
    }
    const blob = await context.repository.downloadQuoteExport(context.projectCode, exportId)
    if (!isCurrentAction(context)) return
    downloadBlob(blob, `quote-export-${exportId}.xlsx`)
    pendingQuoteDownload.value = null
    quoteDialogVisible.value = false
    void loadQuoteExports(context.projectCode, context.repository, context.generation)
  } catch (error) {
    if (isCurrentAction(context)) actionError.value = actionErrorMessage(error)
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function closeQuoteDialog(): void {
  preventBusyClose(() => { quoteDialogVisible.value = false })
}

async function downloadSavedQuote(item: QuoteExportDto): Promise<void> {
  if (quoteDownloadBusyId.value !== null) return
  const targetGeneration = generation
  const projectCode = props.projectCode
  const repository = currentRepository()
  quoteDownloadBusyId.value = item.id
  quoteExportsError.value = null
  try {
    const blob = await repository.downloadQuoteExport(projectCode, item.id)
    if (!isCurrent(targetGeneration) || projectCode !== props.projectCode || repository !== currentRepository()) return
    downloadBlob(blob, `quote-export-${item.id}.xlsx`)
  } catch (error) {
    if (isCurrent(targetGeneration)) quoteExportsError.value = `报价单下载失败：${actionErrorMessage(error)}`
  } finally {
    if (isCurrent(targetGeneration)) quoteDownloadBusyId.value = null
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
  [() => props.projectCode, () => props.repository, () => props.readonly],
  ([projectCode, nextRepository]) => {
    pendingOwner.value = nextRepository ?? defaultProcurementPendingOwner
    resetActionsForContextChange()
    procurementListPagination.page = 1
    purchaseOrderPagination.page = 1
    void loadWorkspace(projectCode, currentRepository())
  },
  { immediate: true },
)

watch(
  () => [
    actionBusy.value,
    pendingListForCurrentContext()?.inFlight,
    pendingListForCurrentContext()?.committed,
    pendingLineForCurrentContext()?.inFlight,
    pendingLineForCurrentContext()?.committed,
    pendingOrderForCurrentContext()?.inFlight,
    pendingOrderForCurrentContext()?.committed,
    pendingReceiptForCurrentContext()?.inFlight,
    pendingReceiptForCurrentContext()?.committed,
    pendingPaymentForCurrentContext()?.inFlight,
    pendingPaymentForCurrentContext()?.committed,
    pendingInvoiceForCurrentContext()?.inFlight,
    pendingInvoiceForCurrentContext()?.committed,
  ],
  () => restoreCurrentPendingWrites(),
)

onBeforeUnmount(() => {
  mounted = false
  generation += 1
  actionSequence += 1
  if (importFile.value && importProjectCode.value && importRepository) {
    importRepository.discardPreviewProcurementImport(importProjectCode.value, importFile.value)
  }
})
</script>

<template>
  <section class="procurement-workspace" data-testid="procurement-workspace">
    <header class="workspace-header">
      <div>
        <h2>采购工作台</h2>
      </div>
      <el-tag v-if="readonly" type="info" effect="plain">项目已归档，仅供查看</el-tag>
      <div v-else class="workspace-actions">
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
          :disabled="!canWrite"
          @click="downloadTemplate"
        >下载标准采购模板</el-button>
        <el-button
          data-testid="procurement-quote-action"
          :disabled="!canWrite || (!recoverableQuoteDownload && (!procurementLists.some((list) => list.status === 'confirmed') || !projectCustomer))"
          @click="openQuote"
        >{{ recoverableQuoteDownload ? '继续下载已生成报价单' : '生成客户报价单' }}</el-button>
      </div>
    </header>
    <p v-if="!readonly" class="capability-note">Excel 会先预览校验，确认后才写入采购清单。</p>
    <DragUploadField
      v-if="!readonly"
      :model-value="importFile"
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      test-id="procurement-import-upload"
      title="拖入采购 Excel，或点击选择"
      hint="只支持 XLSX；系统会先逐行校验，确认后才正式写入"
      :busy="actionBusy"
      :disabled="loading || Boolean(loadError)"
      @update:model-value="previewImport"
    />
    <div v-if="!readonly && importFile && !importPreview && actionError" class="import-retry">
      <span>{{ importFile.name }} 的预览结果未知，可安全复用原请求重试。</span>
      <el-button data-testid="procurement-import-retry" :loading="actionBusy" @click="retryImportPreview">重试预览</el-button>
    </div>

    <el-card v-if="!readonly && importPreview" shadow="never" class="import-preview" data-testid="procurement-import-preview">
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
        <article class="workspace-panel" data-testid="procurement-lists-panel">
          <h3>采购清单</h3>
          <el-alert v-if="procurementListsLoadError" data-testid="procurement-list-load-error" :title="procurementListsLoadError" type="error" :closable="false" show-icon />
          <p v-if="procurementLists.length === 0" class="secondary-text" data-testid="procurement-list-empty">暂无采购清单</p>
          <section v-for="list in procurementLists" :key="list.id" class="record-block">
            <div class="record-heading">
              <h4>{{ list.name }}</h4>
              <span v-if="!readonly" class="line-actions">
                <el-button
                  v-if="list.status === 'draft'"
                  :data-testid="`procurement-list-confirm-${list.id}`"
                  link
                  type="primary"
                  :loading="actionBusy"
                  :disabled="!canWrite"
                  @click="confirmList(list)"
                >确认清单</el-button>
                <el-button
                  v-else-if="list.status === 'confirmed'"
                  :data-testid="`procurement-list-copy-${list.id}`"
                  link
                  type="primary"
                  :loading="actionBusy"
                  :disabled="!canWrite"
                  @click="copyListAsDraft(list)"
                >复制为新草稿</el-button>
              </span>
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
                <span v-if="!readonly && list.status === 'draft'" class="line-actions">
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
                  v-else-if="!readonly && list.status === 'confirmed'"
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
          <footer v-if="procurementListPage && procurementListPage.total > procurementListPage.page_size" class="pagination-footer">
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
        <article class="workspace-panel" data-testid="purchase-orders-panel">
          <h3>采购单</h3>
          <el-alert v-if="purchaseOrdersLoadError" data-testid="purchase-order-load-error" :title="purchaseOrdersLoadError" type="error" :closable="false" show-icon />
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
                :disabled="loading || actionBusy"
                @click="openOrderDetail(order)"
              >订单详情</el-button>
            </li>
          </ul>
          <p v-else class="secondary-text" data-testid="purchase-order-empty">暂无采购单</p>
          <footer v-if="purchaseOrderPage && purchaseOrderPage.total > purchaseOrderPage.page_size" class="pagination-footer">
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
        <article v-if="overview || overviewLoadError" class="workspace-panel" data-testid="procurement-overview">
          <h3>采购概览</h3>
          <el-alert v-if="overviewLoadError" data-testid="procurement-overview-load-error" :title="overviewLoadError" type="error" :closable="false" show-icon />
          <dl v-if="overview" class="overview-list">
            <div><dt>物料行</dt><dd>{{ overview.line_count }}</dd></div>
            <div><dt>已承诺金额</dt><dd>{{ centsToYuan(overview.procurement_committed_cents) }} 元</dd></div>
            <div><dt>已到货金额</dt><dd>{{ centsToYuan(overview.procurement_received_cents) }} 元</dd></div>
            <div><dt>已付款金额</dt><dd>{{ centsToYuan(overview.procurement_paid_cents) }} 元</dd></div>
          </dl>
        </article>
        <article class="workspace-panel" data-testid="procurement-suppliers">
          <h3>可选往来单位</h3>
          <el-alert v-if="companiesLoadError" data-testid="procurement-suppliers-load-error" :title="companiesLoadError" type="error" :closable="false" show-icon />
          <ul v-if="companies.length" class="record-list">
            <li v-for="company in companies" :key="company.id">{{ company.name }}</li>
          </ul>
          <p v-else class="secondary-text">暂无可选往来单位</p>
        </article>
        <article class="workspace-panel" data-testid="quote-export-history">
          <div class="record-heading">
            <div>
              <h3>客户报价单历史</h3>
              <p class="secondary-text">已生成的报价单可随时重新下载。</p>
            </div>
            <el-button
              v-if="quoteExportsError"
              data-testid="quote-export-history-retry"
              link
              type="primary"
              :loading="quoteExportsLoading"
              @click="loadQuoteExports(projectCode, currentRepository(), generation)"
            >重试</el-button>
          </div>
          <el-alert v-if="quoteExportsError" :title="quoteExportsError" type="error" :closable="false" show-icon />
          <p v-else-if="quoteExportsLoading" class="secondary-text" role="status">正在读取报价单历史…</p>
          <ul v-else-if="quoteExports.length" class="record-list">
            <li v-for="item in quoteExports" :key="item.id">
              <div>
                <span>{{ item.title }}</span>
                <span class="secondary-text">{{ item.customer_company_name }} · {{ formatChineseDateTime(item.created_at) }}</span>
              </div>
              <el-button
                :data-testid="`quote-export-download-${item.id}`"
                link
                type="primary"
                :loading="quoteDownloadBusyId === item.id"
                :disabled="quoteDownloadBusyId !== null"
                @click="downloadSavedQuote(item)"
              >重新下载</el-button>
            </li>
          </ul>
          <p v-else class="secondary-text">暂无已生成报价单</p>
        </article>
      </div>
    </template>

    <el-dialog
      v-model="listDialogVisible"
      :teleported="false"
      title="新建采购清单"
      width="min(92vw, 520px)"
      :before-close="beforeListDialogClose"
      :close-on-click-modal="!actionBusy && !listCreateBusy"
      :close-on-press-escape="!actionBusy && !listCreateBusy"
      :show-close="!actionBusy && !listCreateBusy"
    >
      <div v-if="currentListCreate" class="pending-retry-panel">
        <el-alert data-testid="procurement-list-create-uncertain" :title="listCreateBusy ? '正在核对上次建立结果，原内容已锁定。' : '上次建立结果未知，原内容已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableListCreate" data-testid="procurement-list-abandon-pending" :disabled="actionBusy" @click="abandonRecoverableProcurementCreate('list')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentListCreate)" @submit.prevent="createList">
        <el-alert v-if="actionError" data-testid="procurement-list-dialog-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-form-item label="清单名称" required>
          <el-input
            v-model="listForm.name"
            data-testid="procurement-list-name"
            :disabled="actionBusy || Boolean(recoverableListCreate)"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="listForm.notes" type="textarea" :disabled="actionBusy || Boolean(recoverableListCreate)" />
        </el-form-item>
      </el-form>
      <div class="dialog-actions">
        <el-button data-testid="procurement-list-cancel" :disabled="actionBusy || listCreateBusy" @click="cancelListDialog">取消</el-button>
        <el-button data-testid="procurement-list-create-submit" type="primary" :loading="actionBusy || listCreateBusy" :disabled="actionBusy || listCreateBusy" @click="createList">{{ recoverableListCreate ? '原样重试' : listCreateBusy ? '等待原请求' : '建立清单' }}</el-button>
      </div>
    </el-dialog>

    <el-dialog
      v-model="lineDialogVisible"
      data-testid="procurement-line-dialog"
      :teleported="false"
      :title="selectedLineId === null ? '新增采购行' : '编辑采购行'"
      width="min(94vw, 760px)"
      :before-close="beforeLineDialogClose"
      :close-on-click-modal="!actionBusy && !lineCreateBusy"
      :close-on-press-escape="!actionBusy && !lineCreateBusy"
      :show-close="!actionBusy && !lineCreateBusy"
    >
      <div v-if="currentLineCreate && selectedLineId === null" class="pending-retry-panel">
        <el-alert data-testid="procurement-line-create-uncertain" :title="lineCreateBusy ? '正在核对上次新增结果，原内容已锁定。' : '上次新增结果未知，原内容已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableLineCreate" data-testid="procurement-line-abandon-pending" :disabled="actionBusy" @click="abandonRecoverableProcurementCreate('line')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentLineCreate && selectedLineId === null)" @submit.prevent="saveLine">
        <el-alert v-if="actionError" data-testid="procurement-line-dialog-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-form-item label="采购清单" required>
          <el-select v-model="selectedLineListId" style="width: 100%" :disabled="actionBusy || selectedLineId !== null || Boolean(recoverableLineCreate)">
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
              <el-input-number v-model="lineForm.sequenceNo" data-testid="procurement-line-sequence" :min="1" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="类别" required>
              <el-input v-model="lineForm.category" data-testid="procurement-line-category" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="名称" required>
              <el-input v-model="lineForm.name" data-testid="procurement-line-name" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="规格">
              <el-input v-model="lineForm.specification" data-testid="procurement-line-specification" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="品牌">
              <el-input v-model="lineForm.brand" data-testid="procurement-line-brand" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="6">
            <el-form-item label="型号">
              <el-input v-model="lineForm.model" data-testid="procurement-line-model" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="数量" required>
              <el-input
                v-model="lineForm.quantity"
                data-testid="procurement-line-quantity"
                inputmode="decimal"
                placeholder="例如 2.500"
                :disabled="actionBusy || Boolean(recoverableLineCreate)"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="单位" required>
              <el-input v-model="lineForm.unit" data-testid="procurement-line-unit" :disabled="actionBusy || Boolean(recoverableLineCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="成本单价（元）" required>
              <el-input
                v-model="lineForm.unitCostYuan"
                data-testid="procurement-line-cost-price"
                inputmode="decimal"
                placeholder="0.00"
                :disabled="actionBusy || Boolean(recoverableLineCreate)"
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
                :disabled="actionBusy || Boolean(recoverableLineCreate)"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <div class="dialog-actions">
        <el-button data-testid="procurement-line-cancel" :disabled="actionBusy || lineCreateBusy" @click="cancelLineDialog">取消</el-button>
        <el-button data-testid="procurement-line-submit" type="primary" :loading="actionBusy || lineCreateBusy" :disabled="actionBusy || lineCreateBusy" @click="saveLine">{{ selectedLineId !== null ? '保存修改' : recoverableLineCreate ? '原样重试' : lineCreateBusy ? '等待原请求' : '加入清单' }}</el-button>
      </div>
    </el-dialog>

    <el-dialog
      v-model="orderDialogVisible"
      data-testid="purchase-order-dialog"
      class="procurement-attachment-dialog"
      :teleported="false"
      title="新建采购单"
      width="min(94vw, 720px)"
      :before-close="beforeOrderDialogClose"
      :close-on-click-modal="!actionBusy && !orderCreateBusy"
      :close-on-press-escape="!actionBusy && !orderCreateBusy"
      :show-close="!actionBusy && !orderCreateBusy"
      @closed="resetOrderAttachments"
    >
      <el-alert
        v-if="actionError"
        data-testid="purchase-order-error"
        :title="actionError"
        type="error"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="companies.length === 0"
        title="暂无可选供应商，请先在公司资料中维护供应商"
        type="warning"
        :closable="false"
        show-icon
      />
      <div v-if="currentOrderCreate" class="pending-retry-panel">
        <el-alert data-testid="purchase-order-create-uncertain" :title="orderCreateBusy ? '正在核对上次保存结果，原采购单和附件已锁定。' : '上次保存结果未知，原采购单和附件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableOrderCreate" data-testid="purchase-order-abandon-pending" :disabled="actionBusy" @click="abandonRecoverableProcurementCreate('order')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentOrderCreate)" @submit.prevent="createOrder">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12">
            <el-form-item label="采购单号" required>
              <el-input
                v-model="orderForm.orderNo"
                data-testid="purchase-order-number"
                :disabled="actionBusy || Boolean(recoverableOrderCreate)"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="供应商" required>
              <el-select
                v-model="orderForm.supplierCompanyId"
                data-testid="purchase-order-supplier"
                placeholder="请选择本次采购的供应商"
                style="width: 100%"
                :disabled="actionBusy || companies.length === 0 || Boolean(recoverableOrderCreate)"
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
              <el-date-picker v-model="orderForm.orderedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" :disabled="actionBusy || Boolean(recoverableOrderCreate)" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="预计到货日期">
              <el-date-picker v-model="orderForm.expectedDeliveryOn" type="date" value-format="YYYY-MM-DD" clearable style="width: 100%" :disabled="actionBusy || Boolean(recoverableOrderCreate)" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="本单物料" required>
          <div class="order-line-selection">
            <section
              v-for="entry in availableOrderLines"
              :key="entry.line.id"
              class="order-line-selector"
            >
              <el-checkbox
                :model-value="selectedOrderLineIds.includes(entry.line.id)"
                :data-testid="`purchase-order-line-select-${entry.line.id}`"
                :disabled="actionBusy || Boolean(recoverableOrderCreate)"
                @change="toggleOrderLine(entry.line.id, Boolean($event))"
              >
                {{ entry.line.name }} · 剩余 {{ remainingProcurementQuantity(entry.line) }} {{ entry.line.unit }}
              </el-checkbox>
              <el-row :gutter="12">
                <el-col :xs="24" :sm="8">
                  <el-form-item label="采购数量" required>
                    <el-input
                      v-model="orderLineDrafts[entry.line.id].quantity"
                      :data-testid="orderLineTestId(entry.line.id, 'quantity')"
                      :disabled="actionBusy || Boolean(recoverableOrderCreate) || !selectedOrderLineIds.includes(entry.line.id)"
                    />
                  </el-form-item>
                </el-col>
                <el-col :xs="24" :sm="8">
                  <el-form-item label="成本单价（元）" required>
                    <el-input
                      v-model="orderLineDrafts[entry.line.id].unitCostYuan"
                      :data-testid="orderLineTestId(entry.line.id, 'unit-cost')"
                      inputmode="decimal"
                      :disabled="actionBusy || Boolean(recoverableOrderCreate) || !selectedOrderLineIds.includes(entry.line.id)"
                    />
                  </el-form-item>
                </el-col>
                <el-col :xs="24" :sm="8">
                  <el-form-item label="超采原因">
                    <el-input
                      v-model="orderLineDrafts[entry.line.id].overageReason"
                      :data-testid="orderLineTestId(entry.line.id, 'overage-reason')"
                      :disabled="actionBusy || Boolean(recoverableOrderCreate) || !selectedOrderLineIds.includes(entry.line.id)"
                    />
                  </el-form-item>
                </el-col>
              </el-row>
            </section>
          </div>
        </el-form-item>
        <el-form-item label="供应商合同、盖章页或下单凭证">
          <BusinessAttachmentUpload
            v-model="orderFiles"
            test-id="purchase-order-attachments"
            accept=".pdf,.doc,.docx,image/*"
            :busy="actionBusy || Boolean(recoverableOrderCreate)"
          />
        </el-form-item>
        <div data-testid="purchase-order-existing-documents">
          <el-collapse>
            <el-collapse-item title="关联已有资料（可选）" name="existing-documents">
              <el-alert
                v-if="documentOptionsError"
                data-testid="purchase-order-existing-documents-error"
                :title="`${documentOptionsError}；仍可直接上传新文件。`"
                type="warning"
                :closable="false"
                show-icon
              />
              <el-form-item label="已有项目资料">
                <el-select
                  v-model="orderForm.documentVersionIds"
                  multiple
                  filterable
                  collapse-tags
                  clearable
                  style="width: 100%"
                  :disabled="actionBusy || Boolean(recoverableOrderCreate) || Boolean(documentOptionsError)"
                >
                  <el-option
                    v-for="option in documentOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
              </el-form-item>
            </el-collapse-item>
          </el-collapse>
        </div>
        <el-form-item label="备注">
          <el-input v-model="orderForm.notes" type="textarea" :disabled="actionBusy || Boolean(recoverableOrderCreate)" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-actions">
          <el-button :disabled="actionBusy || orderCreateBusy" @click="cancelOrderDialog">取消</el-button>
          <el-button
            data-testid="purchase-order-submit"
            type="primary"
            :loading="actionBusy || orderCreateBusy"
            :disabled="actionBusy || orderCreateBusy || companies.length === 0"
            @click="createOrder"
          >{{ recoverableOrderCreate ? '原样重试' : orderCreateBusy ? '等待原请求' : '保存采购单' }}</el-button>
        </div>
      </template>
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
          <el-descriptions-item label="合同及附件">
            <BusinessAttachmentLinks
              :project-code="projectCode"
              :version-ids="selectedOrder.document_version_ids"
              :options="documentOptions"
              :test-id="`purchase-order-files-${selectedOrder.id}`"
            />
          </el-descriptions-item>
        </el-descriptions>
        <div
          v-if="!readonly && ['draft', 'confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
          class="drawer-actions"
        >
          <el-button
            v-if="selectedOrder.status === 'draft'"
            data-testid="purchase-order-confirm"
            type="primary"
            :loading="actionBusy"
            :disabled="!canWrite"
            @click="confirmOrder"
          >确认采购单</el-button>
          <el-button
            v-if="['confirmed', 'partially_received'].includes(selectedOrder.status)"
            data-testid="purchase-receipt-open"
            type="primary"
            :disabled="!canWrite || !['confirmed', 'partially_received'].includes(selectedOrder.status)"
            @click="openReceiptDialog"
          >登记到货</el-button>
          <el-button
            v-if="['confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
            data-testid="purchase-payment-open"
            :type="selectedOrder.status === 'received' ? 'primary' : 'default'"
            :disabled="!canWrite || !['confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
            @click="openPayment"
          >登记付款</el-button>
          <el-button
            v-if="['confirmed', 'partially_received', 'received'].includes(selectedOrder.status)"
            data-testid="purchase-invoice-open"
            :disabled="!canWrite"
            @click="openInvoice"
          >登记发票</el-button>
          <el-button
            v-if="selectedOrder.status === 'draft'"
            data-testid="purchase-order-edit"
            :disabled="!canWrite"
            @click="openEditOrder"
          >编辑采购单</el-button>
          <el-button
            v-if="['draft', 'confirmed'].includes(selectedOrder.status)"
            data-testid="purchase-order-cancel-open"
            type="danger"
            plain
            :disabled="!canWrite"
            @click="openCancelOrder"
          >取消采购单</el-button>
        </div>
        <section data-testid="goods-receipt-history" class="fact-section">
          <div class="fact-section-heading"><strong>到货历史</strong><small>误登记可冲销，库存会自动回退。</small></div>
          <el-empty v-if="(selectedOrderFacts?.goods_receipts?.length ?? 0) === 0" description="暂无到货记录" :image-size="56" />
          <ul v-else class="record-list fact-list">
            <li v-for="receipt in selectedOrderFacts?.goods_receipts ?? []" :key="`receipt-${receipt.id}`" :data-testid="`goods-receipt-record-${receipt.id}`" class="fact-record">
              <div class="fact-record-main">
                <strong>{{ receipt.received_on }} · 到货记录 #{{ receipt.id }}</strong>
                <span v-for="line in receipt.lines" :key="line.id">
                  {{ line.material_name }} {{ line.material_model ?? '' }} · {{ line.quantity }} {{ line.unit }} · {{ receipt.warehouse_name }} · {{ receipt.status === 'active' ? '有效' : '已冲销' }}
                </span>
                <span v-if="receipt.lines.length === 0">无到货明细 · {{ receipt.warehouse_name }} · {{ receipt.status === 'active' ? '有效' : '已冲销' }}</span>
                <small v-if="receipt.reversal_reason" class="secondary-text">冲销原因：{{ receipt.reversal_reason }}</small>
              </div>
              <span class="fact-actions">
                <el-tag :type="receipt.status === 'active' ? 'success' : 'info'">{{ receipt.status === 'active' ? '有效' : '已冲销' }}</el-tag>
                <el-button
                  v-if="!readonly && receipt.status === 'active'"
                  :data-testid="`goods-receipt-reverse-${receipt.id}`"
                  link
                  type="danger"
                  :disabled="!canWrite"
                  @click="openReceiptReverse(receipt)"
                >冲销</el-button>
              </span>
            </li>
          </ul>
        </section>
        <el-empty
          v-if="(selectedOrderFacts?.supplier_payments?.length ?? 0) === 0 && (selectedOrderFacts?.supplier_invoices?.length ?? 0) === 0"
          description="暂无付款或进项票记录"
        />
        <ul v-else class="record-list fact-list">
          <li v-for="payment in selectedOrderFacts?.supplier_payments ?? []" :key="`payment-${payment.id}`" :data-testid="`supplier-payment-record-${payment.id}`">
            <span class="fact-record-main"><strong>付款 {{ payment.paid_on }} · {{ centsToYuan(payment.amount_cents) }} 元</strong><span>{{ payment.payment_method }} · {{ payment.reference_no || '无参考号' }} · {{ payment.notes || '无备注' }}</span><small v-if="payment.reversal_reason" class="secondary-text">冲销原因：{{ payment.reversal_reason }}</small></span>
            <span class="fact-actions"><el-tag :type="payment.status === 'active' ? 'success' : 'info'">{{ payment.status === 'active' ? '有效' : '已冲销' }}</el-tag><el-button v-if="!readonly && payment.status === 'active'" :data-testid="`supplier-payment-reverse-open-${payment.id}`" link type="danger" :disabled="!canWrite" @click="openSupplierFactReverse({ kind: 'payment', record: payment })">冲销</el-button></span>
          </li>
          <li v-for="invoice in selectedOrderFacts?.supplier_invoices ?? []" :key="`invoice-${invoice.id}`" :data-testid="`supplier-invoice-record-${invoice.id}`">
            <span class="fact-record-main"><strong>发票 {{ invoice.invoice_no }} · {{ invoice.invoiced_on }}</strong><span>{{ centsToYuan(invoice.amount_cents) }} 元</span><BusinessAttachmentLinks :project-code="projectCode" :version-ids="invoice.document_version_ids" :options="documentOptions" :test-id="`supplier-invoice-files-${invoice.id}`" /><small v-if="invoice.reversal_reason" class="secondary-text">冲销原因：{{ invoice.reversal_reason }}</small></span>
            <span class="fact-actions"><el-tag :type="invoice.status === 'active' ? 'success' : 'info'">{{ invoice.status === 'active' ? '有效' : '已冲销' }}</el-tag><el-button v-if="!readonly && invoice.status === 'active'" :data-testid="`supplier-invoice-reverse-open-${invoice.id}`" link type="danger" :disabled="!canWrite" @click="openSupplierFactReverse({ kind: 'invoice', record: invoice })">冲销</el-button></span>
          </li>
        </ul>
      </template>
    </el-drawer>

    <el-dialog v-model="editOrderDialogVisible" data-testid="purchase-order-edit-dialog" :teleported="false" title="编辑采购单" width="min(94vw, 760px)" :before-close="preventBusyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="updateOrder">
        <el-alert v-if="actionError" data-testid="purchase-order-edit-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="采购单号" required><el-input v-model="editOrderForm.orderNo" data-testid="purchase-order-edit-number" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="供应商" required><el-select v-model="editOrderForm.supplierCompanyId" style="width: 100%"><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="company.id" /></el-select></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="预计到货日期"><el-date-picker v-model="editOrderForm.expectedDeliveryOn" type="date" value-format="YYYY-MM-DD" clearable style="width: 100%" /></el-form-item></el-col>
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
        <div class="dialog-actions"><el-button :disabled="actionBusy" @click="closeEditOrderDialog">取消</el-button><el-button data-testid="purchase-order-edit-submit" type="primary" native-type="submit" :loading="actionBusy" :disabled="actionBusy">保存修改</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="cancelOrderDialogVisible" data-testid="purchase-order-cancel-dialog" :teleported="false" title="取消采购单" width="min(92vw, 520px)" :before-close="preventBusyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="cancelOrder"><el-alert v-if="actionError" data-testid="purchase-order-cancel-error" :title="actionError" type="error" :closable="false" show-icon /><el-alert title="已有付款、发票或到货的采购单不能直接取消。" type="warning" :closable="false" /><el-form-item label="取消原因" required><el-input v-model="cancelOrderReason" data-testid="purchase-cancel-reason" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="actionBusy" @click="closeCancelOrderDialog">返回</el-button><el-button data-testid="purchase-cancel-submit" type="danger" native-type="submit" :loading="actionBusy" :disabled="actionBusy">确认取消</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="paymentDialogVisible" data-testid="purchase-payment-dialog" :teleported="false" title="登记供应商付款" width="min(94vw, 620px)" :before-close="beforePaymentDialogClose" :close-on-click-modal="!actionBusy && !paymentSubmissionBusy" :close-on-press-escape="!actionBusy && !paymentSubmissionBusy" :show-close="!actionBusy && !paymentSubmissionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="createPayment">
        <el-alert v-if="actionError" data-testid="purchase-payment-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-alert v-if="currentPaymentSubmission" data-testid="purchase-payment-pending" :title="paymentSubmissionBusy ? '正在核对本次付款结果，原内容和幂等键已锁定。' : '本次付款结果未知，已锁定原内容和幂等键。请重试保存；如确认放弃，关闭时会清理该安全重试记录。'" type="warning" :closable="false" show-icon />
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="付款日期" required><el-date-picker v-model="paymentForm.paidOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" :disabled="actionBusy || Boolean(currentPaymentSubmission)" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="付款金额（元）" required><el-input v-model="paymentForm.amountYuan" data-testid="purchase-payment-amount" inputmode="decimal" :disabled="actionBusy || Boolean(currentPaymentSubmission)" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="付款方式" required><el-input v-model="paymentForm.paymentMethod" :disabled="actionBusy || Boolean(currentPaymentSubmission)" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="付款参考号"><el-input v-model="paymentForm.referenceNo" :disabled="actionBusy || Boolean(currentPaymentSubmission)" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="paymentForm.notes" type="textarea" :disabled="actionBusy || Boolean(currentPaymentSubmission)" /></el-form-item>
        <div class="dialog-actions"><el-button data-testid="purchase-payment-cancel" :disabled="actionBusy || paymentSubmissionBusy" @click="closePaymentDialog">取消</el-button><el-button data-testid="purchase-payment-submit" type="primary" native-type="submit" :loading="actionBusy || paymentSubmissionBusy" :disabled="actionBusy || paymentSubmissionBusy">{{ recoverablePaymentSubmission ? '重试保存' : paymentSubmissionBusy ? '等待原请求' : '保存付款' }}</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="invoiceDialogVisible" data-testid="purchase-invoice-dialog" class="procurement-attachment-dialog" :teleported="false" title="登记进项发票" width="min(94vw, 620px)" :before-close="beforeInvoiceDialogClose" :close-on-click-modal="!actionBusy && !invoiceSubmissionBusy" :close-on-press-escape="!actionBusy && !invoiceSubmissionBusy" :show-close="!actionBusy && !invoiceSubmissionBusy" @closed="resetInvoiceFiles">
      <div v-if="currentInvoiceSubmission" class="pending-retry-panel">
        <el-alert data-testid="purchase-invoice-pending" :title="invoiceSubmissionBusy ? '正在核对上次登记结果，原采购单、内容和文件已锁定。' : '上次登记结果未知，原采购单、内容和文件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableInvoiceSubmission" data-testid="purchase-invoice-abandon-pending" :disabled="actionBusy" @click="abandonRecoverableInvoiceSubmission">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentInvoiceSubmission)" @submit.prevent="createInvoice">
      <el-alert v-if="invoiceError" data-testid="purchase-invoice-error" :title="invoiceError" type="error" :closable="false" />
      <el-row :gutter="14">
        <el-col :xs="24" :sm="12"><el-form-item label="发票号" required><el-input v-model="invoiceForm.invoiceNo" data-testid="purchase-invoice-number" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="开票日期" required><el-date-picker v-model="invoiceForm.invoicedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="发票金额（元）" required><el-input v-model="invoiceForm.amountYuan" data-testid="purchase-invoice-amount" inputmode="decimal" /></el-form-item></el-col>
      </el-row>
      <el-form-item label="发票图片或 PDF">
        <BusinessAttachmentUpload v-model="invoiceFiles" test-id="purchase-invoice-attachments" accept=".pdf,image/*" :busy="actionBusy || Boolean(currentInvoiceSubmission)" />
      </el-form-item>
      <el-alert title="图片可直接随本次登记一起保存；金额、日期和行分摊仍按正式入账规则校验。" type="info" :closable="false" />
      </el-form>
      <template #footer><div class="dialog-actions"><el-button data-testid="purchase-invoice-cancel" :disabled="actionBusy || invoiceSubmissionBusy" @click="closeInvoiceDialog">取消</el-button><el-button data-testid="purchase-invoice-submit" type="primary" :loading="actionBusy || invoiceSubmissionBusy" :disabled="actionBusy || invoiceSubmissionBusy" @click="createInvoice">{{ recoverableInvoiceSubmission ? '原样重试' : invoiceSubmissionBusy ? '等待原请求' : '保存发票' }}</el-button></div></template>
    </el-dialog>

    <el-dialog v-model="quoteDialogVisible" data-testid="procurement-quote-dialog" :teleported="false" title="生成隐藏成本价的客户报价单" width="min(94vw, 620px)" :before-close="preventBusyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="createQuote">
        <el-alert v-if="actionError" data-testid="procurement-quote-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-form-item label="已确认采购清单" required><el-select v-model="quoteForm.listId" data-testid="procurement-quote-list" :disabled="Boolean(pendingQuoteDownload)" style="width: 100%"><el-option v-for="list in procurementLists.filter((item) => item.status === 'confirmed')" :key="list.id" :label="list.name" :value="list.id" /></el-select></el-form-item>
        <el-form-item label="报价单标题" required><el-input v-model="quoteForm.title" data-testid="procurement-quote-title" :disabled="Boolean(pendingQuoteDownload)" /></el-form-item>
        <el-form-item label="客户公司" required><el-text data-testid="procurement-quote-customer" tag="strong">{{ pendingQuoteDownload?.customerName ?? projectCustomer?.name ?? '未绑定客户' }}</el-text><p class="secondary-text">客户来自项目资料，避免报价单开给错误公司。</p></el-form-item>
        <el-form-item label="备注"><el-input v-model="quoteForm.notes" type="textarea" :disabled="Boolean(pendingQuoteDownload)" /></el-form-item>
        <el-alert v-if="pendingQuoteDownload" data-testid="procurement-quote-pending" :title="`已生成：${pendingQuoteDownload.input.title}（${pendingQuoteDownload.listName} / ${pendingQuoteDownload.customerName}）。本次只重试下载。`" type="success" :closable="false" />
        <el-alert v-else title="导出的 Excel 仅包含报价单价，不包含成本价。" type="success" :closable="false" />
        <div class="dialog-actions"><el-button data-testid="procurement-quote-cancel" :disabled="actionBusy" @click="closeQuoteDialog">取消</el-button><el-button data-testid="procurement-quote-submit" type="primary" native-type="submit" :loading="actionBusy" :disabled="actionBusy || (!pendingQuoteDownload && !projectCustomer)">{{ pendingQuoteDownload ? '重试下载' : '生成并下载' }}</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="supplierFactReverseDialogVisible" data-testid="supplier-fact-reverse-dialog" :teleported="false" :title="selectedSupplierFact?.kind === 'payment' ? '冲销供应商付款' : '冲销进项发票'" width="min(92vw, 520px)" :before-close="beforeSupplierFactReverseDialogClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="reverseSupplierFact">
        <el-alert v-if="actionError" data-testid="supplier-fact-reverse-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-alert title="系统只冲销所选原流水，原记录、金额和冲销原因会继续保留。" type="warning" :closable="false" />
        <el-form-item label="原流水"><strong>#{{ selectedSupplierFact?.record.id }}</strong></el-form-item>
        <el-form-item label="冲销原因" required><el-input v-model="supplierFactReverseReason" data-testid="supplier-fact-reverse-reason" type="textarea" :rows="3" /></el-form-item>
        <div class="dialog-actions"><el-button :disabled="actionBusy" @click="closeSupplierFactReverseDialog">取消</el-button><el-button data-testid="supplier-fact-reverse-submit" type="danger" native-type="submit" :loading="actionBusy" :disabled="actionBusy">确认冲销</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="receiptReverseDialogVisible" data-testid="goods-receipt-reverse-dialog" :teleported="false" title="冲销到货记录" width="min(92vw, 520px)" :before-close="beforeReceiptReverseDialogClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy">
      <el-form label-position="top" :disabled="actionBusy" @submit.prevent="reverseReceipt">
        <el-alert v-if="actionError" data-testid="goods-receipt-reverse-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-alert title="确认后会回退本次到货产生的库存和金额，并保留冲销记录。" type="warning" :closable="false" />
        <el-form-item label="冲销原因" required>
          <el-input v-model="receiptReverseReason" data-testid="goods-receipt-reverse-reason" type="textarea" :rows="3" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="actionBusy" @click="closeReceiptReverseDialog">返回</el-button>
          <el-button data-testid="goods-receipt-reverse-submit" type="danger" native-type="submit" :loading="actionBusy" :disabled="actionBusy">确认冲销</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="receiptDialogVisible"
      data-testid="purchase-event-dialog"
      :teleported="false"
      title="确认到货"
      width="min(94vw, 640px)"
      :before-close="beforeReceiptDialogClose"
      :close-on-click-modal="!actionBusy && !receiptCreateBusy"
      :close-on-press-escape="!actionBusy && !receiptCreateBusy"
      :show-close="!actionBusy && !receiptCreateBusy"
    >
      <div v-if="currentReceiptCreate" class="pending-retry-panel">
        <el-alert data-testid="goods-receipt-create-uncertain" :title="receiptCreateBusy ? '正在核对上次到货登记结果，原内容已锁定。' : '上次到货登记结果未知，原内容已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableReceiptCreate" data-testid="goods-receipt-abandon-pending" :disabled="actionBusy" @click="abandonRecoverableProcurementCreate('receipt')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentReceiptCreate)" @submit.prevent="receiveGoods">
        <el-alert v-if="actionError" data-testid="purchase-event-error" :title="actionError" type="error" :closable="false" show-icon />
        <el-form-item label="到货日期" required>
          <el-date-picker v-model="receiptForm.receivedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" :disabled="actionBusy || Boolean(recoverableReceiptCreate)" />
        </el-form-item>
        <el-form-item label="仓库名称" required>
          <el-input
            v-model="receiptForm.warehouseName"
            data-testid="purchase-event-warehouse"
            :disabled="actionBusy || Boolean(recoverableReceiptCreate)"
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
            :disabled="actionBusy || Boolean(recoverableReceiptCreate)"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="receiptForm.notes" type="textarea" :disabled="actionBusy || Boolean(recoverableReceiptCreate)" />
        </el-form-item>
      </el-form>
      <div class="dialog-actions">
        <el-button :disabled="actionBusy || receiptCreateBusy" @click="cancelReceiptDialog">取消</el-button>
        <el-button data-testid="purchase-event-submit" type="primary" :loading="actionBusy || receiptCreateBusy" :disabled="actionBusy || receiptCreateBusy" @click="receiveGoods">{{ recoverableReceiptCreate ? '原样重试' : receiptCreateBusy ? '等待原请求' : '确认到货' }}</el-button>
      </div>
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
.state-message,
.secondary-text,
.overview-list {
  margin: 0;
}

.order-line-selection {
  display: grid;
  width: 100%;
  gap: 10px;
}

.order-line-selector {
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.order-line-selector > .el-row {
  margin-top: 8px;
}

.fact-section {
  margin-top: 18px;
}

.fact-section-heading,
.fact-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.fact-section-heading small {
  color: var(--sunyu-muted);
}

.fact-record-main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.record-list li.fact-record {
  align-items: flex-start;
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

.import-preview { margin: 16px 0; }
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

.pending-retry-panel { display: grid; gap: 10px; margin-bottom: 16px; }
.pending-retry-panel > :deep(.el-button) { justify-self: end; }

.dialog-actions,
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}

.procurement-workspace :deep(.procurement-attachment-dialog .el-dialog__body) {
  max-height: calc(90vh - 142px);
  overflow-y: auto;
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

  .fact-list > li {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
