<script setup lang="ts">
import { reactive, ref } from 'vue'

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

const props = defineProps<{
  operating: ProjectOperatingSnapshot
  projectCode: string
  customerCompany?: { id: number; name: string }
}>()
type CommercialView = 'overview' | 'quotes' | 'contracts' | 'receivables'

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

const quoteForm = reactive({ quote_date: '', amount_cents: '', valid_until: '', notes: '', document_version_ids: [] as number[] })
const contractForm = reactive({
  contract_no: '', title: '', customer_company_id: '', signed_on: '', total_amount_cents: '',
  final_delivery_on: '', allocation_amount_cents: '', notes: '', document_version_ids: [] as number[],
})
const receiptForm = reactive({
  milestone: 'advance' as PaymentMilestone, received_on: '', amount_cents: '',
  payment_method: 'bank_transfer' as PaymentMethod, reference_no: '', notes: '',
})
const termForm = reactive({ due_on: '', planned_amount_cents: '', notes: '' })
const voidForm = reactive({ voided_on: '', reason: '' })

const quoteStatuses: QuoteStatus[] = ['draft', 'sent', 'accepted', 'rejected', 'withdrawn']
const contractStatuses: ContractStatus[] = ['draft', 'signed', 'completed', 'terminated']
const demoDocumentOptions = [
  { value: 1001, label: '现场测绘记录 V1' },
  { value: 1002, label: '技术协议 V2' },
  { value: 1003, label: '合同扫描件 V1' },
]

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
  quoteEditingId.value = null
  Object.assign(quoteForm, { quote_date: localISODate(), amount_cents: '', valid_until: '', notes: '', document_version_ids: [] })
  validationError.value = null
  quoteVisible.value = true
}

function openQuoteEdit(quote: Quote): void {
  quoteEditingId.value = quote.id
  Object.assign(quoteForm, {
    quote_date: quote.quote_date,
    amount_cents: centsToYuan(quote.amount_cents),
    valid_until: quote.valid_until ?? '',
    notes: quote.notes ?? '',
    document_version_ids: [...quote.document_version_ids],
  })
  validationError.value = null
  quoteVisible.value = true
}

function saveQuote(): void {
  const amount = money(quoteForm.amount_cents)
  if (!quoteForm.quote_date || amount === null) {
    validationError.value = '请填写报价日期和正确的元金额'
    return
  }
  const createdAt = now()
  const existing = quotes.value.find((quote) => quote.id === quoteEditingId.value)
  if (existing) {
    Object.assign(existing, {
      quote_date: quoteForm.quote_date,
      amount_cents: amount,
      valid_until: nullable(quoteForm.valid_until),
      notes: nullable(quoteForm.notes),
      document_version_ids: [...quoteForm.document_version_ids],
      revision: existing.revision + 1,
      updated_at: createdAt,
    })
    quoteVisible.value = false
    return
  }
  quotes.value.unshift({
    id: Math.max(0, ...quotes.value.map((quote) => quote.id)) + 1,
    project_code: props.projectCode,
    version_number: Math.max(0, ...quotes.value.map((quote) => quote.version_number)) + 1,
    status: 'draft',
    quote_date: quoteForm.quote_date,
    amount_cents: amount,
    valid_until: nullable(quoteForm.valid_until),
    notes: nullable(quoteForm.notes),
    document_version_ids: [...quoteForm.document_version_ids],
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
  })
  quoteVisible.value = false
}

function openContract(): void {
  contractEditingId.value = null
  Object.assign(contractForm, {
    contract_no: '', title: '', customer_company_id: '', signed_on: '', total_amount_cents: '',
    final_delivery_on: '', allocation_amount_cents: '', notes: '', document_version_ids: [],
  })
  validationError.value = null
  contractVisible.value = true
}

function openContractEdit(contract: Contract): void {
  contractEditingId.value = contract.id
  Object.assign(contractForm, {
    contract_no: contract.contract_no,
    title: contract.title,
    customer_company_id: String(contract.customer_company_id),
    signed_on: contract.signed_on ?? '',
    total_amount_cents: centsToYuan(contract.total_amount_cents),
    final_delivery_on: contract.final_delivery_on ?? '',
    allocation_amount_cents: centsToYuan(allocationTotal(contract)),
    notes: contract.notes ?? '',
    document_version_ids: [...contract.document_version_ids],
  })
  validationError.value = null
  contractVisible.value = true
}

function saveContract(): void {
  const companyId = props.customerCompany?.id
    ?? props.operating.commercial.contracts[0]?.customer_company_id
    ?? null
  const companyName = props.customerCompany?.name
    ?? props.operating.commercial.contracts[0]?.customer_company_name
    ?? '当前项目客户'
  const total = money(contractForm.total_amount_cents)
  const allocation = money(contractForm.allocation_amount_cents)
  if (!contractForm.contract_no.trim() || !contractForm.title.trim() || !Number.isSafeInteger(companyId)
    || companyId === null || companyId <= 0 || total === null || allocation === null || allocation !== total) {
    validationError.value = '请完整填写合同，当前项目分摊必须等于合同总额'
    return
  }
  const createdAt = now()
  const existing = contracts.value.find((contract) => contract.id === contractEditingId.value)
  if (existing) {
    Object.assign(existing, {
      contract_no: contractForm.contract_no.trim(),
      title: contractForm.title.trim(),
      signed_on: nullable(contractForm.signed_on),
      total_amount_cents: total,
      final_delivery_on: nullable(contractForm.final_delivery_on),
      notes: nullable(contractForm.notes),
      document_version_ids: [...contractForm.document_version_ids],
      revision: existing.revision + 1,
      updated_at: createdAt,
    })
    const allocationRecord = existing.allocations.find((item) => item.project_code === props.projectCode)
    if (allocationRecord) allocationRecord.amount_cents = allocation
    contractVisible.value = false
    return
  }
  const id = Math.max(20, ...contracts.value.map((contract) => contract.id)) + 1
  contracts.value.unshift({
    id,
    contract_no: contractForm.contract_no.trim(),
    title: contractForm.title.trim(),
    customer_company_id: companyId,
    customer_company_name: companyName,
    status: 'draft',
    signed_on: nullable(contractForm.signed_on),
    total_amount_cents: total,
    final_delivery_on: nullable(contractForm.final_delivery_on),
    allocations: [{ id: id * 10, contract_id: id, project_code: props.projectCode, amount_cents: allocation }],
    notes: nullable(contractForm.notes),
    document_version_ids: [...contractForm.document_version_ids],
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
  })
  contractVisible.value = false
}

function openTransition(kind: 'quote' | 'contract', id: number): void {
  transitionKind.value = kind
  transitionId.value = id
  quoteTarget.value = null
  contractTarget.value = null
  transitionReason.value = ''
  validationError.value = null
  transitionVisible.value = true
}

function saveTransition(): void {
  const occurredAt = now()
  if (transitionKind.value === 'quote' && quoteTarget.value) {
    const quote = quotes.value.find((item) => item.id === transitionId.value)
    if (quote) {
      quote.status = quoteTarget.value
      quote.revision += 1
      quote.updated_at = occurredAt
    }
  } else if (transitionKind.value === 'contract' && contractTarget.value) {
    const contract = contracts.value.find((item) => item.id === transitionId.value)
    if (contract) {
      if (contractTarget.value === 'signed' && (!contract.signed_on || !contract.final_delivery_on)) {
        validationError.value = '转为已签署前必须补齐签订日期和最终交付日期'
        return
      }
      contract.status = contractTarget.value
      contract.revision += 1
      contract.updated_at = occurredAt
    }
  } else {
    validationError.value = '请选择目标状态'
    return
  }
  transitionVisible.value = false
}

function openTerm(term: PaymentTerm): void {
  selectedMilestone.value = term.milestone
  termForm.due_on = term.due_on ?? ''
  termForm.planned_amount_cents = centsToYuan(term.planned_amount_cents)
  termForm.notes = term.notes ?? ''
  validationError.value = null
  termVisible.value = true
}

function saveTerm(): void {
  const term = receivables.terms.find((item) => item.milestone === selectedMilestone.value)
  const planned = money(termForm.planned_amount_cents)
  if (!term || planned === null) {
    validationError.value = '计划金额必须是正确的元金额'
    return
  }
  term.due_on = nullable(termForm.due_on)
  term.planned_amount_cents = planned
  term.outstanding_amount_cents = Math.max(planned - term.received_amount_cents, 0)
  term.notes = nullable(termForm.notes)
  term.status = planned === 0 ? 'unplanned' : term.received_amount_cents >= planned ? 'paid'
    : term.received_amount_cents > 0 ? 'partial' : 'scheduled'
  term.term_fulfillment_basis_points = planned === 0 ? null
    : Math.round(term.received_amount_cents * 10000 / planned)
  term.revision = (term.revision ?? 0) + 1
  receivables.receivable_amount_cents = receivables.terms.reduce((sum, item) => sum + item.planned_amount_cents, 0)
  receivables.outstanding_receivable_cents = Math.max(receivables.receivable_amount_cents - receivables.received_amount_cents, 0)
  receivables.contract_collection_basis_points = receivables.contracted_amount_cents === 0 ? null
    : Math.round(receivables.allocated_received_amount_cents * 10000 / receivables.contracted_amount_cents)
  termVisible.value = false
}

function openReceipt(): void {
  receiptEditingId.value = null
  Object.assign(receiptForm, { milestone: 'advance', received_on: localISODate(), amount_cents: '', payment_method: 'bank_transfer', reference_no: '', notes: '' })
  validationError.value = null
  receiptVisible.value = true
}

function openReceiptEdit(receipt: Receipt): void {
  receiptEditingId.value = receipt.id
  Object.assign(receiptForm, {
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

function saveReceipt(): void {
  const amount = money(receiptForm.amount_cents)
  if (!receiptForm.received_on || amount === null || amount === 0) {
    validationError.value = '请填写到账日期和大于零的元金额'
    return
  }
  const existing = receivables.receipts.find((receipt) => receipt.id === receiptEditingId.value)
  if (existing) {
    existing.received_on = receiptForm.received_on
    existing.payment_method = receiptForm.payment_method
    existing.reference_no = nullable(receiptForm.reference_no)
    existing.notes = nullable(receiptForm.notes)
    existing.revision += 1
    existing.updated_at = now()
    receiptVisible.value = false
    return
  }
  const createdAt = now()
  const allocationId = contracts.value.flatMap((contract) => contract.allocations)
    .find((allocation) => allocation.project_code === props.projectCode)?.id ?? null
  const receipt: Receipt = {
    id: Math.max(0, ...receivables.receipts.map((item) => item.id)) + 1,
    project_code: props.projectCode,
    contract_allocation_id: allocationId,
    milestone: receiptForm.milestone,
    received_on: receiptForm.received_on,
    amount_cents: amount,
    payment_method: receiptForm.payment_method,
    reference_no: nullable(receiptForm.reference_no),
    notes: nullable(receiptForm.notes),
    status: 'active',
    voided_on: null,
    void_reason: null,
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
  }
  receivables.receipts.unshift(receipt)
  receivables.received_amount_cents += amount
  receivables.allocated_received_amount_cents += allocationId === null ? 0 : amount
  receivables.unallocated_received_amount_cents += allocationId === null ? amount : 0
  receivables.outstanding_receivable_cents = Math.max(receivables.receivable_amount_cents - receivables.received_amount_cents, 0)
  receivables.contract_collection_basis_points = receivables.contracted_amount_cents === 0 ? null
    : Math.round(receivables.allocated_received_amount_cents * 10000 / receivables.contracted_amount_cents)
  const term = receivables.terms.find((item) => item.milestone === receipt.milestone)
  if (term) {
    term.received_amount_cents += amount
    term.outstanding_amount_cents = Math.max(term.planned_amount_cents - term.received_amount_cents, 0)
    term.status = term.received_amount_cents >= term.planned_amount_cents ? 'paid' : 'partial'
    term.term_fulfillment_basis_points = term.planned_amount_cents === 0 ? null
      : Math.round(term.received_amount_cents * 10000 / term.planned_amount_cents)
  }
  receiptVisible.value = false
}

function openVoid(receiptId: number): void {
  selectedReceiptId.value = receiptId
  voidForm.voided_on = localISODate()
  voidForm.reason = ''
  validationError.value = null
  voidVisible.value = true
}

function saveVoid(): void {
  const receipt = receivables.receipts.find((item) => item.id === selectedReceiptId.value)
  if (!receipt || !voidForm.voided_on || !voidForm.reason.trim()) {
    validationError.value = '请填写作废日期和原因'
    return
  }
  receipt.status = 'voided'
  receipt.voided_on = voidForm.voided_on
  receipt.void_reason = voidForm.reason.trim()
  receipt.revision += 1
  receipt.updated_at = now()
  receivables.received_amount_cents = Math.max(receivables.received_amount_cents - receipt.amount_cents, 0)
  if (receipt.contract_allocation_id === null) {
    receivables.unallocated_received_amount_cents = Math.max(receivables.unallocated_received_amount_cents - receipt.amount_cents, 0)
  } else {
    receivables.allocated_received_amount_cents = Math.max(receivables.allocated_received_amount_cents - receipt.amount_cents, 0)
  }
  receivables.outstanding_receivable_cents = Math.max(receivables.receivable_amount_cents - receivables.received_amount_cents, 0)
  receivables.contract_collection_basis_points = receivables.contracted_amount_cents === 0 ? null
    : Math.round(receivables.allocated_received_amount_cents * 10000 / receivables.contracted_amount_cents)
  const term = receivables.terms.find((item) => item.milestone === receipt.milestone)
  if (term) {
    term.received_amount_cents = Math.max(term.received_amount_cents - receipt.amount_cents, 0)
    term.outstanding_amount_cents = Math.max(term.planned_amount_cents - term.received_amount_cents, 0)
    term.status = term.planned_amount_cents === 0 ? 'unplanned'
      : term.received_amount_cents >= term.planned_amount_cents ? 'paid'
        : term.received_amount_cents > 0 ? 'partial' : 'scheduled'
    term.term_fulfillment_basis_points = term.planned_amount_cents === 0 ? null
      : Math.round(term.received_amount_cents * 10000 / term.planned_amount_cents)
  }
  voidVisible.value = false
}
</script>

<template>
  <el-space data-testid="project-demo-commercial" class="project-panel-stack commercial-stack" direction="vertical" alignment="stretch" fill :size="16">
    <el-row justify="space-between" align="middle">
      <div><el-text tag="strong" size="large">报价与收款</el-text><p class="section-note">报价不是项目收入，发票不是收款。</p></div>
      <el-tag type="warning" effect="plain">演示数据</el-tag>
    </el-row>
    <el-space wrap>
      <el-button :type="activeView === 'overview' ? 'primary' : 'default'" @click="activeView = 'overview'">经营摘要</el-button>
      <el-button data-testid="commercial-nav-quotes" :type="activeView === 'quotes' ? 'primary' : 'default'" @click="activeView = 'quotes'">报价版本</el-button>
      <el-button data-testid="commercial-nav-contracts" :type="activeView === 'contracts' ? 'primary' : 'default'" @click="activeView = 'contracts'">项目合同</el-button>
      <el-button data-testid="commercial-nav-receivables" :type="activeView === 'receivables' ? 'primary' : 'default'" @click="activeView = 'receivables'">三段收款</el-button>
    </el-space>

    <template v-if="activeView === 'overview'">
      <el-row :gutter="20">
        <el-col :xs="24" :xl="9"><el-card class="data-card" shadow="never"><template #header><el-text tag="strong">已接受报价</el-text></template><el-empty v-if="!operating.commercial.accepted_quote" description="暂无已接受报价" /><el-descriptions v-else :column="1" border><el-descriptions-item label="报价版本">V{{ operating.commercial.accepted_quote.version_number }}</el-descriptions-item><el-descriptions-item label="报价金额">{{ formatMoney(operating.commercial.accepted_quote.amount_cents) }}</el-descriptions-item><el-descriptions-item label="报价日期">{{ operating.commercial.accepted_quote.quote_date }}</el-descriptions-item><el-descriptions-item label="状态">{{ quoteStatusLabel(operating.commercial.accepted_quote.status) }}</el-descriptions-item></el-descriptions></el-card></el-col>
        <el-col :xs="24" :xl="15"><el-card class="data-card" shadow="never"><template #header><el-text tag="strong">项目合同</el-text></template><el-table :data="contracts" row-key="id"><el-table-column prop="contract_no" label="合同编号" /><el-table-column prop="title" label="合同名称" /><el-table-column label="项目分摊"><template #default="scope">{{ formatMoney(allocationTotal(scope.row)) }}</template></el-table-column><el-table-column label="状态"><template #default="scope">{{ contractStatusLabel(scope.row.status) }}</template></el-table-column></el-table></el-card></el-col>
      </el-row>
      <el-card data-testid="project-demo-receivables" class="data-card" shadow="never"><template #header><el-text tag="strong">三段收款</el-text></template><el-table :data="receivables.terms" row-key="milestone"><el-table-column label="节点"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="计划金额"><template #default="scope">{{ formatMoney(scope.row.planned_amount_cents) }}</template></el-table-column><el-table-column label="已到账"><template #default="scope">{{ formatMoney(scope.row.received_amount_cents) }}</template></el-table-column><el-table-column label="未收"><template #default="scope">{{ formatMoney(scope.row.outstanding_amount_cents) }}</template></el-table-column></el-table></el-card>
    </template>

    <el-card v-else-if="activeView === 'quotes'" data-testid="commercial-quotes" class="data-card" shadow="never">
      <template #header><el-row justify="space-between"><div><el-text tag="strong">报价版本</el-text><p class="section-note">点击彩色状态即可切换，报价不作为项目收入。</p></div><el-button data-testid="quote-create-open" type="primary" @click="openQuote">新建报价</el-button></el-row></template>
      <el-table :data="quotes" row-key="id"><el-table-column label="版本" width="80"><template #default="scope">V{{ scope.row.version_number }}</template></el-table-column><el-table-column label="状态" width="110"><template #default="scope"><el-tag :data-testid="`quote-status-${scope.row.id}`" :type="quoteStatusType(scope.row.status)" class="clickable-status" role="button" tabindex="0" @click="openTransition('quote', scope.row.id)" @keydown.enter="openTransition('quote', scope.row.id)" @keydown.space.prevent="openTransition('quote', scope.row.id)">{{ quoteStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column prop="quote_date" label="报价日期" min-width="120" /><el-table-column label="金额" min-width="150"><template #default="scope">{{ formatMoney(scope.row.amount_cents) }}</template></el-table-column><el-table-column label="编辑" width="80"><template #default="scope"><el-button :data-testid="`quote-edit-open-${scope.row.id}`" link @click="openQuoteEdit(scope.row)">编辑</el-button></template></el-table-column></el-table>
    </el-card>

    <el-card v-else-if="activeView === 'contracts'" data-testid="commercial-contracts" class="data-card" shadow="never">
      <template #header><el-row justify="space-between"><div><el-text tag="strong">项目合同</el-text><p class="section-note">点击彩色状态即可切换，收入只取当前项目分摊额。</p></div><el-button data-testid="contract-create-open" type="primary" @click="openContract">新建合同</el-button></el-row></template>
      <el-table :data="contracts" row-key="id"><el-table-column prop="contract_no" label="合同编号" min-width="150" /><el-table-column label="状态" width="110"><template #default="scope"><el-tag :data-testid="`contract-status-${scope.row.id}`" :type="contractStatusType(scope.row.status)" class="clickable-status" role="button" tabindex="0" @click="openTransition('contract', scope.row.id)" @keydown.enter="openTransition('contract', scope.row.id)" @keydown.space.prevent="openTransition('contract', scope.row.id)">{{ contractStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column prop="title" label="合同名称" min-width="200" /><el-table-column label="总额" min-width="140"><template #default="scope">{{ formatMoney(scope.row.total_amount_cents) }}</template></el-table-column><el-table-column label="项目分摊" min-width="140"><template #default="scope">{{ formatMoney(allocationTotal(scope.row)) }}</template></el-table-column><el-table-column label="编辑" width="80"><template #default="scope"><el-button :data-testid="`contract-edit-open-${scope.row.id}`" link @click="openContractEdit(scope.row)">编辑</el-button></template></el-table-column></el-table>
    </el-card>

    <el-space v-else data-testid="commercial-receivables" class="commercial-receivables" direction="vertical" alignment="stretch" fill :size="16">
      <el-row :gutter="12"><el-col :xs="24" :sm="8"><el-card shadow="never"><div class="metric-value"><span>应收</span><strong>{{ formatMoney(receivables.receivable_amount_cents) }}</strong></div></el-card></el-col><el-col :xs="24" :sm="8"><el-card shadow="never"><div data-testid="receivable-total-received" class="metric-value"><span>实际到账</span><strong>{{ formatMoney(receivables.received_amount_cents) }}</strong></div></el-card></el-col><el-col :xs="24" :sm="8"><el-card shadow="never"><div class="metric-value"><span>未收</span><strong>{{ formatMoney(receivables.outstanding_receivable_cents) }}</strong></div></el-card></el-col></el-row>
      <el-card class="data-card receivable-terms-card" shadow="never"><template #header><el-row justify="space-between"><div><el-text tag="strong">三个固定收款节点</el-text><p class="section-note">合同回款 {{ formatBasisPoints(receivables.contract_collection_basis_points) }}</p></div><el-button data-testid="receipt-create-open" type="primary" @click="openReceipt">登记到账</el-button></el-row></template><el-table :data="receivables.terms" row-key="milestone"><el-table-column label="节点"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="状态"><template #default="scope"><el-tag :type="receivableStatusType(scope.row.status)">{{ receivableStatusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column label="计划"><template #default="scope">{{ formatMoney(scope.row.planned_amount_cents) }}</template></el-table-column><el-table-column label="到账"><template #default="scope">{{ formatMoney(scope.row.received_amount_cents) }}</template></el-table-column><el-table-column label="履约比例"><template #default="scope">{{ formatBasisPoints(scope.row.term_fulfillment_basis_points) }}</template></el-table-column><el-table-column label="操作"><template #default="scope"><el-button link @click="openTerm(scope.row)">编辑计划</el-button></template></el-table-column></el-table><div class="receivable-mobile-list"><el-card v-for="term in receivables.terms" :key="term.milestone" shadow="never"><div class="receivable-mobile-heading"><strong>{{ milestoneLabel(term.milestone) }}</strong><el-tag size="small" :type="receivableStatusType(term.status)">{{ receivableStatusLabel(term.status) }}</el-tag></div><el-descriptions :column="2" size="small" border><el-descriptions-item label="计划">{{ formatMoney(term.planned_amount_cents) }}</el-descriptions-item><el-descriptions-item label="到账">{{ formatMoney(term.received_amount_cents) }}</el-descriptions-item></el-descriptions><el-button plain size="small" @click="openTerm(term)">编辑计划</el-button></el-card></div></el-card>
      <el-card data-testid="receipt-ledger" class="data-card" shadow="never"><template #header><div><el-text tag="strong">到账流水</el-text><p class="section-note">发票不是收款；金额纠错使用作废后重录。</p></div></template><el-empty v-if="receivables.receipts.length === 0" description="暂无到账流水" /><el-table v-else :data="receivables.receipts" row-key="id"><el-table-column prop="received_on" label="到账日期" min-width="110" /><el-table-column label="节点" width="90"><template #default="scope">{{ milestoneLabel(scope.row.milestone) }}</template></el-table-column><el-table-column label="金额" min-width="130"><template #default="scope">{{ formatMoney(scope.row.amount_cents) }}</template></el-table-column><el-table-column prop="reference_no" label="参考号" min-width="150" /><el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'">{{ scope.row.status === 'active' ? '有效' : '已作废' }}</el-tag></template></el-table-column><el-table-column label="操作" width="150"><template #default="scope"><el-button v-if="scope.row.status === 'active'" :data-testid="`receipt-edit-open-${scope.row.id}`" link @click="openReceiptEdit(scope.row)">编辑说明</el-button><el-button v-if="scope.row.status === 'active'" :data-testid="`receipt-void-${scope.row.id}`" link type="danger" @click="openVoid(scope.row.id)">作废</el-button></template></el-table-column></el-table></el-card>
    </el-space>

    <el-dialog v-model="quoteVisible" :title="`${quoteEditingId ? '编辑' : '新建'}报价 · 演示`" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveQuote"><el-form-item label="报价日期" required><el-date-picker data-testid="quote-date" v-model="quoteForm.quote_date" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="报价金额（元）" required><el-input data-testid="quote-amount" v-model="quoteForm.amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="有效期至"><el-date-picker v-model="quoteForm.valid_until" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item label="关联附件"><el-select v-model="quoteForm.document_version_ids" multiple style="width:100%"><el-option v-for="item in demoDocumentOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model="quoteForm.notes" type="textarea" /></el-form-item><el-button data-testid="quote-create-save" type="primary" native-type="submit">{{ quoteEditingId ? '保存演示修改' : '加入演示报价' }}</el-button></el-form></el-dialog>

    <el-dialog v-model="contractVisible" :title="`${contractEditingId ? '编辑' : '新建'}合同 · 演示`" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveContract"><el-form-item label="合同编号" required><el-input data-testid="contract-no" v-model="contractForm.contract_no" /></el-form-item><el-form-item label="合同名称" required><el-input data-testid="contract-title" v-model="contractForm.title" /></el-form-item><el-form-item label="客户公司" required><el-input data-testid="contract-company" :model-value="customerCompany?.name ?? operating.commercial.contracts[0]?.customer_company_name ?? '当前项目客户'" disabled /></el-form-item><el-form-item label="合同总额（元）" required><el-input data-testid="contract-total" v-model="contractForm.total_amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="当前项目分摊（元）" required><el-input data-testid="contract-allocation" v-model="contractForm.allocation_amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="签订日期"><el-date-picker v-model="contractForm.signed_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item label="最终交付日期"><el-date-picker v-model="contractForm.final_delivery_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item label="关联附件"><el-select v-model="contractForm.document_version_ids" multiple style="width:100%"><el-option v-for="item in demoDocumentOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model="contractForm.notes" type="textarea" /></el-form-item><el-button data-testid="contract-create-save" type="primary" native-type="submit">{{ contractEditingId ? '保存演示修改' : '加入演示合同' }}</el-button></el-form></el-dialog>

    <el-dialog v-model="transitionVisible" title="切换状态 · 演示" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-space v-if="transitionKind === 'quote'" wrap><el-button v-for="status in quoteStatuses" :key="status" :type="quoteTarget === status ? 'primary' : 'default'" @click="quoteTarget = status">{{ quoteStatusLabel(status) }}</el-button></el-space><el-space v-else wrap><el-button v-for="status in contractStatuses" :key="status" :type="contractTarget === status ? 'primary' : 'default'" @click="contractTarget = status">{{ contractStatusLabel(status) }}</el-button></el-space><el-input v-model="transitionReason" type="textarea" placeholder="原因（如需）" /><el-button type="primary" @click="saveTransition">确认切换</el-button></el-dialog>

    <el-dialog v-model="termVisible" title="编辑收款计划 · 演示" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveTerm"><el-form-item label="计划日期"><el-date-picker v-model="termForm.due_on" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item label="计划金额（元）"><el-input v-model="termForm.planned_amount_cents" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="备注"><el-input v-model="termForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit">保存演示计划</el-button></el-form></el-dialog>

    <el-dialog v-model="receiptVisible" :title="`${receiptEditingId ? '编辑到账说明' : '登记到账'} · 演示`" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveReceipt"><el-form-item label="节点"><el-select v-model="receiptForm.milestone" :disabled="receiptEditingId !== null"><el-option value="advance" label="预付款" /><el-option value="progress" label="进度款" /><el-option value="final" label="尾款" /></el-select></el-form-item><el-form-item label="到账日期" required><el-date-picker data-testid="receipt-date" v-model="receiptForm.received_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="到账金额（元）" required><el-input data-testid="receipt-amount" v-model="receiptForm.amount_cents" :disabled="receiptEditingId !== null" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="收款方式"><el-select v-model="receiptForm.payment_method"><el-option value="bank_transfer" label="银行转账" /><el-option value="cash" label="现金" /><el-option value="other" label="其他" /></el-select></el-form-item><el-form-item label="参考号"><el-input data-testid="receipt-reference" v-model="receiptForm.reference_no" /></el-form-item><el-form-item label="备注"><el-input v-model="receiptForm.notes" type="textarea" /></el-form-item><el-button data-testid="receipt-create-save" type="primary" native-type="submit">{{ receiptEditingId ? '保存说明' : '加入演示流水' }}</el-button></el-form></el-dialog>

    <el-dialog v-model="voidVisible" title="作废到账 · 演示" :teleported="false"><el-alert v-if="validationError" :title="validationError" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="saveVoid"><el-form-item label="作废日期" required><el-date-picker data-testid="receipt-void-date" v-model="voidForm.voided_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="原因" required><el-input data-testid="receipt-void-reason" v-model="voidForm.reason" type="textarea" /></el-form-item><el-button data-testid="receipt-void-save" type="danger" native-type="submit">确认演示作废</el-button></el-form></el-dialog>
  </el-space>
</template>

<style scoped>
.clickable-status { cursor: pointer; user-select: none; }
.commercial-stack,
.commercial-stack > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
.commercial-receivables,
.commercial-receivables > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
.commercial-stack :deep(.data-card > .el-card__body) { min-width: 0; overflow-x: auto; }
.commercial-stack :deep(.data-card .el-table) { min-width: 620px; }
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
