import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { ApiError } from '../../api'
import { useWorkspaceTab, useWorkspaceValue } from '../shared'
import { localISODate } from '../../domain/dates'
import {
  formatMoney,
  yuanToCents as parseYuanToCents,
} from '../../domain/formatters'
import type {
  AttendanceStatus,
  CrewAssignmentStatus,
  DemoCrewAssignmentViewModel,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoSiteDailyReportViewModel,
  DemoWorkerViewModel,
  LaborEntryBatchInput,
  WorkforceDemoViewModel,
} from '../../domain/workforce'
import {
  createHttpWorkforceWorkspaceRepository,
  type WorkforceWorkspaceRepository,
} from '../../repositories/workforce.live'
import {
  ActionDrawer,
  RecordSearch,
  getEditorDraft,
  clearEditorDraft,
  AttachmentLinks,
  DateInput,
  createPendingRegistry,
  errorText,
  numberValue,
  optionalText,
  options,
  textValue,
  type Editor,
  type Field,
  type Values,
} from './ui'

export interface WorkforceWorkspaceProps {
  projectCode: string
  readonly?: boolean
  repository?: WorkforceWorkspaceRepository
}
class InputError extends Error {}
function yuanToCents(value: string) {
  try {
    return parseYuanToCents(value)
  } catch (error) {
    throw new InputError(errorText(error))
  }
}
interface LaborDraft {
  attendance: AttendanceStatus
  fraction: string
  hours: number
  summary: string
}
interface LaborFormDraft {
  selected: number[]
  drafts: Record<number, LaborDraft>
  batchSummary: string
}
const laborFormDrafts = new WeakMap<
  object,
  Map<string, { date: string; days: Map<string, LaborFormDraft> }>
>()
interface Pending {
  snapshot: WorkforceDemoViewModel | null
  editor: Editor
  send: () => Promise<void>
  inFlight: boolean
}
const repositories = new Map<string, WorkforceWorkspaceRepository>()
const pendingRegistry = createPendingRegistry<Pending>()
const workerLabels = { active: '在职', inactive: '已停用' }
const assignmentLabels = {
  planned: '已计划',
  active: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}
const attendanceLabels = { present: '到场', absent: '缺勤', leave: '请假' }
const advanceLabels = {
  unreimbursed: '未报销',
  partial: '部分报销',
  reimbursed: '已报销',
  voided: '已作废',
}
const paymentLabels = { bank_transfer: '银行转账', cash: '现金', other: '其他' }
const note: Field = { key: 'notes', label: '备注', type: 'textarea' }
const reasonField: Field = {
  key: 'reason',
  label: '原因',
  type: 'textarea',
  required: true,
}
const pagination = {
  defaultPageSize: 10,
  showSizeChanger: true,
  showTotal: (total: number) => `共 ${total} 条`,
}
const dateField = (key: string, label: string, disabled = false): Field => ({
  key,
  label,
  type: 'date',
  required: true,
  disabled,
})
function repositoryFor(project: string) {
  let repository = repositories.get(project)
  if (!repository) {
    repository = createHttpWorkforceWorkspaceRepository()
    repositories.set(project, repository)
  }
  return repository
}
const pendingMap = (repository: WorkforceWorkspaceRepository) =>
  pendingRegistry.forOwner(repository)
export function eligibleAssignments(
  model: WorkforceDemoViewModel,
  workDate: string,
): DemoCrewAssignmentViewModel[] {
  const activeWorkers = new Set(
    model.workers
      .filter((worker) => worker.status === 'active')
      .map((worker) => worker.worker_id),
  )
  const workers = new Map<number, DemoCrewAssignmentViewModel>()
  for (const assignment of model.crew_assignments) {
    if (
      !['planned', 'active'].includes(assignment.status) ||
      !activeWorkers.has(assignment.worker_id) ||
      assignment.scheduled_start_on > workDate ||
      assignment.scheduled_end_on < workDate
    )
      continue
    const prior = workers.get(assignment.worker_id)
    if (
      !prior ||
      (prior.status === 'planned' && assignment.status === 'active') ||
      (prior.status === assignment.status &&
        prior.assignment_id < assignment.assignment_id)
    )
      workers.set(assignment.worker_id, assignment)
  }
  return [...workers.values()]
}
export function advanceTotals(advance: DemoMaterialAdvanceViewModel) {
  const total = advance.items.reduce(
    (sum, item) => sum + item.line_amount_cents,
    0,
  )
  const reimbursed = advance.reimbursements
    .filter((item) => item.status === 'active')
    .reduce((sum, item) => sum + item.amount_cents, 0)
  return { total, reimbursed, outstanding: total - reimbursed }
}

export default function WorkforceWorkspace({
  projectCode,
  readonly = false,
  repository: suppliedRepository,
}: WorkforceWorkspaceProps) {
  useSyncExternalStore(pendingRegistry.subscribe, pendingRegistry.getSnapshot)
  const priorPending = useRef(false)
  const repository = useMemo(
    () => suppliedRepository ?? repositoryFor(projectCode),
    [suppliedRepository, projectCode],
  )
  const [model, setModel] = useState<WorkforceDemoViewModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [formError, setFormError] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [workDate, setWorkDate] = useState(localISODate())
  const [selected, setSelected] = useState<number[]>([])
  const [drafts, setDrafts] = useState<Record<number, LaborDraft>>({})
  const [batchSummary, setBatchSummary] = useState('')
  const [search, setSearch] = useWorkspaceValue('q', '')
  const [activeTab, setActiveTab] = useWorkspaceTab(
    'section',
    ['labor', 'labor-history', 'people', 'workers', 'reports', 'advances'],
    readonly ? 'labor-history' : 'labor',
  )
  const [laborFrom, setLaborFrom] = useState('')
  const [laborTo, setLaborTo] = useState('')
  const [laborWorker, setLaborWorker] = useState<number | undefined>()
  const [history, setHistory] = useState<DemoSiteDailyReportViewModel | null>(
    null,
  )
  const context = useRef({ projectCode, repository, readonly, generation: 0 })
  const generation = useRef(0)
  const requestSequence = useRef(0)
  const actionLock = useRef(false)
  context.current = {
    projectCode,
    repository,
    readonly,
    generation: generation.current,
  }
  const current = (
    project: string,
    repo: WorkforceWorkspaceRepository,
    version: number,
  ) =>
    context.current.projectCode === project &&
    context.current.repository === repo &&
    generation.current === version
  async function refresh() {
    const sequence = ++requestSequence.current
    const version = generation.current
    setLoading(true)
    try {
      const result = await repository.getWorkforcePreview(projectCode)
      if (
        current(projectCode, repository, version) &&
        sequence === requestSequence.current
      ) {
        setModel(result.data)
        setError('')
      }
    } catch (failure) {
      if (
        current(projectCode, repository, version) &&
        sequence === requestSequence.current
      )
        setError(errorText(failure))
      throw failure
    } finally {
      if (
        current(projectCode, repository, version) &&
        sequence === requestSequence.current
      )
        setLoading(false)
    }
  }
  useEffect(() => {
    generation.current += 1
    setModel(null)
    setEditor(null)
    setError('')
    setSuccess('')
    setFormError('')
    setSelected([])
    setWorkDate(
      laborFormDrafts.get(repository)?.get(projectCode)?.date ?? localISODate(),
    )
    setHistory(null)
    setBusy(false)
    actionLock.current = false
    const restored = pendingMap(repository).get(projectCode)
    if (restored) {
      setModel(restored.snapshot)
      setLoading(false)
    } else void refresh().catch(() => undefined)
    return () => {
      generation.current += 1
      requestSequence.current += 1
    }
  }, [projectCode, repository])
  useEffect(() => {
    if (readonly) setEditor(null)
  }, [readonly])
  const active = useMemo(
    () => (model ? eligibleAssignments(model, workDate) : []),
    [model, workDate],
  )
  const workers = new Map(
    model?.workers.map((worker) => [worker.worker_id, worker.name]) ?? [],
  )
  const assignments = new Map(
    model?.crew_assignments.map((assignment) => [
      assignment.assignment_id,
      assignment,
    ]) ?? [],
  )
  const workerOptions = (model?.workers ?? [])
    .filter((worker) => worker.status === 'active')
    .map((worker) => ({ value: worker.worker_id, label: worker.name }))
  const workerName = (id: number) => workers.get(id) ?? `施工员 #${id}`
  const hasWarning = (...sections: string[]) =>
    model?.load_warnings?.some((warning) =>
      sections.includes(warning.section),
    ) ?? false
  const blockedLabor = hasWarning(
    'workers',
    'crew_assignments',
    'labor_entries',
  )
  const pending = pendingMap(repository).get(projectCode)
  useEffect(() => {
    if (priorPending.current && !pending && !actionLock.current)
      void refresh().catch(() => undefined)
    priorPending.current = Boolean(pending)
  }, [pending])
  const mutationDisabled =
    readonly || loading || !model || busy || Boolean(pending)
  useEffect(() => {
    if (!model) return
    const next: Record<number, LaborDraft> = {}
    const recorded: number[] = []
    for (const assignment of active) {
      const entry = model.labor_entries.find(
        (item) =>
          item.work_date === workDate &&
          item.status === 'active' &&
          assignments.get(item.assignment_id)?.worker_id ===
            assignment.worker_id,
      )
      next[assignment.assignment_id] = {
        attendance: entry?.attendance_status ?? 'present',
        fraction: entry?.day_fraction ?? '1.000',
        hours: entry?.work_minutes == null ? 8 : entry.work_minutes / 60,
        summary: entry?.work_summary ?? '',
      }
      if (entry) recorded.push(assignment.assignment_id)
    }
    const draft = laborFormDrafts
      .get(repository)
      ?.get(projectCode)
      ?.days.get(workDate)
    const eligible = new Set(active.map((row) => row.assignment_id))
    setDrafts(
      draft
        ? Object.fromEntries(
            Object.entries(next).map(([id, value]) => [
              id,
              draft.drafts[Number(id)] ?? value,
            ]),
          )
        : next,
    )
    setSelected(
      draft ? draft.selected.filter((id) => eligible.has(id)) : recorded,
    )
    setBatchSummary(draft?.batchSummary ?? '')
  }, [model, workDate])
  useEffect(() => {
    if (!laborFormDrafts.get(repository)?.get(projectCode)?.days.size) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [repository, projectCode, drafts, workDate])
  async function execute(send: () => Promise<void>, submission: Pending) {
    if (
      context.current.projectCode !== projectCode ||
      context.current.repository !== repository ||
      context.current.readonly ||
      actionLock.current ||
      submission?.inFlight
    )
      return
    const version = generation.current
    actionLock.current = true
    setBusy(true)
    setError('')
    setSuccess('')
    setFormError('')
    if (submission) submission.inFlight = true
    try {
      await send()
      clearEditorDraft(repository, projectCode, submission.editor.key)
      if (submission) pendingMap(repository).delete(projectCode)
      if (!current(projectCode, repository, version)) return
      setEditor(null)
      setSuccess('记录已保存')
      window.dispatchEvent(
        new CustomEvent('project-data-changed', { detail: { projectCode } }),
      )
      try {
        await refresh()
      } catch {
        if (current(projectCode, repository, version))
          setSuccess('已保存，但刷新失败。请刷新后查看最新记录。')
      }
    } catch (failure) {
      if (
        submission &&
        (failure instanceof InputError ||
          (failure instanceof Error && failure.name === 'Error') ||
          (failure instanceof ApiError &&
            failure.status >= 400 &&
            failure.status < 500 &&
            ![408, 425, 429].includes(failure.status)))
      )
        pendingMap(repository).delete(projectCode)
      if (!current(projectCode, repository, version)) return
      const message = errorText(failure)
      setFormError(message)
      setError(message)
      if (submission)
        setEditor({
          ...submission.editor,
          frozen: pendingMap(repository).has(projectCode),
        })
    } finally {
      if (submission) {
        submission.inFlight = false
        pendingRegistry.notify()
      }
      if (current(projectCode, repository, version)) {
        setBusy(false)
        actionLock.current = false
      }
    }
  }
  function executeDirect(
    title: string,
    send: () => Promise<void>,
  ): Promise<void> {
    if (
      mutationDisabled ||
      actionLock.current ||
      context.current.projectCode !== projectCode ||
      context.current.repository !== repository ||
      context.current.readonly
    )
      return Promise.resolve()
    const submission: Pending = {
      snapshot: model,
      editor: {
        key: crypto.randomUUID(),
        title,
        initial: {},
        fields: [],
        submit: send,
      },
      send,
      inFlight: false,
    }
    pendingMap(repository).set(projectCode, submission)
    return execute(send, submission)
  }
  function open(
    title: string,
    initial: Values,
    fields: Field[],
    submit: Editor['submit'],
    extra?: Editor['extra'],
  ) {
    if (mutationDisabled) return
    const draft = getEditorDraft(repository, projectCode)
    if (draft && !editor) {
      setEditor(draft)
      setFormError('请先保存或关闭这份未完成的草稿，再开始新的操作。')
      return
    }
    setFormError('')
    setEditor({
      key: crypto.randomUUID(),
      title,
      submitLabel: title.startsWith('编辑')
        ? title.replace('编辑', '保存')
        : title === '新建施工员'
          ? '保存施工员档案'
          : title === '添加项目工人'
            ? '保存项目安排'
            : title === '新建施工日报'
              ? '保存施工日报'
              : title,
      initial,
      fields,
      submit,
      extra,
    })
  }
  async function save(values: Values, files: File[]) {
    if (!editor || readonly || busy) return
    const recoverable = pendingMap(repository).get(projectCode)
    if (recoverable) {
      await execute(recoverable.send, recoverable)
      return
    }
    const captured = structuredClone(values)
    const submission: Pending = {
      snapshot: model,
      editor: { ...editor, initial: captured, files },
      send: () => editor.submit(captured, files),
      inFlight: false,
    }
    pendingMap(repository).set(projectCode, submission)
    await execute(submission.send, submission)
  }
  function reason(
    title: string,
    submit: (reason: string) => Promise<void>,
    required = true,
  ) {
    open(title, { reason: '' }, [{ ...reasonField, required }], (values) =>
      submit(textValue(values, 'reason')),
    )
  }
  function openWorker(worker?: DemoWorkerViewModel) {
    open(
      worker ? '编辑施工员' : '新建施工员',
      worker ? { ...worker } : {},
      [
        { key: 'name', label: '姓名', required: true },
        { key: 'phone', label: '联系电话' },
        note,
      ],
      async (values) => {
        const input = {
          name: textValue(values, 'name'),
          phone: optionalText(values, 'phone'),
          notes: optionalText(values, 'notes'),
        }
        if (worker) await repository.updateWorker(worker.worker_id, input)
        else await repository.createWorker(input)
      },
    )
  }
  function openAssignment(assignment?: DemoCrewAssignmentViewModel) {
    open(
      assignment ? '编辑项目安排' : '添加项目工人',
      assignment
        ? { ...assignment, rate: (assignment.rate_cents / 100).toFixed(2) }
        : {
            worker_id: workerOptions[0]?.value,
            scheduled_start_on: workDate,
            scheduled_end_on: workDate,
            pay_basis: 'daily',
          },
      [
        {
          key: 'worker_id',
          label: '施工员',
          type: 'select',
          options: workerOptions,
          required: true,
          disabled: Boolean(assignment),
        },
        { key: 'role', label: '工种 / 工作职责', required: true },
        dateField('scheduled_start_on', '开始日期'),
        dateField('scheduled_end_on', '结束日期'),
        {
          key: 'pay_basis',
          label: '计薪方式',
          type: 'select',
          options: options({ daily: '日薪', hourly: '时薪' }),
          required: true,
        },
        { key: 'rate', label: '工资标准', type: 'money', required: true },
        note,
      ],
      async (values) => {
        const input = {
          worker_id: numberValue(values, 'worker_id'),
          role: textValue(values, 'role'),
          scheduled_start_on: textValue(values, 'scheduled_start_on'),
          scheduled_end_on: textValue(values, 'scheduled_end_on'),
          pay_basis: textValue(values, 'pay_basis') as 'daily' | 'hourly',
          rate_cents: yuanToCents(textValue(values, 'rate')),
          notes: optionalText(values, 'notes'),
        }
        if (input.scheduled_end_on < input.scheduled_start_on)
          throw new InputError('结束日期不能早于开始日期')
        if (assignment)
          await repository.updateCrewAssignment(
            projectCode,
            assignment.assignment_id,
            input,
          )
        else await repository.assignWorker(projectCode, input)
      },
    )
  }
  function openLabor(entry: DemoLaborEntryViewModel) {
    if (entry.status === 'voided') return
    const identityLocked = entry.replaces_entry_id !== null
    open(
      '更正上工记录',
      {
        ...entry,
        hours: entry.work_minutes == null ? 8 : entry.work_minutes / 60,
        day_fraction: entry.day_fraction ?? '1.000',
      },
      [
        {
          key: 'assignment_id',
          label: '项目安排',
          type: 'select',
          required: true,
          disabled: identityLocked,
          options: (model?.crew_assignments ?? []).map((item) => ({
            value: item.assignment_id,
            label: `${workerName(item.worker_id)} · ${item.role} · ${item.scheduled_start_on}`,
          })),
        },
        dateField('work_date', '上工日期', identityLocked),
        {
          key: 'attendance_status',
          label: '到场状态',
          type: 'select',
          options: options(attendanceLabels),
          required: true,
        },
        {
          key: 'day_fraction',
          label: '上工量',
          type: 'select',
          options: options({ '1.000': '全天', '0.500': '半天' }),
          visible: (values) =>
            values.attendance_status === 'present' &&
            assignments.get(numberValue(values, 'assignment_id'))?.pay_basis ===
              'daily',
        },
        {
          key: 'hours',
          label: '上工小时数',
          type: 'text',
          visible: (values) =>
            values.attendance_status === 'present' &&
            assignments.get(numberValue(values, 'assignment_id'))?.pay_basis ===
              'hourly',
          required: true,
        },
        { key: 'work_summary', label: '工作内容', type: 'textarea' },
        note,
      ],
      async (values) => {
        const assignment = assignments.get(numberValue(values, 'assignment_id'))
        if (!assignment) throw new InputError('项目安排不存在')
        const present = values.attendance_status === 'present'
        const hours = numberValue(values, 'hours')
        if (
          present &&
          assignment.pay_basis === 'hourly' &&
          (!Number.isFinite(hours) || hours <= 0 || hours > 24)
        )
          throw new InputError('上工小时数必须大于 0 且不超过 24')
        await repository.updateLaborEntry(projectCode, entry.entry_id, {
          assignment_id: assignment.assignment_id,
          work_date: textValue(values, 'work_date'),
          attendance_status: values.attendance_status as AttendanceStatus,
          day_fraction:
            present && assignment.pay_basis === 'daily'
              ? textValue(values, 'day_fraction')
              : null,
          work_minutes:
            present && assignment.pay_basis === 'hourly'
              ? Math.round(hours * 60)
              : null,
          work_summary: optionalText(values, 'work_summary'),
          notes: optionalText(values, 'notes'),
        })
      },
      () =>
        identityLocked ? (
          <Alert
            type="info"
            title="替代记录的人员和日期已锁定，仅可更正上工内容。"
          />
        ) : null,
    )
  }
  function openReport(report?: DemoSiteDailyReportViewModel) {
    if (report?.status === 'confirmed') return
    open(
      report ? '编辑施工日报' : '新建施工日报',
      report ? { ...report } : { work_date: workDate },
      [
        dateField('work_date', '施工日期', Boolean(report)),
        { key: 'location', label: '施工地点' },
        { key: 'weather', label: '天气' },
        { key: 'work_summary', label: '施工内容', type: 'textarea' },
        { key: 'blockers', label: '问题与阻塞', type: 'textarea' },
        { key: 'next_plan', label: '下一步计划', type: 'textarea' },
        note,
      ],
      async (values) => {
        await repository.saveSiteDailyReport(projectCode, {
          work_date: textValue(values, 'work_date'),
          location: optionalText(values, 'location'),
          weather: optionalText(values, 'weather'),
          work_summary: optionalText(values, 'work_summary'),
          blockers: optionalText(values, 'blockers'),
          next_plan: optionalText(values, 'next_plan'),
          notes: optionalText(values, 'notes'),
        })
      },
    )
  }
  function openAdvance(advance?: DemoMaterialAdvanceViewModel) {
    open(
      advance ? '编辑现场垫资' : '登记现场垫资',
      advance
        ? {
            ...advance,
            items: advance.items.map((item) => ({
              ...item,
              price: (item.unit_price_cents / 100).toFixed(2),
            })),
          }
        : { spent_on: workDate, worker_id: active[0]?.worker_id, items: [{}] },
      [
        dateField('spent_on', '支出日期'),
        {
          key: 'worker_id',
          label: '垫付人员',
          type: 'select',
          required: true,
          options: (values) =>
            workerOptions.filter((worker) =>
              model?.crew_assignments.some(
                (item) =>
                  item.worker_id === worker.value &&
                  ['planned', 'active'].includes(item.status) &&
                  item.scheduled_start_on <= textValue(values, 'spent_on') &&
                  item.scheduled_end_on >= textValue(values, 'spent_on'),
              ),
            ),
        },
        { key: 'vendor_name', label: '商家名称', required: true },
        note,
      ],
      async (values) => {
        const items = (values.items as Values[] | undefined) ?? []
        if (!items.length) throw new InputError('请至少填写一条采购明细')
        const workerId = numberValue(values, 'worker_id')
        const spentOn = textValue(values, 'spent_on')
        if (
          !workerOptions.some((item) => item.value === workerId) ||
          !model?.crew_assignments.some(
            (item) =>
              item.worker_id === workerId &&
              ['planned', 'active'].includes(item.status) &&
              item.scheduled_start_on <= spentOn &&
              item.scheduled_end_on >= spentOn,
          )
        )
          throw new InputError('垫付人员在该日期没有有效项目安排')
        const input = {
          worker_id: workerId,
          spent_on: spentOn,
          vendor_name: textValue(values, 'vendor_name'),
          notes: optionalText(values, 'notes'),
          document_version_ids: advance?.document_version_ids ?? [],
          items: items.map((item) => ({
            name: textValue(item, 'name'),
            specification: optionalText(item, 'specification'),
            brand: optionalText(item, 'brand'),
            quantity: textValue(item, 'quantity'),
            unit: textValue(item, 'unit'),
            unit_price_cents: yuanToCents(textValue(item, 'price')),
          })),
        }
        if (
          input.items.some(
            (item) =>
              !item.name ||
              !item.unit ||
              !/^\d+(\.\d{1,3})?$/.test(item.quantity) ||
              Number(item.quantity) <= 0,
          )
        )
          throw new InputError(
            '请填写完整的明细名称、单位及大于 0 的数量（最多三位小数）',
          )
        if (advance)
          await repository.updateMaterialAdvance(
            projectCode,
            advance.advance_id,
            input,
          )
        else await repository.saveMaterialAdvance(projectCode, input)
      },
      () => (
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <Space orientation="vertical" style={{ width: '100%' }}>
              {fields.map((field) => (
                <Card
                  size="small"
                  key={field.key}
                  title={`材料明细 ${field.name + 1}`}
                  extra={
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除材料明细 ${field.name + 1}`}
                      disabled={fields.length <= 1}
                      onClick={() => remove(field.name)}
                    />
                  }
                >
                  <Row gutter={12}>
                    {[
                      ['name', '材料名称'],
                      ['specification', '规格'],
                      ['brand', '品牌'],
                      ['quantity', '数量'],
                      ['unit', '单位'],
                      ['price', '单价（元）'],
                    ].map(([key, label]) => (
                      <Col span={12} key={key}>
                        <Form.Item
                          name={[field.name, key!]}
                          label={label}
                          rules={
                            ['name', 'quantity', 'unit', 'price'].includes(key!)
                              ? [{ required: true, message: `请填写${label}` }]
                              : []
                          }
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                    ))}
                  </Row>
                </Card>
              ))}
              <Button block icon={<PlusOutlined />} onClick={() => add({})}>
                添加材料明细
              </Button>
            </Space>
          )}
        </Form.List>
      ),
    )
  }
  function reimburse(advance: DemoMaterialAdvanceViewModel) {
    open(
      '登记报销',
      { reimbursed_on: localISODate(), payment_method: 'bank_transfer' },
      [
        {
          key: 'amount',
          label: '报销金额',
          type: 'money',
          required: true,
          help: `剩余待报销 ${formatMoney(advanceTotals(advance).outstanding)}`,
        },
        dateField('reimbursed_on', '报销日期'),
        {
          key: 'payment_method',
          label: '付款方式',
          type: 'select',
          options: options(paymentLabels),
          required: true,
        },
        note,
      ],
      async (values) => {
        const amount = yuanToCents(textValue(values, 'amount'))
        if (amount <= 0 || amount > advanceTotals(advance).outstanding)
          throw new InputError('报销金额必须大于 0 且不超过待报销金额')
        await repository.recordMaterialAdvanceReimbursement(
          projectCode,
          advance.advance_id,
          {
            amount_cents: amount,
            reimbursed_on: textValue(values, 'reimbursed_on'),
            payment_method: values.payment_method as
              'bank_transfer' | 'cash' | 'other',
            notes: optionalText(values, 'notes'),
          },
        )
      },
    )
  }
  function updateBatch(change: Partial<LaborFormDraft>) {
    const next = { selected, drafts, batchSummary, ...change }
    let projects = laborFormDrafts.get(repository)
    if (!projects) {
      projects = new Map()
      laborFormDrafts.set(repository, projects)
    }
    const stored = projects.get(projectCode) ?? {
      date: workDate,
      days: new Map<string, LaborFormDraft>(),
    }
    stored.date = workDate
    stored.days.set(workDate, structuredClone(next))
    projects.set(projectCode, stored)
    setSelected(next.selected)
    setDrafts(next.drafts)
    setBatchSummary(next.batchSummary)
  }
  function patchDraft(id: number, patch: Partial<LaborDraft>) {
    updateBatch({ drafts: { ...drafts, [id]: { ...drafts[id]!, ...patch } } })
  }
  const draftCost = (assignment: DemoCrewAssignmentViewModel) => {
    const draft = drafts[assignment.assignment_id]
    return !draft || draft.attendance !== 'present'
      ? 0
      : Math.round(
          assignment.rate_cents *
            (assignment.pay_basis === 'daily'
              ? Number(draft.fraction)
              : draft.hours),
        )
  }
  async function saveBatch() {
    if (mutationDisabled || blockedLabor || !selected.length) return
    const input: LaborEntryBatchInput = {
      work_date: workDate,
      entries: selected.map((id) => {
        const assignment = assignments.get(id)!
        const draft = drafts[id]!
        return {
          assignment_id: id,
          attendance_status: draft.attendance,
          day_fraction:
            draft.attendance === 'present' && assignment.pay_basis === 'daily'
              ? draft.fraction
              : null,
          work_minutes:
            draft.attendance === 'present' && assignment.pay_basis === 'hourly'
              ? Math.round(draft.hours * 60)
              : null,
          work_summary: draft.summary.trim() || null,
          notes: null,
        }
      }),
    }
    const send = async () => {
      await repository.saveLaborEntriesBatch(projectCode, input)
      laborFormDrafts
        .get(repository)
        ?.get(projectCode)
        ?.days.delete(input.work_date)
    }
    const submission: Pending = {
      snapshot: model,
      editor: {
        key: crypto.randomUUID(),
        title: `${workDate} 上工记录`,
        initial: {},
        fields: [],
        submit: send,
      },
      send,
      inFlight: false,
    }
    pendingMap(repository).set(projectCode, submission)
    await execute(send, submission)
  }
  const todayEntries =
    model?.labor_entries.filter(
      (entry) => entry.work_date === workDate && entry.status === 'active',
    ) ?? []
  const match = (...values: (string | null | undefined)[]) =>
    !search.trim() ||
    values.some((value) =>
      value?.toLowerCase().includes(search.trim().toLowerCase()),
    )
  const laborColumns: ColumnsType<DemoLaborEntryViewModel> = [
    {
      title: '日期',
      dataIndex: 'work_date',
      sorter: (a, b) => a.work_date.localeCompare(b.work_date),
    },
    {
      title: '施工员',
      render: (_, row) =>
        workerName(assignments.get(row.assignment_id)?.worker_id ?? 0),
    },
    {
      title: '出勤',
      dataIndex: 'attendance_status',
      render: (value: AttendanceStatus) => attendanceLabels[value],
    },
    {
      title: '上工量',
      render: (_, row) =>
        row.day_fraction
          ? `${Number(row.day_fraction)} 天`
          : row.work_minutes !== null
            ? `${row.work_minutes / 60} 小时`
            : '—',
    },
    { title: '人工成本', dataIndex: 'cost_cents', render: formatMoney },
    { title: '工作内容', dataIndex: 'work_summary', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      filters: [
        { text: '有效', value: 'active' },
        { text: '已作废', value: 'voided' },
      ],
      onFilter: (value, row) => row.status === value,
      render: (value: string, row) => (
        <Space>
          <Tag color={value === 'active' ? 'blue' : 'default'}>
            {value === 'active' ? '有效' : '已作废'}
          </Tag>
          {row.replaces_entry_id && <Tag>替代 #{row.replaces_entry_id}</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 140,
      render: (_, row) => (
        <Space>
          <Button
            type="link"
            disabled={mutationDisabled || row.status !== 'active'}
            onClick={() => openLabor(row)}
          >
            更正
          </Button>
          <Button
            type="link"
            danger
            disabled={mutationDisabled || row.status !== 'active'}
            onClick={() =>
              reason('作废上工记录', (reason) =>
                repository.voidLaborEntry(projectCode, row.entry_id, reason),
              )
            }
          >
            作废
          </Button>
        </Space>
      ),
    },
  ]
  const emptyRecords = (
    description: string,
    label: string,
    action: () => void,
  ) => ({
    emptyText: (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={search.trim() ? '没有符合搜索条件的记录' : description}
      >
        {search.trim() ? (
          <Button onClick={() => setSearch('')}>清除搜索</Button>
        ) : (
          !readonly && (
            <Button disabled={mutationDisabled} onClick={action}>
              {label}
            </Button>
          )
        )}
      </Empty>
    ),
  })
  const laborContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {!readonly &&
        laborFormDrafts
          .get(repository)
          ?.get(projectCode)
          ?.days.has(workDate) && (
          <Alert
            type="info"
            showIcon
            title="有未保存的上工填写"
            description="已在本次会话暂存，切换页面后可以继续。请保存上工记录后再关闭浏览器。"
          />
        )}
      <Typography.Text type="secondary">
        选择上工日期，勾选人员后填写出勤与工作内容，再保存本次上工记录。
      </Typography.Text>
      <Space wrap>
        <Typography.Text strong>上工日期</Typography.Text>
        <div style={{ width: 180 }}>
          <DateInput
            value={workDate}
            onChange={(value) => value && setWorkDate(value)}
            disabled={busy || Boolean(pending)}
          />
        </div>
        <Tag color="blue">可上工 {active.length} 人</Tag>
        <Tag>已登记 {todayEntries.length} 条</Tag>
        <Typography.Text strong>
          当天人工{' '}
          {formatMoney(
            todayEntries.reduce((sum, row) => sum + row.cost_cents, 0),
          )}
        </Typography.Text>
      </Space>
      {blockedLabor && (
        <Alert
          type="warning"
          showIcon
          title="人员、安排或工时未完整载入，请刷新后再登记。"
        />
      )}
      {!readonly && (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={batchSummary}
              onChange={(event) =>
                updateBatch({ batchSummary: event.target.value })
              }
              aria-label="统一工作内容"
              placeholder="统一填写工作内容"
              disabled={mutationDisabled}
            />
            <Button
              disabled={
                mutationDisabled || !selected.length || !batchSummary.trim()
              }
              onClick={() =>
                updateBatch({
                  drafts: Object.fromEntries(
                    Object.entries(drafts).map(([id, draft]) => [
                      id,
                      selected.includes(Number(id))
                        ? { ...draft, summary: batchSummary.trim() }
                        : draft,
                    ]),
                  ),
                })
              }
            >
              应用到已选人员
            </Button>
          </Space.Compact>
          <Table
            size="small"
            rowKey="assignment_id"
            dataSource={active}
            pagination={false}
            scroll={{ x: 900 }}
            locale={{
              emptyText: (
                <Empty description="当前日期没有可上工的项目人员">
                  <Button
                    disabled={mutationDisabled}
                    onClick={() =>
                      workerOptions.length ? openAssignment() : openWorker()
                    }
                  >
                    {workerOptions.length ? '添加项目工人' : '新建施工员'}
                  </Button>
                </Empty>
              ),
            }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => updateBatch({ selected: keys.map(Number) }),
              getCheckboxProps: () => ({
                disabled: mutationDisabled || blockedLabor,
              }),
            }}
            columns={[
              {
                title: '施工员 / 工种',
                render: (_, row) => (
                  <Space orientation="vertical" size={0}>
                    <strong>{workerName(row.worker_id)}</strong>
                    <Typography.Text type="secondary">
                      {row.role}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: '到场状态',
                render: (_, row) => (
                  <Select
                    aria-label={`${workerName(row.worker_id)}的到场状态`}
                    style={{ width: 100 }}
                    value={drafts[row.assignment_id]?.attendance}
                    options={options(attendanceLabels)}
                    disabled={
                      mutationDisabled || !selected.includes(row.assignment_id)
                    }
                    onChange={(attendance) =>
                      patchDraft(row.assignment_id, { attendance })
                    }
                  />
                ),
              },
              {
                title: '上工量',
                render: (_, row) =>
                  drafts[row.assignment_id]?.attendance !== 'present' ? (
                    '不计薪'
                  ) : row.pay_basis === 'daily' ? (
                    <Select
                      aria-label={`${workerName(row.worker_id)}的上工量`}
                      style={{ width: 100 }}
                      value={drafts[row.assignment_id]?.fraction}
                      options={options({ '1.000': '全天', '0.500': '半天' })}
                      disabled={
                        mutationDisabled ||
                        !selected.includes(row.assignment_id)
                      }
                      onChange={(fraction) =>
                        patchDraft(row.assignment_id, { fraction })
                      }
                    />
                  ) : (
                    <InputNumber
                      aria-label={`${workerName(row.worker_id)}的上工小时数`}
                      min={0.25}
                      max={24}
                      step={0.5}
                      value={drafts[row.assignment_id]?.hours}
                      disabled={
                        mutationDisabled ||
                        !selected.includes(row.assignment_id)
                      }
                      onChange={(value) =>
                        patchDraft(row.assignment_id, { hours: value ?? 8 })
                      }
                    />
                  ),
              },
              {
                title: '工资计算',
                render: (_, row) => (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text type="secondary">
                      {formatMoney(row.rate_cents)} /{' '}
                      {row.pay_basis === 'daily' ? '日' : '小时'}
                    </Typography.Text>
                    <strong>{formatMoney(draftCost(row))}</strong>
                  </Space>
                ),
              },
              {
                title: '工作内容',
                render: (_, row) => (
                  <Input
                    aria-label={`${workerName(row.worker_id)}的工作内容`}
                    value={drafts[row.assignment_id]?.summary}
                    disabled={
                      mutationDisabled || !selected.includes(row.assignment_id)
                    }
                    onChange={(event) =>
                      patchDraft(row.assignment_id, {
                        summary: event.target.value,
                      })
                    }
                  />
                ),
              },
            ]}
          />
          <Space>
            <Button
              type="primary"
              disabled={mutationDisabled || blockedLabor || !selected.length}
              loading={busy}
              onClick={() => void saveBatch()}
            >
              保存 {selected.length} 人上工记录
            </Button>
            <Button
              disabled={mutationDisabled}
              onClick={() => {
                updateBatch({
                  selected: active.map((item) => item.assignment_id),
                  drafts: Object.fromEntries(
                    Object.entries(drafts).map(([id, draft]) => [
                      id,
                      { ...draft, attendance: 'present' },
                    ]),
                  ),
                })
              }}
            >
              全选到场
            </Button>
            <Button
              disabled={mutationDisabled || !selected.length}
              onClick={() => updateBatch({ selected: [] })}
            >
              清空选择
            </Button>
          </Space>
        </>
      )}
    </Space>
  )
  const laborHistoryContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        查询已登记的出勤与费用；更正和作废会保留原记录。
      </Typography.Text>
      <RecordSearch
        label="搜索上工历史"
        value={search}
        onChange={setSearch}
        placeholder="施工员或工作内容"
      />
      <Space wrap>
        <label htmlFor="labor-from">开始日期</label>
        <div style={{ width: 150 }}>
          <DateInput
            id="labor-from"
            value={laborFrom}
            onChange={setLaborFrom}
          />
        </div>
        <label htmlFor="labor-to">结束日期</label>
        <div style={{ width: 150 }}>
          <DateInput id="labor-to" value={laborTo} onChange={setLaborTo} />
        </div>
        <Typography.Text>施工员</Typography.Text>
        <Select
          style={{ width: 160 }}
          allowClear
          placeholder="全部施工员"
          aria-label="筛选施工员"
          value={laborWorker}
          onChange={setLaborWorker}
          options={(model?.workers ?? []).map((worker) => ({
            value: worker.worker_id,
            label: worker.name,
          }))}
        />
      </Space>
      <Table
        size="small"
        rowKey="entry_id"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                search || laborFrom || laborTo || laborWorker
                  ? '没有符合筛选条件的上工记录'
                  : '尚无上工记录'
              }
            >
              {search || laborFrom || laborTo || laborWorker ? (
                <Button
                  onClick={() => {
                    setSearch('')
                    setLaborFrom('')
                    setLaborTo('')
                    setLaborWorker(undefined)
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                !readonly && (
                  <Button onClick={() => setActiveTab('labor')}>
                    前往上工登记
                  </Button>
                )
              )}
            </Empty>
          ),
        }}
        pagination={pagination}
        columns={laborColumns}
        scroll={{ x: 1000 }}
        dataSource={model?.labor_entries.filter(
          (row) =>
            (!laborFrom || row.work_date >= laborFrom) &&
            (!laborTo || row.work_date <= laborTo) &&
            (!laborWorker ||
              assignments.get(row.assignment_id)?.worker_id === laborWorker) &&
            match(
              row.work_summary,
              workerName(assignments.get(row.assignment_id)?.worker_id ?? 0),
            ),
        )}
        expandable={{
          expandedRowRender: (row) => (
            <Descriptions
              size="small"
              items={[
                { key: 'notes', label: '备注', children: row.notes || '—' },
                {
                  key: 'void',
                  label: '作废原因',
                  children: row.void_reason || '—',
                },
              ]}
            />
          ),
        }}
      />
    </Space>
  )
  const peopleContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={
            mutationDisabled || hasWarning('workers', 'crew_assignments')
          }
          onClick={() => openAssignment()}
        >
          添加项目工人
        </Button>
        <Button onClick={() => setActiveTab('workers')}>管理施工员档案</Button>
        <Typography.Text type="secondary">
          先选人员，再设置工种、排期与计薪标准。
        </Typography.Text>
      </Space>
      <RecordSearch
        label="搜索项目安排"
        value={search}
        onChange={setSearch}
        placeholder="施工员或工种"
      />
      <Table
        locale={emptyRecords('本项目尚未安排施工员', '安排首位项目工人', () =>
          workerOptions.length ? openAssignment() : openWorker(),
        )}
        rowKey="assignment_id"
        size="small"
        pagination={pagination}
        dataSource={model?.crew_assignments.filter((row) =>
          match(workerName(row.worker_id), row.role),
        )}
        scroll={{ x: 900 }}
        columns={[
          {
            title: '施工员 / 工种',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>
                  {workerName(row.worker_id)}
                </Typography.Text>
                <Typography.Text type="secondary">{row.role}</Typography.Text>
              </Space>
            ),
          },
          {
            title: '项目排期',
            render: (_, row) =>
              `${row.scheduled_start_on} 至 ${row.scheduled_end_on === '9999-12-31' ? '长期' : row.scheduled_end_on}`,
          },
          {
            title: '计薪标准',
            render: (_, row) =>
              `${formatMoney(row.rate_cents)} / ${row.pay_basis === 'daily' ? '日' : '小时'}`,
          },
          {
            title: '上工历史',
            render: (_, row) => {
              const entries =
                model?.labor_entries.filter(
                  (entry) =>
                    entry.assignment_id === row.assignment_id &&
                    entry.status === 'active',
                ) ?? []
              const dates = entries.map((entry) => entry.work_date).sort()
              return (
                <Space orientation="vertical" size={0}>
                  <span>
                    {entries.length} 次 ·{' '}
                    {formatMoney(
                      entries.reduce((sum, entry) => sum + entry.cost_cents, 0),
                    )}
                  </span>
                  {dates.length > 0 && (
                    <Typography.Text type="secondary">
                      {dates[0]} 至 {dates[dates.length - 1]}
                    </Typography.Text>
                  )}
                </Space>
              )
            },
          },
          {
            title: '状态',
            dataIndex: 'status',
            filters: options(assignmentLabels).map((item) => ({
              text: item.label,
              value: item.value,
            })),
            onFilter: (value, row) => row.status === value,
            render: (value: CrewAssignmentStatus) => (
              <Tag color={value === 'active' ? 'blue' : 'default'}>
                {assignmentLabels[value]}
              </Tag>
            ),
          },
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={
                    mutationDisabled ||
                    !['planned', 'active'].includes(row.status)
                  }
                  onClick={() => openAssignment(row)}
                >
                  编辑
                </Button>
                {row.status === 'planned' && (
                  <Button
                    type="link"
                    disabled={mutationDisabled}
                    onClick={() =>
                      void executeDirect(
                        `开始 ${workerName(row.worker_id)} 的${row.role}安排`,
                        () =>
                          repository.setCrewAssignmentStatus(
                            projectCode,
                            row.assignment_id,
                            'active',
                            null,
                          ),
                      )
                    }
                  >
                    开始
                  </Button>
                )}
                {['planned', 'active'].includes(row.status) && (
                  <>
                    <Button
                      type="link"
                      disabled={mutationDisabled}
                      onClick={() =>
                        reason(
                          '完成项目安排',
                          (reason) =>
                            repository.setCrewAssignmentStatus(
                              projectCode,
                              row.assignment_id,
                              'completed',
                              reason || null,
                            ),
                          false,
                        )
                      }
                    >
                      完成
                    </Button>
                    <Button
                      type="link"
                      danger
                      disabled={mutationDisabled}
                      onClick={() =>
                        reason('取消项目安排', (reason) =>
                          repository.setCrewAssignmentStatus(
                            projectCode,
                            row.assignment_id,
                            'cancelled',
                            reason,
                          ),
                        )
                      }
                    >
                      取消
                    </Button>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  )
  const workersContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={mutationDisabled || hasWarning('workers')}
          onClick={() => openWorker()}
        >
          新建施工员
        </Button>
        <Typography.Text type="secondary">
          维护姓名、联系方式和在职状态；安排到本项目后才可登记上工。
        </Typography.Text>
      </Space>
      <RecordSearch
        label="搜索施工员"
        value={search}
        onChange={setSearch}
        placeholder="姓名、电话或备注"
      />
      <Table
        locale={emptyRecords('尚无施工员档案', '建立首位施工员档案', () =>
          openWorker(),
        )}
        rowKey="worker_id"
        size="small"
        pagination={pagination}
        dataSource={model?.workers.filter((row) =>
          match(row.name, row.phone, row.notes),
        )}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '联系电话', dataIndex: 'phone' },
          { title: '备注', dataIndex: 'notes' },
          {
            title: '状态',
            dataIndex: 'status',
            filters: options(workerLabels).map((item) => ({
              text: item.label,
              value: item.value,
            })),
            onFilter: (value, row) => row.status === value,
            render: (value: keyof typeof workerLabels) => (
              <Tag color={value === 'active' ? 'green' : 'default'}>
                {workerLabels[value]}
              </Tag>
            ),
          },
          {
            title: '操作',
            render: (_, row) => (
              <Space>
                <Button
                  type="link"
                  disabled={mutationDisabled}
                  onClick={() => openWorker(row)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title={`确认${row.status === 'active' ? '停用' : '启用'} ${row.name}？`}
                  onConfirm={() =>
                    executeDirect(
                      `${row.status === 'active' ? '停用' : '启用'}施工员 ${row.name}`,
                      () =>
                        repository.setWorkerStatus(
                          row.worker_id,
                          row.status === 'active' ? 'inactive' : 'active',
                        ),
                    )
                  }
                  disabled={mutationDisabled}
                >
                  <Button
                    type="link"
                    danger={row.status === 'active'}
                    disabled={mutationDisabled}
                  >
                    {row.status === 'active' ? '停用' : '启用'}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  )
  const reportsContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={mutationDisabled || hasWarning('site_daily_reports')}
        onClick={() => openReport()}
      >
        新建施工日报
      </Button>
      <Space wrap>
        <Tag color="blue">
          待确认{' '}
          {model?.site_daily_reports.filter((row) => row.status === 'draft')
            .length ?? 0}{' '}
          份
        </Tag>
        <RecordSearch
          label="搜索施工日报"
          value={search}
          onChange={setSearch}
          placeholder="日期、地点或施工内容"
        />
      </Space>
      <Table
        locale={emptyRecords('尚未填写施工日报', '填写首份施工日报', () =>
          openReport(),
        )}
        rowKey="work_date"
        size="small"
        pagination={pagination}
        dataSource={model?.site_daily_reports.filter((row) =>
          match(row.work_summary, row.location, row.work_date),
        )}
        columns={[
          {
            title: '日期',
            dataIndex: 'work_date',
            sorter: (a, b) => a.work_date.localeCompare(b.work_date),
          },
          {
            title: '地点 / 天气',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>{row.location || '未填写地点'}</span>
                <Typography.Text type="secondary">
                  {row.weather || '未填写天气'}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '施工内容', dataIndex: 'work_summary', ellipsis: true },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value) => (
              <Tag color={value === 'confirmed' ? 'green' : 'default'}>
                {value === 'confirmed' ? '已确认' : '草稿'}
              </Tag>
            ),
          },
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button type="link" onClick={() => setHistory(row)}>
                  详情与历史
                </Button>
                {row.status === 'draft' ? (
                  <>
                    <Button
                      type="link"
                      disabled={mutationDisabled}
                      onClick={() => openReport(row)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="确认日报后将锁定内容，修改需填写原因重新打开。"
                      onConfirm={() =>
                        executeDirect(`确认 ${row.work_date} 施工日报`, () =>
                          repository.confirmSiteDailyReport(
                            projectCode,
                            row.work_date,
                          ),
                        )
                      }
                      disabled={mutationDisabled}
                    >
                      <Button type="link" disabled={mutationDisabled}>
                        确认
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  <Button
                    type="link"
                    disabled={mutationDisabled}
                    onClick={() =>
                      reason('重新打开施工日报', (reason) =>
                        repository.reopenSiteDailyReport(
                          projectCode,
                          row.work_date,
                          reason,
                        ),
                      )
                    }
                  >
                    重新打开
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  )
  const advancesContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={
          mutationDisabled ||
          hasWarning('material_advances', 'workers', 'crew_assignments')
        }
        onClick={() => openAdvance()}
      >
        登记现场垫资
      </Button>
      <Space wrap>
        <Tag color="orange">
          待报销{' '}
          {formatMoney(
            model?.material_advances
              .filter((row) => row.status !== 'voided')
              .reduce((sum, row) => sum + advanceTotals(row).outstanding, 0) ??
              0,
          )}
        </Tag>
        <RecordSearch
          label="搜索垫资记录"
          value={search}
          onChange={setSearch}
          placeholder="垫付人员、商家或备注"
        />
      </Space>
      <Table
        locale={emptyRecords('尚无现场垫资记录', '登记首笔现场垫资', () =>
          openAdvance(),
        )}
        rowKey="advance_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 1000 }}
        dataSource={model?.material_advances.filter((row) =>
          match(workerName(row.worker_id), row.vendor_name, row.notes),
        )}
        columns={[
          { title: '支出日期', dataIndex: 'spent_on' },
          { title: '垫付人员', render: (_, row) => workerName(row.worker_id) },
          { title: '商家', dataIndex: 'vendor_name' },
          {
            title: '垫付总额',
            render: (_, row) => formatMoney(advanceTotals(row).total),
          },
          {
            title: '已报销',
            render: (_, row) => formatMoney(advanceTotals(row).reimbursed),
          },
          {
            title: '待报销',
            render: (_, row) => formatMoney(advanceTotals(row).outstanding),
          },
          {
            title: '状态',
            dataIndex: 'status',
            filters: options(advanceLabels).map((item) => ({
              text: item.label,
              value: item.value,
            })),
            onFilter: (value, row) => row.status === value,
            render: (value: keyof typeof advanceLabels) => (
              <Tag>{advanceLabels[value]}</Tag>
            ),
          },
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={
                    mutationDisabled ||
                    row.status === 'voided' ||
                    advanceTotals(row).reimbursed > 0
                  }
                  onClick={() => openAdvance(row)}
                >
                  编辑
                </Button>
                <Button
                  type="link"
                  disabled={
                    mutationDisabled ||
                    row.status === 'voided' ||
                    advanceTotals(row).outstanding <= 0
                  }
                  onClick={() => reimburse(row)}
                >
                  报销
                </Button>
                <Button
                  type="link"
                  danger
                  disabled={
                    mutationDisabled ||
                    row.status === 'voided' ||
                    advanceTotals(row).reimbursed > 0
                  }
                  onClick={() =>
                    reason('作废现场垫资', (reason) =>
                      repository.voidMaterialAdvance(
                        projectCode,
                        row.advance_id,
                        reason,
                      ),
                    )
                  }
                >
                  作废
                </Button>
              </Space>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Descriptions
                size="small"
                items={[
                  { key: 'notes', label: '备注', children: row.notes || '—' },
                  {
                    key: 'void',
                    label: '作废原因',
                    children: row.void_reason || '—',
                  },
                  {
                    key: 'files',
                    label: '附件',
                    children: (
                      <AttachmentLinks
                        projectCode={projectCode}
                        ids={row.document_version_ids}
                      />
                    ),
                  },
                ]}
              />
              <Table
                size="small"
                rowKey={(_, index) => String(index)}
                pagination={false}
                dataSource={row.items}
                columns={[
                  { title: '材料名称', dataIndex: 'name' },
                  { title: '规格', dataIndex: 'specification' },
                  { title: '品牌', dataIndex: 'brand' },
                  { title: '数量', dataIndex: 'quantity' },
                  { title: '单位', dataIndex: 'unit' },
                  {
                    title: '单价',
                    dataIndex: 'unit_price_cents',
                    render: formatMoney,
                  },
                  {
                    title: '金额',
                    dataIndex: 'line_amount_cents',
                    render: formatMoney,
                  },
                ]}
              />
              <Typography.Text strong>报销记录</Typography.Text>
              <Table
                rowKey="reimbursement_id"
                size="small"
                pagination={false}
                dataSource={row.reimbursements}
                columns={[
                  { title: '日期', dataIndex: 'reimbursed_on' },
                  {
                    title: '金额',
                    dataIndex: 'amount_cents',
                    render: formatMoney,
                  },
                  {
                    title: '付款方式',
                    dataIndex: 'payment_method',
                    render: (value: keyof typeof paymentLabels) =>
                      paymentLabels[value],
                  },
                  {
                    title: '状态',
                    render: (_, item) =>
                      item.status === 'active'
                        ? '有效'
                        : `已作废：${item.void_reason ?? ''}`,
                  },
                  { title: '备注', dataIndex: 'notes' },
                  {
                    title: '操作',
                    render: (_, item) => (
                      <Button
                        type="link"
                        danger
                        disabled={mutationDisabled || item.status !== 'active'}
                        onClick={() =>
                          reason('作废报销记录', (reason) =>
                            repository.voidMaterialAdvanceReimbursement(
                              projectCode,
                              row.advance_id,
                              item.reimbursement_id,
                              reason,
                            ),
                          )
                        }
                      >
                        作废报销
                      </Button>
                    ),
                  },
                ]}
              />
            </Space>
          ),
        }}
      />
    </Space>
  )
  return (
    <Space
      orientation="vertical"
      size={20}
      style={{ width: '100%' }}
      data-testid="react-workforce-workspace"
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Text type="secondary">
          本项目{' '}
          {new Set(model?.crew_assignments.map((item) => item.worker_id)).size}{' '}
          位施工员 · 累计人工{' '}
          {formatMoney(
            model?.labor_entries
              .filter((item) => item.status === 'active')
              .reduce((sum, item) => sum + item.cost_cents, 0) ?? 0,
          )}
        </Typography.Text>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          disabled={busy || Boolean(editor) || Boolean(pending)}
          onClick={() => void refresh().catch(() => undefined)}
        >
          刷新
        </Button>
      </Space>
      {readonly && (
        <Alert type="info" showIcon title="项目已归档，本页仅供查看" />
      )}
      {model?.load_warnings?.map((warning) => (
        <Alert
          key={warning.section}
          type="warning"
          showIcon
          title={warning.message}
        />
      ))}
      {error && <Alert type="error" showIcon title={error} />}
      {success && <Alert type="success" showIcon title={success} />}
      {pending && !readonly && (
        <Alert
          type="warning"
          showIcon
          title={`${pending.editor.title}：有一笔提交等待确认`}
          action={
            <Button
              disabled={busy || pending.inFlight}
              onClick={() => setEditor({ ...pending.editor, frozen: true })}
            >
              恢复并重试
            </Button>
          }
        />
      )}
      {!pending &&
        !editor &&
        !readonly &&
        getEditorDraft(repository, projectCode) && (
          <Alert
            type="info"
            showIcon
            title={`${getEditorDraft(repository, projectCode)!.title}：有未保存的草稿`}
            action={
              <Button
                onClick={() =>
                  setEditor(getEditorDraft(repository, projectCode) ?? null)
                }
              >
                继续填写
              </Button>
            }
          />
        )}
      <Card
        loading={loading && !model}
        styles={{ body: { padding: '0 16px 16px' } }}
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'labor', label: '上工登记', children: laborContent },
            {
              key: 'labor-history',
              label: '上工历史',
              children: laborHistoryContent,
            },
            { key: 'people', label: '项目安排', children: peopleContent },
            { key: 'workers', label: '施工员档案', children: workersContent },
            { key: 'reports', label: '施工日报', children: reportsContent },
            { key: 'advances', label: '垫资与报销', children: advancesContent },
          ]}
        />
      </Card>
      <ActionDrawer
        draftOwner={repository}
        draftKey={projectCode}
        editor={editor}
        busy={busy}
        error={formError}
        onClose={() => setEditor(null)}
        onSave={save}
      />
      <Modal
        open={Boolean(history)}
        title={`${history?.work_date ?? ''} 施工日报详情与历史`}
        width={820}
        onCancel={() => setHistory(null)}
        footer={<Button onClick={() => setHistory(null)}>关闭</Button>}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          {history && (
            <>
              <Descriptions
                bordered
                size="small"
                column={1}
                items={[
                  ['地点', history.location],
                  ['天气', history.weather],
                  ['施工内容', history.work_summary],
                  ['问题与阻塞', history.blockers],
                  ['下一步计划', history.next_plan],
                  ['备注', history.notes],
                ].map(([label, value]) => ({
                  key: String(label),
                  label,
                  children: value || '—',
                }))}
              />
              <Typography.Title level={5}>已确认版本</Typography.Title>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={history.versions}
                columns={[
                  { title: '版本', dataIndex: 'version_number' },
                  { title: '确认时间', dataIndex: 'confirmed_at' },
                  { title: '施工内容', dataIndex: 'work_summary' },
                ]}
                expandable={{
                  expandedRowRender: (version) => (
                    <Descriptions
                      size="small"
                      column={1}
                      items={[
                        ['地点', version.location],
                        ['天气', version.weather],
                        ['阻塞', version.blockers],
                        ['下一步计划', version.next_plan],
                        ['备注', version.notes],
                      ].map(([label, value]) => ({
                        key: String(label),
                        label,
                        children: value || '—',
                      }))}
                    />
                  ),
                }}
              />
              <Typography.Title level={5}>状态历史</Typography.Title>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={history.events}
                columns={[
                  { title: '时间', dataIndex: 'occurred_at' },
                  {
                    title: '流转',
                    render: (_, event) =>
                      `${event.from_status === 'draft' ? '草稿' : '已确认'} → ${event.to_status === 'draft' ? '草稿' : '已确认'}`,
                  },
                  { title: '原因', dataIndex: 'reason' },
                ]}
              />
            </>
          )}
        </Space>
      </Modal>
    </Space>
  )
}
