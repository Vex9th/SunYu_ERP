<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import type {
  AcceptanceStatus,
  AcceptanceType,
  AfterSalesCoverageType,
  AfterSalesStatus,
  CommissioningStatus,
  DemoAcceptanceViewModel,
  DemoAfterSalesCaseViewModel,
  DemoCommissioningSessionViewModel,
  DemoWarrantyViewModel,
  DeliveryDemoViewModel,
  DrawingDiscipline,
  DrawingSignoffStatus,
  EngineeringChangeSource,
  EngineeringChangeStatus,
  InvoiceStatus,
  InvoiceType,
  WarrantyStatus,
} from '../../domain/workforce'
import { localISODate, localISODateTimeInput } from '../../domain/dates'
import { formatMoney, yuanToCents } from '../../domain/formatters'
import { useDemoBusinessContext } from '../../repositories/demo-context'

const props = defineProps<{
  projectCode: string
  scope?: 'all' | 'commissioning' | 'delivery'
}>()

type DeliveryTab = 'commissioning' | 'changes' | 'acceptance' | 'after-sales'

const repository = useDemoBusinessContext().workforce
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
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const actionSuccess = ref('')
const formBusy = ref(false)
const signoffVisible = ref(false)
const commissioningVisible = ref(false)
const changeVisible = ref(false)
const acceptanceVisible = ref(false)
const invoiceVisible = ref(false)
const afterSalesVisible = ref(false)
const acceptanceCompleteVisible = ref(false)
const warrantyVisible = ref(false)
const invoiceVoidVisible = ref(false)
const afterSalesStatusVisible = ref(false)
const selectedDiscipline = ref<DrawingDiscipline>('mechanical')
const selectedCommissioningId = ref<number | null>(null)
const selectedAcceptanceId = ref(0)
const selectedInvoiceId = ref(0)
const selectedAfterSalesId = ref(0)
let loadVersion = 0

const signoffForm = reactive({ status: 'confirmed' as DrawingSignoffStatus, confirmedOn: '', reason: '', notes: '' })
const commissioningForm = reactive({ startedAt: '', endedAt: '', status: 'planned' as CommissioningStatus, summary: '', issues: '', nextAction: '', notes: '' })
const changeForm = reactive({ source: 'customer_request' as EngineeringChangeSource, title: '', description: '', reason: '', contractDeltaYuan: '0.00', estimatedCostDeltaYuan: '0.00', scheduleDeltaDays: 0, proposedOn: '', notes: '' })
const acceptanceForm = reactive({ acceptanceType: 'pre_acceptance' as AcceptanceType, scheduledOn: '', notes: '' })
const invoiceForm = reactive({ invoiceType: 'contract_payment' as InvoiceType, status: 'planned' as InvoiceStatus, requestedOn: '', recordedOn: '', invoiceNumber: '', amountYuan: '', counterpartyName: '', notes: '' })
const afterSalesForm = reactive({ reportedOn: '', serviceOn: '', reason: '', contactName: '', contactPhone: '', coverageType: 'warranty' as AfterSalesCoverageType, notes: '' })
const acceptanceCompleteForm = reactive({ status: 'passed' as Extract<AcceptanceStatus, 'passed' | 'passed_with_punch' | 'failed'>, performedOn: '', notes: '' })
const warrantyForm = reactive({ startsOn: '', durationMonths: 12, renewalPriceYuan: '', notes: '' })
const invoiceVoidForm = reactive({ reason: '' })
const afterSalesStatusForm = reactive({ status: 'in_progress' as AfterSalesStatus, resolution: '' })

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
const coverageLabels: Record<AfterSalesCoverageType, string> = { warranty: '保内处理', paid: '付费服务', goodwill: '善意支持' }
const afterSalesStatusLabels: Record<AfterSalesStatus, string> = { open: '待处理', in_progress: '处理中', completed: '已完成', cancelled: '已取消' }

function optionalText(value: string): string | null {
  return value.trim() || null
}

async function refreshModel(): Promise<void> {
  model.value = (await repository.getDeliveryPreview(props.projectCode)).data
}

async function runAction(action: () => Promise<void>, close: () => void, message: string): Promise<void> {
  if (formBusy.value) return
  formBusy.value = true
  actionError.value = ''
  actionSuccess.value = ''
  try {
    await action()
    await refreshModel()
    close()
    actionSuccess.value = `${message}（演示数据）`
    ElMessage.success(actionSuccess.value)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    formBusy.value = false
  }
}

function openSignoff(discipline: DrawingDiscipline): void {
  const signoff = model.value?.drawing_signoffs.find((item) => item.discipline === discipline)
  if (!signoff) return
  selectedDiscipline.value = discipline
  Object.assign(signoffForm, { status: signoff.status, confirmedOn: signoff.confirmed_on ?? '', reason: signoff.not_required_reason ?? '', notes: signoff.notes ?? '' })
  signoffVisible.value = true
}

function saveSignoff(): Promise<void> {
  return runAction(() => repository.saveDrawingSignoff(props.projectCode, selectedDiscipline.value, {
    status: signoffForm.status, confirmed_on: optionalText(signoffForm.confirmedOn),
    not_required_reason: signoffForm.status === 'not_required' ? optionalText(signoffForm.reason) : null,
    notes: optionalText(signoffForm.notes), document_version_ids: [],
  }), () => { signoffVisible.value = false }, '图纸会签已更新')
}

function openCommissioningCreate(): void {
  selectedCommissioningId.value = null
  Object.assign(commissioningForm, { startedAt: localISODateTimeInput(), endedAt: '', status: 'in_progress', summary: '', issues: '', nextAction: '', notes: '' })
  commissioningVisible.value = true
}

function openChangeCreate(): void {
  Object.assign(changeForm, { source: 'customer_request', title: '', description: '', reason: '', contractDeltaYuan: '0.00', estimatedCostDeltaYuan: '0.00', scheduleDeltaDays: 0, proposedOn: localISODate(), notes: '' })
  changeVisible.value = true
}

function openAcceptanceCreate(): void {
  Object.assign(acceptanceForm, { acceptanceType: 'pre_acceptance', scheduledOn: localISODate(), notes: '' })
  acceptanceVisible.value = true
}

function openInvoiceCreate(): void {
  const today = localISODate()
  Object.assign(invoiceForm, { invoiceType: 'contract_payment', status: 'recorded', requestedOn: today, recordedOn: today, invoiceNumber: '', amountYuan: '', counterpartyName: '', notes: '' })
  invoiceVisible.value = true
}

function openAfterSalesCreate(): void {
  Object.assign(afterSalesForm, { reportedOn: localISODate(), serviceOn: '', reason: '', contactName: '', contactPhone: '', coverageType: 'warranty', notes: '' })
  afterSalesVisible.value = true
}

function openCommissioningEdit(session: DemoCommissioningSessionViewModel): void {
  selectedCommissioningId.value = session.session_id
  Object.assign(commissioningForm, {
    startedAt: session.started_at,
    endedAt: session.ended_at ?? '',
    status: session.status,
    summary: session.summary ?? '',
    issues: session.issues ?? '',
    nextAction: session.next_action ?? '',
    notes: session.notes ?? '',
  })
  commissioningVisible.value = true
}

function saveCommissioning(): Promise<void> {
  const input = {
    started_at: commissioningForm.startedAt, ended_at: optionalText(commissioningForm.endedAt), status: commissioningForm.status,
    summary: optionalText(commissioningForm.summary), issues: optionalText(commissioningForm.issues), next_action: optionalText(commissioningForm.nextAction), notes: optionalText(commissioningForm.notes), document_version_ids: [],
  }
  return runAction(() => selectedCommissioningId.value === null
    ? repository.saveCommissioningSession(props.projectCode, input)
    : repository.updateCommissioningSession(props.projectCode, selectedCommissioningId.value, input),
  () => { commissioningVisible.value = false }, selectedCommissioningId.value === null ? '调试记录已新增' : '调试记录已更新')
}

function saveChange(): Promise<void> {
  return runAction(() => repository.saveEngineeringChange(props.projectCode, {
    source: changeForm.source, title: changeForm.title.trim(), description: changeForm.description.trim(), reason: changeForm.reason.trim(),
    contract_delta_cents: yuanToCents(changeForm.contractDeltaYuan), estimated_cost_delta_cents: yuanToCents(changeForm.estimatedCostDeltaYuan),
    schedule_delta_days: changeForm.scheduleDeltaDays, proposed_on: changeForm.proposedOn, notes: optionalText(changeForm.notes), document_version_ids: [],
  }), () => { changeVisible.value = false }, '工程变更已新增')
}

function saveAcceptance(): Promise<void> {
  return runAction(() => repository.saveAcceptance(props.projectCode, {
    acceptance_type: acceptanceForm.acceptanceType, scheduled_on: acceptanceForm.scheduledOn, notes: optionalText(acceptanceForm.notes),
  }), () => { acceptanceVisible.value = false }, '验收计划已新增')
}

function saveInvoice(): Promise<void> {
  return runAction(() => repository.saveInvoice(props.projectCode, {
    invoice_type: invoiceForm.invoiceType, status: invoiceForm.status, requested_on: optionalText(invoiceForm.requestedOn), recorded_on: optionalText(invoiceForm.recordedOn),
    invoice_number: optionalText(invoiceForm.invoiceNumber), amount_cents: yuanToCents(invoiceForm.amountYuan), counterparty_name: invoiceForm.counterpartyName.trim(), notes: optionalText(invoiceForm.notes), document_version_ids: [],
  }), () => { invoiceVisible.value = false }, '发票记录已新增')
}

function saveAfterSales(): Promise<void> {
  return runAction(() => repository.saveAfterSalesCase(props.projectCode, {
    reported_on: afterSalesForm.reportedOn, service_on: optionalText(afterSalesForm.serviceOn), reason: afterSalesForm.reason.trim(),
    contact_name: afterSalesForm.contactName.trim(), contact_phone: afterSalesForm.contactPhone.trim(), coverage_type: afterSalesForm.coverageType, notes: optionalText(afterSalesForm.notes),
  }), () => { afterSalesVisible.value = false }, '售后案件已新增')
}

function changeEngineeringStatus(changeId: number, status: EngineeringChangeStatus): Promise<void> {
  return runAction(() => repository.setEngineeringChangeStatus(props.projectCode, changeId, status), () => {}, '工程变更状态已更新')
}

function openAcceptanceComplete(acceptance: DemoAcceptanceViewModel): void {
  selectedAcceptanceId.value = acceptance.acceptance_id
  Object.assign(acceptanceCompleteForm, {
    status: acceptance.status === 'passed' || acceptance.status === 'passed_with_punch' || acceptance.status === 'failed' ? acceptance.status : 'passed',
    performedOn: acceptance.performed_on ?? localISODate(),
    notes: acceptance.notes ?? '',
  })
  acceptanceCompleteVisible.value = true
}

function saveAcceptanceComplete(): Promise<void> {
  return runAction(() => repository.completeAcceptance(props.projectCode, selectedAcceptanceId.value, {
    status: acceptanceCompleteForm.status,
    performed_on: acceptanceCompleteForm.performedOn,
    notes: optionalText(acceptanceCompleteForm.notes),
  }), () => { acceptanceCompleteVisible.value = false }, '验收结果已保存')
}

function openWarrantyEdit(warranty: DemoWarrantyViewModel): void {
  Object.assign(warrantyForm, {
    startsOn: warranty.starts_on,
    durationMonths: warranty.duration_months,
    renewalPriceYuan: (warranty.renewal_price_cents / 100).toFixed(2),
    notes: warranty.notes ?? '',
  })
  warrantyVisible.value = true
}

function saveWarranty(): Promise<void> {
  return runAction(() => repository.updateWarranty(props.projectCode, {
    starts_on: warrantyForm.startsOn,
    duration_months: warrantyForm.durationMonths,
    renewal_price_cents: yuanToCents(warrantyForm.renewalPriceYuan),
    notes: optionalText(warrantyForm.notes),
  }), () => { warrantyVisible.value = false }, '质保信息已更新')
}

function openInvoiceVoid(invoiceId: number): void {
  selectedInvoiceId.value = invoiceId
  invoiceVoidForm.reason = ''
  invoiceVoidVisible.value = true
}

function saveInvoiceVoid(): Promise<void> {
  return runAction(() => repository.voidInvoice(props.projectCode, selectedInvoiceId.value, invoiceVoidForm.reason), () => { invoiceVoidVisible.value = false }, '发票记录已作废')
}

function openAfterSalesStatus(item: DemoAfterSalesCaseViewModel): void {
  selectedAfterSalesId.value = item.case_id
  Object.assign(afterSalesStatusForm, { status: item.status, resolution: item.resolution ?? '' })
  afterSalesStatusVisible.value = true
}

function saveAfterSalesStatus(): Promise<void> {
  return runAction(() => repository.setAfterSalesStatus(
    props.projectCode,
    selectedAfterSalesId.value,
    afterSalesStatusForm.status,
    optionalText(afterSalesStatusForm.resolution),
  ), () => { afterSalesStatusVisible.value = false }, '售后状态已更新')
}

watch(
  () => props.projectCode,
  async (projectCode) => {
    const version = ++loadVersion
    loading.value = true
    loadError.value = ''
    activeTab.value = defaultSection()
    model.value = null
    try {
      const result = await repository.getDeliveryPreview(projectCode)
      if (version === loadVersion) model.value = result.data
    } catch (error) {
      if (version === loadVersion) {
        loadError.value = error instanceof Error ? error.message : '交付演示数据加载失败'
      }
    } finally {
      if (version === loadVersion) loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <section data-testid="delivery-workspace" class="delivery-workspace">
    <header class="module-heading">
      <div>
        <h2>{{ moduleTitle }}</h2>
        <p>{{ moduleDescription }}</p>
      </div>
      <el-tag type="warning" effect="plain">演示数据</el-tag>
    </header>

    <el-alert
      v-if="loadError"
      data-testid="delivery-load-error"
      :title="loadError"
      type="error"
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
              <el-button :data-testid="`signoff-edit-${signoff.discipline}`" plain @click="openSignoff(signoff.discipline)">更新会签</el-button>
            </el-card>
          </div>

          <el-card shadow="never">
            <template #header><div class="card-heading"><div><strong>调试记录</strong><small>问题和下一步允许留空</small></div><el-button data-testid="commissioning-create-open" type="primary" plain @click="openCommissioningCreate">新增调试</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.commissioning_sessions" row-key="session_id">
                <el-table-column label="状态" min-width="100"><template #default="scope"><el-tag type="danger">{{ commissioningLabels[scope.row.status as CommissioningStatus] }}</el-tag></template></el-table-column>
                <el-table-column prop="started_at" label="开始时间" min-width="190" />
                <el-table-column prop="summary" label="本次结果" min-width="180"><template #default="scope">{{ scope.row.summary ?? '未填写' }}</template></el-table-column>
                <el-table-column prop="issues" label="问题" min-width="190"><template #default="scope">{{ scope.row.issues ?? '无' }}</template></el-table-column>
                <el-table-column prop="next_action" label="下一步" min-width="190"><template #default="scope">{{ scope.row.next_action ?? '未填写' }}</template></el-table-column>
                <el-table-column label="操作" min-width="80" fixed="right"><template #default="scope"><el-button :data-testid="`commissioning-edit-${scope.row.session_id}`" link type="primary" @click="openCommissioningEdit(scope.row)">编辑</el-button></template></el-table-column>
              </el-table>
            </div>
          </el-card>
        </div>
      </section>

      <section v-show="scope !== 'delivery' && activeTab === 'changes'" class="delivery-section">
        <div data-testid="delivery-changes-panel" class="panel-stack">
          <div class="panel-actions"><el-alert title="预测成本变化不计入实际成本" type="info" show-icon :closable="false" /><el-button data-testid="change-create-open" type="primary" @click="openChangeCreate">新增变更</el-button></div>
          <el-card v-for="change in model.engineering_changes" :key="change.change_id" shadow="never">
            <template #header>
              <div class="card-heading"><strong>{{ change.title }}</strong><el-tag type="success">{{ changeStatusLabels[change.status] }}</el-tag></div>
            </template>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="来源">{{ changeSourceLabels[change.source] }}</el-descriptions-item>
              <el-descriptions-item label="提出日期">{{ change.proposed_on }}</el-descriptions-item>
              <el-descriptions-item label="合同变化">{{ formatMoney(change.contract_delta_cents) }}</el-descriptions-item>
              <el-descriptions-item label="预测成本变化"><strong>{{ formatMoney(change.estimated_cost_delta_cents) }}</strong></el-descriptions-item>
              <el-descriptions-item label="工期变化">{{ change.schedule_delta_days }} 天</el-descriptions-item>
              <el-descriptions-item label="原因">{{ change.reason }}</el-descriptions-item>
              <el-descriptions-item label="说明" :span="2">{{ change.description }}</el-descriptions-item>
            </el-descriptions>
            <div class="record-actions"><span>流转状态</span><el-select :model-value="change.status" :data-testid="`change-status-${change.change_id}`" size="small" @change="changeEngineeringStatus(change.change_id, $event as EngineeringChangeStatus)"><el-option v-for="(label, value) in changeStatusLabels" :key="value" :value="value" :label="label" /></el-select></div>
          </el-card>
        </div>
      </section>

      <section v-show="scope !== 'commissioning' && activeTab === 'acceptance'" class="delivery-section">
        <div data-testid="delivery-acceptance-panel" class="panel-stack">
          <el-alert title="质保状态由后端日期规则返回" description="页面只读展示状态、截止日和剩余天数，不自行推导。" type="info" show-icon :closable="false" />
          <el-card shadow="never">
            <template #header><div class="card-heading"><strong>验收记录</strong><el-button data-testid="acceptance-create-open" type="primary" @click="openAcceptanceCreate">新增验收</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.acceptances" row-key="acceptance_id">
                <el-table-column label="类型" min-width="110"><template #default="scope">{{ acceptanceTypeLabels[scope.row.acceptance_type as AcceptanceType] }}</template></el-table-column>
                <el-table-column label="状态" min-width="130"><template #default="scope">{{ acceptanceStatusLabels[scope.row.status as AcceptanceStatus] }}</template></el-table-column>
                <el-table-column prop="scheduled_on" label="计划日期" min-width="120" />
                <el-table-column prop="performed_on" label="实际日期" min-width="120"><template #default="scope">{{ scope.row.performed_on ?? '未执行' }}</template></el-table-column>
                <el-table-column prop="notes" label="说明" min-width="180"><template #default="scope">{{ scope.row.notes ?? '无' }}</template></el-table-column>
                <el-table-column label="操作" min-width="110" fixed="right"><template #default="scope"><el-button :data-testid="`acceptance-complete-${scope.row.acceptance_id}`" link type="primary" @click="openAcceptanceComplete(scope.row)">完成验收</el-button></template></el-table-column>
              </el-table>
            </div>
          </el-card>
          <el-card v-if="model.warranty" shadow="never">
            <template #header><div class="card-heading"><strong>质保期限</strong><div class="compact-actions"><el-tag type="success">{{ warrantyStatusLabels[model.warranty.status] }}</el-tag><el-button data-testid="warranty-edit-open" plain size="small" @click="openWarrantyEdit(model.warranty)">编辑质保</el-button></div></div></template>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="开始">{{ model.warranty.starts_on }}</el-descriptions-item>
              <el-descriptions-item label="截止">{{ model.warranty.ends_on }}</el-descriptions-item>
              <el-descriptions-item label="期限">{{ model.warranty.duration_months }} 个月</el-descriptions-item>
              <el-descriptions-item label="剩余天数">{{ model.warranty.days_remaining }} 天</el-descriptions-item>
              <el-descriptions-item label="续费价格">{{ formatMoney(model.warranty.renewal_price_cents) }}（不是收入）</el-descriptions-item>
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
            <template #header><div class="card-heading"><strong>发票记录</strong><el-button data-testid="invoice-create-open" type="primary" plain @click="openInvoiceCreate">登记发票</el-button></div></template>
            <div class="table-scroll">
              <el-table :data="model.invoices" row-key="invoice_id">
                <el-table-column label="类型" min-width="110"><template #default="scope">{{ invoiceTypeLabels[scope.row.invoice_type as InvoiceType] }}</template></el-table-column>
                <el-table-column label="状态" min-width="100"><template #default="scope">{{ invoiceStatusLabels[scope.row.status as InvoiceStatus] }}</template></el-table-column>
                <el-table-column prop="invoice_number" label="发票号码" min-width="150"><template #default="scope">{{ scope.row.invoice_number ?? '未登记' }}</template></el-table-column>
                <el-table-column label="金额" min-width="130"><template #default="scope"><strong>{{ formatMoney(scope.row.amount_cents) }}</strong></template></el-table-column>
                <el-table-column prop="counterparty_name" label="对方单位" min-width="160" />
                <el-table-column prop="recorded_on" label="登记日期" min-width="120"><template #default="scope">{{ scope.row.recorded_on ?? '未登记' }}</template></el-table-column>
                <el-table-column label="操作" min-width="80" fixed="right"><template #default="scope"><el-button :data-testid="`invoice-void-${scope.row.invoice_id}`" link type="danger" :disabled="scope.row.status === 'void'" @click="openInvoiceVoid(scope.row.invoice_id)">作废</el-button></template></el-table-column>
              </el-table>
            </div>
          </el-card>

          <el-card shadow="never">
            <template #header><div class="card-heading"><strong>售后案件</strong><el-button data-testid="after-sales-create-open" type="primary" @click="openAfterSalesCreate">新增售后</el-button></div></template>
            <div class="case-grid">
              <article v-for="item in model.after_sales" :key="item.case_id" class="case-card">
                <div class="card-heading"><strong>{{ item.reason }}</strong><el-tag type="warning">{{ afterSalesStatusLabels[item.status] }}</el-tag></div>
                <p>{{ coverageLabels[item.coverage_type] }} · 报修 {{ item.reported_on }} · 服务 {{ item.service_on ?? '待安排' }}</p>
                <p>{{ item.contact_name }} · {{ item.contact_phone }}</p>
                <small>{{ item.resolution ?? item.notes ?? '尚无处理结论' }}</small>
                <el-button :data-testid="`after-sales-status-${item.case_id}`" plain size="small" @click="openAfterSalesStatus(item)">更新状态</el-button>
              </article>
            </div>
          </el-card>
        </div>
      </section>
    </div>

    <el-dialog v-model="acceptanceCompleteVisible" :teleported="false" title="完成验收（演示数据）" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveAcceptanceComplete"><el-form-item label="验收结果"><el-select v-model="acceptanceCompleteForm.status" style="width:100%"><el-option label="通过" value="passed" /><el-option label="带整改项通过" value="passed_with_punch" /><el-option label="未通过" value="failed" /></el-select></el-form-item><el-form-item label="实际验收日期" required><el-date-picker v-model="acceptanceCompleteForm.performedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="结果说明"><el-input v-model="acceptanceCompleteForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存验收结果</el-button></el-form></el-dialog>

    <el-dialog v-model="warrantyVisible" :teleported="false" title="编辑质保（演示数据）" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveWarranty"><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="质保开始日" required><el-date-picker v-model="warrantyForm.startsOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="质保月数" required><el-input-number v-model="warrantyForm.durationMonths" :min="1" :max="120" /></el-form-item></el-col></el-row><el-form-item label="续费价格（元）"><el-input v-model="warrantyForm.renewalPriceYuan" inputmode="decimal" /></el-form-item><el-form-item label="备注"><el-input v-model="warrantyForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存质保</el-button></el-form></el-dialog>

    <el-dialog v-model="invoiceVoidVisible" :teleported="false" title="作废发票记录（演示数据）" width="min(94vw, 480px)"><el-form label-position="top" @submit.prevent="saveInvoiceVoid"><el-form-item label="作废原因" required><el-input v-model="invoiceVoidForm.reason" type="textarea" /></el-form-item><el-button type="danger" native-type="submit" :loading="formBusy">确认作废</el-button></el-form></el-dialog>

    <el-dialog v-model="afterSalesStatusVisible" :teleported="false" title="更新售后状态（演示数据）" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveAfterSalesStatus"><el-form-item label="处理状态"><el-select v-model="afterSalesStatusForm.status" style="width:100%"><el-option v-for="(label, value) in afterSalesStatusLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item :label="afterSalesStatusForm.status === 'completed' ? '处理结果（必填）' : '处理进展'"><el-input v-model="afterSalesStatusForm.resolution" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存售后状态</el-button></el-form></el-dialog>

    <el-dialog v-model="signoffVisible" :teleported="false" title="更新图纸会签（演示数据）" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveSignoff"><el-form-item label="状态"><el-select v-model="signoffForm.status" style="width:100%"><el-option value="pending" label="待确认" /><el-option value="confirmed" label="已确认" /><el-option value="not_required" label="无需图纸" /></el-select></el-form-item><el-form-item label="确认日期"><el-date-picker v-model="signoffForm.confirmedOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item><el-form-item v-if="signoffForm.status === 'not_required'" label="无需图纸原因"><el-input v-model="signoffForm.reason" /></el-form-item><el-form-item label="备注"><el-input v-model="signoffForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存会签</el-button></el-form></el-dialog>

    <el-dialog v-model="commissioningVisible" :teleported="false" :title="selectedCommissioningId === null ? '新增调试记录（演示数据）' : '编辑调试记录（演示数据）'" width="min(94vw, 680px)"><el-form label-position="top" @submit.prevent="saveCommissioning"><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="commissioning-started-at" label="开始时间" required><el-date-picker v-model="commissioningForm.startedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="结束时间"><el-date-picker v-model="commissioningForm.endedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" clearable style="width:100%" /></el-form-item></el-col></el-row><el-form-item label="状态"><el-select v-model="commissioningForm.status" style="width:100%"><el-option v-for="(label, value) in commissioningLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item label="本次结果"><el-input v-model="commissioningForm.summary" type="textarea" /></el-form-item><el-form-item label="问题"><el-input v-model="commissioningForm.issues" /></el-form-item><el-form-item label="下一步"><el-input v-model="commissioningForm.nextAction" /></el-form-item><el-form-item label="备注"><el-input v-model="commissioningForm.notes" /></el-form-item><el-button data-testid="commissioning-save" type="primary" native-type="submit" :loading="formBusy">保存调试记录</el-button></el-form></el-dialog>

    <el-dialog v-model="changeVisible" :teleported="false" title="新增工程变更（演示数据）" width="min(94vw, 720px)"><el-form label-position="top" @submit.prevent="saveChange"><el-form-item label="来源"><el-select v-model="changeForm.source" style="width:100%"><el-option v-for="(label, value) in changeSourceLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item label="标题" required><el-input v-model="changeForm.title" /></el-form-item><el-form-item label="变更说明" required><el-input v-model="changeForm.description" type="textarea" /></el-form-item><el-form-item label="原因" required><el-input v-model="changeForm.reason" /></el-form-item><el-row :gutter="12"><el-col :xs="24" :sm="8"><el-form-item label="合同变化（元）"><el-input v-model="changeForm.contractDeltaYuan" inputmode="decimal" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="预测成本变化（元）"><el-input v-model="changeForm.estimatedCostDeltaYuan" inputmode="decimal" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="工期变化（天）"><el-input-number v-model="changeForm.scheduleDeltaDays" /></el-form-item></el-col></el-row><el-form-item data-testid="engineering-change-date" label="提出日期"><el-date-picker v-model="changeForm.proposedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="备注"><el-input v-model="changeForm.notes" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存工程变更</el-button></el-form></el-dialog>

    <el-dialog v-model="acceptanceVisible" :teleported="false" title="新增验收计划（演示数据）" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveAcceptance"><el-form-item label="验收类型"><el-select v-model="acceptanceForm.acceptanceType" style="width:100%"><el-option v-for="(label, value) in acceptanceTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item data-testid="acceptance-scheduled-date" label="计划日期" required><el-date-picker v-model="acceptanceForm.scheduledOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item><el-form-item label="说明"><el-input v-model="acceptanceForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存验收计划</el-button></el-form></el-dialog>

    <el-dialog v-model="invoiceVisible" :teleported="false" title="登记发票（演示数据）" width="min(94vw, 680px)"><el-form label-position="top" @submit.prevent="saveInvoice"><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="发票类型"><el-select v-model="invoiceForm.invoiceType" style="width:100%"><el-option v-for="(label, value) in invoiceTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="状态"><el-select v-model="invoiceForm.status" style="width:100%"><el-option v-for="(label, value) in invoiceStatusLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item></el-col></el-row><el-form-item label="发票号码"><el-input v-model="invoiceForm.invoiceNumber" /></el-form-item><el-form-item label="金额（元）"><el-input v-model="invoiceForm.amountYuan" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="对方单位"><el-input v-model="invoiceForm.counterpartyName" /></el-form-item><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="申请日期"><el-date-picker v-model="invoiceForm.requestedOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item data-testid="invoice-recorded-date" label="登记日期"><el-date-picker v-model="invoiceForm.recordedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row><el-form-item label="备注"><el-input v-model="invoiceForm.notes" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存发票记录</el-button></el-form></el-dialog>

    <el-dialog v-model="afterSalesVisible" :teleported="false" title="新增售后案件（演示数据）" width="min(94vw, 680px)"><el-form label-position="top" @submit.prevent="saveAfterSales"><el-form-item label="报修原因" required><el-input v-model="afterSalesForm.reason" type="textarea" /></el-form-item><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="联系人"><el-input v-model="afterSalesForm.contactName" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="联系电话"><el-input v-model="afterSalesForm.contactPhone" /></el-form-item></el-col></el-row><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="after-sales-reported-date" label="报修日期"><el-date-picker v-model="afterSalesForm.reportedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="服务日期"><el-date-picker v-model="afterSalesForm.serviceOn" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item></el-col></el-row><el-form-item label="保障方式"><el-select v-model="afterSalesForm.coverageType" style="width:100%"><el-option v-for="(label, value) in coverageLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model="afterSalesForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存售后案件</el-button></el-form></el-dialog>
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
