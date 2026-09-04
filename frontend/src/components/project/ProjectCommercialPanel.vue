<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { ElMessageBox } from 'element-plus'

import { ApiError } from '../../api'
import type {
  Contract,
  ContractStatus,
  PaymentMilestone,
  PaymentMethod,
  PaymentTerm,
  ProjectOperatingSnapshot,
  Quote,
  QuoteStatus,
  Receipt,
} from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { centsToYuan, formatBasisPoints, formatMoney, yuanToCents } from '../../domain/formatters'
import BusinessAttachmentLinks from '../common/BusinessAttachmentLinks.vue'
import BusinessAttachmentUpload from '../common/BusinessAttachmentUpload.vue'
import {
  clearPendingWrite,
  defaultProjectCommercialPendingOwner,
  getPendingWrite,
  projectCommercialPendingKey,
  setPendingWrite,
} from '../../pendingWriteRegistry'
import {
  createHttpProjectOperatingRepository,
  type ContractInput,
  type DocumentVersionOption,
  type ProjectOperatingRepository,
  type QuoteInput,
} from '../../repositories/project-operating.live'

const props = withDefaults(defineProps<{
  operating: ProjectOperatingSnapshot
  projectCode: string
  customerCompany?: { id: number; name: string }
  repository?: ProjectOperatingRepository
  readonly?: boolean
}>(), {
  readonly: false,
})
const emit = defineEmits<{ changed: [] }>()
type CommercialView = 'overview' | 'quotes' | 'contracts' | 'receivables'

const defaultRepository = createHttpProjectOperatingRepository()
let repository = props.repository ?? defaultRepository
const activeView = ref<CommercialView>('overview')
const quotes = ref<Quote[]>(props.operating.commercial.accepted_quote ? [{ ...props.operating.commercial.accepted_quote }] : [])
const contracts = ref<Contract[]>(props.operating.commercial.contracts.map((contract) => ({
  ...contract,
  allocations: contract.allocations.map((allocation) => ({ ...allocation })),
})))
const receivables = reactive({
  ...props.operating.receivables,
  terms: props.operating.receivables.terms.map((term) => ({ ...term })),
  receipts: props.operating.receivables.receipts.map((receipt) => ({ ...receipt })),
})

const quoteVisible = ref(false)
const quoteEditingId = ref<number | null>(null)
const contractVisible = ref(false)
const contractEditingId = ref<number | null>(null)
const transitionVisible = ref(false)
const transitionKind = ref<'quote' | 'contract'>('quote')
const transitionId = ref<number | null>(null)
const quoteTarget = ref<QuoteStatus | null>(null)
const contractTarget = ref<ContractStatus | null>(null)
const transitionReason = ref('')
const receiptVisible = ref(false)
const receiptEditingId = ref<number | null>(null)
const termVisible = ref(false)
const voidVisible = ref(false)
const selectedMilestone = ref<PaymentMilestone>('advance')
const selectedReceiptId = ref<number | null>(null)
const validationError = ref<string | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const actionBusy = ref(false)
const actionSuccess = ref<string | null>(null)
const actionWarning = ref<string | null>(null)
const documentOptions = ref<DocumentVersionOption[]>([])
const quoteFiles = ref<File[]>([])
const contractFiles = ref<File[]>([])
interface CommercialActionContext {
  generation: number
  sequence: number
  projectCode: string
  repository: ProjectOperatingRepository
  owner: object
}

interface PendingQuoteSubmission {
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  input: QuoteInput
  files: File[]
  inFlight: boolean
  result?: Quote
}

interface PendingContractSubmission {
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  input: ContractInput
  files: File[]
  inFlight: boolean
  result?: Contract
}

const pendingOwner = shallowRef<object>(props.repository ?? defaultProjectCommercialPendingOwner)
let mounted = true
let actionGeneration = 0
let actionSequence = 0
let loadVersion = 0

const quoteForm = reactive({ quote_date: '', amount_cents: '', valid_until: '', notes: '', document_version_ids: [] as number[] })
const contractForm = reactive({
  contract_no: '', title: '', signed_on: '', total_amount_cents: '',
  final_delivery_on: '', notes: '', document_version_ids: [] as number[],
})

function pendingQuoteForCurrentContext(): PendingQuoteSubmission | null {
  return getPendingWrite<PendingQuoteSubmission>(
    pendingOwner.value,
    projectCommercialPendingKey('quote', props.projectCode),
  )
}

function pendingContractForCurrentContext(): PendingContractSubmission | null {
  return getPendingWrite<PendingContractSubmission>(
    pendingOwner.value,
    projectCommercialPendingKey('contract', props.projectCode),
  )
}

const currentQuoteSubmission = computed(pendingQuoteForCurrentContext)
const currentContractSubmission = computed(pendingContractForCurrentContext)
const recoverableQuoteSubmission = computed(() => {
  const pending = pendingQuoteForCurrentContext()
  return pending && !pending.inFlight && !pending.result ? pending : null
})
const recoverableContractSubmission = computed(() => {
  const pending = pendingContractForCurrentContext()
  return pending && !pending.inFlight && !pending.result ? pending : null
})
const quotePendingBusy = computed(() => Boolean(pendingQuoteForCurrentContext()?.inFlight))
const contractPendingBusy = computed(() => Boolean(pendingContractForCurrentContext()?.inFlight))
const receiptForm = reactive({
  contract_allocation_id: null as number | null,
  milestone: 'advance' as PaymentMilestone, received_on: '', amount_cents: '',
  payment_method: 'bank_transfer' as PaymentMethod, reference_no: '', notes: '',
})
const termForm = reactive({ due_on: '', planned_amount_cents: '', notes: '' })
const voidForm = reactive({ voided_on: '', reason: '' })

const quoteTransitions: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent', 'withdrawn'],
  sent: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
}
const contractTransitions: Record<ContractStatus, ContractStatus[]> = {
  draft: ['signed', 'terminated'],
  signed: ['completed', 'terminated'],
  completed: [],
  terminated: [],
}
const selectedQuote = computed(() => quotes.value.find((item) => item.id === transitionId.value) ?? null)
const selectedContract = computed(() => contracts.value.find((item) => item.id === transitionId.value) ?? null)
const availableQuoteStatuses = computed(() => selectedQuote.value ? quoteTransitions[selectedQuote.value.status] : [])
const availableContractStatuses = computed(() => selectedContract.value ? contractTransitions[selectedContract.value.status] : [])
const acceptedQuote = computed(() => quotes.value.find((item) => item.status === 'accepted') ?? null)
const receiptAllocationOptions = computed(() => contracts.value
  .filter((contract) => contract.status === 'signed' || contract.status === 'completed')
  .flatMap((contract) => contract.allocations
    .filter((allocation) => allocation.project_code === props.projectCode)
    .map((allocation) => ({
      id: allocation.id,
      label: `${contract.contract_no} · ${contract.title}`,
    }))))

const receiptAllocationDisplay = computed(() => {
  const allocationId = receiptForm.contract_allocation_id
  if (allocationId === null) return '未归属（历史记录）'
  for (const contract of contracts.value) {
    if (contract.allocations.some((allocation) => allocation.id === allocationId)) {
      return `${contract.contract_no} · ${contract.title}`
    }
  }
  return `历史合同归属 #${allocationId}`
})

function hasQuoteTransitions(status: QuoteStatus): boolean {
  return quoteTransitions[status].length > 0
}

function hasContractTransitions(status: ContractStatus): boolean {
  return contractTransitions[status].length > 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '商务操作失败'
}

function setPayments(payments: ProjectOperatingSnapshot['receivables']): void {
  Object.assign(receivables, payments, {
    terms: payments.terms.map((term) => ({ ...term })),
    receipts: payments.receipts.map((receipt) => ({ ...receipt })),
  })
}

async function loadCommercial(): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  loadError.value = null
  try {
    const [quoteResult, contractResult, paymentResult, documentResult] = await Promise.allSettled([
      repository.listQuotes(props.projectCode),
      repository.listContracts(props.projectCode),
      repository.getPayments(props.projectCode),
      repository.listDocumentVersionOptions(props.projectCode),
    ])
    if (version !== loadVersion) return
    if (quoteResult.status === 'rejected') throw quoteResult.reason
    if (contractResult.status === 'rejected') throw contractResult.reason
    if (paymentResult.status === 'rejected') throw paymentResult.reason
    quotes.value = quoteResult.value.items
    contracts.value = contractResult.value.items
    setPayments(paymentResult.value)
    if (documentResult.status === 'fulfilled') {
      documentOptions.value = documentResult.value
      actionWarning.value = null
    } else {
      documentOptions.value = []
      actionWarning.value = '报价、合同和收款已读取；已有资料暂时无法读取，仍可直接上传新文件。'
    }
  } catch (error) {
    if (version === loadVersion) loadError.value = errorMessage(error)
  } finally {
    if (version === loadVersion) {
      loading.value = false
      consumeResolvedPendingSubmissions()
    }
  }
}

async function refreshPayments(): Promise<void> {
  setPayments(await repository.getPayments(props.projectCode))
}

async function refreshPaymentsAfterSave(): Promise<void> {
  try {
    await refreshPayments()
    actionWarning.value = null
  } catch {
    actionSuccess.value = null
    actionWarning.value = '已保存，但刷新失败，请刷新页面。'
  }
}

function startAction(actionRepository: ProjectOperatingRepository = repository): CommercialActionContext {
  return {
    generation: actionGeneration,
    sequence: ++actionSequence,
    projectCode: props.projectCode,
    repository: actionRepository,
    owner: pendingOwner.value,
  }
}

function isCurrentAction(context: CommercialActionContext): boolean {
  return mounted
    && context.generation === actionGeneration
    && context.sequence === actionSequence
    && context.projectCode === props.projectCode
    && context.owner === pendingOwner.value
}

async function submit<T>(
  action: () => Promise<T>,
  message: string,
  suppliedContext?: CommercialActionContext,
): Promise<T | undefined> {
  if (actionBusy.value) return undefined
  const context = suppliedContext ?? startAction()
  actionBusy.value = true
  validationError.value = null
  actionSuccess.value = null
  actionWarning.value = null
  try {
    const result = await action()
    if (!isCurrentAction(context)) return undefined
    actionSuccess.value = message
    emit('changed')
    return result
  } catch (error) {
    if (isCurrentAction(context)) validationError.value = errorMessage(error)
    return undefined
  } finally {
    if (isCurrentAction(context)) actionBusy.value = false
  }
}

function replaceQuote(quote: Quote): void {
  const index = quotes.value.findIndex((item) => item.id === quote.id)
  if (index < 0) quotes.value.unshift(quote)
  else quotes.value.splice(index, 1, quote)
}

function replaceContract(contract: Contract): void {
  const index = contracts.value.findIndex((item) => item.id === contract.id)
  if (index < 0) contracts.value.unshift(contract)
  else contracts.value.splice(index, 1, contract)
}

function restoreQuoteSubmission(pending: PendingQuoteSubmission): void {
  quoteEditingId.value = null
  Object.assign(quoteForm, {
    quote_date: pending.input.quote_date,
    amount_cents: centsToYuan(pending.input.amount_cents),
    valid_until: pending.input.valid_until ?? '',
    notes: pending.input.notes ?? '',
    document_version_ids: [...pending.input.document_version_ids],
  })
  quoteFiles.value = pending.files
  activeView.value = 'quotes'
  quoteVisible.value = true
}

function restoreContractSubmission(pending: PendingContractSubmission): void {
  contractEditingId.value = null
  Object.assign(contractForm, {
    contract_no: pending.input.contract_no,
    title: pending.input.title,
    signed_on: pending.input.signed_on ?? '',
    total_amount_cents: centsToYuan(pending.input.total_amount_cents),
    final_delivery_on: pending.input.final_delivery_on ?? '',
    notes: pending.input.notes ?? '',
    document_version_ids: [...pending.input.document_version_ids],
  })
  contractFiles.value = pending.files
  activeView.value = 'contracts'
  contractVisible.value = true
}

function restoreCurrentPendingSubmissions(): void {
  const quotePending = currentQuoteSubmission.value
  if (quotePending && !quotePending.result) restoreQuoteSubmission(quotePending)
  const contractPending = currentContractSubmission.value
  if (contractPending && !contractPending.result) restoreContractSubmission(contractPending)
}

function consumeResolvedPendingSubmissions(): void {
  if (loading.value || actionBusy.value) return
  const quotePending = currentQuoteSubmission.value
  if (quotePending?.result && clearPendingWrite(quotePending.owner, quotePending.key, quotePending)) {
    replaceQuote(quotePending.result)
    quoteVisible.value = false
    quoteFiles.value = []
    actionSuccess.value = '报价已创建。'
    emit('changed')
  }
  const contractPending = currentContractSubmission.value
  if (contractPending?.result && clearPendingWrite(contractPending.owner, contractPending.key, contractPending)) {
    replaceContract(contractPending.result)
    contractVisible.value = false
    contractEditingId.value = null
    contractFiles.value = []
    actionSuccess.value = '合同已创建。'
    emit('changed')
  }
}

function milestoneLabel(milestone: PaymentMilestone): string {
  return { advance: '预付款', progress: '进度款', final: '尾款' }[milestone]
}

function quoteStatusLabel(status: QuoteStatus): string {
  return { draft: '草稿', sent: '已发送', accepted: '已接受', rejected: '已拒绝', withdrawn: '已撤回' }[status]
}

function contractStatusLabel(status: ContractStatus): string {
  return { draft: '草稿', signed: '已签署', completed: '已完成', terminated: '已终止' }[status]
}

function quoteStatusType(status: QuoteStatus): 'info' | 'primary' | 'success' | 'danger' | 'warning' {
  return ({ draft: 'info', sent: 'primary', accepted: 'success', rejected: 'danger', withdrawn: 'warning' } as const)[status]
}

function contractStatusType(status: ContractStatus): 'info' | 'primary' | 'success' | 'danger' {
  return ({ draft: 'info', signed: 'primary', completed: 'success', terminated: 'danger' } as const)[status]
}

function receivableStatusLabel(status: string): string {
  return {
    unplanned: '未设置',
    scheduled: '待收款',
    partial: '部分到账',
    paid: '已收清',
    overdue: '已逾期',
  }[status] ?? status
}

function receivableStatusType(status: string): 'info' | 'primary' | 'success' | 'danger' | 'warning' {
  if (status === 'paid') return 'success'
  if (status === 'overdue') return 'danger'
  if (status === 'partial') return 'warning'
  if (status === 'scheduled') return 'primary'
  return 'info'
}

function allocationTotal(contract: Contract): number {
  return contract.allocations.filter((item) => item.project_code === props.projectCode)
    .reduce((sum, item) => sum + item.amount_cents, 0)
}

function now(): string { return new Date().toISOString() }
function nullable(value: string): string | null { return value.trim() || null }
function money(value: string): number | null {
  try {
    return yuanToCents(value)
  } catch {
    return null
  }
}

function openQuote(): void {
  if (props.readonly) return
  const pending = currentQuoteSubmission.value
  if (pending && !pending.result) {
    restoreQuoteSubmission(pending)
    return
  }
  quoteEditingId.value = null
  Object.assign(quoteForm, { quote_date: localISODate(), amount_cents: '', valid_until: '', notes: '', document_version_ids: [] })
  quoteFiles.value = []
  validationError.value = null
  quoteVisible.value = true
}

function openQuoteEdit(quote: Quote): void {
  if (props.readonly || quote.status !== 'draft') return
  quoteEditingId.value = quote.id
  Object.assign(quoteForm, {
    quote_date: quote.quote_date,
    amount_cents: centsToYuan(quote.amount_cents),
    valid_until: quote.valid_until ?? '',
    notes: quote.notes ?? '',
    document_version_ids: [...quote.document_version_ids],
  })
  quoteFiles.value = []
  validationError.value = null
  quoteVisible.value = true
}

async function saveQuote(): Promise<void> {
  if (props.readonly || actionBusy.value || quotePendingBusy.value) return
  const existing = quotes.value.find((quote) => quote.id === quoteEditingId.value)
  const recoverable = existing ? null : recoverableQuoteSubmission.value
  const amount = recoverable ? recoverable.input.amount_cents : money(quoteForm.amount_cents)
  if (!recoverable && (!quoteForm.quote_date || amount === null)) {
    validationError.value = '请填写报价日期和正确的元金额'
    return
  }
  const submittedProjectCode = props.projectCode
  const context = startAction(recoverable?.repository)
  const input: QuoteInput = recoverable?.input ?? {
    quote_date: quoteForm.quote_date,
    amount_cents: amount!,
    valid_until: nullable(quoteForm.valid_until),
    notes: nullable(quoteForm.notes),
    document_version_ids: [...quoteForm.document_version_ids],
  }
  const files = recoverable?.files ?? [...quoteFiles.value]
  const pending: PendingQuoteSubmission | null = existing ? null : recoverable ?? {
    owner: context.owner,
    key: projectCommercialPendingKey('quote', context.projectCode),
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    files,
    inFlight: true,
  }
  if (pending) {
    pending.inFlight = true
    delete pending.result
    setPendingWrite(pending.owner, pending.key, pending)
  }
  const saved = existing
    ? await submit(
      () => context.repository.updateQuote(context.projectCode, existing.id, {
        ...input,
        expected_revision: existing.revision,
      }),
      '报价已更新。',
      context,
    )
    : await submit(
      () => context.repository.createQuote(context.projectCode, input, files).then(
        (quote) => {
          pending!.inFlight = false
          pending!.result = quote
          setPendingWrite(pending!.owner, pending!.key, pending!)
          return quote
        },
        (error: unknown) => {
          pending!.inFlight = false
          if (isDefinitiveSubmissionFailure(error)) {
            clearPendingWrite(pending!.owner, pending!.key, pending!)
          } else {
            setPendingWrite(pending!.owner, pending!.key, pending!)
          }
          throw error
        },
      ),
      '报价已创建。',
      context,
  )
  if (saved && mounted && props.projectCode === submittedProjectCode) {
    if (pending) clearPendingWrite(pending.owner, pending.key, pending)
    replaceQuote(saved)
    quoteVisible.value = false
    quoteFiles.value = []
  }
}

function discardQuoteSubmission(pending: PendingQuoteSubmission): void {
  const discarded = pending.repository.discardCreateQuote(pending.projectCode, pending.input, pending.files)
  if (discarded || !pending.inFlight) clearPendingWrite(pending.owner, pending.key, pending)
}

function isDefinitiveSubmissionFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function discardPendingQuoteSubmission(): void {
  if (currentQuoteSubmission.value) discardQuoteSubmission(currentQuoteSubmission.value)
}

function abandonPendingQuoteSubmission(): void {
  const pending = recoverableQuoteSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的报价',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => discardQuoteSubmission(pending)).catch(() => undefined)
}

function resetQuoteFiles(): void {
  if (actionBusy.value || quotePendingBusy.value) return
  quoteFiles.value = []
}

function preventQuoteClose(done: () => void): void {
  if (quotePendingBusy.value) return
  preventDirtyClose(() => {
    discardPendingQuoteSubmission()
    done()
  })
}

function closeQuote(): void {
  if (actionBusy.value || quotePendingBusy.value) return
  preventQuoteClose(() => { quoteVisible.value = false })
}

function openContract(): void {
  if (props.readonly) return
  const pending = currentContractSubmission.value
  if (pending && !pending.result) {
    restoreContractSubmission(pending)
    return
  }
  contractEditingId.value = null
  Object.assign(contractForm, {
    contract_no: '', title: '', signed_on: '', total_amount_cents: '',
    final_delivery_on: '', notes: '', document_version_ids: [],
  })
  contractFiles.value = []
  validationError.value = null
  contractVisible.value = true
}

function openContractEdit(contract: Contract): void {
  if (props.readonly || contract.status !== 'draft') return
  contractEditingId.value = contract.id
  Object.assign(contractForm, {
    contract_no: contract.contract_no,
    title: contract.title,
    signed_on: contract.signed_on ?? '',
    total_amount_cents: centsToYuan(contract.total_amount_cents),
    final_delivery_on: contract.final_delivery_on ?? '',
    notes: contract.notes ?? '',
    document_version_ids: [...contract.document_version_ids],
  })
  contractFiles.value = []
  validationError.value = null
  contractVisible.value = true
}

async function saveContract(): Promise<void> {
  if (props.readonly || actionBusy.value || contractPendingBusy.value) return
  const existing = contracts.value.find((contract) => contract.id === contractEditingId.value)
  const recoverable = existing ? null : recoverableContractSubmission.value
  const companyId = props.customerCompany?.id
    ?? props.operating.commercial.contracts[0]?.customer_company_id
    ?? null
  const total = recoverable ? recoverable.input.total_amount_cents : money(contractForm.total_amount_cents)
  if (!recoverable && (
    !contractForm.contract_no.trim()
    || !contractForm.title.trim()
    || !Number.isSafeInteger(companyId)
    || companyId === null
    || companyId <= 0
    || total === null
    || total <= 0
  )) {
    validationError.value = '请完整填写合同，合同金额必须大于零'
    return
  }
  if (total === null) {
    validationError.value = '合同金额格式不正确'
    return
  }
  if (existing && existing.allocations.length === 0) {
    validationError.value = '合同缺少项目分摊数据，当前页面无法安全保存，请刷新后重试或联系管理员'
    return
  }
  const totalChanged = existing ? total !== existing.total_amount_cents : false
  if (existing && existing.allocations.length > 1 && totalChanged) {
    validationError.value = '跨项目合同修改总额需要同时调整全部项目分摊，当前页面不支持，请保持原合同总额'
    return
  }
  const allocations = recoverable?.input.allocations ?? (existing
    ? existing.allocations.map((allocation) => ({
      project_code: allocation.project_code,
      amount_cents: existing.allocations.length === 1 && totalChanged ? total : allocation.amount_cents,
    }))
    : [{ project_code: props.projectCode, amount_cents: total }])
  const submittedProjectCode = props.projectCode
  const context = startAction(recoverable?.repository)
  const input: ContractInput = recoverable?.input ?? {
    contract_no: contractForm.contract_no.trim(),
    title: contractForm.title.trim(),
    customer_company_id: companyId!,
    signed_on: nullable(contractForm.signed_on),
    total_amount_cents: total,
    final_delivery_on: nullable(contractForm.final_delivery_on),
    allocations,
    notes: nullable(contractForm.notes),
    document_version_ids: [...contractForm.document_version_ids],
  }
  const files = recoverable?.files ?? [...contractFiles.value]
  const pending: PendingContractSubmission | null = existing ? null : recoverable ?? {
    owner: context.owner,
    key: projectCommercialPendingKey('contract', context.projectCode),
    projectCode: context.projectCode,
    repository: context.repository,
    input,
    files,
    inFlight: true,
  }
  if (pending) {
    pending.inFlight = true
    delete pending.result
    setPendingWrite(pending.owner, pending.key, pending)
  }
  const saved = existing
    ? await submit(
      () => context.repository.updateContract(context.projectCode, existing.id, {
        ...input,
        expected_revision: existing.revision,
      }),
      '合同已更新。',
      context,
    )
    : await submit(
      () => context.repository.createContract(context.projectCode, input, files).then(
        (contract) => {
          pending!.inFlight = false
          pending!.result = contract
          setPendingWrite(pending!.owner, pending!.key, pending!)
          return contract
        },
        (error: unknown) => {
          pending!.inFlight = false
          if (isDefinitiveSubmissionFailure(error)) {
            clearPendingWrite(pending!.owner, pending!.key, pending!)
          } else {
            setPendingWrite(pending!.owner, pending!.key, pending!)
          }
          throw error
        },
      ),
      '合同已创建。',
      context,
  )
  if (saved && mounted && props.projectCode === submittedProjectCode) {
    if (pending) clearPendingWrite(pending.owner, pending.key, pending)
    replaceContract(saved)
    contractVisible.value = false
    contractEditingId.value = null
    contractFiles.value = []
    await refreshPaymentsAfterSave()
  }
}

function discardContractSubmission(pending: PendingContractSubmission): void {
  const discarded = pending.repository.discardCreateContract(pending.projectCode, pending.input, pending.files)
  if (discarded || !pending.inFlight) clearPendingWrite(pending.owner, pending.key, pending)
}

function discardPendingContractSubmission(): void {
  if (currentContractSubmission.value) discardContractSubmission(currentContractSubmission.value)
}

function abandonPendingContractSubmission(): void {
  const pending = recoverableContractSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后无法再使用原请求安全核对结果，确定继续修改吗？',
    '放弃结果未知的合同',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => discardContractSubmission(pending)).catch(() => undefined)
}

function resetContractFiles(): void {
  if (actionBusy.value || contractPendingBusy.value) return
  contractFiles.value = []
}

function preventContractClose(done: () => void): void {
  if (contractPendingBusy.value) return
  preventDirtyClose(() => {
    discardPendingContractSubmission()
    done()
  })
}

function preventDirtyClose(done: () => void): void {
  if (actionBusy.value) return
  void ElMessageBox.confirm(
    '关闭后未保存的内容会丢失，确定关闭吗？',
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => done()).catch(() => undefined)
}

function closeContract(): void {
  if (actionBusy.value || contractPendingBusy.value) return
  preventContractClose(() => { contractVisible.value = false })
}

function closeTransition(): void {
  preventDirtyClose(() => { transitionVisible.value = false })
}

function closeTerm(): void {
  preventDirtyClose(() => { termVisible.value = false })
}

function closeReceipt(): void {
  preventDirtyClose(() => { receiptVisible.value = false })
}

function closeVoid(): void {
  preventDirtyClose(() => { voidVisible.value = false })
}

function openTransition(kind: 'quote' | 'contract', id: number): void {
  if (props.readonly) return
  const transitions = kind === 'quote'
    ? quoteTransitions[quotes.value.find((item) => item.id === id)?.status ?? 'accepted']
    : contractTransitions[contracts.value.find((item) => item.id === id)?.status ?? 'completed']
  if (transitions.length === 0) return
  transitionKind.value = kind
  transitionId.value = id
  quoteTarget.value = null
  contractTarget.value = null
  transitionReason.value = ''
  validationError.value = null
  transitionVisible.value = true
}

async function saveTransition(): Promise<void> {
  if (props.readonly) return
  const occurredAt = now()
  if (transitionKind.value === 'quote' && quoteTarget.value) {
    const quote = quotes.value.find((item) => item.id === transitionId.value)
    if (quote) {
      if (!quoteTransitions[quote.status].includes(quoteTarget.value)) {
        validationError.value = '请选择当前报价可以执行的状态'
        return
      }
      const saved = await submit(
        () => repository.transitionQuote(props.projectCode, quote.id, {
          to_status: quoteTarget.value!,
          occurred_at: occurredAt,
          reason: nullable(transitionReason.value),
          expected_revision: quote.revision,
        }),
        '报价状态已更新。',
      )
      if (!saved) return
      replaceQuote(saved)
    }
  } else if (transitionKind.value === 'contract' && contractTarget.value) {
    const contract = contracts.value.find((item) => item.id === transitionId.value)
    if (contract) {
      if (!contractTransitions[contract.status].includes(contractTarget.value)) {
        validationError.value = '请选择当前合同可以执行的状态'
        return
      }
      if (contractTarget.value === 'signed' && (!contract.signed_on || !contract.final_delivery_on)) {
        validationError.value = '转为已签署前必须补齐签订日期和最终交付日期'
        return
      }
      const saved = await submit(
        () => repository.transitionContract(props.projectCode, contract.id, {
          to_status: contractTarget.value!,
          occurred_at: occurredAt,
          reason: nullable(transitionReason.value),
          expected_revision: contract.revision,
        }),
        '合同状态已更新。',
      )
      if (!saved) return
      replaceContract(saved)
      transitionVisible.value = false
      transitionId.value = null
      await refreshPaymentsAfterSave()
      return
    }
  } else {
    validationError.value = '请选择目标状态'
    return
  }
  transitionVisible.value = false
}

function openTerm(term: PaymentTerm): void {
  if (props.readonly) return
  selectedMilestone.value = term.milestone
  termForm.due_on = term.due_on ?? ''
  termForm.planned_amount_cents = centsToYuan(term.planned_amount_cents)
  termForm.notes = term.notes ?? ''
  validationError.value = null
  termVisible.value = true
}

async function saveTerm(): Promise<void> {
  if (props.readonly) return
  const term = receivables.terms.find((item) => item.milestone === selectedMilestone.value)
  const planned = money(termForm.planned_amount_cents)
  if (!term || planned === null) {
    validationError.value = '计划金额必须是正确的元金额'
    return
  }
  const saved = await submit(
    () => repository.putPaymentTerm(props.projectCode, term.milestone, {
      due_on: nullable(termForm.due_on),
      planned_amount_cents: planned,
      notes: nullable(termForm.notes),
      expected_revision: term.revision,
    }),
    '收款计划已保存。',
  )
  if (saved) {
    const index = receivables.terms.findIndex((item) => item.milestone === saved.milestone)
    if (index >= 0) receivables.terms.splice(index, 1, saved)
    termVisible.value = false
    await refreshPaymentsAfterSave()
  }
}

function openReceipt(): void {
  if (props.readonly) return
  receiptEditingId.value = null
  Object.assign(receiptForm, {
    contract_allocation_id: receiptAllocationOptions.value.length === 1
      ? receiptAllocationOptions.value[0]!.id
      : null,
    milestone: 'advance', received_on: localISODate(), amount_cents: '',
    payment_method: 'bank_transfer', reference_no: '', notes: '',
  })
  validationError.value = null
  receiptVisible.value = true
}

function openReceiptEdit(receipt: Receipt): void {
  if (props.readonly) return
  receiptEditingId.value = receipt.id
  Object.assign(receiptForm, {
    contract_allocation_id: receipt.contract_allocation_id,
    milestone: receipt.milestone,
    received_on: receipt.received_on,
    amount_cents: centsToYuan(receipt.amount_cents),
    payment_method: receipt.payment_method,
    reference_no: receipt.reference_no ?? '',
    notes: receipt.notes ?? '',
  })
  validationError.value = null
  receiptVisible.value = true
}

async function saveReceipt(): Promise<void> {
  if (props.readonly) return
  const amount = money(receiptForm.amount_cents)
  if (!receiptForm.received_on || amount === null || amount === 0) {
    validationError.value = '请填写到账日期和大于零的元金额'
    return
  }
  const existing = receivables.receipts.find((receipt) => receipt.id === receiptEditingId.value)
  if (existing) {
    const saved = await submit(
      () => repository.updateReceipt(props.projectCode, existing.id, {
        reference_no: nullable(receiptForm.reference_no),
        notes: nullable(receiptForm.notes),
        expected_revision: existing.revision,
      }),
      '到账说明已更新。',
    )
    if (saved) {
      const index = receivables.receipts.findIndex((receipt) => receipt.id === saved.id)
      if (index >= 0) receivables.receipts.splice(index, 1, saved)
      receiptVisible.value = false
      receiptEditingId.value = null
      await refreshPaymentsAfterSave()
    }
    return
  }
  const allocationId = receiptForm.contract_allocation_id
  if (allocationId === null
    || !receiptAllocationOptions.value.some((allocation) => allocation.id === allocationId)) {
    validationError.value = '请选择本次到账归属的合同'
    return
  }
  const saved = await submit(
    () => repository.createReceipt(props.projectCode, {
      contract_allocation_id: allocationId,
      milestone: receiptForm.milestone,
      received_on: receiptForm.received_on,
      amount_cents: amount,
      payment_method: receiptForm.payment_method,
      reference_no: nullable(receiptForm.reference_no),
      notes: nullable(receiptForm.notes),
    }),
    '到账流水已登记。',
  )
  if (saved) {
    receivables.receipts.unshift(saved)
    receiptVisible.value = false
    receiptEditingId.value = null
    Object.assign(receiptForm, {
      contract_allocation_id: null,
      milestone: 'advance', received_on: '', amount_cents: '', payment_method: 'bank_transfer',
      reference_no: '', notes: '',
    })
    await refreshPaymentsAfterSave()
  }
}

function openVoid(receiptId: number): void {
  if (props.readonly) return
  selectedReceiptId.value = receiptId
  voidForm.voided_on = localISODate()
  voidForm.reason = ''
  validationError.value = null
  voidVisible.value = true
}

async function saveVoid(): Promise<void> {
  if (props.readonly) return
  const receipt = receivables.receipts.find((item) => item.id === selectedReceiptId.value)
  if (!receipt || !voidForm.voided_on || !voidForm.reason.trim()) {
    validationError.value = '请填写作废日期和原因'
    return
  }
  const saved = await submit(
    () => repository.voidReceipt(props.projectCode, receipt.id, {
      voided_on: voidForm.voided_on,
      reason: voidForm.reason.trim(),
      expected_revision: receipt.revision,
    }),
    '到账流水已作废。',
  )
  if (saved) {
    const index = receivables.receipts.findIndex((item) => item.id === saved.id)
    if (index >= 0) receivables.receipts.splice(index, 1, saved)
    voidVisible.value = false
    selectedReceiptId.value = null
    Object.assign(voidForm, { voided_on: '', reason: '' })
    await refreshPaymentsAfterSave()
  }
}

watch([() => props.projectCode, () => props.repository], ([, nextRepository]) => {
  actionGeneration += 1
  actionSequence += 1
  repository = nextRepository ?? defaultRepository
  pendingOwner.value = nextRepository ?? defaultProjectCommercialPendingOwner
  actionBusy.value = false
  validationError.value = null
  activeView.value = 'overview'
  quoteVisible.value = false
  quoteFiles.value = []
  contractVisible.value = false
  contractFiles.value = []
  transitionVisible.value = false
  receiptVisible.value = false
  termVisible.value = false
  voidVisible.value = false
  actionSuccess.value = null
  actionWarning.value = null
  restoreCurrentPendingSubmissions()
  void loadCommercial()
}, { immediate: true })

watch(
  [() => currentQuoteSubmission.value?.result, () => currentContractSubmission.value?.result],
  () => consumeResolvedPendingSubmissions(),
)

onBeforeUnmount(() => {
  mounted = false
  actionGeneration += 1
  actionSequence += 1
})
</script>

<template>
  <el-space data-testid="project-demo-commercial" class="project-panel-stack commercial-stack" direction="vertical" alignment="stretch" fill :size="16">
    <el-row justify="space-between" align="middle">
      <div><el-text tag="strong" size="large">报价与收款</el-text><p class="section-note">报价不是项目收入，发票不是收款。</p></div>
      <el-tag v-if="readonly" type="info" effect="plain">项目已归档，仅供查看</el-tag>
    </el-row>
    <el-skeleton v-if="loading" :rows="5" animated />
    <el-result v-else-if="loadError" data-testid="commercial-load-error" icon="error" title="商务台账读取失败" :sub-title="loadError">
      <template #extra><el-button data-testid="commercial-load-retry" type="primary" @click="loadCommercial">重新读取</el-button></template>
    </el-result>
    <el-alert v-if="actionSuccess" :title="actionSuccess" type="success" :closable="false" />
    <el-alert
      v-if="actionWarning"
      data-testid="commercial-refresh-warning"
      :title="actionWarning"
      type="warning"
      :closable="false"
    />
    <el-space role="tablist" aria-label="商务视图" wrap>
      <el-button role="tab" :aria-selected="activeView === 'overview'" :type="activeView === 'overview' ? 'primary' : 'default'" @click="activeView = 'overview'">经营摘要</el-button>
      <el-button role="tab" :aria-selected="activeView === 'quotes'" data-testid="commercial-nav-quotes" :type="activeView === 'quotes' ? 'primary' : 'default'" @click="activeView = 'quotes'">报价版本</el-button>
      <el-button role="tab" :aria-selected="activeView === 'contracts'" data-testid="commercial-nav-contracts" :type="activeView === 'contracts' ? 'primary' : 'default'" @click="activeView = 'contracts'">项目合同</el-button>
      <el-button role="tab" :aria-selected="activeView === 'receivables'" data-testid="commercial-nav-receivables" :type="activeView === 'receivables' ? 'primary' : 'default'" @click="activeView = 'receivables'">三段收款</el-button>
    </el-space>

    <template v-if="activeView === 'overview'">
      <el-row :gutter="20">
        <el-col :xs="24" :xl="9"><el-card class="data-card" shadow="never"><template #header><el-text tag="strong">已接受报价</el-text></template><el-empty v-if="!acceptedQuote" description="暂无已接受报价" /><el-descriptions v-else :column="1" border><el-descriptions-item label="报价版本">V{{ acceptedQuote.version_number }}</el-descriptions-item><el-descriptions-item label="报价金额">{{ formatMoney(acceptedQuote.amount_cents) }}</el-descriptions-item><el-descriptions-item label="报价日期">{{ acceptedQuote.quote_date }}</el-descriptions-item><el-descriptions-item label="状态">{{ quoteStatusLabel(acceptedQuote.status) }}</el-descriptions-item></el-descriptions></el-card></el-col>
        <el-col :xs="24" :xl="15"><el-card class="data-card" shadow="never"><template #header><el-text tag="strong">项目合同</el-text></template><el-table :data="contracts" row-key="id"><el-table-column prop="contract_no" label="合同编号" /><el-table-column prop="title" label="合同名称" /><el-table-column label="项目分摊"><template #default="scope">{{ formatMoney(allocationTotal(scope.row)) }}</template></el-table-column><el-table-column label="状态"><template #default="scope">{{ contractStatusLabel(scope.row.status) }}</template></el-table-column></el-table></el-card></el-col>
      </el-row>
      <el-card data-testid="project-demo-receivables" class="data-card" shadow="never"><template #header><el-text tag="strong">三段收款</el-text></template><el-table :data="receivables.terms" row-key="milestone"><el-table-column label="节点"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="计划金额"><template #default="scope">{{ formatMoney(scope.row.planned_amount_cents) }}</template></el-table-column><el-table-column label="已到账"><template #default="scope">{{ formatMoney(scope.row.received_amount_cents) }}</template></el-table-column><el-table-column label="未收"><template #default="scope">{{ formatMoney(scope.row.outstanding_amount_cents) }}</template></el-table-column></el-table></el-card>
    </template>

    <el-card v-else-if="activeView === 'quotes'" data-testid="commercial-quotes" class="data-card" shadow="never">
      <template #header><el-row justify="space-between"><div><el-text tag="strong">报价版本</el-text><p class="section-note">仅草稿可编辑；需确认时使用“推进状态”。</p></div><el-button v-if="!readonly" data-testid="quote-create-open" type="primary" @click="openQuote">新建报价</el-button></el-row></template>
      <el-table :data="quotes" row-key="id"><el-table-column label="版本" width="80"><template #default="scope">V{{ scope.row.version_number }}</template></el-table-column><el-table-column label="状态" width="110"><template #default="scope"><el-tag :data-testid="`quote-status-${scope.row.id}`" :type="quoteStatusType(scope.row.status)">{{ quoteStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column prop="quote_date" label="报价日期" min-width="120" /><el-table-column label="金额" min-width="150"><template #default="scope">{{ formatMoney(scope.row.amount_cents) }}</template></el-table-column><el-table-column label="附件" min-width="220"><template #default="scope"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="scope.row.document_version_ids" :options="documentOptions" :test-id="`quote-files-${scope.row.id}`" /></template></el-table-column><el-table-column v-if="!readonly" label="操作" width="170"><template #default="scope"><el-button v-if="scope.row.status === 'draft'" :data-testid="`quote-edit-open-${scope.row.id}`" :aria-label="`编辑报价 V${scope.row.version_number}`" link @click="openQuoteEdit(scope.row)">编辑</el-button><el-button v-if="hasQuoteTransitions(scope.row.status)" :data-testid="`quote-transition-open-${scope.row.id}`" :aria-label="`推进报价 V${scope.row.version_number} 状态`" link type="primary" @click="openTransition('quote', scope.row.id)">推进状态</el-button><span v-if="scope.row.status !== 'draft' && !hasQuoteTransitions(scope.row.status)" class="section-note">无需操作</span></template></el-table-column></el-table>
    </el-card>

    <el-card v-else-if="activeView === 'contracts'" data-testid="commercial-contracts" class="data-card" shadow="never">
      <template #header><el-row justify="space-between"><div><el-text tag="strong">项目合同</el-text><p class="section-note">仅草稿可编辑；收入只取当前项目分摊额。</p></div><el-button v-if="!readonly" data-testid="contract-create-open" type="primary" @click="openContract">新建合同</el-button></el-row></template>
      <el-table :data="contracts" row-key="id"><el-table-column prop="contract_no" label="合同编号" min-width="150" /><el-table-column label="状态" width="110"><template #default="scope"><el-tag :data-testid="`contract-status-${scope.row.id}`" :type="contractStatusType(scope.row.status)">{{ contractStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column prop="title" label="合同名称" min-width="200" /><el-table-column label="总额" min-width="140"><template #default="scope">{{ formatMoney(scope.row.total_amount_cents) }}</template></el-table-column><el-table-column label="项目分摊" min-width="140"><template #default="scope">{{ formatMoney(allocationTotal(scope.row)) }}</template></el-table-column><el-table-column label="附件" min-width="220"><template #default="scope"><BusinessAttachmentLinks :project-code="projectCode" :version-ids="scope.row.document_version_ids" :options="documentOptions" :test-id="`contract-files-${scope.row.id}`" /></template></el-table-column><el-table-column v-if="!readonly" label="操作" width="170"><template #default="scope"><el-button v-if="scope.row.status === 'draft'" :data-testid="`contract-edit-open-${scope.row.id}`" :aria-label="`编辑合同 ${scope.row.title}`" link @click="openContractEdit(scope.row)">编辑</el-button><el-button v-if="hasContractTransitions(scope.row.status)" :data-testid="`contract-transition-open-${scope.row.id}`" :aria-label="`推进合同 ${scope.row.title} 状态`" link type="primary" @click="openTransition('contract', scope.row.id)">推进状态</el-button><span v-if="scope.row.status !== 'draft' && !hasContractTransitions(scope.row.status)" class="section-note">无需操作</span></template></el-table-column></el-table>
    </el-card>

    <el-space v-else data-testid="commercial-receivables" class="commercial-receivables" direction="vertical" alignment="stretch" fill :size="16">
      <el-row :gutter="12"><el-col :xs="24" :sm="8"><el-card shadow="never"><div class="metric-value"><span>应收</span><strong>{{ formatMoney(receivables.receivable_amount_cents) }}</strong></div></el-card></el-col><el-col :xs="24" :sm="8"><el-card shadow="never"><div data-testid="receivable-total-received" class="metric-value"><span>实际到账</span><strong>{{ formatMoney(receivables.received_amount_cents) }}</strong></div></el-card></el-col><el-col :xs="24" :sm="8"><el-card shadow="never"><div class="metric-value"><span>未收</span><strong>{{ formatMoney(receivables.outstanding_receivable_cents) }}</strong></div></el-card></el-col></el-row>
      <el-card class="data-card receivable-terms-card" shadow="never"><template #header><el-row justify="space-between"><div><el-text tag="strong">三个固定收款节点</el-text><p class="section-note">合同回款 {{ formatBasisPoints(receivables.contract_collection_basis_points) }}</p></div><el-button v-if="!readonly" data-testid="receipt-create-open" type="primary" :disabled="receiptAllocationOptions.length === 0" @click="openReceipt">登记到账</el-button></el-row></template><el-alert v-if="!readonly && receiptAllocationOptions.length === 0" title="请先签订并确认合同，再登记到账。" type="warning" :closable="false" /><el-table :data="receivables.terms" row-key="milestone"><el-table-column label="节点"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="状态"><template #default="scope"><el-tag :type="receivableStatusType(scope.row.status)">{{ receivableStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column label="计划"><template #default="scope">{{ formatMoney(scope.row.planned_amount_cents) }}</template></el-table-column><el-table-column label="到账"><template #default="scope">{{ formatMoney(scope.row.received_amount_cents) }}</template></el-table-column><el-table-column label="履约比例"><template #default="scope">{{ formatBasisPoints(scope.row.term_fulfillment_basis_points) }}</template></el-table-column><el-table-column v-if="!readonly" label="操作"><template #default="scope"><el-button :data-testid="`payment-term-edit-${scope.row.milestone}`" link @click="openTerm(scope.row)">编辑计划</el-button></template></el-table-column></el-table><div class="receivable-mobile-list"><el-card v-for="term in receivables.terms" :key="term.milestone" shadow="never"><div class="receivable-mobile-heading"><strong>{{ milestoneLabel(term.milestone) }}</strong><el-tag size="small" :type="receivableStatusType(term.status)">{{ receivableStatusLabel(term.status) }}</el-tag></div><el-descriptions :column="2" size="small" border><el-descriptions-item label="计划">{{ formatMoney(term.planned_amount_cents) }}</el-descriptions-item><el-descriptions-item label="到账">{{ formatMoney(term.received_amount_cents) }}</el-descriptions-item></el-descriptions><el-button v-if="!readonly" plain size="small" @click="openTerm(term)">编辑计划</el-button></el-card></div></el-card>
      <el-card data-testid="receipt-ledger" class="data-card" shadow="never"><template #header><div><el-text tag="strong">到账流水</el-text><p class="section-note">发票不是收款；金额纠错使用作废后重录。</p></div></template><el-empty v-if="receivables.receipts.length === 0" description="暂无到账流水" /><el-table v-else :data="receivables.receipts" row-key="id"><el-table-column prop="received_on" label="到账日期" min-width="110" /><el-table-column label="节点" width="90"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="金额" min-width="130"><template #default="scope">{{ formatMoney(scope.row.amount_cents) }}</template></el-table-column><el-table-column prop="reference_no" label="参考号" min-width="150" /><el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'">{{ scope.row.status === 'active' ? '有效' : '已作废' }}</el-tag></template></el-table-column><el-table-column v-if="!readonly" label="操作" width="150"><template #default="scope"><el-button v-if="scope.row.status === 'active'" :data-testid="`receipt-edit-open-${scope.row.id}`" link @click="openReceiptEdit(scope.row)">编辑说明</el-button><el-button v-if="scope.row.status === 'active'" :data-testid="`receipt-void-${scope.row.id}`" link type="danger" @click="openVoid(scope.row.id)">作废</el-button></template></el-table-column></el-table></el-card>
    </el-space>

    <el-dialog
      v-model="quoteVisible"
      :title="`${quoteEditingId ? '编辑' : '新建'}报价`"
      class="quote-dialog"
      width="min(720px, calc(100vw - 32px))"
      top="5vh"
      :teleported="false"
      :close-on-click-modal="!actionBusy && !quotePendingBusy"
      :close-on-press-escape="!actionBusy && !quotePendingBusy"
      :show-close="!actionBusy && !quotePendingBusy"
      :before-close="preventQuoteClose"
      @closed="resetQuoteFiles"
    >
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <div v-if="currentQuoteSubmission" class="pending-retry-panel">
        <el-alert data-testid="quote-create-uncertain" :title="quotePendingBusy ? '原报价请求仍在处理中，原内容和附件已保留，请等待结果。' : '上次创建结果未知，原内容和附件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableQuoteSubmission" data-testid="quote-abandon-pending" :disabled="actionBusy" @click="abandonPendingQuoteSubmission">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentQuoteSubmission)" @submit.prevent="saveQuote">
        <el-form-item label="报价日期" required><el-date-picker data-testid="quote-date" v-model="quoteForm.quote_date" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
        <el-form-item label="报价金额（元）" required><el-input data-testid="quote-amount" v-model="quoteForm.amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item>
        <el-form-item label="有效期至"><el-date-picker v-model="quoteForm.valid_until" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="quoteForm.notes" type="textarea" /></el-form-item>
        <el-form-item v-if="quoteEditingId === null" label="报价文件">
          <BusinessAttachmentUpload
            v-model="quoteFiles"
            test-id="quote-attachments"
            accept=".pdf,.doc,.docx,.xls,.xlsx,image/*"
            :busy="actionBusy || Boolean(currentQuoteSubmission)"
          />
        </el-form-item>
        <el-collapse>
          <el-collapse-item title="关联已有资料（可选）" name="existing-documents">
            <el-form-item label="已有项目资料"><el-select v-model="quoteForm.document_version_ids" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="item in documentOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          </el-collapse-item>
        </el-collapse>
      </el-form>
      <template #footer>
        <el-button data-testid="quote-cancel" :disabled="actionBusy || quotePendingBusy" @click="closeQuote">取消</el-button>
        <el-button data-testid="quote-create-save" type="primary" :loading="actionBusy || quotePendingBusy" :disabled="actionBusy || quotePendingBusy" @click="saveQuote">{{ quoteEditingId ? '保存修改' : recoverableQuoteSubmission ? '原样重试' : quotePendingBusy ? '等待原请求' : '创建报价' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="contractVisible"
      :title="`${contractEditingId ? '编辑' : '新建'}合同`"
      class="business-dialog"
      width="min(720px, calc(100vw - 32px))"
      top="5vh"
      :teleported="false"
      :close-on-click-modal="!actionBusy && !contractPendingBusy"
      :close-on-press-escape="!actionBusy && !contractPendingBusy"
      :show-close="!actionBusy && !contractPendingBusy"
      :before-close="preventContractClose"
      @closed="resetContractFiles"
    >
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <div v-if="currentContractSubmission" class="pending-retry-panel">
        <el-alert data-testid="contract-create-uncertain" :title="contractPendingBusy ? '原合同请求仍在处理中，原内容和附件已保留，请等待结果。' : '上次创建结果未知，原内容和附件已锁定。请原样重试；如需修改，先明确放弃原请求。'" type="warning" :closable="false" show-icon />
        <el-button v-if="recoverableContractSubmission" data-testid="contract-abandon-pending" :disabled="actionBusy" @click="abandonPendingContractSubmission">放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" :disabled="actionBusy || Boolean(currentContractSubmission)" @submit.prevent="saveContract">
        <el-form-item label="合同编号" required><el-input data-testid="contract-no" v-model="contractForm.contract_no" /></el-form-item>
        <el-form-item label="合同名称" required><el-input data-testid="contract-title" v-model="contractForm.title" /></el-form-item>
        <el-form-item label="客户公司" required><el-input data-testid="contract-company" :model-value="customerCompany?.name ?? operating.commercial.contracts[0]?.customer_company_name ?? '当前项目客户'" disabled /></el-form-item>
        <el-form-item label="合同总额（元）" required><el-input data-testid="contract-total" v-model="contractForm.total_amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item>
        <el-form-item label="签订日期"><el-date-picker v-model="contractForm.signed_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item>
        <el-form-item label="最终交付日期"><el-date-picker v-model="contractForm.final_delivery_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="contractForm.notes" type="textarea" /></el-form-item>
        <el-form-item v-if="contractEditingId === null" label="合同文件">
          <BusinessAttachmentUpload
            v-model="contractFiles"
            test-id="contract-attachments"
            accept=".pdf,.doc,.docx,image/*"
            :busy="actionBusy || Boolean(currentContractSubmission)"
          />
        </el-form-item>
        <el-collapse>
          <el-collapse-item title="关联已有资料（可选）" name="existing-contract-documents">
            <el-form-item label="已有项目资料"><el-select v-model="contractForm.document_version_ids" multiple filterable collapse-tags clearable style="width:100%"><el-option v-for="item in documentOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          </el-collapse-item>
        </el-collapse>
      </el-form>
      <template #footer>
        <el-button data-testid="contract-cancel" :disabled="actionBusy || contractPendingBusy" @click="closeContract">取消</el-button>
        <el-button data-testid="contract-create-save" type="primary" :loading="actionBusy || contractPendingBusy" :disabled="actionBusy || contractPendingBusy" @click="saveContract">{{ contractEditingId ? '保存修改' : recoverableContractSubmission ? '原样重试' : contractPendingBusy ? '等待原请求' : '创建合同' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="transitionVisible" title="切换状态" width="min(94vw, 520px)" :teleported="false" :before-close="preventDirtyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-space v-if="transitionKind === 'quote'" role="radiogroup" aria-label="报价目标状态" wrap><el-button v-for="status in availableQuoteStatuses" :key="status" role="radio" :aria-checked="quoteTarget === status" :type="quoteTarget === status ? 'primary' : 'default'" @click="quoteTarget = status">{{ quoteStatusLabel(status) }}</el-button></el-space><el-space v-else role="radiogroup" aria-label="合同目标状态" wrap><el-button v-for="status in availableContractStatuses" :key="status" role="radio" :aria-checked="contractTarget === status" :type="contractTarget === status ? 'primary' : 'default'" @click="contractTarget = status">{{ contractStatusLabel(status) }}</el-button></el-space><el-input v-model="transitionReason" type="textarea" placeholder="原因（如需）" /><template #footer><div class="dialog-actions"><el-button data-testid="transition-cancel" :disabled="actionBusy" @click="closeTransition">取消</el-button><el-button type="primary" :loading="actionBusy" @click="saveTransition">确认切换</el-button></div></template></el-dialog>

    <el-dialog v-model="termVisible" title="编辑收款计划" width="min(94vw, 560px)" :teleported="false" :before-close="preventDirtyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveTerm"><el-form-item label="计划日期"><el-date-picker v-model="termForm.due_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item label="计划金额（元）"><el-input v-model="termForm.planned_amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="备注"><el-input v-model="termForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button data-testid="term-cancel" :disabled="actionBusy" @click="closeTerm">取消</el-button><el-button type="primary" native-type="submit" :loading="actionBusy">保存计划</el-button></div></el-form></el-dialog>

    <el-dialog v-model="receiptVisible" :title="receiptEditingId ? '编辑到账说明' : '登记到账'" width="min(94vw, 620px)" :teleported="false" :before-close="preventDirtyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveReceipt"><el-form-item v-if="receiptEditingId === null" label="归属合同" required><el-select v-model="receiptForm.contract_allocation_id" data-testid="receipt-contract-allocation" placeholder="请选择本次到账归属的合同" style="width:100%"><el-option v-for="allocation in receiptAllocationOptions" :key="allocation.id" :label="allocation.label" :value="allocation.id" /></el-select></el-form-item><el-form-item v-else label="归属合同"><el-text data-testid="receipt-contract-allocation-readonly">{{ receiptAllocationDisplay }}</el-text></el-form-item><el-form-item label="节点"><el-select v-model="receiptForm.milestone" :disabled="receiptEditingId !== null"><el-option value="advance" label="预付款" /><el-option value="progress" label="进度款" /><el-option value="final" label="尾款" /></el-select></el-form-item><el-form-item label="到账日期" required><el-date-picker data-testid="receipt-date" v-model="receiptForm.received_on" type="date" value-format="YYYY-MM-DD" :clearable="false" :disabled="receiptEditingId !== null" style="width:100%" /></el-form-item><el-form-item label="到账金额（元）" required><el-input data-testid="receipt-amount" v-model="receiptForm.amount_cents" :disabled="receiptEditingId !== null" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="收款方式"><el-select v-model="receiptForm.payment_method" :disabled="receiptEditingId !== null"><el-option value="bank_transfer" label="银行转账" /><el-option value="cash" label="现金" /><el-option value="other" label="其他" /></el-select></el-form-item><el-form-item label="参考号"><el-input data-testid="receipt-reference" v-model="receiptForm.reference_no" /></el-form-item><el-form-item label="备注"><el-input v-model="receiptForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button data-testid="receipt-cancel" :disabled="actionBusy" @click="closeReceipt">取消</el-button><el-button data-testid="receipt-create-save" type="primary" native-type="submit" :loading="actionBusy">{{ receiptEditingId ? '保存说明' : '登记到账' }}</el-button></div></el-form></el-dialog>

    <el-dialog v-model="voidVisible" title="作废到账" width="min(94vw, 520px)" :teleported="false" :before-close="preventDirtyClose" :close-on-click-modal="!actionBusy" :close-on-press-escape="!actionBusy" :show-close="!actionBusy"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveVoid"><el-form-item label="作废日期" required><el-date-picker data-testid="receipt-void-date" v-model="voidForm.voided_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="原因" required><el-input data-testid="receipt-void-reason" v-model="voidForm.reason" type="textarea" /></el-form-item><div class="dialog-actions"><el-button data-testid="receipt-void-cancel" :disabled="actionBusy" @click="closeVoid">取消</el-button><el-button data-testid="receipt-void-save" type="danger" native-type="submit" :loading="actionBusy">确认作废</el-button></div></el-form></el-dialog>
  </el-space>
</template>

<style scoped>
.commercial-stack,
.commercial-stack > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; }
.pending-retry-panel { display: grid; gap: 10px; margin-bottom: 16px; }
.pending-retry-panel > :deep(.el-button) { justify-self: end; }
.commercial-receivables,
.commercial-receivables > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
.commercial-stack :deep(.data-card > .el-card__body) { min-width: 0; overflow-x: auto; }
.commercial-stack :deep(.data-card .el-table) { min-width: 620px; }
.commercial-stack :deep(.quote-dialog .el-dialog__body),
.commercial-stack :deep(.business-dialog .el-dialog__body) {
  max-height: calc(90vh - 142px);
  overflow-y: auto;
}
.commercial-receivables :deep(.el-table th:last-child),
.commercial-receivables :deep(.el-table td:last-child) {
  position: sticky;
  right: 0;
  z-index: 2;
  background: var(--el-bg-color);
  box-shadow: -8px 0 12px -12px var(--el-text-color-secondary);
}
.receivable-mobile-list { display: none; }
@media (max-width: 520px) {
  .receivable-terms-card > :deep(.el-card__body > .el-table) { display: none; }
  .receivable-mobile-list { display: grid; gap: 10px; }
  .receivable-mobile-list :deep(.el-card__body) { display: grid; gap: 10px; padding: 12px; }
  .receivable-mobile-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .receivable-mobile-list :deep(.el-button) { width: 100%; margin: 0; }
}
</style>
