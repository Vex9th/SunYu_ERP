<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, toRaw, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { ApiError } from '../../api'
import type {
  AcceptanceInput,
  AcceptanceStatus,
  AcceptanceType,
  AfterSalesCoverageType,
  AfterSalesInput,
  AfterSalesStatus,
  CommissioningSessionInput,
  CommissioningStatus,
  DemoAcceptanceViewModel,
  DemoAfterSalesCaseViewModel,
  DemoCommissioningSessionViewModel,
  DemoWarrantyViewModel,
  DeliveryDemoViewModel,
  DeliverySummaryViewModel,
  DrawingDiscipline,
  DrawingSignoffStatus,
  EngineeringChangeInput,
  EngineeringChangeSource,
  EngineeringChangeStatus,
  InvoiceStatus,
  InvoiceInput,
  InvoiceType,
  WarrantyStatus,
} from '../../domain/workforce'
import { optionalYuanToCents, signedYuanToCents } from '../../domain/workforce'
import { formatChineseDateTime, localISODate, localISODateTimeInput } from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import BusinessAttachmentLinks from '../common/BusinessAttachmentLinks.vue'
import BusinessAttachmentUpload from '../common/BusinessAttachmentUpload.vue'
import {
  clearPendingWrite,
  defaultDeliveryPendingOwner,
  deliveryPendingKey,
  getPendingWrite,
  setPendingWrite,
} from '../../pendingWriteRegistry'
import {
  createHttpDeliveryRepository,
  type DeliveryWorkspaceRepository,
} from '../../repositories/delivery.live'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'

const props = withDefaults(defineProps<{
  projectCode: string
  scope?: 'all' | 'commissioning' | 'delivery'
  readonly?: boolean
  repository?: DeliveryWorkspaceRepository
}>(), {
  readonly: false,
})
const emit = defineEmits<{ changed: []; 'open-commercial': [] }>()

type DeliveryTab = 'commissioning' | 'changes' | 'acceptance' | 'after-sales'

const defaultRepository = createHttpDeliveryRepository()
let repository = toRaw(props.repository ?? defaultRepository)
const pendingOwner = shallowRef<object>(props.repository ? toRaw(props.repository) : defaultDeliveryPendingOwner)
const activeTab = ref<DeliveryTab>(props.scope === 'delivery' ? 'acceptance' : 'commissioning')
const moduleTitle = computed(() => props.scope === 'commissioning'
  ? '调试与工程变更'
  : props.scope === 'delivery' ? '验收、发票与售后' : '交付、质量与售后')
const moduleDescription = computed(() => props.scope === 'commissioning'
  ? `项目 ${props.projectCode} · 会签、调试和现场变更集中处理。`
  : props.scope === 'delivery'
    ? `项目 ${props.projectCode} · 验收、质保、发票和售后各自记录。`
    : `项目 ${props.projectCode} · 会签、调试、验收、发票和售后各自记录。`)
const defaultSection = (): DeliveryTab => props.scope === 'delivery' ? 'acceptance' : 'commissioning'
const model = ref<DeliveryDemoViewModel | null>(null)
const deliverySummary = ref<DeliverySummaryViewModel | null>(null)
const finalPaymentSummary = computed(() => deliverySummary.value?.final_payment ?? null)
const deliverySummaryLoading = ref(false)
const deliverySummaryError = ref('')
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const actionSuccess = ref('')
const formError = ref('')
const documentOptions = ref<DocumentVersionOption[]>([])
const signoffFiles = ref<File[]>([])
const commissioningFiles = ref<File[]>([])
const changeFiles = ref<File[]>([])
const acceptanceFiles = ref<File[]>([])
const invoiceFiles = ref<File[]>([])
interface DeliveryActionContext {
  generation: number
  sequence: number
  projectCode: string
  repository: DeliveryWorkspaceRepository
  owner: object
}

interface PendingInvoiceSubmission {
  owner: object
  key: string
  projectCode: string
  repository: DeliveryWorkspaceRepository
  input: InvoiceInput
  files: File[]
  inFlight: boolean
  committed: boolean
}

type PendingDeliveryCreateKind = 'commissioning' | 'change' | 'acceptance' | 'after-sales'

interface PendingDeliveryCreateSubmission {
  owner: object
  key: string
  kind: PendingDeliveryCreateKind
  projectCode: string
  repository: DeliveryWorkspaceRepository
  input: CommissioningSessionInput | EngineeringChangeInput | AcceptanceInput | AfterSalesInput
  files: File[]
  send: () => Promise<void>
  discard: () => boolean
  inFlight: boolean
  committed: boolean
}

let pendingChangeConfirmationToken: symbol | null = null
let mounted = true
let actionGeneration = 0
let actionSequence = 0
const formBusy = ref(false)
const signoffVisible = ref(false)
const commissioningVisible = ref(false)
const changeVisible = ref(false)
const acceptanceVisible = ref(false)
const invoiceVisible = ref(false)
const afterSalesVisible = ref(false)
const acceptanceCompleteVisible = ref(false)
const acceptanceCancelVisible = ref(false)
const warrantyVisible = ref(false)
const invoiceVoidVisible = ref(false)
const afterSalesStatusVisible = ref(false)
const changeTransitionVisible = ref(false)
const selectedDiscipline = ref<DrawingDiscipline>('mechanical')
const selectedCommissioningId = ref<number | null>(null)
const editingChangeId = ref<number | null>(null)
const editingAcceptanceId = ref<number | null>(null)
const selectedAcceptanceId = ref(0)
const editingInvoiceId = ref<number | null>(null)
const selectedInvoiceId = ref(0)
const selectedAfterSalesId = ref(0)
const editingAfterSalesId = ref<number | null>(null)
const selectedChangeId = ref(0)
const selectedChangeStatus = ref<EngineeringChangeStatus>('proposed')
let loadVersion = 0
let deliverySummaryLoadVersion = 0

function invoiceSubmissionForCurrentContext(): PendingInvoiceSubmission | null {
  return getPendingWrite<PendingInvoiceSubmission>(
    pendingOwner.value,
    deliveryPendingKey('invoice', props.projectCode),
  )
}

function deliveryCreateForCurrentContext(kind: PendingDeliveryCreateKind): PendingDeliveryCreateSubmission | null {
  return getPendingWrite<PendingDeliveryCreateSubmission>(
    pendingOwner.value,
    deliveryPendingKey(kind, props.projectCode),
  )
}

const recoverableInvoiceSubmission = computed(() => {
  const pending = invoiceSubmissionForCurrentContext()
  return pending
    && editingInvoiceId.value === null
    && !pending.inFlight
    && !pending.committed
    ? pending
    : null
})
const invoiceSubmissionBusy = computed(() => Boolean(invoiceSubmissionForCurrentContext()?.inFlight))

const signoffForm = reactive({ status: 'confirmed' as DrawingSignoffStatus, confirmedOn: '', reason: '', notes: '', documentVersionIds: [] as number[] })
const commissioningForm = reactive({ startedAt: '', endedAt: '', status: 'planned' as CommissioningStatus, summary: '', issues: '', nextAction: '', notes: '', documentVersionIds: [] as number[] })
const changeForm = reactive({ source: 'customer_request' as EngineeringChangeSource, title: '', description: '', reason: '', contractDeltaYuan: '0.00', estimatedCostDeltaYuan: '0.00', scheduleDeltaDays: 0, proposedOn: '', notes: '', documentVersionIds: [] as number[] })
const acceptanceForm = reactive({ acceptanceType: 'pre_acceptance' as AcceptanceType, scheduledOn: '', notes: '', correctionReason: '' })
const invoiceForm = reactive({ invoiceType: 'contract_payment' as InvoiceType, status: 'planned' as InvoiceStatus, requestedOn: '', recordedOn: '', invoiceNumber: '', amountYuan: '', counterpartyName: '', notes: '', documentVersionIds: [] as number[] })
const afterSalesForm = reactive({ reportedOn: '', serviceOn: '', reason: '', contactName: '', contactPhone: '', coverageType: '' as AfterSalesCoverageType | '', notes: '' })
type AcceptanceCompletionStatus = Extract<AcceptanceStatus, 'passed' | 'passed_with_punch' | 'failed'>
const acceptanceCompleteForm = reactive({
  status: '' as AcceptanceCompletionStatus | '',
  performedOn: '', notes: '', warrantyStartsOn: '', warrantyMonths: 12,
  warrantyRenewalPriceYuan: '', warrantyNotes: '',
  documentVersionIds: [] as number[],
})
const acceptanceCancelForm = reactive({ reason: '' })
const warrantyForm = reactive({ startsOn: '', durationMonths: 12, renewalPriceYuan: '', notes: '' })
const invoiceVoidForm = reactive({ reason: '' })
const afterSalesStatusForm = reactive({ status: 'in_progress' as AfterSalesStatus, resolution: '' })
const changeTransitionForm = reactive({ targetStatus: 'approved' as EngineeringChangeStatus, reason: '' })

const disciplineLabels: Record<DrawingDiscipline, string> = { mechanical: '机械图纸', electrical: '电气图纸' }
const signoffLabels: Record<DrawingSignoffStatus, string> = { pending: '待确认', confirmed: '已确认', not_required: '无需图纸' }
const commissioningLabels: Record<CommissioningStatus, string> = { planned: '已计划', in_progress: '调试中', blocked: '阻塞', completed: '已完成', cancelled: '已取消' }
const changeStatusLabels: Record<EngineeringChangeStatus, string> = { proposed: '已提出', approved: '已批准', rejected: '已拒绝', implemented: '已实施', cancelled: '已取消' }
const changeSourceLabels: Record<EngineeringChangeSource, string> = { commissioning: '调试', customer_request: '客户要求', site_condition: '现场条件', technical_agreement: '技术协议', other: '其他' }
const acceptanceTypeLabels: Record<AcceptanceType, string> = { pre_acceptance: '预验收', final: '最终验收', reinspection: '复验' }
const acceptanceStatusLabels: Record<AcceptanceStatus, string> = { scheduled: '已安排', passed: '通过', passed_with_punch: '带整改项通过', failed: '未通过', cancelled: '已取消' }
const warrantyStatusLabels: Record<WarrantyStatus, string> = { not_started: '未开始', active: '生效中', expiring: '即将到期', expired: '已到期' }
const invoiceTypeLabels: Record<InvoiceType, string> = { contract_payment: '合同款', additional_work: '增补工作', warranty_service: '质保服务', other: '其他' }
const invoiceStatusLabels: Record<InvoiceStatus, string> = { planned: '计划中', requested: '已申请', recorded: '已登记', void: '已作废' }
const invoiceCreationStatusLabels: Record<Exclude<InvoiceStatus, 'void'>, string> = {
  planned: '计划中',
  requested: '已申请',
  recorded: '已登记',
}
const coverageLabels: Record<AfterSalesCoverageType, string> = { warranty: '保内处理', paid: '付费服务', goodwill: '善意支持' }
const afterSalesStatusLabels: Record<AfterSalesStatus, string> = { open: '待处理', in_progress: '处理中', completed: '已完成', cancelled: '已取消' }
type StatusTagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'
const commissioningStatusTypes: Record<CommissioningStatus, StatusTagType> = {
  planned: 'info', in_progress: 'primary', blocked: 'danger', completed: 'success', cancelled: 'info',
}
const changeStatusTypes: Record<EngineeringChangeStatus, StatusTagType> = {
  proposed: 'info', approved: 'primary', rejected: 'danger', implemented: 'success', cancelled: 'info',
}
const warrantyStatusTypes: Record<WarrantyStatus, StatusTagType> = {
  not_started: 'info', active: 'success', expiring: 'warning', expired: 'danger',
}
const afterSalesStatusTypes: Record<AfterSalesStatus, StatusTagType> = {
  open: 'warning', in_progress: 'primary', completed: 'success', cancelled: 'info',
}
const afterSalesTransitions: Record<AfterSalesStatus, AfterSalesStatus[]> = {
  open: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}
const selectedAfterSalesStatus = ref<AfterSalesStatus>('open')
const availableAfterSalesStatuses = computed(() => afterSalesTransitions[selectedAfterSalesStatus.value])
const changeTransitions: Record<EngineeringChangeStatus, EngineeringChangeStatus[]> = {
  proposed: ['approved', 'rejected', 'cancelled'],
  approved: ['implemented', 'cancelled'],
  rejected: [],
  implemented: [],
  cancelled: [],
}
const availableChangeStatuses = computed(() => changeTransitions[selectedChangeStatus.value])
const selectedAcceptance = computed(() => model.value?.acceptances.find((item) => item.acceptance_id === selectedAcceptanceId.value) ?? null)
const acceptanceNeedsWarranty = computed(() => selectedAcceptance.value?.acceptance_type === 'final'
  && (acceptanceCompleteForm.status === 'passed' || acceptanceCompleteForm.status === 'passed_with_punch'))
const afterSalesWarrantyJudgment = computed(() => {
  const warranty = model.value?.warranty
  if (!warranty) {
    return {
      isUnderWarranty: false,
      label: '系统判断：未建立质保',
      detail: '当前项目没有质保期限，不能登记为保内处理。',
      type: 'info' as const,
    }
  }
  const reportedOn = afterSalesForm.reportedOn
  const isUnderWarranty = reportedOn >= warranty.starts_on && reportedOn <= warranty.ends_on
  return isUnderWarranty
    ? {
        isUnderWarranty,
        label: '系统判断：保内',
        detail: `报修日位于 ${warranty.starts_on} 至 ${warranty.ends_on} 的质保期内。`,
        type: 'success' as const,
      }
    : {
        isUnderWarranty,
        label: '系统判断：过保',
        detail: `报修日不在 ${warranty.starts_on} 至 ${warranty.ends_on} 的质保期内。`,
        type: 'warning' as const,
      }
})

function optionalText(value: string): string | null {
  return value.trim() || null
}

function startAction(actionRepository: DeliveryWorkspaceRepository = repository): DeliveryActionContext {
  return {
    generation: actionGeneration,
    sequence: ++actionSequence,
    projectCode: props.projectCode,
    repository: actionRepository,
    owner: pendingOwner.value,
  }
}

function isCurrentAction(context: DeliveryActionContext): boolean {
  return mounted
    && context.generation === actionGeneration
    && context.sequence === actionSequence
    && context.projectCode === props.projectCode
    && context.owner === pendingOwner.value
}

async function refreshModel(context: DeliveryActionContext): Promise<void> {
  const result = await context.repository.getDeliveryPreview(context.projectCode)
  if (isCurrentAction(context)) model.value = result.data
}

async function loadDeliverySummary(
  projectCode = props.projectCode,
  sourceRepository = repository,
): Promise<void> {
  const version = ++deliverySummaryLoadVersion
  deliverySummaryLoading.value = true
  deliverySummaryError.value = ''
  try {
    const result = await sourceRepository.getDeliverySummary(projectCode)
    if (version === deliverySummaryLoadVersion && projectCode === props.projectCode && sourceRepository === repository) {
      deliverySummary.value = result.data
    }
  } catch (error) {
    if (version === deliverySummaryLoadVersion && projectCode === props.projectCode && sourceRepository === repository) {
      deliverySummary.value = null
      deliverySummaryError.value = error instanceof Error ? error.message : '尾款摘要读取失败'
    }
  } finally {
    if (version === deliverySummaryLoadVersion) deliverySummaryLoading.value = false
  }
}

async function runAction(
  action: () => Promise<void>,
  close: () => void,
  message: string,
  suppliedContext?: DeliveryActionContext,
): Promise<void> {
  if (formBusy.value || props.readonly) {
    if (props.readonly) actionError.value = '项目已归档，只能查看，不能再修改交付记录'
    return
  }
  const context = suppliedContext ?? startAction()
  formBusy.value = true
  actionError.value = ''
  actionSuccess.value = ''
  formError.value = ''
  try {
    await action()
    if (!isCurrentAction(context)) return
    close()
    actionSuccess.value = message
    emit('changed')
    ElMessage.success(actionSuccess.value)
    try {
      await refreshModel(context)
    } catch {
      if (!isCurrentAction(context)) return
      actionSuccess.value = `${message}；已保存但刷新失败，请手动刷新页面查看最新数据`
      ElMessage.warning(actionSuccess.value)
    }
  } catch (error) {
    if (isCurrentAction(context)) {
      formError.value = deliveryErrorMessage(error)
      actionError.value = formError.value
    }
  } finally {
    if (isCurrentAction(context)) formBusy.value = false
  }
}

function deliveryErrorMessage(error: unknown): string {
  const errorCode = typeof error === 'object' && error !== null && 'errorCode' in error
    ? (error as { errorCode?: unknown }).errorCode
    : undefined
  if (errorCode === 'INVOICE_NUMBER_CONFLICT') return '发票号码已存在，请核对后再保存'
  if (errorCode === 'WARRANTY_COVERAGE_MISMATCH') return '保障方式与报修日期的质保判断不一致，请重新选择'
  return error instanceof Error ? error.message : '保存失败'
}

function prepareDialog(): boolean {
  if (props.readonly) {
    actionError.value = '项目已归档，只能查看，不能再修改交付记录'
    return false
  }
  formError.value = ''
  actionError.value = ''
  return true
}

function preventBusyClose(done: () => void): void {
  if (formBusy.value) return
  confirmUnsavedClose(done)
}

function confirmUnsavedClose(done: () => void, message = '关闭后未保存的内容会丢失，确定关闭吗？'): void {
  void ElMessageBox.confirm(
    message,
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => done()).catch(() => undefined)
}

function pendingDeliveryCreate(
  kind: PendingDeliveryCreateKind,
  context: DeliveryActionContext,
  input: PendingDeliveryCreateSubmission['input'],
  files: File[],
  send: () => Promise<void>,
  discard: () => boolean,
): PendingDeliveryCreateSubmission {
  const key = deliveryPendingKey(kind, context.projectCode)
  const current = getPendingWrite<PendingDeliveryCreateSubmission>(context.owner, key)
  if (current) return current
  const pending = {
    owner: context.owner,
    key,
    kind,
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    files,
    send,
    discard,
    inFlight: false,
    committed: false,
  }
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

function runPendingDeliveryCreate(
  pending: PendingDeliveryCreateSubmission,
  close: () => void,
  message: string,
  context: DeliveryActionContext,
): Promise<void> {
  return runAction(async () => {
    pending.inFlight = true
    pending.committed = false
    setPendingWrite(pending.owner, pending.key, pending)
    try {
      await pending.send()
      pending.inFlight = false
      pending.committed = true
      setPendingWrite(pending.owner, pending.key, pending)
    } catch (error) {
      pending.inFlight = false
      if (isDefinitiveDeliveryCreateFailure(error)) {
        clearPendingWrite(pending.owner, pending.key, pending)
      } else setPendingWrite(pending.owner, pending.key, pending)
      throw error
    }
  }, () => {
    clearPendingWrite(pending.owner, pending.key, pending)
    close()
  }, message, context)
}

function isDefinitiveDeliveryCreateFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function discardDeliveryCreateSubmission(pending: PendingDeliveryCreateSubmission): boolean {
  const discarded = pending.discard()
  if (discarded) clearPendingWrite(pending.owner, pending.key, pending)
  return discarded
}

function recoverableDeliveryCreate(kind: PendingDeliveryCreateKind): boolean {
  const pending = deliveryCreateForCurrentContext(kind)
  return Boolean(pending && !pending.inFlight && !pending.committed)
}

function hasDeliveryCreate(kind: PendingDeliveryCreateKind): boolean {
  return Boolean(deliveryCreateForCurrentContext(kind))
}

function deliveryCreateBusy(kind: PendingDeliveryCreateKind): boolean {
  return Boolean(deliveryCreateForCurrentContext(kind)?.inFlight)
}

function abandonRecoverableDeliveryCreate(kind: PendingDeliveryCreateKind): void {
  const pending = deliveryCreateForCurrentContext(kind)
  if (!pending || pending.inFlight || pending.committed) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的新增记录',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (!discardDeliveryCreateSubmission(pending)) {
      formError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
    }
  }).catch(() => undefined)
}

function restoreDeliveryCreateSubmission(pending: PendingDeliveryCreateSubmission): void {
  if (pending.kind === 'commissioning') {
    const input = pending.input as CommissioningSessionInput
    selectedCommissioningId.value = null
    Object.assign(commissioningForm, {
      startedAt: input.started_at,
      endedAt: input.ended_at ?? '',
      status: input.status,
      summary: input.summary ?? '',
      issues: input.issues ?? '',
      nextAction: input.next_action ?? '',
      notes: input.notes ?? '',
      documentVersionIds: [...input.document_version_ids],
    })
    commissioningFiles.value = pending.files
    activeTab.value = 'commissioning'
    commissioningVisible.value = true
  }
  if (pending.kind === 'change') {
    const input = pending.input as EngineeringChangeInput
    editingChangeId.value = null
    Object.assign(changeForm, {
      source: input.source,
      title: input.title,
      description: input.description,
      reason: input.reason,
      contractDeltaYuan: (input.contract_delta_cents / 100).toFixed(2),
      estimatedCostDeltaYuan: (input.estimated_cost_delta_cents / 100).toFixed(2),
      scheduleDeltaDays: input.schedule_delta_days,
      proposedOn: input.proposed_on,
      notes: input.notes ?? '',
      documentVersionIds: [...input.document_version_ids],
    })
    changeFiles.value = pending.files
    activeTab.value = 'changes'
    changeVisible.value = true
  }
  if (pending.kind === 'acceptance') {
    const input = pending.input as AcceptanceInput
    editingAcceptanceId.value = null
    Object.assign(acceptanceForm, {
      acceptanceType: input.acceptance_type,
      scheduledOn: input.scheduled_on,
      notes: input.notes ?? '',
      correctionReason: '',
    })
    activeTab.value = 'acceptance'
    acceptanceVisible.value = true
  }
  if (pending.kind === 'after-sales') {
    const input = pending.input as AfterSalesInput
    editingAfterSalesId.value = null
    Object.assign(afterSalesForm, {
      reportedOn: input.reported_on,
      serviceOn: input.service_on ?? '',
      reason: input.reason,
      contactName: input.contact_name,
      contactPhone: input.contact_phone,
      coverageType: input.coverage_type,
      notes: input.notes ?? '',
    })
    activeTab.value = 'after-sales'
    afterSalesVisible.value = true
  }
}

function restoreInvoiceSubmission(pending: PendingInvoiceSubmission): void {
  editingInvoiceId.value = null
  Object.assign(invoiceForm, {
    invoiceType: pending.input.invoice_type,
    status: pending.input.status,
    requestedOn: pending.input.requested_on ?? '',
    recordedOn: pending.input.recorded_on ?? '',
    invoiceNumber: pending.input.invoice_number ?? '',
    amountYuan: pending.input.amount_cents === null ? '' : (pending.input.amount_cents / 100).toFixed(2),
    counterpartyName: pending.input.counterparty_name ?? '',
    notes: pending.input.notes ?? '',
    documentVersionIds: [...pending.input.document_version_ids],
  })
  invoiceFiles.value = pending.files
  activeTab.value = 'after-sales'
  invoiceVisible.value = true
}

function restoreCurrentPendingWrites(): void {
  for (const kind of ['commissioning', 'change', 'acceptance', 'after-sales'] as const) {
    const pending = deliveryCreateForCurrentContext(kind)
    if (pending && !pending.committed) restoreDeliveryCreateSubmission(pending)
  }
  const invoicePending = invoiceSubmissionForCurrentContext()
  if (invoicePending && !invoicePending.committed) restoreInvoiceSubmission(invoicePending)
}

function consumeCommittedPendingWrites(): void {
  if (loading.value || formBusy.value) return
  const committed = [
    ...(['commissioning', 'change', 'acceptance', 'after-sales'] as const)
      .map((kind) => deliveryCreateForCurrentContext(kind))
      .filter((pending): pending is PendingDeliveryCreateSubmission => Boolean(pending?.committed)),
    invoiceSubmissionForCurrentContext(),
  ].filter((pending): pending is PendingDeliveryCreateSubmission | PendingInvoiceSubmission => Boolean(pending?.committed))
  if (committed.length === 0) return
  for (const pending of committed) clearPendingWrite(pending.owner, pending.key, pending)
  commissioningVisible.value = false
  changeVisible.value = false
  acceptanceVisible.value = false
  afterSalesVisible.value = false
  invoiceVisible.value = false
  actionSuccess.value = '先前提交的交付记录已保存，当前数据已刷新'
  emit('changed')
  ElMessage.success(actionSuccess.value)
  const context = startAction()
  void refreshModel(context).catch(() => {
    if (isCurrentAction(context)) actionSuccess.value = '先前提交的交付记录已保存，但刷新失败，请手动刷新页面'
  })
}

function preventCommissioningClose(done: () => void): void {
  preventDeliveryCreateClose('commissioning', done)
}

function preventChangeClose(done: () => void): void {
  preventDeliveryCreateClose('change', done)
}

function preventAcceptanceClose(done: () => void): void {
  preventDeliveryCreateClose('acceptance', done)
}

function preventAfterSalesClose(done: () => void): void {
  preventDeliveryCreateClose('after-sales', done)
}

function preventDeliveryCreateClose(
  kind: PendingDeliveryCreateKind,
  done: () => void,
): void {
  if (formBusy.value || deliveryCreateBusy(kind)) return
  const pending = deliveryCreateForCurrentContext(kind)
  if (!pending) {
    confirmUnsavedClose(done)
    return
  }
  void ElMessageBox.confirm(
    '本次新增结果未知。放弃后将不能使用原请求安全重试，确定关闭吗？',
    '放弃结果未知的新增记录',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (discardDeliveryCreateSubmission(pending)) done()
    else formError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function preventInvoiceClose(done: () => void): void {
  if (formBusy.value || invoiceSubmissionBusy.value) return
  const pending = recoverableInvoiceSubmission.value
  if (pending) {
    void ElMessageBox.confirm(
      '本次发票登记结果未知。放弃后将不能使用原请求安全重试，确定关闭吗？',
      '放弃结果未知的发票登记',
      { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '保留原请求' },
    ).then(() => {
      if (discardInvoiceSubmission(pending)) done()
      else formError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
    }).catch(() => undefined)
    return
  }
  confirmUnsavedClose(
    done,
    '关闭后未保存的发票内容和待上传图片会丢失，确定关闭吗？',
  )
}

type DeliveryDialogName =
  | 'transition' | 'acceptance-complete' | 'warranty' | 'invoice-void'
  | 'after-sales-status' | 'signoff' | 'commissioning' | 'change'
  | 'acceptance' | 'acceptance-cancel' | 'invoice' | 'after-sales'

function cancelDeliveryDialog(name: DeliveryDialogName): void {
  if (formBusy.value) return
  if (name === 'commissioning') {
    preventCommissioningClose(() => { commissioningVisible.value = false })
    return
  }
  if (name === 'change') {
    preventChangeClose(() => { changeVisible.value = false })
    return
  }
  if (name === 'acceptance') {
    preventAcceptanceClose(() => { acceptanceVisible.value = false })
    return
  }
  if (name === 'invoice') {
    preventInvoiceClose(() => { invoiceVisible.value = false })
    return
  }
  if (name === 'after-sales') {
    preventAfterSalesClose(() => { afterSalesVisible.value = false })
    return
  }
  confirmUnsavedClose(() => {
    if (name === 'transition') changeTransitionVisible.value = false
    if (name === 'acceptance-complete') acceptanceCompleteVisible.value = false
    if (name === 'warranty') warrantyVisible.value = false
    if (name === 'invoice-void') invoiceVoidVisible.value = false
    if (name === 'after-sales-status') afterSalesStatusVisible.value = false
    if (name === 'signoff') signoffVisible.value = false
    if (name === 'acceptance-cancel') acceptanceCancelVisible.value = false
  })
}

function openSignoff(discipline: DrawingDiscipline): void {
  if (!prepareDialog()) return
  const signoff = model.value?.drawing_signoffs.find((item) => item.discipline === discipline)
  if (!signoff) return
  selectedDiscipline.value = discipline
  Object.assign(signoffForm, { status: signoff.status, confirmedOn: signoff.confirmed_on ?? '', reason: signoff.not_required_reason ?? '', notes: signoff.notes ?? '', documentVersionIds: [...signoff.document_version_ids] })
  signoffFiles.value = []
  signoffVisible.value = true
}

function saveSignoff(): Promise<void> {
  const files = [...signoffFiles.value]
  return runAction(() => repository.saveDrawingSignoff(props.projectCode, selectedDiscipline.value, {
    status: signoffForm.status, confirmed_on: optionalText(signoffForm.confirmedOn),
    not_required_reason: signoffForm.status === 'not_required' ? optionalText(signoffForm.reason) : null,
    notes: optionalText(signoffForm.notes), document_version_ids: [...signoffForm.documentVersionIds],
  }, files), () => { signoffVisible.value = false }, '图纸会签已更新')
}

function resetSignoffFiles(): void {
  if (!formBusy.value) signoffFiles.value = []
}

function openCommissioningCreate(): void {
  if (!prepareDialog()) return
  selectedCommissioningId.value = null
  Object.assign(commissioningForm, { startedAt: localISODateTimeInput(), endedAt: '', status: 'in_progress', summary: '', issues: '', nextAction: '', notes: '', documentVersionIds: [] })
  commissioningFiles.value = []
  commissioningVisible.value = true
}

function openChangeCreate(): void {
  if (!prepareDialog()) return
  editingChangeId.value = null
  Object.assign(changeForm, { source: 'customer_request', title: '', description: '', reason: '', contractDeltaYuan: '0.00', estimatedCostDeltaYuan: '0.00', scheduleDeltaDays: 0, proposedOn: localISODate(), notes: '', documentVersionIds: [] })
  changeFiles.value = []
  changeVisible.value = true
}

function openChangeEdit(change: DeliveryDemoViewModel['engineering_changes'][number]): void {
  if (change.status !== 'proposed' || !prepareDialog()) return
  editingChangeId.value = change.change_id
  Object.assign(changeForm, {
    source: change.source,
    title: change.title,
    description: change.description,
    reason: change.reason,
    contractDeltaYuan: (change.contract_delta_cents / 100).toFixed(2),
    estimatedCostDeltaYuan: (change.estimated_cost_delta_cents / 100).toFixed(2),
    scheduleDeltaDays: change.schedule_delta_days,
    proposedOn: change.proposed_on,
    notes: change.notes ?? '',
    documentVersionIds: [...change.document_version_ids],
  })
  changeFiles.value = []
  changeVisible.value = true
}

function openAcceptanceCreate(): void {
  if (!prepareDialog()) return
  editingAcceptanceId.value = null
  Object.assign(acceptanceForm, { acceptanceType: 'pre_acceptance', scheduledOn: localISODate(), notes: '', correctionReason: '' })
  acceptanceVisible.value = true
}

function openAcceptanceReschedule(acceptance: DemoAcceptanceViewModel): void {
  if (acceptance.status !== 'scheduled' || !prepareDialog()) return
  editingAcceptanceId.value = acceptance.acceptance_id
  Object.assign(acceptanceForm, {
    acceptanceType: acceptance.acceptance_type,
    scheduledOn: acceptance.scheduled_on,
    notes: acceptance.notes ?? '',
    correctionReason: '',
  })
  acceptanceVisible.value = true
}

function openAcceptanceCancel(acceptance: DemoAcceptanceViewModel): void {
  if (acceptance.status !== 'scheduled' || !prepareDialog()) return
  selectedAcceptanceId.value = acceptance.acceptance_id
  acceptanceCancelForm.reason = ''
  acceptanceCancelVisible.value = true
}

function openInvoiceCreate(): void {
  if (!prepareDialog()) return
  editingInvoiceId.value = null
  Object.assign(invoiceForm, { invoiceType: 'contract_payment', status: 'planned', requestedOn: '', recordedOn: '', invoiceNumber: '', amountYuan: '', counterpartyName: '', notes: '', documentVersionIds: [] })
  invoiceFiles.value = []
  invoiceVisible.value = true
}

function openInvoiceEdit(invoice: DeliveryDemoViewModel['invoices'][number]): void {
  if (invoice.status !== 'planned' && invoice.status !== 'requested') return
  if (!prepareDialog()) return
  editingInvoiceId.value = invoice.invoice_id
  Object.assign(invoiceForm, {
    invoiceType: invoice.invoice_type,
    status: invoice.status,
    requestedOn: invoice.requested_on ?? '',
    recordedOn: invoice.recorded_on ?? '',
    invoiceNumber: invoice.invoice_number ?? '',
    amountYuan: invoice.amount_cents === null ? '' : (invoice.amount_cents / 100).toFixed(2),
    counterpartyName: invoice.counterparty_name ?? '',
    notes: invoice.notes ?? '',
    documentVersionIds: [...invoice.document_version_ids],
  })
  invoiceFiles.value = []
  invoiceVisible.value = true
}

function prepareInvoiceDatesForStatus(status: InvoiceStatus): void {
  if (status === 'planned') {
    invoiceForm.requestedOn = ''
    invoiceForm.recordedOn = ''
    return
  }
  if (!invoiceForm.requestedOn) invoiceForm.requestedOn = localISODate()
  if (status === 'recorded' && !invoiceForm.recordedOn) {
    invoiceForm.recordedOn = localISODate()
  }
  if (status === 'requested') invoiceForm.recordedOn = ''
}

function openAfterSalesCreate(): void {
  if (!prepareDialog()) return
  editingAfterSalesId.value = null
  Object.assign(afterSalesForm, { reportedOn: localISODate(), serviceOn: '', reason: '', contactName: '', contactPhone: '', coverageType: '', notes: '' })
  afterSalesVisible.value = true
}

function openAfterSalesEdit(item: DemoAfterSalesCaseViewModel): void {
  if ((item.status !== 'open' && item.status !== 'in_progress') || !prepareDialog()) return
  editingAfterSalesId.value = item.case_id
  Object.assign(afterSalesForm, {
    reportedOn: item.reported_on,
    serviceOn: item.service_on ?? '',
    reason: item.reason,
    contactName: item.contact_name,
    contactPhone: item.contact_phone,
    coverageType: item.coverage_type,
    notes: item.notes ?? '',
  })
  afterSalesVisible.value = true
}

function openCommissioningEdit(session: DemoCommissioningSessionViewModel): void {
  if (!prepareDialog()) return
  selectedCommissioningId.value = session.session_id
  Object.assign(commissioningForm, {
    startedAt: session.started_at,
    endedAt: session.ended_at ?? '',
    status: session.status,
    summary: session.summary ?? '',
    issues: session.issues ?? '',
    nextAction: session.next_action ?? '',
    notes: session.notes ?? '',
    documentVersionIds: [...session.document_version_ids],
  })
  commissioningFiles.value = []
  commissioningVisible.value = true
}

function saveCommissioning(): Promise<void> {
  if (props.readonly || formBusy.value || deliveryCreateBusy('commissioning')) return Promise.resolve()
  const input: CommissioningSessionInput = {
    started_at: commissioningForm.startedAt, ended_at: optionalText(commissioningForm.endedAt), status: commissioningForm.status,
    summary: optionalText(commissioningForm.summary), issues: optionalText(commissioningForm.issues), next_action: optionalText(commissioningForm.nextAction), notes: optionalText(commissioningForm.notes), document_version_ids: [...commissioningForm.documentVersionIds],
  }
  const files = [...commissioningFiles.value]
  if (selectedCommissioningId.value !== null) {
    const sessionId = selectedCommissioningId.value
    return runAction(
      () => repository.updateCommissioningSession(props.projectCode, sessionId, input),
      () => { commissioningVisible.value = false },
      '调试记录已更新',
    )
  }
  const context = startAction()
  const pending = pendingDeliveryCreate(
    'commissioning',
    context,
    input,
    files,
    () => context.repository.saveCommissioningSession(context.projectCode, input, files),
    () => context.repository.discardSaveCommissioningSession(context.projectCode, input, files),
  )
  return runPendingDeliveryCreate(
    pending,
    () => { commissioningVisible.value = false },
    '调试记录已新增',
    context,
  )
}

function saveChange(): Promise<void> {
  if (props.readonly || formBusy.value || deliveryCreateBusy('change')) return Promise.resolve()
  const input: EngineeringChangeInput = {
    source: changeForm.source, title: changeForm.title.trim(), description: changeForm.description.trim(), reason: changeForm.reason.trim(),
    contract_delta_cents: signedYuanToCents(changeForm.contractDeltaYuan), estimated_cost_delta_cents: signedYuanToCents(changeForm.estimatedCostDeltaYuan),
    schedule_delta_days: changeForm.scheduleDeltaDays, proposed_on: changeForm.proposedOn, notes: optionalText(changeForm.notes), document_version_ids: [...changeForm.documentVersionIds],
  }
  const files = [...changeFiles.value]
  if (editingChangeId.value !== null) {
    const changeId = editingChangeId.value
    return runAction(
      () => repository.updateEngineeringChange(props.projectCode, changeId, input),
      () => { changeVisible.value = false },
      '工程变更已更新',
    )
  }
  const context = startAction()
  const pending = pendingDeliveryCreate(
    'change',
    context,
    input,
    files,
    () => context.repository.saveEngineeringChange(context.projectCode, input, files),
    () => context.repository.discardSaveEngineeringChange(context.projectCode, input, files),
  )
  return runPendingDeliveryCreate(
    pending,
    () => { changeVisible.value = false },
    '工程变更已新增',
    context,
  )
}

function resetCommissioningFiles(): void {
  if (!formBusy.value) commissioningFiles.value = []
}

function resetChangeFiles(): void {
  if (!formBusy.value) changeFiles.value = []
}

function saveAcceptance(): Promise<void> {
  if (props.readonly || formBusy.value || deliveryCreateBusy('acceptance')) return Promise.resolve()
  if (editingAcceptanceId.value !== null && !acceptanceForm.correctionReason.trim()) {
    formError.value = '请填写改期原因'
    return Promise.resolve()
  }
  const input: AcceptanceInput = {
    acceptance_type: acceptanceForm.acceptanceType, scheduled_on: acceptanceForm.scheduledOn, notes: optionalText(acceptanceForm.notes),
  }
  if (editingAcceptanceId.value !== null) {
    const acceptanceId = editingAcceptanceId.value
    return runAction(
      () => repository.rescheduleAcceptance(
        props.projectCode,
        acceptanceId,
        input,
        acceptanceForm.correctionReason,
      ),
      () => { acceptanceVisible.value = false },
      '验收计划已改期',
    )
  }
  const context = startAction()
  const pending = pendingDeliveryCreate(
    'acceptance',
    context,
    input,
    [],
    () => context.repository.saveAcceptance(context.projectCode, input),
    () => context.repository.discardSaveAcceptance(context.projectCode, input),
  )
  return runPendingDeliveryCreate(
    pending,
    () => { acceptanceVisible.value = false },
    '验收计划已新增',
    context,
  )
}

function saveAcceptanceCancellation(): Promise<void> | undefined {
  if (!acceptanceCancelForm.reason.trim()) {
    formError.value = '请填写取消原因'
    return undefined
  }
  return runAction(
    () => repository.cancelAcceptance(props.projectCode, selectedAcceptanceId.value, acceptanceCancelForm.reason),
    () => { acceptanceCancelVisible.value = false },
    '验收计划已取消',
  )
}

function saveInvoice(): Promise<void> | undefined {
  if (props.readonly || formBusy.value || invoiceSubmissionBusy.value) return undefined
  const recoverable = recoverableInvoiceSubmission.value
  if (recoverable) return submitInvoice(recoverable)
  const hasMeaningfulField = Boolean(
    invoiceFiles.value.length
    || invoiceForm.documentVersionIds.length
    || invoiceForm.invoiceNumber.trim()
    || invoiceForm.amountYuan.trim()
    || invoiceForm.counterpartyName.trim()
    || invoiceForm.requestedOn
    || invoiceForm.notes.trim(),
  )
  if (!hasMeaningfulField) {
    formError.value = '请至少上传一个文件、关联一份已有资料，或填写一项发票信息'
    return undefined
  }
  let amount: number | null
  try {
    amount = optionalYuanToCents(invoiceForm.amountYuan)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '发票金额不正确'
    return undefined
  }
  const status = invoiceForm.status
  const requestedOn = status === 'planned' ? null : optionalText(invoiceForm.requestedOn)
  const recordedOn = status === 'recorded' ? optionalText(invoiceForm.recordedOn) : null
  const invoiceNumber = optionalText(invoiceForm.invoiceNumber)
  if (status === 'requested' && requestedOn === null) {
    formError.value = '请填写发票申请日期'
    return undefined
  }
  if (status === 'recorded'
    && (requestedOn === null || recordedOn === null || invoiceNumber === null || amount === null)) {
    formError.value = '已登记发票必须填写申请日期、登记日期、发票号码和金额'
    return undefined
  }
  if (status === 'recorded' && requestedOn !== null && recordedOn !== null && recordedOn < requestedOn) {
    formError.value = '登记日期不能早于申请日期'
    return undefined
  }
  const input: InvoiceInput = {
    invoice_type: invoiceForm.invoiceType, status, requested_on: requestedOn, recorded_on: recordedOn,
    invoice_number: invoiceNumber, amount_cents: amount, counterparty_name: optionalText(invoiceForm.counterpartyName), notes: optionalText(invoiceForm.notes), document_version_ids: [...invoiceForm.documentVersionIds],
  }
  if (editingInvoiceId.value !== null) {
    const invoiceId = editingInvoiceId.value
    return runAction(
      () => repository.updateInvoice(props.projectCode, invoiceId, input),
      () => {
        editingInvoiceId.value = null
        invoiceVisible.value = false
      },
      '发票记录已补录',
    )
  }
  const files = [...invoiceFiles.value]
  const pending: PendingInvoiceSubmission = {
    owner: pendingOwner.value,
    key: deliveryPendingKey('invoice', props.projectCode),
    projectCode: props.projectCode,
    repository,
    input,
    files,
    inFlight: false,
    committed: false,
  }
  setPendingWrite(pending.owner, pending.key, pending)
  return submitInvoice(pending)
}

function submitInvoice(pending: PendingInvoiceSubmission): Promise<void> {
  const context = startAction()
  pending.inFlight = true
  pending.committed = false
  setPendingWrite(pending.owner, pending.key, pending)
  return runAction(() => pending.repository.saveInvoice(
    pending.projectCode,
    pending.input,
    pending.files,
  ).then(
    () => {
      pending.inFlight = false
      pending.committed = true
      setPendingWrite(pending.owner, pending.key, pending)
    },
    (error: unknown) => {
      pending.inFlight = false
      if (isDefinitiveDeliveryCreateFailure(error)) {
        clearPendingWrite(pending.owner, pending.key, pending)
      } else setPendingWrite(pending.owner, pending.key, pending)
      throw error
    },
  ), () => {
    clearPendingWrite(pending.owner, pending.key, pending)
    if (mounted && props.projectCode === pending.projectCode) {
      invoiceVisible.value = false
      invoiceFiles.value = []
    }
  }, '发票记录已新增', context)
}

function discardInvoiceSubmission(pending: PendingInvoiceSubmission): boolean {
  const discarded = pending.repository.discardSaveInvoice(pending.projectCode, pending.input, pending.files)
  if (discarded) clearPendingWrite(pending.owner, pending.key, pending)
  return discarded
}

function abandonRecoverableInvoiceSubmission(): void {
  const pending = recoverableInvoiceSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的发票登记',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    if (!discardInvoiceSubmission(pending)) {
      formError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
    }
  }).catch(() => undefined)
}

function resetInvoiceFiles(): void {
  if (formBusy.value) return
  editingInvoiceId.value = null
  invoiceFiles.value = []
}

function saveAfterSales(): Promise<void> | undefined {
  if (props.readonly || formBusy.value || deliveryCreateBusy('after-sales')) return undefined
  const coverageType = afterSalesForm.coverageType
  if (!coverageType) {
    formError.value = '请选择保障方式'
    return undefined
  }
  if (coverageType === 'warranty' && !afterSalesWarrantyJudgment.value.isUnderWarranty) {
    formError.value = model.value?.warranty
      ? '报修日期不在质保期内，不能选择保内处理'
      : '项目未建立质保，不能选择保内处理'
    return undefined
  }
  const input: AfterSalesInput = {
    reported_on: afterSalesForm.reportedOn, service_on: optionalText(afterSalesForm.serviceOn), reason: afterSalesForm.reason.trim(),
    contact_name: afterSalesForm.contactName.trim(), contact_phone: afterSalesForm.contactPhone.trim(), coverage_type: coverageType, notes: optionalText(afterSalesForm.notes),
  }
  if (editingAfterSalesId.value !== null) {
    const caseId = editingAfterSalesId.value
    return runAction(
      () => repository.updateAfterSalesCase(props.projectCode, caseId, input),
      () => { afterSalesVisible.value = false },
      '售后资料已更新',
    )
  }
  const context = startAction()
  const pending = pendingDeliveryCreate(
    'after-sales',
    context,
    input,
    [],
    () => context.repository.saveAfterSalesCase(context.projectCode, input),
    () => context.repository.discardSaveAfterSalesCase(context.projectCode, input),
  )
  return runPendingDeliveryCreate(
    pending,
    () => { afterSalesVisible.value = false },
    '售后案件已新增',
    context,
  )
}

function openChangeTransition(changeId: number, status: EngineeringChangeStatus): void {
  const next = changeTransitions[status]
  if (next.length === 0) return
  if (!prepareDialog()) return
  selectedChangeId.value = changeId
  selectedChangeStatus.value = status
  Object.assign(changeTransitionForm, { targetStatus: next[0], reason: '' })
  changeTransitionVisible.value = true
}

async function saveChangeTransition(): Promise<void> {
  if (props.readonly) {
    actionError.value = '项目已归档，只能查看，不能再修改交付记录'
    return
  }
  const target = changeTransitionForm.targetStatus
  const context = startAction()
  const changeId = selectedChangeId.value
  const reason = changeTransitionForm.reason
  if (target === 'rejected' || target === 'implemented' || target === 'cancelled') {
    if (pendingChangeConfirmationToken !== null) return
    const confirmationToken = Symbol('change-confirmation')
    pendingChangeConfirmationToken = confirmationToken
    try {
      await ElMessageBox.confirm(
        `确认将工程变更设为“${changeStatusLabels[target]}”？保存后不能恢复到上一状态。`,
        '确认终态',
        { type: 'warning', confirmButtonText: '确认保存', cancelButtonText: '返回检查' },
      )
    } catch {
      return
    } finally {
      if (pendingChangeConfirmationToken === confirmationToken) pendingChangeConfirmationToken = null
    }
  }
  if (!isCurrentAction(context)) return
  return runAction(
    () => context.repository.setEngineeringChangeStatus(
      context.projectCode,
      changeId,
      target,
      reason,
    ),
    () => { changeTransitionVisible.value = false },
    '工程变更状态已更新',
    context,
  )
}

function closePendingChangeConfirmation(): void {
  if (pendingChangeConfirmationToken === null) return
  pendingChangeConfirmationToken = null
  ElMessageBox.close()
}

function openAcceptanceComplete(acceptance: DemoAcceptanceViewModel): void {
  if (!prepareDialog()) return
  selectedAcceptanceId.value = acceptance.acceptance_id
  Object.assign(acceptanceCompleteForm, {
    status: acceptance.status === 'passed' || acceptance.status === 'passed_with_punch' || acceptance.status === 'failed' ? acceptance.status : '',
    performedOn: acceptance.performed_on ?? localISODate(),
    notes: acceptance.notes ?? '',
    warrantyStartsOn: acceptance.performed_on ?? localISODate(),
    warrantyMonths: 12,
    warrantyRenewalPriceYuan: '',
    warrantyNotes: '',
    documentVersionIds: [...acceptance.document_version_ids],
  })
  acceptanceFiles.value = []
  acceptanceCompleteVisible.value = true
}

function saveAcceptanceComplete(): Promise<void> {
  const status = acceptanceCompleteForm.status
  if (!status) {
    formError.value = '请选择本次真实验收结果'
    return Promise.resolve()
  }
  const files = [...acceptanceFiles.value]
  return runAction(() => repository.completeAcceptance(props.projectCode, selectedAcceptanceId.value, {
    status,
    performed_on: acceptanceCompleteForm.performedOn,
    notes: optionalText(acceptanceCompleteForm.notes),
    document_version_ids: [...acceptanceCompleteForm.documentVersionIds],
    warranty: acceptanceNeedsWarranty.value ? {
      starts_on: acceptanceCompleteForm.warrantyStartsOn,
      duration_months: acceptanceCompleteForm.warrantyMonths,
      renewal_price_cents: optionalYuanToCents(acceptanceCompleteForm.warrantyRenewalPriceYuan),
      notes: optionalText(acceptanceCompleteForm.warrantyNotes),
    } : null,
  }, files), () => { acceptanceCompleteVisible.value = false }, '验收结果已保存')
}

function resetAcceptanceFiles(): void {
  if (!formBusy.value) acceptanceFiles.value = []
}

function openWarrantyEdit(warranty: DemoWarrantyViewModel): void {
  if (!prepareDialog()) return
  Object.assign(warrantyForm, {
    startsOn: warranty.starts_on,
    durationMonths: warranty.duration_months,
    renewalPriceYuan: warranty.renewal_price_cents === null
      ? ''
      : (warranty.renewal_price_cents / 100).toFixed(2),
    notes: warranty.notes ?? '',
  })
  warrantyVisible.value = true
}

function saveWarranty(): Promise<void> {
  return runAction(() => repository.updateWarranty(props.projectCode, {
    starts_on: warrantyForm.startsOn,
    duration_months: warrantyForm.durationMonths,
    renewal_price_cents: optionalYuanToCents(warrantyForm.renewalPriceYuan),
    notes: optionalText(warrantyForm.notes),
  }), () => { warrantyVisible.value = false }, '质保信息已更新')
}

function openInvoiceVoid(invoiceId: number): void {
  if (!prepareDialog()) return
  selectedInvoiceId.value = invoiceId
  invoiceVoidForm.reason = ''
  invoiceVoidVisible.value = true
}

function saveInvoiceVoid(): Promise<void> {
  return runAction(() => repository.voidInvoice(props.projectCode, selectedInvoiceId.value, invoiceVoidForm.reason), () => { invoiceVoidVisible.value = false }, '发票记录已作废')
}

function openAfterSalesStatus(item: DemoAfterSalesCaseViewModel): void {
  if (!prepareDialog()) return
  const available = afterSalesTransitions[item.status]
  if (available.length === 0) return
  selectedAfterSalesId.value = item.case_id
  selectedAfterSalesStatus.value = item.status
  Object.assign(afterSalesStatusForm, { status: available[0], resolution: '' })
  afterSalesStatusVisible.value = true
}

function saveAfterSalesStatus(): Promise<void> {
  if (afterSalesStatusForm.status === 'cancelled' && !afterSalesStatusForm.resolution.trim()) {
    formError.value = '请填写取消原因'
    return Promise.resolve()
  }
  if (afterSalesStatusForm.status === 'completed' && !afterSalesStatusForm.resolution.trim()) {
    formError.value = '请填写处理结果'
    return Promise.resolve()
  }
  return runAction(() => repository.setAfterSalesStatus(
    props.projectCode,
    selectedAfterSalesId.value,
    afterSalesStatusForm.status,
    optionalText(afterSalesStatusForm.resolution),
  ), () => { afterSalesStatusVisible.value = false }, '售后状态已更新')
}

function resetDialogsForContextChange(): void {
  closePendingChangeConfirmation()
  signoffVisible.value = false
  commissioningVisible.value = false
  changeVisible.value = false
  acceptanceVisible.value = false
  acceptanceCancelVisible.value = false
  invoiceVisible.value = false
  afterSalesVisible.value = false
  acceptanceCompleteVisible.value = false
  warrantyVisible.value = false
  invoiceVoidVisible.value = false
  afterSalesStatusVisible.value = false
  changeTransitionVisible.value = false
  selectedCommissioningId.value = null
  editingChangeId.value = null
  editingAcceptanceId.value = null
  selectedAcceptanceId.value = 0
  editingInvoiceId.value = null
  selectedInvoiceId.value = 0
  selectedAfterSalesId.value = 0
  editingAfterSalesId.value = null
  selectedChangeId.value = 0
  signoffFiles.value = []
  commissioningFiles.value = []
  changeFiles.value = []
  acceptanceFiles.value = []
  invoiceFiles.value = []
}

watch(
  [() => props.projectCode, () => props.repository],
  async ([projectCode, nextRepository]) => {
    actionGeneration += 1
    actionSequence += 1
    repository = toRaw(nextRepository ?? defaultRepository)
    pendingOwner.value = nextRepository ? toRaw(nextRepository) : defaultDeliveryPendingOwner
    formBusy.value = false
    formError.value = ''
    actionError.value = ''
    actionSuccess.value = ''
    const version = ++loadVersion
    loading.value = true
    loadError.value = ''
    activeTab.value = defaultSection()
    model.value = null
    documentOptions.value = []
    deliverySummary.value = null
    resetDialogsForContextChange()
    restoreCurrentPendingWrites()
    void loadDeliverySummary(projectCode, repository)
    try {
      const result = await repository.getDeliveryPreview(projectCode)
      if (version === loadVersion) model.value = result.data
      if (repository.listDocumentVersionOptions) {
        try {
          const options = await repository.listDocumentVersionOptions(projectCode)
          if (version === loadVersion) documentOptions.value = options
        } catch (error) {
          if (version === loadVersion) {
            actionError.value = error instanceof Error ? `项目文件加载失败：${error.message}` : '项目文件加载失败'
          }
        }
      }
    } catch (error) {
      if (version === loadVersion) {
        loadError.value = error instanceof Error ? error.message : '交付数据加载失败'
      }
    } finally {
      if (version === loadVersion) {
        loading.value = false
        consumeCommittedPendingWrites()
      }
    }
  },
  { immediate: true },
)

watch(
  () => [
    loading.value,
    formBusy.value,
    deliveryCreateForCurrentContext('commissioning')?.committed,
    deliveryCreateForCurrentContext('change')?.committed,
    deliveryCreateForCurrentContext('acceptance')?.committed,
    deliveryCreateForCurrentContext('after-sales')?.committed,
    invoiceSubmissionForCurrentContext()?.committed,
  ],
  () => consumeCommittedPendingWrites(),
)

onBeforeUnmount(() => {
  mounted = false
  actionGeneration += 1
  actionSequence += 1
  deliverySummaryLoadVersion += 1
  closePendingChangeConfirmation()
})
</script>

<template>
  <section data-testid="delivery-workspace" class="delivery-workspace">
    <header class="module-heading">
      <div>
        <h2>{{ moduleTitle }}</h2>
        <p>{{ moduleDescription }}</p>
      </div>
    </header>

    <el-alert v-if="readonly" title="项目已归档，本页仅供查看" type="info" show-icon :closable="false" />

    <el-alert
      v-if="loadError"
      data-testid="delivery-load-error"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
    />
    <el-alert
      v-for="warning in model?.load_warnings ?? []"
      :key="warning"
      data-testid="delivery-partial-warning"
      :title="warning"
      type="warning"
      show-icon
      :closable="false"
    />
    <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
    <el-alert v-if="actionSuccess" :title="actionSuccess" type="success" show-icon closable @close="actionSuccess = ''" />

    <el-card v-if="loading" shadow="never"><el-skeleton :rows="6" animated /></el-card>

    <div v-else-if="model" class="delivery-sections">
      <el-radio-group v-model="activeTab" class="delivery-section-nav">
        <el-radio-button v-if="scope !== 'delivery'" data-testid="delivery-tab-commissioning" value="commissioning">会签与调试</el-radio-button>
        <el-radio-button v-if="scope !== 'delivery'" data-testid="delivery-tab-changes" value="changes">工程变更</el-radio-button>
        <el-radio-button v-if="scope !== 'commissioning'" data-testid="delivery-tab-acceptance" value="acceptance">验收与质保</el-radio-button>
        <el-radio-button v-if="scope !== 'commissioning'" data-testid="delivery-tab-after-sales" value="after-sales">发票与售后</el-radio-button>
      </el-radio-group>
      <section v-show="scope !== 'delivery' && activeTab === 'commissioning'" class="delivery-section">
        <div data-testid="delivery-commissioning-panel" class="panel-stack">
          <div class="signoff-grid">
            <el-card v-for="signoff in model.drawing_signoffs" :key="signoff.discipline" shadow="never">
              <template #header>
                <div class="card-heading">
                  <strong>{{ disciplineLabels[signoff.discipline] }}</strong>
                  <el-tag :type="signoff.status === 'confirmed' ? 'success' : signoff.status === 'not_required' ? 'info' : 'warning'">{{ signoffLabels[signoff.status] }}</el-tag>
                </div>
              </template>
              <p>{{ signoff.not_required_reason ?? signoff.notes ?? '等待确认' }}</p>
              <small>{{ signoff.confirmed_on ?? '尚未确认' }} · 附件不是前提</small>
              <BusinessAttachmentLinks :project-code="projectCode" :version-ids="signoff.document_version_ids" :options="documentOptions" :test-id="`signoff-files-${signoff.discipline}`" />
              <el-button v-if="!readonly" :data-testid="`signoff-edit-${signoff.discipline}`" plain @click="openSignoff(signoff.discipline)">更新会签</el-button>
            </el-card>
          </div>

          <el-card shadow="never">
            <template #header><div class="card-heading"><div><strong>调试记录</strong><small>问题和下一步允许留空</small></div><el-button v-if="!readonly" data-testid="commissioning-create-open" type="primary" plain @click="openCommissioningCreate">新增调试</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.commissioning_sessions" row-key="session_id">
                <el-table-column label="状态" min-width="100"><template #default="scope"><el-tag :type="commissioningStatusTypes[scope.row.status as CommissioningStatus]">{{ commissioningLabels[scope.row.status as CommissioningStatus] }}</el-tag></template></el-table-column>
                <el-table-column prop="started_at" label="开始时间" min-width="190" />
                <el-table-column prop="summary" label="本次结果" min-width="180"><template #default="scope">{{ scope.row.summary ?? '未填写' }}</template></el-table-column>
                <el-table-column prop="issues" label="问题" min-width="190"><template #default="scope">{{ scope.row.issues ?? '无' }}</template></el-table-column>
                <el-table-column prop="next_action" label="下一步" min-width="190"><template #default="scope">{{ scope.row.next_action ?? '未填写' }}</template></el-table-column>
                <el-table-column label="附件" min-width="210"><template #default="scope"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="scope.row.document_version_ids" :options="documentOptions" :test-id="`commissioning-files-${scope.row.session_id}`" /></template></el-table-column>
                <el-table-column v-if="!readonly" label="操作" min-width="80" fixed="right"><template #default="scope"><el-button :data-testid="`commissioning-edit-${scope.row.session_id}`" link type="primary" @click="openCommissioningEdit(scope.row)">编辑</el-button></template></el-table-column>
              </el-table>
            </div>
          </el-card>
        </div>
      </section>

      <section v-show="scope !== 'delivery' && activeTab === 'changes'" class="delivery-section">
        <div data-testid="delivery-changes-panel" class="panel-stack">
          <div class="panel-actions"><el-alert title="预测成本变化不计入实际成本" type="info" show-icon :closable="false" /><el-button v-if="!readonly" data-testid="change-create-open" type="primary" @click="openChangeCreate">新增变更</el-button></div>
          <el-card v-for="change in model.engineering_changes" :key="change.change_id" shadow="never">
            <template #header>
              <div class="card-heading"><strong>{{ change.title }}</strong><el-tag :type="changeStatusTypes[change.status]">{{ changeStatusLabels[change.status] }}</el-tag></div>
            </template>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="来源">{{ changeSourceLabels[change.source] }}</el-descriptions-item>
              <el-descriptions-item label="提出日期">{{ change.proposed_on }}</el-descriptions-item>
              <el-descriptions-item label="合同变化">{{ formatMoney(change.contract_delta_cents) }}</el-descriptions-item>
              <el-descriptions-item label="预测成本变化"><strong>{{ formatMoney(change.estimated_cost_delta_cents) }}</strong></el-descriptions-item>
              <el-descriptions-item label="工期变化">{{ change.schedule_delta_days }} 天</el-descriptions-item>
              <el-descriptions-item label="原因">{{ change.reason }}</el-descriptions-item>
              <el-descriptions-item label="说明" :span="2">{{ change.description }}</el-descriptions-item>
              <el-descriptions-item label="附件" :span="2"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="change.document_version_ids" :options="documentOptions" :test-id="`change-files-${change.change_id}`" /></el-descriptions-item>
            </el-descriptions>
            <div class="record-actions">
              <el-button
                v-if="!readonly && change.status === 'proposed'"
                :data-testid="`change-edit-${change.change_id}`"
                plain
                @click="openChangeEdit(change)"
              >编辑内容</el-button>
              <el-button
                v-if="!readonly && changeTransitions[change.status].length > 0"
                :data-testid="`change-transition-open-${change.change_id}`"
                type="primary"
                plain
                @click="openChangeTransition(change.change_id, change.status)"
              >更新状态</el-button>
              <el-text v-else-if="changeTransitions[change.status].length === 0" type="info">已到最终状态</el-text>
            </div>
          </el-card>
        </div>
      </section>

      <section v-show="scope !== 'commissioning' && activeTab === 'acceptance'" class="delivery-section">
        <div data-testid="delivery-acceptance-panel" class="panel-stack">
          <el-card data-testid="delivery-final-payment-summary" shadow="never">
            <template #header>
              <div class="card-heading">
                <strong>尾款收款</strong>
                <el-button
                  v-if="!readonly"
                  data-testid="delivery-open-final-payment"
                  type="primary"
                  plain
                  @click="emit('open-commercial')"
                >去登记到账</el-button>
              </div>
            </template>
            <el-skeleton v-if="deliverySummaryLoading" :rows="1" animated />
            <el-alert v-else-if="deliverySummaryError" :title="deliverySummaryError" type="warning" :closable="false">
              <el-button link type="primary" @click="loadDeliverySummary()">重新读取</el-button>
            </el-alert>
            <el-descriptions v-else-if="finalPaymentSummary" :column="4" border>
              <el-descriptions-item label="约定日期">{{ finalPaymentSummary.due_on ?? '未约定' }}</el-descriptions-item>
              <el-descriptions-item label="应收">{{ formatMoney(finalPaymentSummary.planned_amount_cents) }}</el-descriptions-item>
              <el-descriptions-item label="已收">{{ formatMoney(finalPaymentSummary.received_amount_cents) }}</el-descriptions-item>
              <el-descriptions-item label="未收"><strong>{{ formatMoney(finalPaymentSummary.outstanding_amount_cents) }}</strong></el-descriptions-item>
            </el-descriptions>
          </el-card>
          <el-alert title="质保状态由后端日期规则返回" description="页面只读展示状态、截止日和剩余天数，不自行推导。" type="info" show-icon :closable="false" />
          <el-card shadow="never">
            <template #header><div class="card-heading"><strong>验收记录</strong><el-button v-if="!readonly" data-testid="acceptance-create-open" type="primary" @click="openAcceptanceCreate">新增验收</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.acceptances" row-key="acceptance_id">
                <el-table-column label="类型" min-width="110"><template #default="scope">{{ acceptanceTypeLabels[scope.row.acceptance_type as AcceptanceType] }}</template></el-table-column>
                <el-table-column label="状态" min-width="130"><template #default="scope">{{ acceptanceStatusLabels[scope.row.status as AcceptanceStatus] }}</template></el-table-column>
                <el-table-column prop="scheduled_on" label="计划日期" min-width="120" />
                <el-table-column prop="performed_on" label="实际日期" min-width="130"><template #default="scope">{{ scope.row.status === 'cancelled' ? `取消 ${scope.row.cancelled_at ?? scope.row.performed_on}` : (scope.row.performed_on ?? '未执行') }}</template></el-table-column>
                <el-table-column prop="notes" label="说明" min-width="180"><template #default="scope">{{ scope.row.cancel_reason ?? scope.row.notes ?? '无' }}</template></el-table-column>
                <el-table-column label="附件" min-width="210"><template #default="scope"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="scope.row.document_version_ids" :options="documentOptions" :test-id="`acceptance-files-${scope.row.acceptance_id}`" /></template></el-table-column>
                <el-table-column v-if="!readonly" label="操作" min-width="280" fixed="right">
                  <template #default="scope">
                    <div v-if="scope.row.status === 'scheduled'" class="compact-actions">
                      <el-button :data-testid="`acceptance-complete-${scope.row.acceptance_id}`" :aria-label="`完成 ${scope.row.scheduled_on} 的验收`" link type="primary" @click="openAcceptanceComplete(scope.row)">完成验收</el-button>
                      <el-button :data-testid="`acceptance-reschedule-${scope.row.acceptance_id}`" :aria-label="`修改 ${scope.row.scheduled_on} 的验收日期`" link @click="openAcceptanceReschedule(scope.row)">修改日期</el-button>
                      <el-button :data-testid="`acceptance-cancel-${scope.row.acceptance_id}`" :aria-label="`取消 ${scope.row.scheduled_on} 的验收`" link type="danger" @click="openAcceptanceCancel(scope.row)">取消验收</el-button>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-card>
          <el-card v-if="model.warranty" shadow="never">
            <template #header><div class="card-heading"><strong>质保期限</strong><div class="compact-actions"><el-tag :type="warrantyStatusTypes[model.warranty.status]">{{ warrantyStatusLabels[model.warranty.status] }}</el-tag><el-button v-if="!readonly" data-testid="warranty-edit-open" plain size="small" @click="openWarrantyEdit(model.warranty)">编辑质保</el-button></div></div></template>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="开始">{{ model.warranty.starts_on }}</el-descriptions-item>
              <el-descriptions-item label="截止">{{ model.warranty.ends_on }}</el-descriptions-item>
              <el-descriptions-item label="期限">{{ model.warranty.duration_months }} 个月</el-descriptions-item>
              <el-descriptions-item label="剩余天数">{{ model.warranty.days_remaining }} 天</el-descriptions-item>
              <el-descriptions-item label="续费价格">{{ model.warranty.renewal_price_cents === null ? '未设置' : `${formatMoney(model.warranty.renewal_price_cents)}（不是收入）` }}</el-descriptions-item>
              <el-descriptions-item label="备注">{{ model.warranty.notes ?? '无' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
          <el-empty v-else description="暂无质保记录" />
        </div>
      </section>

      <section v-show="scope !== 'commissioning' && activeTab === 'after-sales'" class="delivery-section">
        <div data-testid="delivery-after-sales-panel" class="panel-stack">
          <el-alert title="发票记录独立于收款" description="尾款继续留在既有商务收款，不在此建立第二套到账状态。" type="info" show-icon :closable="false" />
          <el-card shadow="never">
            <template #header><div class="card-heading"><strong>发票记录</strong><el-button v-if="!readonly" data-testid="invoice-create-open" type="primary" plain @click="openInvoiceCreate">登记发票</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.invoices" row-key="invoice_id">
                <el-table-column label="类型" min-width="110"><template #default="scope">{{ invoiceTypeLabels[scope.row.invoice_type as InvoiceType] }}</template></el-table-column>
                <el-table-column label="状态" min-width="100"><template #default="scope">{{ invoiceStatusLabels[scope.row.status as InvoiceStatus] }}</template></el-table-column>
                <el-table-column prop="invoice_number" label="发票号码" min-width="150"><template #default="scope">{{ scope.row.invoice_number ?? '未登记' }}</template></el-table-column>
                <el-table-column label="金额" min-width="130"><template #default="scope"><strong>{{ formatMoney(scope.row.amount_cents) }}</strong></template></el-table-column>
                <el-table-column prop="counterparty_name" label="对方单位" min-width="160" />
                <el-table-column prop="recorded_on" label="登记日期" min-width="120"><template #default="scope">{{ scope.row.recorded_on ?? '未登记' }}</template></el-table-column>
                <el-table-column label="附件" min-width="210"><template #default="scope"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="scope.row.document_version_ids" :options="documentOptions" :test-id="`invoice-files-${scope.row.invoice_id}`" /></template></el-table-column>
                <el-table-column v-if="!readonly" label="操作" min-width="130" fixed="right"><template #default="scope"><div class="compact-actions"><el-button v-if="scope.row.status === 'planned' || scope.row.status === 'requested'" :data-testid="`invoice-edit-${scope.row.invoice_id}`" link type="primary" @click="openInvoiceEdit(scope.row)">补录</el-button><el-button v-if="scope.row.status !== 'void'" :data-testid="`invoice-void-${scope.row.invoice_id}`" link type="danger" @click="openInvoiceVoid(scope.row.invoice_id)">作废</el-button></div></template></el-table-column>
              </el-table>
            </div>
          </el-card>

          <el-card shadow="never">
            <template #header><div class="card-heading"><strong>售后案件</strong><el-button v-if="!readonly" data-testid="after-sales-create-open" type="primary" @click="openAfterSalesCreate">新增售后</el-button></div></template>
            <div class="case-grid">
              <article v-for="item in model.after_sales" :key="item.case_id" :data-testid="`after-sales-row-${item.case_id}`" class="case-card">
                <div class="card-heading"><strong>{{ item.reason }}</strong><el-tag :type="afterSalesStatusTypes[item.status]">{{ afterSalesStatusLabels[item.status] }}</el-tag></div>
                <p>{{ coverageLabels[item.coverage_type] }} · 报修 {{ item.reported_on }} · 服务 {{ item.service_on ?? '待安排' }}</p>
                <el-alert v-if="item.coverage_type === 'warranty' && !item.is_under_warranty" :data-testid="`after-sales-warranty-conflict-${item.case_id}`" title="历史记录待核对：标记为保内，但服务端按报修日判定已过保" type="warning" show-icon :closable="false" />
                <p>{{ item.contact_name }} · {{ item.contact_phone }}</p>
                <small>{{ item.resolution ?? item.notes ?? '尚无处理结论' }}</small>
                <small v-if="item.completed_at">实际完成 {{ formatChineseDateTime(item.completed_at) }}</small>
                <div v-if="!readonly && (item.status === 'open' || item.status === 'in_progress')" class="compact-actions">
                  <el-button :data-testid="`after-sales-edit-${item.case_id}`" plain size="small" @click="openAfterSalesEdit(item)">编辑资料</el-button>
                  <el-button :data-testid="`after-sales-status-${item.case_id}`" plain size="small" @click="openAfterSalesStatus(item)">更新状态</el-button>
                </div>
              </article>
            </div>
          </el-card>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="changeTransitionVisible"
      data-testid="change-transition-dialog"
      :before-close="preventBusyClose"
      :close-on-click-modal="!formBusy"
      :close-on-press-escape="!formBusy"
      :teleported="false"
      title="更新工程变更状态"
      width="min(94vw, 520px)"
    >
      <el-form label-position="top" @submit.prevent="saveChangeTransition">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="下一状态" required>
          <el-select v-model="changeTransitionForm.targetStatus" style="width:100%">
            <el-option v-for="status in availableChangeStatuses" :key="status" :value="status" :label="changeStatusLabels[status]" />
          </el-select>
        </el-form-item>
        <el-form-item label="流转原因" required><el-input v-model="changeTransitionForm.reason" type="textarea" placeholder="说明为什么进入这个状态" /></el-form-item>
        <div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('transition')">取消</el-button><el-button type="primary" native-type="submit" :loading="formBusy">保存状态</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="acceptanceCompleteVisible" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="完成验收" width="min(94vw, 680px)" @closed="resetAcceptanceFiles">
      <el-form label-position="top" :disabled="formBusy" @submit.prevent="saveAcceptanceComplete">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="验收结果" required><el-select v-model="acceptanceCompleteForm.status" data-testid="acceptance-complete-status" placeholder="请选择实际结果" style="width:100%" @change="formError = ''"><el-option label="通过" value="passed" /><el-option label="带整改项通过" value="passed_with_punch" /><el-option label="未通过" value="failed" /></el-select></el-form-item>
        <el-form-item label="实际验收日期" required><el-date-picker v-model="acceptanceCompleteForm.performedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
        <el-form-item label="结果说明"><el-input v-model="acceptanceCompleteForm.notes" type="textarea" /></el-form-item>
        <el-form-item label="验收单或现场照片">
          <BusinessAttachmentUpload v-model="acceptanceFiles" test-id="acceptance-attachments" accept=".pdf,image/*" :busy="formBusy" />
        </el-form-item>
        <el-collapse><el-collapse-item title="关联已有资料（可选）" name="existing-documents"><el-form-item label="已有项目资料"><el-select v-model="acceptanceCompleteForm.documentVersionIds" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="option in documentOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item></el-collapse-item></el-collapse>
        <template v-if="acceptanceNeedsWarranty">
          <el-alert title="最终验收通过后将同时建立质保倒计时" type="info" :closable="false" />
          <el-row :gutter="12">
            <el-col :xs="24" :sm="12"><el-form-item label="质保开始日" required><el-date-picker v-model="acceptanceCompleteForm.warrantyStartsOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col>
            <el-col :xs="24" :sm="12"><el-form-item label="质保月数" required><el-input-number v-model="acceptanceCompleteForm.warrantyMonths" :min="1" :max="240" /></el-form-item></el-col>
          </el-row>
          <el-form-item label="过保续费价格（元）"><el-input v-model="acceptanceCompleteForm.warrantyRenewalPriceYuan" inputmode="decimal" /></el-form-item>
          <el-form-item label="质保备注"><el-input v-model="acceptanceCompleteForm.warrantyNotes" type="textarea" /></el-form-item>
        </template>
        <div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('acceptance-complete')">取消</el-button><el-button type="primary" native-type="submit" :loading="formBusy" :disabled="formBusy">保存验收结果</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="warrantyVisible" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :teleported="false" title="编辑质保" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveWarranty"><el-alert v-if="formError" :title="formError" type="error" :closable="false" /><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="质保开始日" required><el-date-picker v-model="warrantyForm.startsOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="质保月数" required><el-input-number v-model="warrantyForm.durationMonths" :min="1" :max="120" /></el-form-item></el-col></el-row><el-form-item label="续费价格（元）"><el-input v-model="warrantyForm.renewalPriceYuan" data-testid="warranty-renewal-price" inputmode="decimal" /></el-form-item><el-form-item label="备注"><el-input v-model="warrantyForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('warranty')">取消</el-button><el-button type="primary" native-type="submit" :loading="formBusy">保存质保</el-button></div></el-form></el-dialog>

    <el-dialog v-model="invoiceVoidVisible" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :teleported="false" title="作废发票记录" width="min(94vw, 480px)"><el-form label-position="top" @submit.prevent="saveInvoiceVoid"><el-alert v-if="formError" :title="formError" type="error" :closable="false" /><el-form-item label="作废原因" required><el-input v-model="invoiceVoidForm.reason" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('invoice-void')">取消</el-button><el-button type="danger" native-type="submit" :loading="formBusy">确认作废</el-button></div></el-form></el-dialog>

    <el-dialog v-model="afterSalesStatusVisible" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :teleported="false" title="更新售后状态" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveAfterSalesStatus"><el-alert v-if="formError" data-testid="after-sales-status-error" :title="formError" type="error" :closable="false" /><el-form-item label="处理状态"><el-select v-model="afterSalesStatusForm.status" data-testid="after-sales-next-status" style="width:100%"><el-option v-for="status in availableAfterSalesStatuses" :key="status" :value="status" :label="afterSalesStatusLabels[status]" /></el-select></el-form-item><el-form-item :label="afterSalesStatusForm.status === 'completed' ? '处理结果（必填）' : afterSalesStatusForm.status === 'cancelled' ? '取消原因（必填）' : '处理进展'"><el-input v-model="afterSalesStatusForm.resolution" data-testid="after-sales-status-resolution" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('after-sales-status')">取消</el-button><el-button data-testid="after-sales-status-save" type="primary" native-type="submit" :loading="formBusy">保存售后状态</el-button></div></el-form></el-dialog>

    <el-dialog v-model="signoffVisible" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="更新图纸会签" width="min(94vw, 680px)" @closed="resetSignoffFiles"><el-form label-position="top" :disabled="formBusy" @submit.prevent="saveSignoff"><el-alert v-if="formError" :title="formError" type="error" :closable="false" /><el-form-item label="状态"><el-select v-model="signoffForm.status" style="width:100%"><el-option value="pending" label="待确认" /><el-option value="confirmed" label="已确认" /><el-option value="not_required" label="无需图纸" /></el-select></el-form-item><el-form-item label="确认日期"><el-date-picker v-model="signoffForm.confirmedOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item v-if="signoffForm.status === 'not_required'" label="无需图纸原因"><el-input v-model="signoffForm.reason" /></el-form-item><el-form-item label="最终确认图纸"><BusinessAttachmentUpload v-model="signoffFiles" test-id="signoff-attachments" accept=".dwg,.dxf,.pdf,image/*,.zip,.rar,.7z" :busy="formBusy" /></el-form-item><el-collapse><el-collapse-item title="关联已有资料（可选）" name="existing-documents"><el-form-item label="已有项目资料"><el-select v-model="signoffForm.documentVersionIds" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="option in documentOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item></el-collapse-item></el-collapse><el-form-item label="备注"><el-input v-model="signoffForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('signoff')">取消</el-button><el-button type="primary" native-type="submit" :loading="formBusy" :disabled="formBusy">保存会签</el-button></div></el-form></el-dialog>

    <el-dialog v-model="commissioningVisible" :before-close="preventCommissioningClose" :close-on-click-modal="!formBusy && !deliveryCreateBusy('commissioning')" :close-on-press-escape="!formBusy && !deliveryCreateBusy('commissioning')" :show-close="!formBusy && !deliveryCreateBusy('commissioning')" :teleported="false" :title="selectedCommissioningId === null ? '新增调试记录' : '编辑调试记录'" width="min(94vw, 680px)" @closed="resetCommissioningFiles">
      <div v-if="hasDeliveryCreate('commissioning')" class="pending-retry-panel">
        <el-alert data-testid="commissioning-create-uncertain" :title="deliveryCreateBusy('commissioning') ? '正在核对上次新增结果，原内容和附件已锁定。' : '上次新增结果未知，原内容和附件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableDeliveryCreate('commissioning')" data-testid="commissioning-abandon-pending" :disabled="formBusy" @click="abandonRecoverableDeliveryCreate('commissioning')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="formBusy || hasDeliveryCreate('commissioning')" @submit.prevent="saveCommissioning">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="commissioning-started-at" label="开始时间" required><el-date-picker v-model="commissioningForm.startedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="结束时间"><el-date-picker v-model="commissioningForm.endedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" clearable style="width:100%" /></el-form-item></el-col></el-row>
        <el-form-item label="状态"><el-select v-model="commissioningForm.status" style="width:100%"><el-option v-for="(label, value) in commissioningLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        <el-form-item label="本次结果"><el-input v-model="commissioningForm.summary" type="textarea" /></el-form-item>
        <el-form-item label="问题"><el-input v-model="commissioningForm.issues" /></el-form-item>
        <el-form-item label="下一步"><el-input v-model="commissioningForm.nextAction" /></el-form-item>
        <el-form-item v-if="selectedCommissioningId === null" label="现场记录、照片或变更资料"><BusinessAttachmentUpload v-model="commissioningFiles" test-id="commissioning-attachments" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*,.zip,.rar,.7z" :busy="formBusy || hasDeliveryCreate('commissioning')" /></el-form-item>
        <el-collapse><el-collapse-item title="关联已有资料（可选）" name="existing-documents"><el-form-item label="已有项目资料"><el-select v-model="commissioningForm.documentVersionIds" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="option in documentOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item></el-collapse-item></el-collapse>
        <el-form-item label="备注"><el-input v-model="commissioningForm.notes" /></el-form-item>
      </el-form>
      <div class="dialog-actions"><el-button :disabled="formBusy || deliveryCreateBusy('commissioning')" @click="cancelDeliveryDialog('commissioning')">取消</el-button><el-button data-testid="commissioning-save" type="primary" :loading="formBusy || deliveryCreateBusy('commissioning')" @click="saveCommissioning">{{ recoverableDeliveryCreate('commissioning') ? '原样重试' : '保存调试记录' }}</el-button></div>
    </el-dialog>

    <el-dialog v-model="changeVisible" data-testid="engineering-change-dialog" :before-close="preventChangeClose" :close-on-click-modal="!formBusy && !deliveryCreateBusy('change')" :close-on-press-escape="!formBusy && !deliveryCreateBusy('change')" :show-close="!formBusy && !deliveryCreateBusy('change')" :teleported="false" :title="editingChangeId === null ? '新增工程变更' : '编辑工程变更'" width="min(94vw, 720px)" @closed="resetChangeFiles">
      <div v-if="hasDeliveryCreate('change')" class="pending-retry-panel">
        <el-alert data-testid="change-create-uncertain" :title="deliveryCreateBusy('change') ? '正在核对上次新增结果，原内容和附件已锁定。' : '上次新增结果未知，原内容和附件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableDeliveryCreate('change')" data-testid="change-abandon-pending" :disabled="formBusy" @click="abandonRecoverableDeliveryCreate('change')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="formBusy || hasDeliveryCreate('change')" @submit.prevent="saveChange">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="来源"><el-select v-model="changeForm.source" style="width:100%"><el-option v-for="(label, value) in changeSourceLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        <el-form-item label="标题" required><el-input v-model="changeForm.title" data-testid="engineering-change-title" /></el-form-item>
        <el-form-item label="变更说明" required><el-input v-model="changeForm.description" type="textarea" /></el-form-item>
        <el-form-item label="原因" required><el-input v-model="changeForm.reason" /></el-form-item>
        <el-row :gutter="12"><el-col :xs="24" :sm="8"><el-form-item label="合同变化（元）"><el-input v-model="changeForm.contractDeltaYuan" inputmode="decimal" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="预测成本变化（元）"><el-input v-model="changeForm.estimatedCostDeltaYuan" inputmode="decimal" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="工期变化（天）"><el-input-number v-model="changeForm.scheduleDeltaDays" /></el-form-item></el-col></el-row>
        <el-form-item data-testid="engineering-change-date" label="提出日期"><el-date-picker v-model="changeForm.proposedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
        <el-form-item v-if="editingChangeId === null" label="变更确认单、照片或技术资料"><BusinessAttachmentUpload v-model="changeFiles" test-id="engineering-change-attachments" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*,.zip,.rar,.7z" :busy="formBusy || hasDeliveryCreate('change')" /></el-form-item>
        <el-collapse><el-collapse-item title="关联已有资料（可选）" name="existing-documents"><el-form-item label="已有项目资料"><el-select v-model="changeForm.documentVersionIds" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="option in documentOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item></el-collapse-item></el-collapse>
        <el-form-item label="备注"><el-input v-model="changeForm.notes" /></el-form-item>
      </el-form>
      <div class="dialog-actions"><el-button :disabled="formBusy || deliveryCreateBusy('change')" @click="cancelDeliveryDialog('change')">取消</el-button><el-button type="primary" :loading="formBusy || deliveryCreateBusy('change')" @click="saveChange">{{ editingChangeId !== null ? '保存修改' : recoverableDeliveryCreate('change') ? '原样重试' : '保存工程变更' }}</el-button></div>
    </el-dialog>

    <el-dialog v-model="acceptanceVisible" data-testid="acceptance-plan-dialog" :before-close="preventAcceptanceClose" :close-on-click-modal="!formBusy && !deliveryCreateBusy('acceptance')" :close-on-press-escape="!formBusy && !deliveryCreateBusy('acceptance')" :show-close="!formBusy && !deliveryCreateBusy('acceptance')" :teleported="false" :title="editingAcceptanceId === null ? '新增验收计划' : '修改验收计划'" width="min(94vw, 560px)">
      <div v-if="hasDeliveryCreate('acceptance')" class="pending-retry-panel">
        <el-alert data-testid="acceptance-create-uncertain" :title="deliveryCreateBusy('acceptance') ? '正在核对上次新增结果，原内容已锁定。' : '上次新增结果未知，原内容已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableDeliveryCreate('acceptance')" data-testid="acceptance-abandon-pending" :disabled="formBusy" @click="abandonRecoverableDeliveryCreate('acceptance')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="formBusy || hasDeliveryCreate('acceptance')" @submit.prevent="saveAcceptance">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="验收类型"><el-select v-model="acceptanceForm.acceptanceType" style="width:100%"><el-option v-for="(label, value) in acceptanceTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        <el-form-item data-testid="acceptance-scheduled-date" label="计划日期" required><el-date-picker v-model="acceptanceForm.scheduledOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="acceptanceForm.notes" type="textarea" /></el-form-item>
        <el-form-item v-if="editingAcceptanceId !== null" label="改期原因" required><el-input v-model="acceptanceForm.correctionReason" data-testid="acceptance-reschedule-reason" type="textarea" placeholder="说明为什么修改原验收计划" /></el-form-item>
      </el-form>
      <div class="dialog-actions"><el-button :disabled="formBusy || deliveryCreateBusy('acceptance')" @click="cancelDeliveryDialog('acceptance')">取消</el-button><el-button type="primary" :loading="formBusy || deliveryCreateBusy('acceptance')" @click="saveAcceptance">{{ editingAcceptanceId !== null ? '保存改期' : recoverableDeliveryCreate('acceptance') ? '原样重试' : '保存验收计划' }}</el-button></div>
    </el-dialog>

    <el-dialog v-model="acceptanceCancelVisible" data-testid="acceptance-cancel-dialog" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :teleported="false" title="取消验收计划" width="min(94vw, 480px)"><el-form label-position="top" @submit.prevent="saveAcceptanceCancellation"><el-alert title="取消后将保留本次计划和原因，不能恢复；如需重约请新建验收。" type="warning" :closable="false" /><el-alert v-if="formError" :title="formError" type="error" :closable="false" /><el-form-item label="取消原因" required><el-input v-model="acceptanceCancelForm.reason" data-testid="acceptance-cancel-reason" type="textarea" placeholder="例如：客户要求重新约期" /></el-form-item><div class="dialog-actions"><el-button :disabled="formBusy" @click="cancelDeliveryDialog('acceptance-cancel')">返回</el-button><el-button type="danger" native-type="submit" :loading="formBusy">确认取消</el-button></div></el-form></el-dialog>

    <el-dialog v-model="invoiceVisible" :before-close="preventInvoiceClose" :close-on-click-modal="!formBusy && !invoiceSubmissionBusy" :close-on-press-escape="!formBusy && !invoiceSubmissionBusy" :show-close="!formBusy && !invoiceSubmissionBusy" :teleported="false" :title="editingInvoiceId === null ? '登记发票' : '补录发票'" width="min(94vw, 680px)" @closed="resetInvoiceFiles">
      <div v-if="invoiceSubmissionForCurrentContext()" class="pending-retry-panel">
        <el-alert data-testid="invoice-create-uncertain" :title="invoiceSubmissionBusy ? '正在核对上次登记结果，原内容和文件已锁定。' : '上次登记结果未知，原内容和文件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableInvoiceSubmission" data-testid="invoice-abandon-pending" :disabled="formBusy" @click="abandonRecoverableInvoiceSubmission">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="formBusy || Boolean(invoiceSubmissionForCurrentContext())" @submit.prevent="saveInvoice">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item v-if="editingInvoiceId === null" label="发票图片或 PDF">
          <BusinessAttachmentUpload v-model="invoiceFiles" test-id="invoice-attachments" accept=".pdf,image/*" :busy="formBusy || Boolean(invoiceSubmissionForCurrentContext())" />
        </el-form-item>
        <el-alert v-if="editingInvoiceId === null" title="只上传图片也可以直接保存，系统会先标记为“计划中”，之后可从列表补录开票信息。" type="info" :closable="false" />
        <el-alert v-else title="原发票附件和已关联项目资料会保留；选择“已登记”后需补齐日期、发票号和金额。" type="info" :closable="false" />
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="发票类型"><el-select v-model="invoiceForm.invoiceType" style="width:100%"><el-option v-for="(label, value) in invoiceTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="状态"><el-select v-model="invoiceForm.status" data-testid="invoice-status" style="width:100%" @change="prepareInvoiceDatesForStatus"><el-option v-for="(label, value) in invoiceCreationStatusLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item></el-col></el-row>
        <el-form-item label="发票号码" :required="invoiceForm.status === 'recorded'"><el-input v-model="invoiceForm.invoiceNumber" data-testid="invoice-number" /></el-form-item>
        <el-form-item label="金额（元）" :required="invoiceForm.status === 'recorded'"><el-input v-model="invoiceForm.amountYuan" data-testid="invoice-amount" inputmode="decimal" :placeholder="invoiceForm.status === 'recorded' ? '已登记时必填' : '可留空'" /></el-form-item>
        <el-form-item label="对方单位"><el-input v-model="invoiceForm.counterpartyName" /></el-form-item>
        <el-row v-if="invoiceForm.status !== 'planned'" :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="invoice-requested-date" label="申请日期" required><el-date-picker v-model="invoiceForm.requestedOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item></el-col><el-col v-if="invoiceForm.status === 'recorded'" :xs="24" :sm="12"><el-form-item data-testid="invoice-recorded-date" label="登记日期" required><el-date-picker v-model="invoiceForm.recordedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-collapse><el-collapse-item title="关联已有资料（可选）" name="existing-documents"><el-form-item label="已有项目资料"><el-select v-model="invoiceForm.documentVersionIds" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="option in documentOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item></el-collapse-item></el-collapse>
        <el-form-item label="备注"><el-input v-model="invoiceForm.notes" /></el-form-item>
      </el-form>
      <div class="dialog-actions"><el-button data-testid="invoice-cancel" :disabled="formBusy || invoiceSubmissionBusy" @click="cancelDeliveryDialog('invoice')">取消</el-button><el-button data-testid="invoice-save" type="primary" :loading="formBusy || invoiceSubmissionBusy" :disabled="formBusy || invoiceSubmissionBusy" @click="saveInvoice">{{ recoverableInvoiceSubmission ? '原样重试' : '保存发票记录' }}</el-button></div>
    </el-dialog>

    <el-dialog v-model="afterSalesVisible" data-testid="after-sales-dialog" :before-close="preventAfterSalesClose" :close-on-click-modal="!formBusy && !deliveryCreateBusy('after-sales')" :close-on-press-escape="!formBusy && !deliveryCreateBusy('after-sales')" :show-close="!formBusy && !deliveryCreateBusy('after-sales')" :teleported="false" :title="editingAfterSalesId === null ? '新增售后案件' : '编辑售后资料'" width="min(94vw, 680px)">
      <div v-if="hasDeliveryCreate('after-sales')" class="pending-retry-panel">
        <el-alert data-testid="after-sales-create-uncertain" :title="deliveryCreateBusy('after-sales') ? '正在核对上次新增结果，原内容已锁定。' : '上次新增结果未知，原内容已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableDeliveryCreate('after-sales')" data-testid="after-sales-abandon-pending" :disabled="formBusy" @click="abandonRecoverableDeliveryCreate('after-sales')">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="formBusy || hasDeliveryCreate('after-sales')" @submit.prevent="saveAfterSales">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="报修原因" required><el-input v-model="afterSalesForm.reason" data-testid="after-sales-reason" type="textarea" /></el-form-item>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12"><el-form-item label="联系人"><el-input v-model="afterSalesForm.contactName" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="联系电话"><el-input v-model="afterSalesForm.contactPhone" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12"><el-form-item data-testid="after-sales-reported-date" label="报修日期"><el-date-picker v-model="afterSalesForm.reportedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="服务日期"><el-date-picker v-model="afterSalesForm.serviceOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item></el-col>
        </el-row>
        <el-alert
          data-testid="after-sales-warranty-judgment"
          :title="afterSalesWarrantyJudgment.label"
          :description="afterSalesWarrantyJudgment.detail"
          :type="afterSalesWarrantyJudgment.type"
          show-icon
          :closable="false"
        />
        <el-form-item label="保障方式" required>
          <el-select v-model="afterSalesForm.coverageType" data-testid="after-sales-coverage" placeholder="请选择实际处理方式" style="width:100%">
            <el-option v-for="(label, value) in coverageLabels" :key="value" :value="value" :label="label" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="afterSalesForm.notes" type="textarea" /></el-form-item>
      </el-form>
      <div class="dialog-actions"><el-button :disabled="formBusy || deliveryCreateBusy('after-sales')" @click="cancelDeliveryDialog('after-sales')">取消</el-button><el-button type="primary" :loading="formBusy || deliveryCreateBusy('after-sales')" @click="saveAfterSales">{{ editingAfterSalesId !== null ? '保存修改' : recoverableDeliveryCreate('after-sales') ? '原样重试' : '保存售后案件' }}</el-button></div>
    </el-dialog>
  </section>
</template>

<style scoped>
.delivery-workspace,
.delivery-sections,
.panel-stack {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.pending-retry-panel { display: grid; gap: 10px; }
.pending-retry-panel > :deep(.el-button) { justify-self: end; }

.delivery-section-nav { display: flex; flex-wrap: wrap; }
.delivery-section { min-width: 0; }

.module-heading,
.card-heading,
.panel-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.panel-actions { align-items: flex-start; }
.panel-actions :deep(.el-alert) { flex: 1; }

.record-actions,
.compact-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.record-actions {
  justify-content: flex-end;
  margin-top: 12px;
  color: var(--el-text-color-secondary);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.record-actions :deep(.el-select) {
  width: 150px;
}

.module-heading h2 {
  margin: 4px 0;
  font-size: clamp(1.35rem, 3vw, 2rem);
}

.module-heading p,
.signoff-grid p,
.case-card p {
  margin: 0;
}

.module-tabs,
.table-scroll {
  min-width: 0;
}

.table-scroll {
  overflow-x: auto;
}

.signoff-grid,
.case-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.signoff-grid :deep(.el-card__body),
.case-card {
  display: grid;
  gap: 10px;
}

.case-card {
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
}

small {
  color: var(--el-text-color-secondary);
}

@media (max-width: 640px) {
  .module-heading,
  .card-heading,
  .panel-actions,
  .record-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .signoff-grid,
  .case-grid {
    grid-template-columns: 1fr;
  }

  .delivery-section-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .delivery-section-nav :deep(.el-radio-button__inner) { width: 100%; padding-inline: 8px; }
}
</style>
