<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { ElMessage } from 'element-plus'

import type {
  AttendanceStatus,
  CrewAssignmentStatus,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoWorkerViewModel,
  WorkerPayBasis,
  WorkforceDemoViewModel,
} from '../../domain/workforce'
import { localISODate } from '../../domain/dates'
import { formatMoney, yuanToCents } from '../../domain/formatters'
import {
  createHttpWorkforceWorkspaceRepository,
  type WorkforceWorkspaceRepository,
} from '../../repositories/workforce.live'

const props = withDefaults(defineProps<{
  projectCode: string
  repository?: WorkforceWorkspaceRepository
}>(), {
  repository: () => createHttpWorkforceWorkspaceRepository(),
})

interface LaborDraft {
  attendanceStatus: AttendanceStatus
  dayFraction: '1.000' | '0.500'
  hours: number
  workSummary: string
}

const repository = toRaw(props.repository)
const model = ref<WorkforceDemoViewModel | null>(null)
const workDate = ref(localISODate())
const selectedAssignmentIds = ref<number[]>([])
const batchWorkSummary = ref('')
const drafts = ref<Record<number, LaborDraft>>({})
const saving = ref(false)
const loading = ref(true)
const loadError = ref('')
const successNotice = ref('')
const errorNotice = ref('')
const workerDialogVisible = ref(false)
const assignmentDialogVisible = ref(false)
const reportDialogVisible = ref(false)
const advanceDialogVisible = ref(false)
const workerEditVisible = ref(false)
const reimbursementVisible = ref(false)
const formBusy = ref(false)
const selectedWorkerId = ref(0)
const selectedAdvanceId = ref(0)
let loadVersion = 0

const workerForm = reactive({ name: '', phone: '', notes: '' })
const assignmentForm = reactive({
  workerId: 0, role: '', startOn: '', endOn: '', payBasis: 'daily' as WorkerPayBasis, rateYuan: '', notes: '',
})
const reportForm = reactive({ workDate: localISODate(), location: '', weather: '', workSummary: '', blockers: '', nextPlan: '', notes: '' })
const advanceForm = reactive({
  workerId: 0, spentOn: localISODate(), vendorName: '', itemName: '', specification: '', brand: '', quantity: '', unit: '', unitPriceYuan: '', notes: '',
})
const workerEditForm = reactive({ name: '', phone: '', notes: '' })
const reimbursementForm = reactive({ amountYuan: '', reimbursedOn: localISODate(), paymentMethod: 'bank_transfer' as 'bank_transfer' | 'cash' | 'other', notes: '' })

const attendanceLabels: Record<AttendanceStatus, string> = {
  present: '到场',
  absent: '缺勤',
  leave: '请假',
}
const payBasisLabels: Record<WorkerPayBasis, string> = { daily: '日薪', hourly: '时薪' }
const assignmentStatusLabels = { planned: '已计划', active: '进行中', completed: '已完成', cancelled: '已取消' } as const

const workerNames = computed(() => new Map(
  model.value?.workers.map((worker) => [worker.worker_id, worker.name]) ?? [],
))
const assignmentWorkers = computed(() => new Map(
  model.value?.crew_assignments.map((assignment) => [
    assignment.assignment_id,
    workerNames.value.get(assignment.worker_id) ?? `施工员 #${assignment.worker_id}`,
  ]) ?? [],
))
const activeWorkerIds = computed(() => new Set(
  model.value?.workers.filter((worker) => worker.status === 'active').map((worker) => worker.worker_id) ?? [],
))
const activeAssignments = computed(() => model.value?.crew_assignments.filter(
  (assignment) => (
    (assignment.status === 'active' || assignment.status === 'planned')
    && activeWorkerIds.value.has(assignment.worker_id)
    && assignment.scheduled_start_on <= workDate.value
    && assignment.scheduled_end_on >= workDate.value
  ),
) ?? [])
const currentLaborEntries = computed(() => model.value?.labor_entries.filter(
  (entry) => entry.work_date === workDate.value && entry.status !== 'voided',
) ?? [])
const currentLaborCostCents = computed(() => currentLaborEntries.value.reduce(
  (total, entry) => total + entry.cost_cents,
  0,
))
const projectAssignmentSummaries = computed(() => (model.value?.crew_assignments ?? []).map((assignment) => {
  const entries = (model.value?.labor_entries ?? [])
    .filter((entry) => entry.assignment_id === assignment.assignment_id && entry.status === 'active')
    .sort((left, right) => left.work_date.localeCompare(right.work_date))
  return {
    assignment,
    firstWorkDate: entries[0]?.work_date ?? null,
    lastWorkDate: entries[entries.length - 1]?.work_date ?? null,
    laborCount: entries.length,
    laborCostCents: entries.reduce((total, entry) => total + entry.cost_cents, 0),
  }
}))

function assignmentRate(payBasis: WorkerPayBasis, rateCents: number): string {
  return `${formatMoney(rateCents)} / ${payBasis === 'daily' ? '日' : '小时'}`
}

function payBasisLabel(payBasis: WorkerPayBasis): string {
  return payBasisLabels[payBasis]
}

function assignmentEndLabel(value: string): string {
  return value === '9999-12-31' ? '长期' : value
}

function assignmentStatusLabel(status: CrewAssignmentStatus): string {
  return assignmentStatusLabels[status]
}

function laborMeasure(entry: WorkforceDemoViewModel['labor_entries'][number]): string {
  if (entry.day_fraction === '1.000') return '全天'
  if (entry.day_fraction === '0.500') return '半天'
  if (entry.work_minutes !== null) return `${formatHours(entry.work_minutes)} 小时`
  return '无计薪量'
}

function formatHours(minutes: number): string {
  return Number((minutes / 60).toFixed(2)).toString()
}

function currentEntryForAssignment(assignmentId: number): DemoLaborEntryViewModel | null {
  const workforce = model.value
  const assignment = workforce?.crew_assignments.find((item) => item.assignment_id === assignmentId)
  if (!workforce || !assignment) return null
  return workforce.labor_entries.find((entry) => {
    if (entry.work_date !== workDate.value || entry.status === 'voided') return false
    const entryAssignment = workforce.crew_assignments.find(
      (item) => item.assignment_id === entry.assignment_id,
    )
    return entryAssignment?.worker_id === assignment.worker_id
  }) ?? null
}

function initializeDrafts(workforce: WorkforceDemoViewModel): void {
  const selected: number[] = []
  drafts.value = Object.fromEntries(workforce.crew_assignments.map((assignment) => {
    const entry = (() => {
      const assignmentWorkerId = assignment.worker_id
      return workforce.labor_entries.find((candidate) => {
        if (candidate.work_date !== workDate.value || candidate.status === 'voided') return false
        return workforce.crew_assignments.find(
          (item) => item.assignment_id === candidate.assignment_id,
        )?.worker_id === assignmentWorkerId
      })
    })()
    const isSelectable = (assignment.status === 'active' || assignment.status === 'planned')
      && assignment.scheduled_start_on <= workDate.value
      && assignment.scheduled_end_on >= workDate.value
      && activeWorkerIds.value.has(assignment.worker_id)
    if (entry && isSelectable) selected.push(assignment.assignment_id)
    return [assignment.assignment_id, {
      attendanceStatus: entry?.attendance_status ?? 'present',
      dayFraction: entry?.day_fraction === '0.500' ? '0.500' : '1.000',
      hours: entry?.work_minutes === null || entry?.work_minutes === undefined
        ? 8
        : Number((entry.work_minutes / 60).toFixed(2)),
      workSummary: entry?.work_summary ?? '',
    } satisfies LaborDraft]
  }))
  selectedAssignmentIds.value = selected
  batchWorkSummary.value = ''
}

function draftCostCents(assignmentId: number): number {
  const assignment = model.value?.crew_assignments.find((item) => item.assignment_id === assignmentId)
  const draft = drafts.value[assignmentId]
  if (!assignment || !draft || draft.attendanceStatus !== 'present') return 0
  if (assignment.pay_basis === 'daily') {
    return draft.dayFraction === '1.000' ? assignment.rate_cents : Math.round(assignment.rate_cents / 2)
  }
  return Math.round(assignment.rate_cents * draft.hours)
}

function draftCostFormula(assignmentId: number): string {
  const assignment = model.value?.crew_assignments.find((item) => item.assignment_id === assignmentId)
  const draft = drafts.value[assignmentId]
  if (!assignment || !draft) return '—'
  if (draft.attendanceStatus !== 'present') return `不计薪 = ${formatMoney(0)}`
  const measure = assignment.pay_basis === 'daily'
    ? (draft.dayFraction === '1.000' ? '全天' : '半天')
    : `${draft.hours} 小时`
  return `${formatMoney(assignment.rate_cents)} × ${measure} = ${formatMoney(draftCostCents(assignmentId))}`
}

function selectAllAssignments(): void {
  selectedAssignmentIds.value = activeAssignments.value.map((assignment) => assignment.assignment_id)
}

function clearSelectedAssignments(): void {
  selectedAssignmentIds.value = []
}

function applyBatchWorkSummary(): void {
  const summary = batchWorkSummary.value.trim()
  if (!summary) return
  for (const assignmentId of selectedAssignmentIds.value) {
    const draft = drafts.value[assignmentId]
    if (draft) draft.workSummary = summary
  }
}

function toggleAssignment(assignmentId: number, checked: boolean): void {
  if (checked) {
    if (!selectedAssignmentIds.value.includes(assignmentId)) {
      selectedAssignmentIds.value = [...selectedAssignmentIds.value, assignmentId]
    }
    return
  }
  selectedAssignmentIds.value = selectedAssignmentIds.value.filter((id) => id !== assignmentId)
}

async function saveTodayLabor(): Promise<void> {
  if (!model.value || selectedAssignmentIds.value.length === 0) return
  const submittedCount = selectedAssignmentIds.value.length
  saving.value = true
  successNotice.value = ''
  errorNotice.value = ''
  try {
    const assignments = new Map(model.value.crew_assignments.map((assignment) => [
      assignment.assignment_id,
      assignment,
    ]))
    await repository.saveLaborEntriesBatch(props.projectCode, {
      work_date: workDate.value,
      entries: selectedAssignmentIds.value.map((assignmentId) => {
        const assignment = assignments.get(assignmentId)
        const draft = drafts.value[assignmentId]
        if (!assignment || !draft) throw new Error('项目排单不存在')
        return {
          assignment_id: assignmentId,
          attendance_status: draft.attendanceStatus,
          day_fraction: draft.attendanceStatus === 'present' && assignment.pay_basis === 'daily'
            ? draft.dayFraction
            : null,
          work_minutes: draft.attendanceStatus === 'present' && assignment.pay_basis === 'hourly'
            ? Math.round(draft.hours * 60)
            : null,
          work_summary: draft.workSummary,
          notes: null,
        }
      }),
    })
    selectedAssignmentIds.value = []
    successNotice.value = `已保存 ${workDate.value} 的 ${submittedCount} 人上工记录`
    ElMessage.success('今日上工已统一保存')
    try {
      await refreshModel()
    } catch {
      successNotice.value = '今日上工已保存但刷新失败，请手动刷新页面查看最新数据'
      ElMessage.warning(successNotice.value)
    }
  } catch (error) {
    errorNotice.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    saving.value = false
  }
}

function optionalText(value: string): string | null {
  return value.trim() || null
}

async function refreshModel(): Promise<void> {
  model.value = (await repository.getWorkforcePreview(props.projectCode)).data
  initializeDrafts(model.value)
}

async function runForm(action: () => Promise<void>, close: () => void, message: string): Promise<void> {
  if (formBusy.value) return
  formBusy.value = true
  errorNotice.value = ''
  try {
    await action()
    close()
    successNotice.value = message
    ElMessage.success(successNotice.value)
    try {
      await refreshModel()
    } catch {
      successNotice.value = `${message}；已保存但刷新失败，请手动刷新页面查看最新数据`
      ElMessage.warning(successNotice.value)
    }
  } catch (error) {
    errorNotice.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    formBusy.value = false
  }
}

function openWorker(): void {
  Object.assign(workerForm, { name: '', phone: '', notes: '' })
  workerDialogVisible.value = true
}

function saveWorker(): Promise<void> {
  return runForm(async () => {
    await repository.createWorker({ name: workerForm.name, phone: optionalText(workerForm.phone), notes: optionalText(workerForm.notes) })
  }, () => { workerDialogVisible.value = false }, '施工员已新增')
}

function openAssignment(): void {
  const today = localISODate()
  Object.assign(assignmentForm, { workerId: model.value?.workers.find((item) => item.status === 'active')?.worker_id ?? 0, role: '', startOn: today, endOn: today, payBasis: 'daily', rateYuan: '', notes: '' })
  assignmentDialogVisible.value = true
}

function saveAssignment(): Promise<void> {
  return runForm(async () => {
    await repository.assignWorker(props.projectCode, {
      worker_id: assignmentForm.workerId, role: assignmentForm.role,
      scheduled_start_on: assignmentForm.startOn, scheduled_end_on: assignmentForm.endOn,
      pay_basis: assignmentForm.payBasis, rate_cents: yuanToCents(assignmentForm.rateYuan), notes: optionalText(assignmentForm.notes),
    })
  }, () => { assignmentDialogVisible.value = false }, '项目工人已添加')
}

function openReport(): void {
  Object.assign(reportForm, { workDate: workDate.value, location: '', weather: '', workSummary: '', blockers: '', nextPlan: '', notes: '' })
  reportDialogVisible.value = true
}

function saveReport(): Promise<void> {
  return runForm(async () => {
    await repository.saveSiteDailyReport(props.projectCode, {
      work_date: reportForm.workDate, location: optionalText(reportForm.location), weather: optionalText(reportForm.weather),
      work_summary: optionalText(reportForm.workSummary), blockers: optionalText(reportForm.blockers), next_plan: optionalText(reportForm.nextPlan), notes: optionalText(reportForm.notes),
    })
  }, () => { reportDialogVisible.value = false }, '施工日报已保存')
}

function openAdvance(): void {
  Object.assign(advanceForm, { workerId: model.value?.workers[0]?.worker_id ?? 0, spentOn: workDate.value, vendorName: '', itemName: '', specification: '', brand: '', quantity: '', unit: '', unitPriceYuan: '', notes: '' })
  advanceDialogVisible.value = true
}

function saveAdvance(): Promise<void> {
  return runForm(async () => {
    await repository.saveMaterialAdvance(props.projectCode, {
      worker_id: advanceForm.workerId, spent_on: advanceForm.spentOn, vendor_name: advanceForm.vendorName,
      items: [{ name: advanceForm.itemName, specification: optionalText(advanceForm.specification), brand: optionalText(advanceForm.brand), quantity: advanceForm.quantity, unit: advanceForm.unit, unit_price_cents: yuanToCents(advanceForm.unitPriceYuan) }],
      notes: optionalText(advanceForm.notes), document_version_ids: [],
    })
  }, () => { advanceDialogVisible.value = false }, '现场垫资已登记')
}

function openWorkerEdit(worker: DemoWorkerViewModel): void {
  selectedWorkerId.value = worker.worker_id
  Object.assign(workerEditForm, { name: worker.name, phone: worker.phone ?? '', notes: worker.notes ?? '' })
  workerEditVisible.value = true
}

function saveWorkerEdit(): Promise<void> {
  return runForm(() => repository.updateWorker(selectedWorkerId.value, {
    name: workerEditForm.name,
    phone: optionalText(workerEditForm.phone),
    notes: optionalText(workerEditForm.notes),
  }), () => { workerEditVisible.value = false }, '施工员信息已更新')
}

function changeWorkerStatus(worker: DemoWorkerViewModel): Promise<void> {
  if (worker.status !== 'active') return Promise.resolve()
  return runForm(() => repository.setWorkerStatus(worker.worker_id, 'inactive'), () => {}, '施工员已停用')
}

function confirmReport(workDate: string): Promise<void> {
  return runForm(() => repository.confirmSiteDailyReport(props.projectCode, workDate), () => {}, '施工日报已确认')
}

function openReimbursement(advance: DemoMaterialAdvanceViewModel): void {
  selectedAdvanceId.value = advance.advance_id
  Object.assign(reimbursementForm, { amountYuan: '', reimbursedOn: localISODate(), paymentMethod: 'bank_transfer', notes: '' })
  reimbursementVisible.value = true
}

function saveReimbursement(): Promise<void> {
  return runForm(() => repository.recordMaterialAdvanceReimbursement(props.projectCode, selectedAdvanceId.value, {
    amount_cents: yuanToCents(reimbursementForm.amountYuan),
    reimbursed_on: reimbursementForm.reimbursedOn,
    payment_method: reimbursementForm.paymentMethod,
    notes: optionalText(reimbursementForm.notes),
  }), () => { reimbursementVisible.value = false }, '报销记录已保存')
}

watch(
  () => props.projectCode,
  async (projectCode) => {
    const version = ++loadVersion
    loading.value = true
    loadError.value = ''
    model.value = null
    selectedAssignmentIds.value = []
    successNotice.value = ''
    errorNotice.value = ''
    try {
      const result = await repository.getWorkforcePreview(projectCode)
      if (version === loadVersion) {
        model.value = result.data
        initializeDrafts(result.data)
      }
    } catch (error) {
      if (version === loadVersion) {
        loadError.value = error instanceof Error ? error.message : '施工数据加载失败'
      }
    } finally {
      if (version === loadVersion) loading.value = false
    }
  },
  { immediate: true },
)

watch(activeAssignments, (assignments) => {
  const validIds = new Set(assignments.map((assignment) => assignment.assignment_id))
  selectedAssignmentIds.value = selectedAssignmentIds.value.filter((id) => validIds.has(id))
})

watch(workDate, () => {
  if (model.value) initializeDrafts(model.value)
})
</script>

<template>
  <section data-testid="workforce-center" class="workforce-center">
    <header class="module-heading">
      <div>
        <h2>今日施工</h2>
        <p>项目 {{ projectCode }} · 默认处理今天上工，多人一次保存。</p>
      </div>
      <el-tag size="small" type="success" effect="plain">实时数据</el-tag>
    </header>

    <el-alert
      v-if="loadError"
      data-testid="workforce-load-error"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
    />

    <el-card v-if="loading" shadow="never"><el-skeleton :rows="6" animated /></el-card>

    <template v-else-if="model">
      <div class="action-row">
        <div class="secondary-actions">
          <el-button data-testid="assignment-create-open" plain @click="openAssignment">添加项目工人</el-button>
          <el-button data-testid="worker-create-open" plain @click="openWorker">新建施工员</el-button>
          <el-button data-testid="daily-report-open" plain @click="openReport">施工日报</el-button>
          <el-button data-testid="material-advance-open" plain @click="openAdvance">现场垫资</el-button>
        </div>
      </div>

      <el-card data-testid="project-crew-summary" shadow="never" class="management-card">
        <template #header>
          <div class="card-heading">
            <div><strong>本项目人员与历史</strong><small>排期、计薪、上工日期和累计人工一处查看</small></div>
          </div>
        </template>
        <el-table :data="projectAssignmentSummaries" row-key="assignment.assignment_id" size="small">
          <el-table-column label="项目人员">
            <template #default="scope">
              <div
                :data-testid="`project-worker-summary-${scope.row.assignment.assignment_id}`"
                class="crew-summary-row"
              >
                <div class="worker-cell">
                  <strong>{{ workerNames.get(scope.row.assignment.worker_id) }}</strong>
                  <small>{{ scope.row.assignment.role }}</small>
                </div>
                <div class="crew-summary-item">
                  <small>项目排期</small>
                  <span>{{ scope.row.assignment.scheduled_start_on }} 至 {{ assignmentEndLabel(scope.row.assignment.scheduled_end_on) }}</span>
                  <small>{{ payBasisLabel(scope.row.assignment.pay_basis) }} {{ assignmentRate(scope.row.assignment.pay_basis, scope.row.assignment.rate_cents) }}</small>
                </div>
                <div class="crew-summary-item">
                  <small>历史上工</small>
                  <span v-if="scope.row.laborCount">{{ scope.row.firstWorkDate }} 至 {{ scope.row.lastWorkDate }}</span>
                  <span v-else>暂无记录</span>
                  <small>{{ scope.row.laborCount }} 次 · {{ formatMoney(scope.row.laborCostCents) }}</small>
                </div>
                <el-tag size="small" effect="plain">{{ assignmentStatusLabel(scope.row.assignment.status) }}</el-tag>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <el-collapse class="worker-directory">
          <el-collapse-item :title="`施工员档案（${model.workers.length} 人）`" name="directory">
            <el-table :data="model.workers" row-key="worker_id" size="small">
              <el-table-column prop="name" label="施工员" min-width="110" />
              <el-table-column prop="phone" label="电话" min-width="130"><template #default="scope">{{ scope.row.phone ?? '未填写' }}</template></el-table-column>
              <el-table-column label="状态" min-width="80"><template #default="scope"><el-tag size="small" :type="scope.row.status === 'active' ? 'success' : 'info'">{{ scope.row.status === 'active' ? '在职' : '已停用' }}</el-tag></template></el-table-column>
              <el-table-column label="操作" min-width="150" fixed="right"><template #default="scope"><div class="compact-actions"><el-button :data-testid="`worker-edit-${scope.row.worker_id}`" link type="primary" @click="openWorkerEdit(scope.row)">编辑</el-button><el-button v-if="scope.row.status === 'active'" :data-testid="`worker-deactivate-${scope.row.worker_id}`" link type="danger" @click="changeWorkerStatus(scope.row)">停用</el-button></div></template></el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </el-card>

      <el-card data-testid="workforce-labor-panel" shadow="never" class="labor-card">
        <template #header>
          <div class="card-heading">
            <div>
              <strong>今日上工</strong>
              <small>勾选人员，统一保存当天记录</small>
            </div>
            <el-date-picker
              v-model="workDate"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY-MM-DD"
              :clearable="false"
              aria-label="上工日期"
            />
          </div>
        </template>

        <div data-testid="workforce-today-summary" class="today-summary">
          <div class="summary-metrics">
            <span><strong>可上工 {{ activeAssignments.length }} 人</strong><small>当前排单</small></span>
            <span><strong>已记录 {{ currentLaborEntries.length }} 条</strong><small>所选日期</small></span>
            <span><strong>{{ formatMoney(currentLaborCostCents) }}</strong><small>当天人工</small></span>
          </div>
          <div class="summary-actions">
            <el-button data-testid="labor-select-all" link type="primary" @click="selectAllAssignments">全选到场</el-button>
            <el-button link :disabled="selectedAssignmentIds.length === 0" @click="clearSelectedAssignments">清空</el-button>
          </div>
        </div>

        <div class="batch-summary">
          <el-input
            v-model="batchWorkSummary"
            data-testid="labor-batch-summary"
            placeholder="统一填写工作内容，例如：控制柜接线与点位核对"
            clearable
          />
          <el-button
            data-testid="labor-apply-summary"
            :disabled="selectedAssignmentIds.length === 0 || !batchWorkSummary.trim()"
            @click="applyBatchWorkSummary"
          >应用到已选人员</el-button>
        </div>

        <div class="labor-grid labor-grid-header" aria-hidden="true">
          <span>选择</span><span>施工员</span><span>到场状态</span><span>上工量</span><span>工资计算</span><span>工作内容</span>
        </div>
        <div
          v-for="assignment in activeAssignments"
          :key="assignment.assignment_id"
          :data-testid="`labor-row-${assignment.assignment_id}`"
          class="labor-grid labor-row"
        >
          <el-checkbox
            :model-value="selectedAssignmentIds.includes(assignment.assignment_id)"
            :data-testid="`labor-select-${assignment.assignment_id}`"
            :aria-label="`选择${workerNames.get(assignment.worker_id)}`"
            @change="toggleAssignment(assignment.assignment_id, Boolean($event))"
          />
          <div class="worker-cell">
            <strong>{{ workerNames.get(assignment.worker_id) }}</strong>
            <small>{{ assignment.role }} · {{ currentEntryForAssignment(assignment.assignment_id) ? '已登记' : '待登记' }}</small>
          </div>
          <el-select
            v-model="drafts[assignment.assignment_id].attendanceStatus"
            :data-testid="`labor-attendance-${assignment.assignment_id}`"
            aria-label="到场状态"
          >
            <el-option v-for="(label, value) in attendanceLabels" :key="value" :label="label" :value="value" />
          </el-select>
          <el-select
            v-if="drafts[assignment.assignment_id].attendanceStatus === 'present' && assignment.pay_basis === 'daily'"
            v-model="drafts[assignment.assignment_id].dayFraction"
            aria-label="日薪上工量"
          >
            <el-option label="全天" value="1.000" />
            <el-option label="半天" value="0.500" />
          </el-select>
          <el-input-number
            v-else-if="drafts[assignment.assignment_id].attendanceStatus === 'present'"
            v-model="drafts[assignment.assignment_id].hours"
            :min="0.25"
            :max="24"
            :step="0.5"
            :precision="2"
            controls-position="right"
            aria-label="时薪小时数"
          />
          <el-text v-else type="info">不计上工量</el-text>
          <div class="pay-cell">
            <el-tag size="small" effect="plain">{{ payBasisLabels[assignment.pay_basis] }}</el-tag>
            <strong>{{ draftCostFormula(assignment.assignment_id) }}</strong>
          </div>
          <el-input
            v-model="drafts[assignment.assignment_id].workSummary"
            :data-testid="`labor-summary-${assignment.assignment_id}`"
            placeholder="今天完成了什么"
            clearable
          />
        </div>

        <div class="save-row">
          <span>已选择 {{ selectedAssignmentIds.length }} 人</span>
          <el-button
            data-testid="workforce-save-labor"
            type="primary"
            :disabled="selectedAssignmentIds.length === 0"
            :loading="saving"
            @click="saveTodayLabor"
          >保存今日上工（{{ selectedAssignmentIds.length }}人）</el-button>
        </div>
      </el-card>

      <el-alert v-if="successNotice" class="workforce-notice" :title="successNotice" type="success" :closable="false" />
      <el-alert v-if="errorNotice" class="workforce-notice" :title="errorNotice" type="error" :closable="false" />

      <el-card shadow="never" class="labor-history-card">
        <template #header><strong>最近上工记录</strong></template>
        <el-alert title="当天记录需要纠错时，请在上方选择日期后重新批量保存" type="info" :closable="false" />
        <div class="table-scroll">
          <el-table :data="model.labor_entries" row-key="entry_id" size="small">
            <el-table-column prop="work_date" label="日期" min-width="108" />
            <el-table-column label="施工员" min-width="100"><template #default="scope">{{ assignmentWorkers.get(scope.row.assignment_id) }}</template></el-table-column>
            <el-table-column label="状态" min-width="76"><template #default="scope">{{ attendanceLabels[scope.row.attendance_status as AttendanceStatus] }}</template></el-table-column>
            <el-table-column label="上工量" min-width="90"><template #default="scope">{{ laborMeasure(scope.row) }}</template></el-table-column>
            <el-table-column label="人工成本" min-width="110"><template #default="scope"><strong>{{ formatMoney(scope.row.cost_cents) }}</strong></template></el-table-column>
            <el-table-column prop="work_summary" label="工作内容" min-width="180"><template #default="scope">{{ scope.row.work_summary ?? '未填写' }}</template></el-table-column>
            <el-table-column label="记录状态" min-width="100"><template #default="scope"><el-tag size="small" :type="scope.row.status === 'voided' ? 'info' : 'success'">{{ scope.row.status === 'voided' ? '已作废' : '有效' }}</el-tag></template></el-table-column>
          </el-table>
        </div>
      </el-card>

      <div class="field-records-grid">
        <el-card shadow="never">
          <template #header><div class="card-heading"><strong>最近施工日报</strong><el-button v-if="model.site_daily_reports[0]?.status === 'draft'" :data-testid="`report-confirm-${model.site_daily_reports[0]?.work_date}`" type="primary" plain size="small" @click="confirmReport(model.site_daily_reports[0]!.work_date)">确认日报</el-button></div></template>
          <el-empty v-if="model.site_daily_reports.length === 0" description="暂无施工日报" />
          <el-descriptions v-else :column="1" border>
            <el-descriptions-item label="日期">{{ model.site_daily_reports[0]?.work_date }}</el-descriptions-item>
            <el-descriptions-item label="现场">{{ model.site_daily_reports[0]?.location ?? '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="施工内容">{{ model.site_daily_reports[0]?.work_summary ?? '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="下一步">{{ model.site_daily_reports[0]?.next_plan ?? '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ model.site_daily_reports[0]?.status === 'confirmed' ? '已确认' : '待确认' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
        <el-card shadow="never">
          <template #header><div class="card-heading"><strong>最近现场垫资</strong><el-button v-if="model.material_advances[0]?.status !== 'reimbursed' && model.material_advances[0]?.status !== 'voided'" :data-testid="`reimbursement-open-${model.material_advances[0]?.advance_id}`" type="primary" plain size="small" @click="openReimbursement(model.material_advances[0]!)">记录报销</el-button></div></template>
          <el-empty v-if="model.material_advances.length === 0" description="暂无垫资记录" />
          <el-descriptions v-else :column="1" border>
            <el-descriptions-item label="日期">{{ model.material_advances[0]?.spent_on }}</el-descriptions-item>
            <el-descriptions-item label="商户">{{ model.material_advances[0]?.vendor_name }}</el-descriptions-item>
            <el-descriptions-item label="物料">{{ model.material_advances[0]?.items[0]?.name }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ model.material_advances[0]?.status === 'unreimbursed' ? '未报销' : '处理中' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>
    </template>

    <el-dialog v-model="workerEditVisible" :teleported="false" title="编辑施工员" width="min(94vw, 520px)"><el-form label-position="top" @submit.prevent="saveWorkerEdit"><el-form-item label="姓名" required><el-input v-model="workerEditForm.name" /></el-form-item><el-form-item label="电话"><el-input v-model="workerEditForm.phone" /></el-form-item><el-form-item label="备注"><el-input v-model="workerEditForm.notes" type="textarea" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存人员</el-button></el-form></el-dialog>

    <el-dialog v-model="reimbursementVisible" :teleported="false" title="记录报销" width="min(94vw, 560px)"><el-form label-position="top" @submit.prevent="saveReimbursement"><el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="报销金额（元）" required><el-input v-model="reimbursementForm.amountYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="报销日期" required><el-date-picker v-model="reimbursementForm.reimbursedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row><el-form-item label="支付方式"><el-select v-model="reimbursementForm.paymentMethod" style="width:100%"><el-option label="银行转账" value="bank_transfer" /><el-option label="现金" value="cash" /><el-option label="其他" value="other" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model="reimbursementForm.notes" /></el-form-item><el-button type="primary" native-type="submit" :loading="formBusy">保存报销</el-button></el-form></el-dialog>

    <el-dialog v-model="workerDialogVisible" data-testid="worker-create-dialog" :teleported="false" title="新建施工员" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveWorker">
        <el-form-item label="姓名" required><el-input v-model="workerForm.name" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="workerForm.phone" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="workerForm.notes" type="textarea" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="formBusy">保存施工员</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="assignmentDialogVisible" data-testid="assignment-create-dialog" :teleported="false" title="添加项目工人" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="saveAssignment">
        <el-form-item label="施工员" required><el-select v-model="assignmentForm.workerId" style="width:100%"><el-option v-for="worker in model?.workers ?? []" :key="worker.worker_id" :label="worker.name" :value="worker.worker_id" /></el-select></el-form-item>
        <el-form-item label="岗位" required><el-input v-model="assignmentForm.role" /></el-form-item>
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="assignment-start-date" label="开始日期" required><el-date-picker v-model="assignmentForm.startOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item data-testid="assignment-end-date" label="结束日期" required><el-date-picker v-model="assignmentForm.endOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="计薪方式"><el-select v-model="assignmentForm.payBasis" style="width:100%"><el-option value="daily" label="日薪" /><el-option value="hourly" label="时薪" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item :label="`${assignmentForm.payBasis === 'daily' ? '日薪' : '时薪'}（元）`"><el-input v-model="assignmentForm.rateYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col></el-row>
        <el-form-item label="备注"><el-input v-model="assignmentForm.notes" type="textarea" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="formBusy">添加到项目</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reportDialogVisible" data-testid="daily-report-dialog" :teleported="false" title="施工日报" width="min(94vw, 680px)">
      <el-form label-position="top" @submit.prevent="saveReport">
        <el-row :gutter="12"><el-col :xs="24" :sm="8"><el-form-item data-testid="daily-report-date" label="日期" required><el-date-picker v-model="reportForm.workDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="现场"><el-input v-model="reportForm.location" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="天气"><el-input v-model="reportForm.weather" /></el-form-item></el-col></el-row>
        <el-form-item label="施工内容" required><el-input v-model="reportForm.workSummary" type="textarea" /></el-form-item>
        <el-form-item label="阻碍"><el-input v-model="reportForm.blockers" /></el-form-item>
        <el-form-item label="下一步"><el-input v-model="reportForm.nextPlan" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="reportForm.notes" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="formBusy">保存日报</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="advanceDialogVisible" data-testid="material-advance-dialog" :teleported="false" title="现场垫资" width="min(94vw, 720px)">
      <el-form label-position="top" @submit.prevent="saveAdvance">
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="垫资人"><el-select v-model="advanceForm.workerId" style="width:100%"><el-option v-for="worker in model?.workers ?? []" :key="worker.worker_id" :label="worker.name" :value="worker.worker_id" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item data-testid="material-advance-date" label="日期"><el-date-picker v-model="advanceForm.spentOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-form-item label="商户名称" required><el-input v-model="advanceForm.vendorName" /></el-form-item>
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="物料名称" required><el-input v-model="advanceForm.itemName" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="advanceForm.specification" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="数量"><el-input v-model="advanceForm.quantity" placeholder="1.000" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="单位"><el-input v-model="advanceForm.unit" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="单价（元）"><el-input v-model="advanceForm.unitPriceYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col></el-row>
        <el-form-item label="备注"><el-input v-model="advanceForm.notes" type="textarea" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="formBusy">登记垫资</el-button>
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.workforce-center {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.labor-card { order: 1; }
.workforce-notice { order: 2; }
.action-row { order: 3; }
.management-card { order: 4; }
.labor-history-card { order: 5; }
.field-records-grid { order: 6; }

.module-heading,
.card-heading,
.save-row,
.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.module-heading h2 {
  margin: 0 0 4px;
  font-size: clamp(1.25rem, 2vw, 1.65rem);
}

.module-heading p,
.card-heading small,
.worker-cell small {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.card-heading > div,
.worker-cell {
  display: grid;
  gap: 3px;
}

.table-scroll {
  min-width: 0;
}

.table-scroll {
  overflow-x: auto;
}

.secondary-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.field-records-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.compact-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.compact-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.secondary-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.labor-card :deep(.el-card__body) {
  padding: 0;
}

.today-summary,
.batch-summary,
.summary-metrics,
.summary-actions {
  display: flex;
  align-items: center;
}

.today-summary {
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-extra-light);
}

.summary-metrics {
  flex-wrap: wrap;
  gap: 24px;
}

.summary-metrics > span {
  display: grid;
  gap: 2px;
}

.summary-metrics small {
  color: var(--el-text-color-secondary);
}

.summary-actions {
  gap: 4px;
  white-space: nowrap;
}

.batch-summary {
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.labor-grid {
  display: grid;
  grid-template-columns: 52px minmax(120px, .75fr) minmax(115px, .65fr) minmax(130px, .7fr) minmax(230px, 1.15fr) minmax(180px, 1fr);
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
}

.labor-grid-header {
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 600;
}

.labor-row {
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.pay-cell {
  display: grid;
  justify-items: start;
  gap: 4px;
  min-width: 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.pay-cell strong { font-size: 13px; font-weight: 600; }

.crew-summary-row {
  display: grid;
  grid-template-columns: minmax(120px, .65fr) minmax(220px, 1.25fr) minmax(190px, 1fr) minmax(120px, .7fr);
  align-items: center;
  gap: 12px 24px;
  padding: 2px 0;
}

.crew-summary-item { display: grid; gap: 3px; }
.crew-summary-item small { color: var(--el-text-color-secondary); }
.worker-directory { margin-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.worker-directory :deep(.el-collapse-item__header) { padding: 0 12px; }
.worker-directory :deep(.el-collapse-item__content) { padding-bottom: 0; }

.save-row {
  padding: 12px 16px;
  background: var(--el-fill-color-extra-light);
  color: var(--el-text-color-secondary);
}

@media (max-width: 760px) {
  .module-heading,
  .card-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .labor-grid-header {
    display: none;
  }

  .labor-grid {
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 14px;
  }

  .labor-row > :first-child {
    justify-self: start;
  }

  .crew-summary-row { grid-template-columns: 1fr; gap: 9px; padding: 8px 0; }

  .save-row {
    align-items: stretch;
    flex-direction: column;
  }

  .today-summary,
  .batch-summary {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .summary-actions {
    justify-content: flex-end;
  }

  .secondary-actions,
  .secondary-actions :deep(.el-button),
  .batch-summary :deep(.el-button),
  .save-row :deep(.el-button) {
    width: 100%;
  }

  .field-records-grid { grid-template-columns: 1fr; }
}
</style>
