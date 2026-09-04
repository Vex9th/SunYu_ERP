<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, toRaw, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import type {
  AttendanceStatus,
  CrewAssignmentStatus,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoWorkerViewModel,
  WorkerPayBasis,
  WorkforceDemoViewModel,
  WorkforcePreviewSection,
} from '../../domain/workforce'
import { localISODate } from '../../domain/dates'
import { formatMoney, yuanToCents } from '../../domain/formatters'
import {
  createHttpWorkforceWorkspaceRepository,
  type WorkforceWorkspaceRepository,
} from '../../repositories/workforce.live'

const props = withDefaults(defineProps<{
  projectCode: string
  readonly?: boolean
  repository?: WorkforceWorkspaceRepository
}>(), {
  readonly: false,
  repository: () => createHttpWorkforceWorkspaceRepository(),
})
const emit = defineEmits<{ changed: [] }>()

interface LaborDraft {
  attendanceStatus: AttendanceStatus
  dayFraction: '1.000' | '0.500'
  hours: number
  workSummary: string
}

interface AdvanceItemDraft {
  name: string
  specification: string
  brand: string
  quantity: string
  unit: string
  unitPriceYuan: string
}

type DataEntryDialog =
  | 'worker-create'
  | 'worker-edit'
  | 'assignment'
  | 'labor-edit'
  | 'daily-report'
  | 'material-advance'
  | 'reimbursement'

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
const formError = ref('')
const workerDialogVisible = ref(false)
const assignmentDialogVisible = ref(false)
const reportDialogVisible = ref(false)
const advanceDialogVisible = ref(false)
const workerEditVisible = ref(false)
const reimbursementVisible = ref(false)
const laborEditVisible = ref(false)
const laborVoidVisible = ref(false)
const assignmentTransitionVisible = ref(false)
const reportReopenVisible = ref(false)
const advanceVoidVisible = ref(false)
const reimbursementVoidVisible = ref(false)
const formBusy = ref(false)
const selectedWorkerId = ref(0)
const selectedAdvanceId = ref(0)
const selectedLaborEntryId = ref(0)
const selectedAssignmentId = ref(0)
const selectedReportWorkDate = ref('')
const selectedReimbursementId = ref(0)
const editingAssignmentId = ref<number | null>(null)
const editingAdvanceId = ref<number | null>(null)
const assignmentTransitionStatus = ref<Extract<CrewAssignmentStatus, 'completed' | 'cancelled'>>('completed')
const assignmentTransitionError = ref('')
let loadVersion = 0
let workspaceGeneration = 0
let confirmationOpen = false

const workerForm = reactive({ name: '', phone: '', notes: '' })
const assignmentForm = reactive({
  workerId: 0, role: '', startOn: '', endOn: '', payBasis: 'daily' as WorkerPayBasis, rateYuan: '', notes: '',
})
const reportForm = reactive({ workDate: localISODate(), location: '', weather: '', workSummary: '', blockers: '', nextPlan: '', notes: '' })
const advanceForm = reactive({
  workerId: 0,
  spentOn: localISODate(),
  vendorName: '',
  items: [] as AdvanceItemDraft[],
  notes: '',
})
const workerEditForm = reactive({ name: '', phone: '', notes: '' })
const reimbursementForm = reactive({ amountYuan: '', reimbursedOn: localISODate(), paymentMethod: 'bank_transfer' as 'bank_transfer' | 'cash' | 'other', notes: '' })
const laborEditForm = reactive({
  assignmentId: 0,
  workDate: localISODate(),
  attendanceStatus: 'present' as AttendanceStatus,
  dayFraction: '1.000',
  hours: 8,
  workSummary: '',
  notes: '',
})
const laborVoidForm = reactive({ reason: '' })
const assignmentTransitionForm = reactive({ reason: '' })
const reportReopenForm = reactive({ reason: '' })
const advanceVoidForm = reactive({ reason: '' })
const reimbursementVoidForm = reactive({ reason: '' })
const dataEntryBaselines = new Map<DataEntryDialog, string>()

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
const activeWorkers = computed(() => model.value?.workers.filter(
  (worker) => worker.status === 'active',
) ?? [])
const activeAssignments = computed(() => {
  const candidates = (model.value?.crew_assignments ?? []).filter((assignment) => (
    (assignment.status === 'active' || assignment.status === 'planned')
    && activeWorkerIds.value.has(assignment.worker_id)
    && assignment.scheduled_start_on <= workDate.value
    && assignment.scheduled_end_on >= workDate.value
  ))
  const byWorker = new Map<number, typeof candidates[number]>()
  for (const assignment of candidates) {
    const current = byWorker.get(assignment.worker_id)
    if (!current
      || (current.status === 'planned' && assignment.status === 'active')
      || (current.status === assignment.status && assignment.assignment_id > current.assignment_id)) {
      byWorker.set(assignment.worker_id, assignment)
    }
  }
  return [...byWorker.values()]
})
const advanceEligibleWorkers = computed(() => {
  const workerIds = new Set((model.value?.crew_assignments ?? [])
    .filter((assignment) => (
      (assignment.status === 'active' || assignment.status === 'planned')
      && assignment.scheduled_start_on <= advanceForm.spentOn
      && assignment.scheduled_end_on >= advanceForm.spentOn
    ))
    .map((assignment) => assignment.worker_id))
  return activeWorkers.value.filter((worker) => workerIds.has(worker.worker_id))
})
const currentLaborEntries = computed(() => model.value?.labor_entries.filter(
  (entry) => entry.work_date === workDate.value && entry.status !== 'voided',
) ?? [])
const selectedLaborEntry = computed(() => model.value?.labor_entries.find(
  (entry) => entry.entry_id === selectedLaborEntryId.value,
) ?? null)
const laborReplacementIdentityLocked = computed(() => (
  selectedLaborEntry.value !== null && selectedLaborEntry.value.replaces_entry_id !== null
))
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
const loadWarnings = computed(() => model.value?.load_warnings ?? [])

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

function advanceTotalCents(advance: DemoMaterialAdvanceViewModel): number {
  return advance.items.reduce((total, item) => total + item.line_amount_cents, 0)
}

function advanceReimbursedCents(advance: DemoMaterialAdvanceViewModel): number {
  return advance.reimbursements
    .filter((item) => item.status === 'active')
    .reduce((total, item) => total + item.amount_cents, 0)
}

function activeRepository(): WorkforceWorkspaceRepository {
  return toRaw(props.repository)
}

function emptyAdvanceItem(): AdvanceItemDraft {
  return { name: '', specification: '', brand: '', quantity: '', unit: '', unitPriceYuan: '' }
}

function paymentMethodLabel(method: DemoMaterialAdvanceViewModel['reimbursements'][number]['payment_method']): string {
  return { bank_transfer: '银行转账', cash: '现金', other: '其他' }[method]
}

function canChangeAdvance(advance: DemoMaterialAdvanceViewModel): boolean {
  return advance.status !== 'voided' && advanceReimbursedCents(advance) === 0
}

function hasLoadWarning(...sections: WorkforcePreviewSection[]): boolean {
  return loadWarnings.value.some((warning) => sections.includes(warning.section))
}

function loadWarningMessage(section: WorkforcePreviewSection): string {
  return loadWarnings.value
    .filter((warning) => warning.section === section)
    .map((warning) => warning.message)
    .join('；')
}

function dataEntrySnapshot(dialog: DataEntryDialog): string {
  switch (dialog) {
    case 'worker-create': return JSON.stringify(workerForm)
    case 'worker-edit': return JSON.stringify(workerEditForm)
    case 'assignment': return JSON.stringify(assignmentForm)
    case 'labor-edit': return JSON.stringify(laborEditForm)
    case 'daily-report': return JSON.stringify(reportForm)
    case 'material-advance': return JSON.stringify(advanceForm)
    case 'reimbursement': return JSON.stringify(reimbursementForm)
  }
}

function markDataEntryPristine(dialog: DataEntryDialog): void {
  dataEntryBaselines.set(dialog, dataEntrySnapshot(dialog))
}

function preventDataEntryClose(dialog: DataEntryDialog, done: () => void): void {
  if (formBusy.value || confirmationOpen) return
  if (dataEntryBaselines.get(dialog) === dataEntrySnapshot(dialog)) {
    done()
    return
  }
  const generation = workspaceGeneration
  confirmationOpen = true
  void ElMessageBox.confirm(
    '关闭后未保存的内容会丢失，确定关闭吗？',
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => {
    if (generation === workspaceGeneration) done()
  }).catch(() => undefined).finally(() => {
    if (generation === workspaceGeneration) confirmationOpen = false
  })
}

function cancelDataEntry(dialog: DataEntryDialog, close: () => void): void {
  preventDataEntryClose(dialog, close)
}

const beforeCloseWorkerCreate = (done: () => void): void => preventDataEntryClose('worker-create', done)
const beforeCloseWorkerEdit = (done: () => void): void => preventDataEntryClose('worker-edit', done)
const beforeCloseAssignment = (done: () => void): void => preventDataEntryClose('assignment', done)
const beforeCloseLaborEdit = (done: () => void): void => preventDataEntryClose('labor-edit', done)
const beforeCloseDailyReport = (done: () => void): void => preventDataEntryClose('daily-report', done)
const beforeCloseMaterialAdvance = (done: () => void): void => preventDataEntryClose('material-advance', done)
const beforeCloseReimbursement = (done: () => void): void => preventDataEntryClose('reimbursement', done)

function advanceStatusLabel(advance: DemoMaterialAdvanceViewModel): string {
  if (advance.status === 'reimbursed') return '已报销'
  if (advance.status === 'partial') return '部分报销'
  if (advance.status === 'voided') return '已作废'
  return '未报销'
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
  for (const assignment of activeAssignments.value) {
    const draft = drafts.value[assignment.assignment_id]
    if (draft) draft.attendanceStatus = 'present'
  }
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
  if (props.readonly || !model.value || selectedAssignmentIds.value.length === 0) return
  const generation = workspaceGeneration
  const projectCode = props.projectCode
  const repository = activeRepository()
  const submittedCount = selectedAssignmentIds.value.length
  saving.value = true
  successNotice.value = ''
  errorNotice.value = ''
  try {
    const assignments = new Map(model.value.crew_assignments.map((assignment) => [
      assignment.assignment_id,
      assignment,
    ]))
    await repository.saveLaborEntriesBatch(projectCode, {
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
    if (generation !== workspaceGeneration
      || projectCode !== props.projectCode
      || repository !== activeRepository()) return
    selectedAssignmentIds.value = []
    successNotice.value = `已保存 ${workDate.value} 的 ${submittedCount} 人上工记录`
    emit('changed')
    ElMessage.success('今日上工已统一保存')
    try {
      await refreshModel()
    } catch {
      successNotice.value = '今日上工已保存但刷新失败，请手动刷新页面查看最新数据'
      ElMessage.warning(successNotice.value)
    }
  } catch (error) {
    if (generation !== workspaceGeneration) return
    errorNotice.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    if (generation === workspaceGeneration) saving.value = false
  }
}

function optionalText(value: string): string | null {
  return value.trim() || null
}

function legacyReportEvents(report: WorkforceDemoViewModel['site_daily_reports'][number]) {
  return report.events.filter((event) => event.report_version_id === null)
}

async function refreshModel(): Promise<void> {
  const version = loadVersion
  const projectCode = props.projectCode
  const repository = activeRepository()
  const data = (await repository.getWorkforcePreview(projectCode)).data
  if (version !== loadVersion || projectCode !== props.projectCode || repository !== activeRepository()) return
  model.value = data
  initializeDrafts(data)
}

async function runForm(action: () => Promise<void>, close: () => void, message: string): Promise<void> {
  if (formBusy.value || props.readonly) {
    if (props.readonly) errorNotice.value = '项目已归档，只能查看，不能再修改施工记录'
    return
  }
  const generation = workspaceGeneration
  formBusy.value = true
  errorNotice.value = ''
  formError.value = ''
  try {
    await action()
    if (generation !== workspaceGeneration) return
    close()
    successNotice.value = message
    emit('changed')
    ElMessage.success(successNotice.value)
    try {
      await refreshModel()
    } catch {
      successNotice.value = `${message}；已保存但刷新失败，请手动刷新页面查看最新数据`
      ElMessage.warning(successNotice.value)
    }
  } catch (error) {
    if (generation !== workspaceGeneration) return
    formError.value = error instanceof Error ? error.message : '保存失败'
    errorNotice.value = formError.value
  } finally {
    if (generation === workspaceGeneration) formBusy.value = false
  }
}

function prepareDialog(): boolean {
  if (props.readonly) {
    errorNotice.value = '项目已归档，只能查看，不能再修改施工记录'
    return false
  }
  formError.value = ''
  errorNotice.value = ''
  return true
}

function preventBusyClose(done: () => void): void {
  if (!formBusy.value) done()
}

function openWorker(): void {
  if (!prepareDialog()) return
  Object.assign(workerForm, { name: '', phone: '', notes: '' })
  markDataEntryPristine('worker-create')
  workerDialogVisible.value = true
}

function saveWorker(): Promise<void> {
  return runForm(async () => {
    await activeRepository().createWorker({ name: workerForm.name, phone: optionalText(workerForm.phone), notes: optionalText(workerForm.notes) })
  }, () => { workerDialogVisible.value = false }, '施工员已新增')
}

function openAssignment(): void {
  if (!prepareDialog()) return
  editingAssignmentId.value = null
  const today = localISODate()
  Object.assign(assignmentForm, { workerId: model.value?.workers.find((item) => item.status === 'active')?.worker_id ?? 0, role: '', startOn: today, endOn: today, payBasis: 'daily', rateYuan: '', notes: '' })
  markDataEntryPristine('assignment')
  assignmentDialogVisible.value = true
}

function saveAssignment(): Promise<void> {
  return runForm(async () => {
    const input = {
      worker_id: assignmentForm.workerId, role: assignmentForm.role,
      scheduled_start_on: assignmentForm.startOn, scheduled_end_on: assignmentForm.endOn,
      pay_basis: assignmentForm.payBasis, rate_cents: yuanToCents(assignmentForm.rateYuan), notes: optionalText(assignmentForm.notes),
    }
    if (editingAssignmentId.value === null) {
      await activeRepository().assignWorker(props.projectCode, input)
    } else {
      await activeRepository().updateCrewAssignment(props.projectCode, editingAssignmentId.value, input)
    }
  }, () => { assignmentDialogVisible.value = false }, editingAssignmentId.value === null ? '项目工人已添加' : '项目排单已更新')
}

function openAssignmentEdit(assignment: WorkforceDemoViewModel['crew_assignments'][number]): void {
  if (!prepareDialog() || (assignment.status !== 'planned' && assignment.status !== 'active')) return
  editingAssignmentId.value = assignment.assignment_id
  Object.assign(assignmentForm, {
    workerId: assignment.worker_id,
    role: assignment.role,
    startOn: assignment.scheduled_start_on,
    endOn: assignment.scheduled_end_on,
    payBasis: assignment.pay_basis,
    rateYuan: (assignment.rate_cents / 100).toFixed(2),
    notes: assignment.notes ?? '',
  })
  markDataEntryPristine('assignment')
  assignmentDialogVisible.value = true
}

function openReport(report?: WorkforceDemoViewModel['site_daily_reports'][number]): void {
  if (!prepareDialog()) return
  Object.assign(reportForm, {
    workDate: report?.work_date ?? workDate.value,
    location: report?.location ?? '',
    weather: report?.weather ?? '',
    workSummary: report?.work_summary ?? '',
    blockers: report?.blockers ?? '',
    nextPlan: report?.next_plan ?? '',
    notes: report?.notes ?? '',
  })
  markDataEntryPristine('daily-report')
  reportDialogVisible.value = true
}

function saveReport(): Promise<void> {
  return runForm(async () => {
    await activeRepository().saveSiteDailyReport(props.projectCode, {
      work_date: reportForm.workDate, location: optionalText(reportForm.location), weather: optionalText(reportForm.weather),
      work_summary: optionalText(reportForm.workSummary), blockers: optionalText(reportForm.blockers), next_plan: optionalText(reportForm.nextPlan), notes: optionalText(reportForm.notes),
    })
  }, () => { reportDialogVisible.value = false }, '施工日报已保存')
}

function openAdvance(): void {
  if (!prepareDialog()) return
  editingAdvanceId.value = null
  const workerId = activeAssignments.value[0]?.worker_id ?? 0
  Object.assign(advanceForm, {
    workerId,
    spentOn: workDate.value,
    vendorName: '',
    items: [emptyAdvanceItem()],
    notes: '',
  })
  markDataEntryPristine('material-advance')
  advanceDialogVisible.value = true
}

function saveAdvance(): Promise<void> {
  return runForm(async () => {
    const input = {
      worker_id: advanceForm.workerId, spent_on: advanceForm.spentOn, vendor_name: advanceForm.vendorName,
      items: advanceForm.items.map((item) => ({
        name: item.name,
        specification: optionalText(item.specification),
        brand: optionalText(item.brand),
        quantity: item.quantity,
        unit: item.unit,
        unit_price_cents: yuanToCents(item.unitPriceYuan),
      })),
      notes: optionalText(advanceForm.notes), document_version_ids: [],
    }
    if (editingAdvanceId.value === null) {
      await activeRepository().saveMaterialAdvance(props.projectCode, input)
    } else {
      await activeRepository().updateMaterialAdvance(props.projectCode, editingAdvanceId.value, input)
    }
  }, () => { advanceDialogVisible.value = false }, editingAdvanceId.value === null ? '现场垫资已登记' : '现场垫资已更新')
}

function openAdvanceEdit(advance: DemoMaterialAdvanceViewModel): void {
  if (!prepareDialog() || !canChangeAdvance(advance)) return
  editingAdvanceId.value = advance.advance_id
  Object.assign(advanceForm, {
    workerId: advance.worker_id,
    spentOn: advance.spent_on,
    vendorName: advance.vendor_name,
    items: advance.items.map((item) => ({
      name: item.name,
      specification: item.specification ?? '',
      brand: item.brand ?? '',
      quantity: item.quantity,
      unit: item.unit,
      unitPriceYuan: (item.unit_price_cents / 100).toFixed(2),
    })),
    notes: advance.notes ?? '',
  })
  markDataEntryPristine('material-advance')
  advanceDialogVisible.value = true
}

function addAdvanceItem(): void {
  advanceForm.items.push(emptyAdvanceItem())
}

function removeAdvanceItem(index: number): void {
  if (advanceForm.items.length > 1) advanceForm.items.splice(index, 1)
}

function openWorkerEdit(worker: DemoWorkerViewModel): void {
  if (!prepareDialog()) return
  selectedWorkerId.value = worker.worker_id
  Object.assign(workerEditForm, { name: worker.name, phone: worker.phone ?? '', notes: worker.notes ?? '' })
  markDataEntryPristine('worker-edit')
  workerEditVisible.value = true
}

function saveWorkerEdit(): Promise<void> {
  return runForm(() => activeRepository().updateWorker(selectedWorkerId.value, {
    name: workerEditForm.name,
    phone: optionalText(workerEditForm.phone),
    notes: optionalText(workerEditForm.notes),
  }), () => { workerEditVisible.value = false }, '施工员信息已更新')
}

function changeWorkerStatus(worker: DemoWorkerViewModel): Promise<void> {
  const nextStatus = worker.status === 'active' ? 'inactive' : 'active'
  return runForm(
    () => activeRepository().setWorkerStatus(worker.worker_id, nextStatus),
    () => {},
    nextStatus === 'active' ? '施工员已重新启用' : '施工员已停用',
  )
}

function changeAssignmentStatus(
  assignmentId: number,
  status: CrewAssignmentStatus,
  reason: string | null,
): Promise<void> {
  const labels: Record<CrewAssignmentStatus, string> = {
    planned: '排单已恢复计划',
    active: '排单已开始',
    completed: '排单已完成',
    cancelled: '排单已取消',
  }
  return runForm(
    () => activeRepository().setCrewAssignmentStatus(props.projectCode, assignmentId, status, reason),
    () => {},
    labels[status],
  )
}

function requestAssignmentStatus(
  assignmentId: number,
  status: Extract<CrewAssignmentStatus, 'active' | 'completed' | 'cancelled'>,
): Promise<void> | void {
  if (status === 'active') return changeAssignmentStatus(assignmentId, status, null)
  if (!prepareDialog()) return
  selectedAssignmentId.value = assignmentId
  assignmentTransitionStatus.value = status
  assignmentTransitionForm.reason = ''
  assignmentTransitionError.value = ''
  assignmentTransitionVisible.value = true
}

function saveAssignmentTransition(): Promise<void> {
  const reason = optionalText(assignmentTransitionForm.reason)
  if (assignmentTransitionStatus.value === 'cancelled' && reason === null) {
    assignmentTransitionError.value = '请填写取消原因'
    return Promise.resolve()
  }
  assignmentTransitionError.value = ''
  return runForm(
    () => activeRepository().setCrewAssignmentStatus(
      props.projectCode,
      selectedAssignmentId.value,
      assignmentTransitionStatus.value,
      reason,
    ),
    () => { assignmentTransitionVisible.value = false },
    assignmentTransitionStatus.value === 'completed' ? '排单已完成' : '排单已取消',
  )
}

function openLaborEdit(entry: DemoLaborEntryViewModel): void {
  if (!prepareDialog()) return
  selectedLaborEntryId.value = entry.entry_id
  Object.assign(laborEditForm, {
    assignmentId: entry.assignment_id,
    workDate: entry.work_date,
    attendanceStatus: entry.attendance_status,
    dayFraction: entry.day_fraction ?? '1.000',
    hours: entry.work_minutes === null ? 8 : Number((entry.work_minutes / 60).toFixed(2)),
    workSummary: entry.work_summary ?? '',
    notes: entry.notes ?? '',
  })
  markDataEntryPristine('labor-edit')
  laborEditVisible.value = true
}

function saveLaborEdit(): Promise<void> {
  const assignment = model.value?.crew_assignments.find(
    (item) => item.assignment_id === laborEditForm.assignmentId,
  )
  if (!assignment) {
    errorNotice.value = '项目排单不存在'
    return Promise.resolve()
  }
  const isPresent = laborEditForm.attendanceStatus === 'present'
  return runForm(() => activeRepository().updateLaborEntry(
    props.projectCode,
    selectedLaborEntryId.value,
    {
      assignment_id: laborEditForm.assignmentId,
      work_date: laborEditForm.workDate,
      attendance_status: laborEditForm.attendanceStatus,
      day_fraction: isPresent && assignment.pay_basis === 'daily'
        ? laborEditForm.dayFraction
        : null,
      work_minutes: isPresent && assignment.pay_basis === 'hourly'
        ? Math.round(laborEditForm.hours * 60)
        : null,
      work_summary: optionalText(laborEditForm.workSummary),
      notes: optionalText(laborEditForm.notes),
    },
  ), () => { laborEditVisible.value = false }, '上工记录已更新')
}

function openLaborVoid(entry: DemoLaborEntryViewModel): void {
  if (!prepareDialog()) return
  selectedLaborEntryId.value = entry.entry_id
  laborVoidForm.reason = ''
  laborVoidVisible.value = true
}

function saveLaborVoid(): Promise<void> {
  return runForm(
    () => activeRepository().voidLaborEntry(
      props.projectCode,
      selectedLaborEntryId.value,
      laborVoidForm.reason,
    ),
    () => { laborVoidVisible.value = false },
    '上工记录已作废',
  )
}

async function confirmReport(workDate: string): Promise<void> {
  if (confirmationOpen || formBusy.value || !prepareDialog()) return
  const generation = workspaceGeneration
  const projectCode = props.projectCode
  const repository = activeRepository()
  confirmationOpen = true
  try {
    await ElMessageBox.confirm(
      '确认后将锁定该日报；如需修改，必须填写原因重新打开。',
      '确认施工日报',
      { type: 'warning', confirmButtonText: '确认日报', cancelButtonText: '再检查一下' },
    )
  } catch {
    return
  } finally {
    confirmationOpen = false
  }
  if (generation !== workspaceGeneration
    || projectCode !== props.projectCode
    || repository !== activeRepository()) return
  await runForm(
    () => repository.confirmSiteDailyReport(projectCode, workDate),
    () => {},
    '施工日报已确认',
  )
}

function openReportReopen(workDate: string): void {
  if (!prepareDialog()) return
  selectedReportWorkDate.value = workDate
  reportReopenForm.reason = ''
  reportReopenVisible.value = true
}

function saveReportReopen(): Promise<void> {
  return runForm(
    () => activeRepository().reopenSiteDailyReport(
      props.projectCode,
      selectedReportWorkDate.value,
      reportReopenForm.reason,
    ),
    () => { reportReopenVisible.value = false },
    '施工日报已重新打开',
  )
}

function openReimbursement(advance: DemoMaterialAdvanceViewModel): void {
  if (!prepareDialog()) return
  selectedAdvanceId.value = advance.advance_id
  Object.assign(reimbursementForm, { amountYuan: '', reimbursedOn: localISODate(), paymentMethod: 'bank_transfer', notes: '' })
  markDataEntryPristine('reimbursement')
  reimbursementVisible.value = true
}

function saveReimbursement(): Promise<void> {
  return runForm(() => activeRepository().recordMaterialAdvanceReimbursement(props.projectCode, selectedAdvanceId.value, {
    amount_cents: yuanToCents(reimbursementForm.amountYuan),
    reimbursed_on: reimbursementForm.reimbursedOn,
    payment_method: reimbursementForm.paymentMethod,
    notes: optionalText(reimbursementForm.notes),
  }), () => { reimbursementVisible.value = false }, '报销记录已保存')
}

function openAdvanceVoid(advanceId: number): void {
  if (!prepareDialog()) return
  selectedAdvanceId.value = advanceId
  advanceVoidForm.reason = ''
  advanceVoidVisible.value = true
}

function saveAdvanceVoid(): Promise<void> {
  return runForm(
    () => activeRepository().voidMaterialAdvance(
      props.projectCode,
      selectedAdvanceId.value,
      advanceVoidForm.reason,
    ),
    () => { advanceVoidVisible.value = false },
    '现场垫资已作废',
  )
}

function openReimbursementVoid(advanceId: number, reimbursementId: number): void {
  if (!prepareDialog()) return
  selectedAdvanceId.value = advanceId
  selectedReimbursementId.value = reimbursementId
  reimbursementVoidForm.reason = ''
  reimbursementVoidVisible.value = true
}

function saveReimbursementVoid(): Promise<void> {
  return runForm(
    () => activeRepository().voidMaterialAdvanceReimbursement(
      props.projectCode,
      selectedAdvanceId.value,
      selectedReimbursementId.value,
      reimbursementVoidForm.reason,
    ),
    () => { reimbursementVoidVisible.value = false },
    '报销记录已冲销',
  )
}

function closeAllDialogs(): void {
  workerDialogVisible.value = false
  assignmentDialogVisible.value = false
  reportDialogVisible.value = false
  advanceDialogVisible.value = false
  workerEditVisible.value = false
  reimbursementVisible.value = false
  laborEditVisible.value = false
  laborVoidVisible.value = false
  assignmentTransitionVisible.value = false
  reportReopenVisible.value = false
  advanceVoidVisible.value = false
  reimbursementVoidVisible.value = false
  if (confirmationOpen) {
    confirmationOpen = false
    ElMessageBox.close()
  }
}

watch(
  [() => props.projectCode, () => props.repository] as const,
  async ([projectCode, rawRepository]) => {
    workspaceGeneration += 1
    const version = ++loadVersion
    closeAllDialogs()
    formBusy.value = false
    saving.value = false
    loading.value = true
    loadError.value = ''
    model.value = null
    selectedAssignmentIds.value = []
    successNotice.value = ''
    errorNotice.value = ''
    formError.value = ''
    const repository = toRaw(rawRepository)
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

onBeforeUnmount(() => {
  workspaceGeneration += 1
  loadVersion += 1
  closeAllDialogs()
})

watch(activeAssignments, (assignments) => {
  const validIds = new Set(assignments.map((assignment) => assignment.assignment_id))
  selectedAssignmentIds.value = selectedAssignmentIds.value.filter((id) => validIds.has(id))
})

watch(workDate, () => {
  if (model.value) initializeDrafts(model.value)
})

watch(() => advanceForm.spentOn, () => {
  if (!advanceEligibleWorkers.value.some((worker) => worker.worker_id === advanceForm.workerId)) {
    advanceForm.workerId = advanceEligibleWorkers.value[0]?.worker_id ?? 0
  }
})
</script>

<template>
  <section data-testid="workforce-center" class="workforce-center">
    <header class="module-heading">
      <div>
        <h2>今日施工</h2>
        <p>项目 {{ projectCode }} · 默认处理今天上工，多人一次保存。</p>
      </div>
    </header>

    <el-alert v-if="readonly" title="项目已归档，本页仅供查看" type="info" show-icon :closable="false" />

    <div v-if="loadWarnings.length" data-testid="workforce-load-warnings" class="load-warning-list">
      <el-alert
        v-for="warning in loadWarnings"
        :key="`${warning.section}-${warning.message}`"
        :title="warning.message"
        type="warning"
        show-icon
        :closable="false"
      />
    </div>

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
      <div v-if="!readonly" class="action-row">
        <div data-testid="workforce-header-actions" class="secondary-actions">
          <el-button data-testid="daily-report-open" type="primary" @click="openReport">施工日报</el-button>
          <el-button v-if="activeAssignments.length" data-testid="material-advance-open" plain @click="openAdvance">现场垫资</el-button>
          <el-button data-testid="assignment-create-open" plain @click="openAssignment">添加项目工人</el-button>
          <el-button data-testid="worker-create-open" plain @click="openWorker">新建施工员</el-button>
        </div>
      </div>

      <el-card data-testid="project-crew-summary" shadow="never" class="management-card">
        <template #header>
          <div class="card-heading">
            <div><strong>本项目人员与历史</strong><small>排期、计薪、上工日期和累计人工一处查看</small></div>
          </div>
        </template>
        <el-alert
          v-if="hasLoadWarning('workers', 'crew_assignments', 'labor_entries')"
          title="人员、排单或上工数据未完整载入，以下仅显示已载入内容"
          type="warning"
          :closable="false"
        />
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
                <div class="assignment-actions">
                  <el-tag size="small" effect="plain">{{ assignmentStatusLabel(scope.row.assignment.status) }}</el-tag>
                  <div
                    v-if="!readonly && (scope.row.assignment.status === 'planned' || scope.row.assignment.status === 'active')"
                    class="compact-actions"
                  >
                    <el-button :data-testid="`assignment-edit-${scope.row.assignment.assignment_id}`" :aria-label="`编辑 ${workerNames.get(scope.row.assignment.worker_id) ?? `施工员 #${scope.row.assignment.worker_id}`} 的${scope.row.assignment.role}排单`" link type="primary" @click="openAssignmentEdit(scope.row.assignment)">编辑</el-button>
                    <el-button v-if="scope.row.assignment.status === 'planned'" :data-testid="`assignment-start-${scope.row.assignment.assignment_id}`" :aria-label="`开始 ${workerNames.get(scope.row.assignment.worker_id) ?? `施工员 #${scope.row.assignment.worker_id}`} 的${scope.row.assignment.role}排单`" link type="success" @click="requestAssignmentStatus(scope.row.assignment.assignment_id, 'active')">开始</el-button>
                    <el-button :data-testid="`assignment-complete-${scope.row.assignment.assignment_id}`" :aria-label="`完成 ${workerNames.get(scope.row.assignment.worker_id) ?? `施工员 #${scope.row.assignment.worker_id}`} 的${scope.row.assignment.role}排单`" link type="success" @click="requestAssignmentStatus(scope.row.assignment.assignment_id, 'completed')">完成</el-button>
                    <el-button :data-testid="`assignment-cancel-${scope.row.assignment.assignment_id}`" :aria-label="`取消 ${workerNames.get(scope.row.assignment.worker_id) ?? `施工员 #${scope.row.assignment.worker_id}`} 的${scope.row.assignment.role}排单`" link type="danger" @click="requestAssignmentStatus(scope.row.assignment.assignment_id, 'cancelled')">取消</el-button>
                  </div>
                </div>
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
              <el-table-column v-if="!readonly" label="操作" min-width="150" fixed="right"><template #default="scope"><div class="compact-actions"><el-button :data-testid="`worker-edit-${scope.row.worker_id}`" :aria-label="`编辑施工员 ${scope.row.name}`" link type="primary" @click="openWorkerEdit(scope.row)">编辑</el-button><el-button v-if="scope.row.status === 'active'" :data-testid="`worker-deactivate-${scope.row.worker_id}`" :aria-label="`停用施工员 ${scope.row.name}`" link type="danger" @click="changeWorkerStatus(scope.row)">停用</el-button><el-button v-else :data-testid="`worker-reactivate-${scope.row.worker_id}`" :aria-label="`重新启用施工员 ${scope.row.name}`" link type="success" @click="changeWorkerStatus(scope.row)">重新启用</el-button></div></template></el-table-column>
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
              :disabled="readonly"
              aria-label="上工日期"
            />
          </div>
        </template>

        <el-alert
          v-if="hasLoadWarning('workers', 'crew_assignments', 'labor_entries')"
          title="今日上工依赖的人员数据未完整载入，请刷新后再登记"
          type="warning"
          :closable="false"
        />

        <div data-testid="workforce-today-summary" class="today-summary">
          <div class="summary-metrics">
            <span><strong>可上工 {{ activeAssignments.length }} 人</strong><small>当前排单</small></span>
            <span><strong>已记录 {{ currentLaborEntries.length }} 条</strong><small>所选日期</small></span>
            <span><strong>{{ formatMoney(currentLaborCostCents) }}</strong><small>当天人工</small></span>
          </div>
          <div v-if="!readonly && activeAssignments.length" class="summary-actions">
            <el-button data-testid="labor-select-all" link type="primary" @click="selectAllAssignments">全选到场</el-button>
            <el-button link :disabled="selectedAssignmentIds.length === 0" @click="clearSelectedAssignments">清空</el-button>
          </div>
        </div>

        <el-empty
          v-if="!readonly && activeAssignments.length === 0 && !hasLoadWarning('workers', 'crew_assignments')"
          data-testid="workforce-empty-attendance"
          :description="activeWorkers.length === 0 ? '还没有施工员，请先录入人员资料' : '当前日期没有可上工的项目人员'"
        >
          <el-button type="primary" @click="activeWorkers.length === 0 ? openWorker() : openAssignment()">
            {{ activeWorkers.length === 0 ? '先新建施工员' : '添加项目工人' }}
          </el-button>
        </el-empty>

        <div v-if="!readonly && activeAssignments.length" class="batch-summary">
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

        <div v-if="!readonly && activeAssignments.length" class="labor-grid labor-grid-header" aria-hidden="true">
          <span>选择</span><span>施工员</span><span>到场状态</span><span>上工量</span><span>工资计算</span><span>工作内容</span>
        </div>
        <div
          v-for="assignment in readonly ? [] : activeAssignments"
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
            :aria-label="`${workerNames.get(assignment.worker_id)}的到场状态`"
            :disabled="!selectedAssignmentIds.includes(assignment.assignment_id)"
          >
            <el-option v-for="(label, value) in attendanceLabels" :key="value" :label="label" :value="value" />
          </el-select>
          <el-select
            v-if="drafts[assignment.assignment_id].attendanceStatus === 'present' && assignment.pay_basis === 'daily'"
            v-model="drafts[assignment.assignment_id].dayFraction"
            :aria-label="`${workerNames.get(assignment.worker_id)}的日薪上工量`"
            :disabled="!selectedAssignmentIds.includes(assignment.assignment_id)"
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
            :aria-label="`${workerNames.get(assignment.worker_id)}的时薪小时数`"
            :disabled="!selectedAssignmentIds.includes(assignment.assignment_id)"
          />
          <el-text v-else type="info">不计上工量</el-text>
          <div class="pay-cell">
            <el-tag size="small" effect="plain">{{ payBasisLabels[assignment.pay_basis] }}</el-tag>
            <strong>{{ draftCostFormula(assignment.assignment_id) }}</strong>
          </div>
          <el-input
            v-model="drafts[assignment.assignment_id].workSummary"
            :data-testid="`labor-summary-${assignment.assignment_id}`"
            :aria-label="`${workerNames.get(assignment.worker_id)}的工作内容`"
            placeholder="今天完成了什么"
            clearable
            :disabled="!selectedAssignmentIds.includes(assignment.assignment_id)"
          />
        </div>

        <div v-if="!readonly && activeAssignments.length" class="save-row">
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
        <el-alert v-if="hasLoadWarning('labor_entries')" title="上工记录未完整载入，下表不代表全部历史" type="warning" :closable="false" />
        <el-alert title="当天多人可继续批量覆盖；历史单条记录也可直接编辑或作废" type="info" :closable="false" />
        <div class="table-scroll">
          <el-table :data="model.labor_entries" row-key="entry_id" size="small">
            <el-table-column prop="work_date" label="日期" min-width="108" />
            <el-table-column label="施工员" min-width="100"><template #default="scope">{{ assignmentWorkers.get(scope.row.assignment_id) }}</template></el-table-column>
            <el-table-column label="状态" min-width="76"><template #default="scope">{{ attendanceLabels[scope.row.attendance_status as AttendanceStatus] }}</template></el-table-column>
            <el-table-column label="上工量" min-width="90"><template #default="scope">{{ laborMeasure(scope.row) }}</template></el-table-column>
            <el-table-column label="人工成本" min-width="110"><template #default="scope"><strong>{{ formatMoney(scope.row.cost_cents) }}</strong></template></el-table-column>
            <el-table-column prop="work_summary" label="工作内容" min-width="180"><template #default="scope">{{ scope.row.work_summary ?? '未填写' }}</template></el-table-column>
            <el-table-column label="记录状态" min-width="150">
              <template #default="scope">
                <div class="worker-cell">
                  <el-tag size="small" :type="scope.row.status === 'voided' ? 'info' : 'success'">{{ scope.row.status === 'voided' ? '已作废' : '有效' }}</el-tag>
                  <small v-if="scope.row.replaces_entry_id !== null">更正自记录 #{{ scope.row.replaces_entry_id }}</small>
                </div>
              </template>
            </el-table-column>
            <el-table-column v-if="!readonly" label="操作" min-width="120" fixed="right">
              <template #default="scope">
                <div v-if="scope.row.status === 'active'" class="compact-actions">
                  <el-button :data-testid="`labor-edit-${scope.row.entry_id}`" :aria-label="`编辑${assignmentWorkers.get(scope.row.assignment_id) ?? `排单 #${scope.row.assignment_id}`} ${scope.row.work_date} 上工记录`" link type="primary" @click="openLaborEdit(scope.row)">编辑</el-button>
                  <el-button :data-testid="`labor-void-${scope.row.entry_id}`" :aria-label="`作废${assignmentWorkers.get(scope.row.assignment_id) ?? `排单 #${scope.row.assignment_id}`} ${scope.row.work_date} 上工记录`" link type="danger" @click="openLaborVoid(scope.row)">作废</el-button>
                </div>
                <el-text v-else type="info">—</el-text>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-card>

      <div class="field-records-grid">
        <el-card data-testid="site-daily-reports-card" shadow="never">
          <template #header><div class="card-heading"><strong>{{ hasLoadWarning('site_daily_reports') ? '施工日报（仅显示已载入）' : '全部施工日报' }}</strong><small>{{ model.site_daily_reports.length }} 条</small></div></template>
          <el-alert v-if="hasLoadWarning('site_daily_reports')" :title="loadWarningMessage('site_daily_reports')" type="warning" :closable="false" />
          <el-empty v-else-if="model.site_daily_reports.length === 0" description="暂无施工日报" />
          <div v-else class="record-list">
            <article
              v-for="report in model.site_daily_reports"
              :key="report.work_date"
              :data-testid="`report-row-${report.work_date}`"
              class="field-record"
            >
              <div class="card-heading"><strong>{{ report.work_date }} · {{ report.location ?? '未填写现场' }}</strong><el-tag size="small" :type="report.status === 'confirmed' ? 'success' : 'warning'">{{ report.status === 'confirmed' ? '已确认' : '待确认' }}</el-tag></div>
              <p>{{ report.work_summary ?? '未填写施工内容' }}</p>
              <small>下一步：{{ report.next_plan ?? '未填写' }}</small>
              <el-collapse v-if="report.versions.length || legacyReportEvents(report).length">
                <el-collapse-item :name="`report-history-${report.work_date}`">
                  <template #title>确认历史（{{ report.versions.length }} 个可预览版本）</template>
                  <div class="record-list">
                    <div
                      v-for="version in report.versions"
                      :key="version.id"
                      :data-testid="`report-version-${report.work_date}-${version.version_number}`"
                    >
                      <strong>确认版本 V{{ version.version_number }}</strong>
                      <p>{{ version.work_summary ?? '未填写施工内容' }}</p>
                      <small>{{ version.confirmed_at }}</small>
                      <small
                        v-for="event in report.events.filter((item) => item.report_version_id === version.id && item.to_status === 'draft')"
                        :key="event.id"
                      >重新打开：{{ event.reason }}</small>
                    </div>
                    <div
                      v-for="event in legacyReportEvents(report)"
                      :key="`legacy-report-event-${event.id}`"
                      data-testid="report-legacy-event"
                    >
                      <div class="card-heading">
                        <strong>{{ event.to_status === 'confirmed' ? '迁移前确认记录' : '迁移前重新打开记录' }}</strong>
                        <el-tag size="small" type="warning" effect="plain">迁移前无快照</el-tag>
                      </div>
                      <small>{{ event.occurred_at }}</small>
                      <small v-if="event.reason">原因：{{ event.reason }}</small>
                    </div>
                  </div>
                </el-collapse-item>
              </el-collapse>
              <div v-if="!readonly" class="compact-actions">
                <template v-if="report.status === 'draft'">
                  <el-button :aria-label="`编辑 ${report.work_date} 施工日报`" link type="primary" @click="openReport(report)">编辑</el-button>
                  <el-button :data-testid="`report-confirm-${report.work_date}`" :aria-label="`确认 ${report.work_date} 施工日报`" link type="success" @click="confirmReport(report.work_date)">确认日报</el-button>
                </template>
                <el-button
                  v-else
                  :data-testid="`report-reopen-${report.work_date}`"
                  :aria-label="`重新打开 ${report.work_date} 施工日报`"
                  link
                  type="warning"
                  @click="openReportReopen(report.work_date)"
                >重新打开</el-button>
              </div>
            </article>
          </div>
        </el-card>
        <el-card data-testid="material-advances-card" shadow="never">
          <template #header><div class="card-heading"><strong>{{ hasLoadWarning('material_advances') ? '现场垫资（仅显示已载入）' : '全部现场垫资' }}</strong><small>{{ model.material_advances.length }} 笔</small></div></template>
          <el-alert v-if="hasLoadWarning('material_advances')" :title="loadWarningMessage('material_advances')" type="warning" :closable="false" />
          <el-empty v-else-if="model.material_advances.length === 0" description="暂无垫资记录" />
          <div v-else class="record-list">
            <article
              v-for="advance in model.material_advances"
              :key="advance.advance_id"
              :data-testid="`advance-row-${advance.advance_id}`"
              class="field-record"
            >
              <div class="card-heading"><strong>{{ advance.spent_on }} · {{ advance.vendor_name }}</strong><el-tag size="small">{{ advanceStatusLabel(advance) }}</el-tag></div>
              <p>{{ advance.items.map((item) => item.name).join('、') || '未填写物料' }}</p>
              <small>垫资 {{ formatMoney(advanceTotalCents(advance)) }} · 已报销 {{ formatMoney(advanceReimbursedCents(advance)) }}</small>
              <small v-if="advance.status === 'voided'">作废原因：{{ advance.void_reason }}</small>
              <div v-if="advance.reimbursements.length" class="reimbursement-list">
                <div
                  v-for="reimbursement in advance.reimbursements"
                  :key="reimbursement.reimbursement_id"
                  :data-testid="`reimbursement-row-${advance.advance_id}-${reimbursement.reimbursement_id}`"
                  class="reimbursement-row"
                >
                  <span>{{ formatMoney(reimbursement.amount_cents) }} · {{ reimbursement.reimbursed_on }} · {{ paymentMethodLabel(reimbursement.payment_method) }}</span>
                  <span>{{ reimbursement.notes ?? '无备注' }} · {{ reimbursement.status === 'active' ? '有效' : '已冲销' }}</span>
                  <small v-if="reimbursement.status === 'voided'">原因：{{ reimbursement.void_reason }}</small>
                  <el-button
                    v-if="!readonly && reimbursement.status === 'active'"
                    :data-testid="`reimbursement-void-${advance.advance_id}-${reimbursement.reimbursement_id}`"
                    :aria-label="`冲销 ${advance.vendor_name} ${reimbursement.reimbursed_on} 的报销记录`"
                    link
                    type="danger"
                    @click="openReimbursementVoid(advance.advance_id, reimbursement.reimbursement_id)"
                  >冲销</el-button>
                </div>
              </div>
              <div v-if="!readonly && advance.status !== 'voided'" class="compact-actions">
                <el-button
                  v-if="advance.status === 'unreimbursed' || advance.status === 'partial'"
                  :data-testid="`reimbursement-open-${advance.advance_id}`"
                  :aria-label="`记录 ${advance.vendor_name} ${advance.spent_on} 垫资的报销`"
                  link
                  type="primary"
                  @click="openReimbursement(advance)"
                >记录报销</el-button>
                <template v-if="canChangeAdvance(advance)">
                  <el-button :data-testid="`advance-edit-${advance.advance_id}`" :aria-label="`编辑 ${advance.vendor_name} ${advance.spent_on} 现场垫资`" link @click="openAdvanceEdit(advance)">编辑</el-button>
                  <el-button :data-testid="`advance-void-${advance.advance_id}`" :aria-label="`作废 ${advance.vendor_name} ${advance.spent_on} 现场垫资`" link type="danger" @click="openAdvanceVoid(advance.advance_id)">作废</el-button>
                </template>
              </div>
            </article>
          </div>
        </el-card>
      </div>
    </template>

    <el-dialog
      v-model="workerEditVisible"
      :before-close="beforeCloseWorkerEdit"
      :close-on-click-modal="!formBusy"
      :close-on-press-escape="!formBusy"
      :show-close="!formBusy"
      :teleported="false"
      title="编辑施工员"
      width="min(94vw, 520px)"
    >
      <el-form label-position="top" @submit.prevent="saveWorkerEdit">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="姓名" required><el-input v-model="workerEditForm.name" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="workerEditForm.phone" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="workerEditForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="cancelDataEntry('worker-edit', () => { workerEditVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">保存人员</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="laborEditVisible" data-testid="labor-edit-dialog" :before-close="beforeCloseLaborEdit" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="编辑上工记录" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="saveLaborEdit">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert
          v-if="laborReplacementIdentityLocked"
          data-testid="labor-replacement-identity-notice"
          title="补录记录的施工员和上工日期已锁定；身份错误请先作废，再重新登记。"
          type="warning"
          :closable="false"
        />
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12"><el-form-item label="排单" required><el-select v-model="laborEditForm.assignmentId" data-testid="labor-edit-assignment" :disabled="laborReplacementIdentityLocked" style="width:100%"><el-option v-for="assignment in model?.crew_assignments ?? []" :key="assignment.assignment_id" :label="`${workerNames.get(assignment.worker_id)} · ${assignment.role}`" :value="assignment.assignment_id" /></el-select></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item data-testid="labor-edit-date" label="上工日期" required><el-date-picker v-model="laborEditForm.workDate" :disabled="laborReplacementIdentityLocked" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="到场状态"><el-select v-model="laborEditForm.attendanceStatus" style="width:100%"><el-option v-for="(label, value) in attendanceLabels" :key="value" :label="label" :value="value" /></el-select></el-form-item>
        <el-form-item v-if="laborEditForm.attendanceStatus === 'present' && model?.crew_assignments.find((item) => item.assignment_id === laborEditForm.assignmentId)?.pay_basis === 'daily'" label="上工量"><el-select v-model="laborEditForm.dayFraction" style="width:100%"><el-option label="全天" value="1.000" /><el-option label="半天" value="0.500" /></el-select></el-form-item>
        <el-form-item v-else-if="laborEditForm.attendanceStatus === 'present'" label="小时数"><el-input-number v-model="laborEditForm.hours" :min="0.02" :max="24" :step="0.5" :precision="2" controls-position="right" /></el-form-item>
        <el-form-item data-testid="labor-edit-summary" label="工作内容"><el-input v-model="laborEditForm.workSummary" type="textarea" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="laborEditForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="labor-edit-cancel" :disabled="formBusy" @click="cancelDataEntry('labor-edit', () => { laborEditVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">保存修改</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="laborVoidVisible" data-testid="labor-void-dialog" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="作废上工记录" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveLaborVoid">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert title="作废后不再计入项目人工成本，原记录仍保留可追溯" type="warning" :closable="false" />
        <el-form-item data-testid="labor-void-reason" label="作废原因" required><el-input v-model="laborVoidForm.reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="laborVoidVisible = false">取消</el-button>
          <el-button type="danger" native-type="submit" :loading="formBusy">确认作废</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="assignmentTransitionVisible"
      data-testid="assignment-transition-dialog"
      :teleported="false"
      :before-close="preventBusyClose"
      :close-on-click-modal="!formBusy"
      :close-on-press-escape="!formBusy"
      :show-close="!formBusy"
      :title="assignmentTransitionStatus === 'completed' ? '确认完成排单' : '确认取消排单'"
      width="min(94vw, 520px)"
    >
      <el-form label-position="top" @submit.prevent="saveAssignmentTransition">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert
          v-if="assignmentTransitionError"
          data-testid="assignment-transition-error"
          :title="assignmentTransitionError"
          type="error"
          :closable="false"
        />
        <el-alert
          :title="assignmentTransitionStatus === 'completed' ? '确认后该排单将进入已完成状态' : '确认后该排单将进入已取消状态'"
          type="warning"
          :closable="false"
        />
        <el-form-item
          data-testid="assignment-transition-reason"
          :label="assignmentTransitionStatus === 'completed' ? '完成说明（选填）' : '取消原因'"
          :required="assignmentTransitionStatus === 'cancelled'"
        ><el-input v-model="assignmentTransitionForm.reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="assignmentTransitionVisible = false">取消</el-button>
          <el-button
            :type="assignmentTransitionStatus === 'completed' ? 'primary' : 'danger'"
            native-type="submit"
            :loading="formBusy"
          >{{ assignmentTransitionStatus === 'completed' ? '确认完成' : '确认取消' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reimbursementVisible" data-testid="reimbursement-dialog" :before-close="beforeCloseReimbursement" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="记录报销" width="min(94vw, 560px)">
      <el-form label-position="top" @submit.prevent="saveReimbursement">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="报销金额（元）" required><el-input v-model="reimbursementForm.amountYuan" data-testid="reimbursement-amount" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="报销日期" required><el-date-picker v-model="reimbursementForm.reimbursedOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-form-item label="支付方式"><el-select v-model="reimbursementForm.paymentMethod" style="width:100%"><el-option label="银行转账" value="bank_transfer" /><el-option label="现金" value="cash" /><el-option label="其他" value="other" /></el-select></el-form-item>
        <el-form-item label="备注"><el-input v-model="reimbursementForm.notes" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="reimbursement-cancel" :disabled="formBusy" @click="cancelDataEntry('reimbursement', () => { reimbursementVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">保存报销</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="workerDialogVisible" data-testid="worker-create-dialog" :before-close="beforeCloseWorkerCreate" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="新建施工员" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveWorker">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="姓名" required><el-input v-model="workerForm.name" data-testid="worker-create-name" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="workerForm.phone" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="workerForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="worker-create-cancel" :disabled="formBusy" @click="cancelDataEntry('worker-create', () => { workerDialogVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">保存施工员</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="assignmentDialogVisible" :data-testid="editingAssignmentId === null ? 'assignment-create-dialog' : 'assignment-edit-dialog'" :before-close="beforeCloseAssignment" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" :title="editingAssignmentId === null ? '添加项目工人' : '编辑项目排单'" width="min(94vw, 620px)">
      <el-form label-position="top" @submit.prevent="saveAssignment">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-form-item label="施工员" required><el-select v-model="assignmentForm.workerId" style="width:100%"><el-option v-for="worker in activeWorkers" :key="worker.worker_id" :label="worker.name" :value="worker.worker_id" /></el-select></el-form-item>
        <el-form-item data-testid="assignment-role" label="岗位" required><el-input v-model="assignmentForm.role" /></el-form-item>
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item data-testid="assignment-start-date" label="开始日期" required><el-date-picker v-model="assignmentForm.startOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item data-testid="assignment-end-date" label="结束日期" required><el-date-picker v-model="assignmentForm.endOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="计薪方式"><el-select v-model="assignmentForm.payBasis" style="width:100%"><el-option value="daily" label="日薪" /><el-option value="hourly" label="时薪" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item :label="`${assignmentForm.payBasis === 'daily' ? '日薪' : '时薪'}（元）`"><el-input v-model="assignmentForm.rateYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col></el-row>
        <el-form-item label="备注"><el-input v-model="assignmentForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="assignment-cancel" :disabled="formBusy" @click="cancelDataEntry('assignment', () => { assignmentDialogVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">{{ editingAssignmentId === null ? '添加到项目' : '保存排单' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reportDialogVisible" data-testid="daily-report-dialog" :before-close="beforeCloseDailyReport" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="施工日报" width="min(94vw, 680px)">
      <el-form label-position="top" @submit.prevent="saveReport">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-row :gutter="12"><el-col :xs="24" :sm="8"><el-form-item data-testid="daily-report-date" label="日期" required><el-date-picker v-model="reportForm.workDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="现场"><el-input v-model="reportForm.location" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="天气"><el-input v-model="reportForm.weather" /></el-form-item></el-col></el-row>
        <el-form-item label="施工内容" required><el-input v-model="reportForm.workSummary" data-testid="daily-report-summary" type="textarea" /></el-form-item>
        <el-form-item label="阻碍"><el-input v-model="reportForm.blockers" /></el-form-item>
        <el-form-item label="下一步"><el-input v-model="reportForm.nextPlan" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="reportForm.notes" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="daily-report-cancel" :disabled="formBusy" @click="cancelDataEntry('daily-report', () => { reportDialogVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">保存日报</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="advanceDialogVisible" :data-testid="editingAdvanceId === null ? 'material-advance-dialog' : 'material-advance-edit-dialog'" :before-close="beforeCloseMaterialAdvance" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" :title="editingAdvanceId === null ? '现场垫资' : '编辑现场垫资'" width="min(94vw, 720px)">
      <el-form label-position="top" @submit.prevent="saveAdvance">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="垫资人"><el-select v-model="advanceForm.workerId" style="width:100%"><el-option v-for="worker in advanceEligibleWorkers" :key="worker.worker_id" :label="worker.name" :value="worker.worker_id" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item data-testid="material-advance-date" label="日期"><el-date-picker v-model="advanceForm.spentOn" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item></el-col></el-row>
        <el-alert v-if="advanceEligibleWorkers.length === 0" title="所选日期没有当前项目的有效排单人员，不能登记垫资" type="warning" :closable="false" />
        <el-form-item data-testid="advance-vendor" label="商户名称" required><el-input v-model="advanceForm.vendorName" /></el-form-item>
        <div v-for="(item, index) in advanceForm.items" :key="index" class="advance-item-editor">
          <div class="card-heading"><strong>物料 {{ index + 1 }}</strong><el-button v-if="advanceForm.items.length > 1" link type="danger" @click="removeAdvanceItem(index)">删除</el-button></div>
          <el-row :gutter="12"><el-col :xs="24" :sm="12"><el-form-item label="物料名称" required><el-input v-model="item.name" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="item.specification" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="数量" required><el-input v-model="item.quantity" placeholder="1.000" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="单位" required><el-input v-model="item.unit" /></el-form-item></el-col><el-col :xs="24" :sm="8"><el-form-item label="单价（元）" required><el-input v-model="item.unitPriceYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col></el-row>
        </div>
        <el-button plain @click="addAdvanceItem">增加一项物料</el-button>
        <el-form-item label="备注"><el-input v-model="advanceForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="material-advance-cancel" :disabled="formBusy" @click="cancelDataEntry('material-advance', () => { advanceDialogVisible = false })">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="formBusy">{{ editingAdvanceId === null ? '登记垫资' : '保存修改' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reportReopenVisible" data-testid="report-reopen-dialog" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="重新打开施工日报" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveReportReopen">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert title="重新打开后日报恢复为草稿，修改完成后需要再次确认" type="warning" :closable="false" />
        <el-form-item data-testid="report-reopen-reason" label="重新打开原因" required><el-input v-model="reportReopenForm.reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="reportReopenVisible = false">取消</el-button>
          <el-button type="warning" native-type="submit" :loading="formBusy">确认重新打开</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="advanceVoidVisible" data-testid="advance-void-dialog" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="作废现场垫资" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveAdvanceVoid">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert title="作废后不再计入项目成本，原记录仍保留可追溯" type="warning" :closable="false" />
        <el-form-item data-testid="advance-void-reason" label="作废原因" required><el-input v-model="advanceVoidForm.reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="advanceVoidVisible = false">取消</el-button>
          <el-button type="danger" native-type="submit" :loading="formBusy">确认作废</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reimbursementVoidVisible" data-testid="reimbursement-void-dialog" :before-close="preventBusyClose" :close-on-click-modal="!formBusy" :close-on-press-escape="!formBusy" :show-close="!formBusy" :teleported="false" title="冲销报销记录" width="min(94vw, 520px)">
      <el-form label-position="top" @submit.prevent="saveReimbursementVoid">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert title="冲销不会删除原报销；金额将从已报销合计扣除并恢复为待报销" type="warning" :closable="false" />
        <el-form-item data-testid="reimbursement-void-reason" label="冲销原因" required><el-input v-model="reimbursementVoidForm.reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="formBusy" @click="reimbursementVoidVisible = false">取消</el-button>
          <el-button type="danger" native-type="submit" :loading="formBusy">确认冲销</el-button>
        </div>
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

.load-warning-list {
  display: grid;
  gap: 8px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.dialog-actions :deep(.el-button + .el-button) {
  margin-left: 0;
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

.record-list { display: grid; gap: 10px; }
.field-record { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); }
.field-record p { margin: 0; }
.reimbursement-list,
.reimbursement-row,
.advance-item-editor { display: grid; gap: 6px; }
.reimbursement-list,
.advance-item-editor { padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); }
.reimbursement-row + .reimbursement-row { padding-top: 8px; border-top: 1px solid var(--el-border-color-extra-light); }
.reimbursement-row small { color: var(--el-text-color-secondary); }

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
.assignment-actions { display: grid; justify-items: start; gap: 4px; }
.crew-summary-item small { color: var(--el-text-color-secondary); }
.worker-directory { margin-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.worker-directory :deep(.el-collapse-item__header) { padding: 0 12px; }
.worker-directory :deep(.el-collapse-item__content) { padding-bottom: 0; }

.save-row {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--el-fill-color-extra-light);
  border-top: 1px solid var(--el-border-color-lighter);
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
