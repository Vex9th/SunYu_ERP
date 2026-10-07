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
  Modal,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { ApiError } from '../../api'
import { useWorkspaceTab, useWorkspaceValue } from '../shared'
import {
  localISODate,
  localISODateTimeInput,
  formatChineseDateTime,
} from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import { optionalYuanToCents, signedYuanToCents } from '../../domain/workforce'
import type {
  AcceptanceInput,
  AfterSalesInput,
  AfterSalesStatus,
  CommissioningSessionInput,
  DeliveryDemoViewModel,
  DeliverySummaryViewModel,
  DemoAcceptanceViewModel,
  DemoAfterSalesCaseViewModel,
  DemoCommissioningSessionViewModel,
  DemoEngineeringChangeViewModel,
  DemoInvoiceViewModel,
  DrawingDiscipline,
  DrawingSignoffInput,
  EngineeringChangeInput,
  EngineeringChangeStatus,
  InvoiceInput,
} from '../../domain/workforce'
import {
  createHttpDeliveryRepository,
  type DeliveryWorkspaceRepository,
  type DeliveryAcceptanceCompletionInput,
  type NullableWarrantyInput,
} from '../../repositories/delivery.live'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'
import {
  ActionDrawer,
  RecordSearch,
  getEditorDraft,
  clearEditorDraft,
  AttachmentLinks,
  createPendingRegistry,
  errorText,
  idsValue,
  numberValue,
  optionalText,
  options,
  textValue,
  type Editor,
  type Field,
  type Values,
} from '../workforce/ui'

export interface DeliveryWorkspaceProps {
  projectCode: string
  readonly?: boolean
  scope?: 'all' | 'commissioning' | 'delivery'
  repository?: DeliveryWorkspaceRepository
}
type CreateKind =
  'commissioning' | 'change' | 'acceptance' | 'invoice' | 'after-sales'
interface PendingCreate {
  kind: CreateKind | 'mutation'
  snapshot: DeliveryDemoViewModel | null
  editor: Editor
  send: () => Promise<void>
  discard: () => boolean
  inFlight: boolean
}
const repositories = new Map<string, DeliveryWorkspaceRepository>()
const pendingRegistry = createPendingRegistry<PendingCreate>()
const disciplines = { mechanical: '机械图纸', electrical: '电气图纸' }
const signoffs = {
  pending: '待确认',
  confirmed: '已确认',
  not_required: '无需图纸',
}
const commissioningStatuses = {
  planned: '已计划',
  in_progress: '调试中',
  blocked: '阻塞',
  completed: '已完成',
  cancelled: '已取消',
}
const changeStatuses = {
  proposed: '已提出',
  approved: '已批准',
  rejected: '已拒绝',
  implemented: '已实施',
  cancelled: '已取消',
}
const changeSources = {
  commissioning: '调试',
  customer_request: '客户要求',
  site_condition: '现场条件',
  technical_agreement: '技术协议',
  other: '其他',
}
const acceptanceTypes = {
  pre_acceptance: '预验收',
  final: '最终验收',
  reinspection: '复验',
}
const acceptanceStatuses = {
  scheduled: '已安排',
  passed: '通过',
  passed_with_punch: '带整改项通过',
  failed: '未通过',
  cancelled: '已取消',
}
const invoiceTypes = {
  contract_payment: '合同款',
  additional_work: '增补工作',
  warranty_service: '质保服务',
  other: '其他',
}
const invoiceStatuses = {
  planned: '计划中',
  requested: '已申请',
  recorded: '已登记',
  void: '已作废',
}
const coverageTypes = {
  warranty: '保内处理',
  paid: '付费服务',
  goodwill: '善意支持',
}
const afterSalesStatuses = {
  open: '待处理',
  in_progress: '处理中',
  completed: '已完成',
  cancelled: '已取消',
}
const warrantyStatuses = {
  not_started: '未开始',
  active: '生效中',
  expiring: '即将到期',
  expired: '已到期',
}
export const changeTransitions: Record<
  EngineeringChangeStatus,
  EngineeringChangeStatus[]
> = {
  proposed: ['approved', 'rejected', 'cancelled'],
  approved: ['implemented', 'cancelled'],
  rejected: [],
  implemented: [],
  cancelled: [],
}
export const afterSalesTransitions: Record<
  AfterSalesStatus,
  AfterSalesStatus[]
> = {
  open: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}
const note: Field = { key: 'notes', label: '备注', type: 'textarea' }
const documentsField: Field = {
  key: 'document_version_ids',
  label: '关联资料',
  type: 'documents',
}
const date = (key: string, label: string, required = true): Field => ({
  key,
  label,
  type: 'date',
  required,
})
const choice = (
  key: string,
  label: string,
  labels: Record<string, string>,
): Field => ({
  key,
  label,
  type: 'select',
  options: options(labels),
  required: true,
})
const area = (key: string, label: string, required = false): Field => ({
  key,
  label,
  type: 'textarea',
  required,
})
const money = (key: string, label: string, required = false): Field => ({
  key,
  label,
  type: 'money',
  required,
})
const pagination = {
  defaultPageSize: 10,
  showSizeChanger: true,
  showTotal: (total: number) => `共 ${total} 条`,
}
function repositoryFor(project: string) {
  let repository = repositories.get(project)
  if (!repository) {
    repository = createHttpDeliveryRepository()
    repositories.set(project, repository)
  }
  return repository
}
const pendingMap = (repository: DeliveryWorkspaceRepository) =>
  pendingRegistry.forOwner(repository)
function statusColor(value: string) {
  return [
    'confirmed',
    'completed',
    'implemented',
    'passed',
    'active',
    'recorded',
  ].includes(value)
    ? 'green'
    : ['blocked', 'failed', 'rejected', 'expired'].includes(value)
      ? 'red'
      : ['in_progress', 'approved', 'requested'].includes(value)
        ? 'blue'
        : ['passed_with_punch', 'expiring', 'open'].includes(value)
          ? 'gold'
          : 'default'
}
function statusColumn<T extends { status: string }>(
  labels: Record<string, string>,
): ColumnsType<T>[number] {
  return {
    title: '状态',
    dataIndex: 'status',
    render: (value: string) => (
      <Tag color={statusColor(value)}>{labels[value] ?? value}</Tag>
    ),
  }
}
function warrantyInput(values: Values, prefix = ''): NullableWarrantyInput {
  return {
    starts_on: textValue(values, `${prefix}starts_on`),
    duration_months: numberValue(values, `${prefix}duration_months`),
    renewal_price_cents: optionalYuanToCents(
      textValue(values, `${prefix}renewal_price`),
    ),
    notes: optionalText(values, `${prefix}notes`),
  }
}
export function invoiceInput(values: Values, fileCount: number): InvoiceInput {
  const status = textValue(values, 'status') as InvoiceInput['status']
  const requested =
    status === 'planned' ? null : optionalText(values, 'requested_on')
  const recorded =
    status === 'recorded' ? optionalText(values, 'recorded_on') : null
  const amount = optionalYuanToCents(textValue(values, 'amount'))
  const number = optionalText(values, 'invoice_number')
  if (
    !fileCount &&
    !idsValue(values).length &&
    !number &&
    amount === null &&
    !optionalText(values, 'counterparty_name') &&
    !requested &&
    !optionalText(values, 'notes')
  )
    throw new Error('请至少上传一个文件、关联资料或填写一项发票信息')
  if (status === 'requested' && !requested)
    throw new Error('请填写发票申请日期')
  if (
    status === 'recorded' &&
    (!requested || !recorded || !number || amount === null)
  )
    throw new Error('已登记发票必须填写申请日期、登记日期、发票号码和金额')
  if (requested && recorded && recorded < requested)
    throw new Error('登记日期不能早于申请日期')
  if (!['planned', 'requested', 'recorded'].includes(status))
    throw new Error('请选择正确的发票状态')
  return {
    invoice_type: values.invoice_type as InvoiceInput['invoice_type'],
    status,
    requested_on: requested,
    recorded_on: recorded,
    invoice_number: number,
    amount_cents: amount,
    counterparty_name: optionalText(values, 'counterparty_name'),
    notes: optionalText(values, 'notes'),
    document_version_ids: idsValue(values),
  }
}

export default function DeliveryWorkspace({
  projectCode,
  readonly = false,
  scope = 'all',
  repository: suppliedRepository,
}: DeliveryWorkspaceProps) {
  useSyncExternalStore(pendingRegistry.subscribe, pendingRegistry.getSnapshot)
  const priorPending = useRef(false)
  const repository = useMemo(
    () => suppliedRepository ?? repositoryFor(projectCode),
    [suppliedRepository, projectCode],
  )
  const [model, setModel] = useState<DeliveryDemoViewModel | null>(null)
  const [summary, setSummary] = useState<DeliverySummaryViewModel | null>(null)
  const [documents, setDocuments] = useState<DocumentVersionOption[]>([])
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [documentError, setDocumentError] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [search, setSearch] = useWorkspaceValue('q', '')
  const [activeTab, setActiveTab] = useWorkspaceTab(
    'section',
    scope === 'all'
      ? ['commissioning', 'changes', 'acceptance', 'invoices', 'after-sales']
      : scope === 'commissioning'
        ? ['commissioning', 'changes']
        : ['acceptance', 'invoices', 'after-sales'],
    scope === 'delivery' ? 'acceptance' : 'commissioning',
  )
  const [statusFilters, setStatusFilters] = useState<Record<string, string>>({})
  const [modal, modalHolder] = Modal.useModal()
  const generation = useRef(0)
  const requestSequence = useRef(0)
  const summarySequence = useRef(0)
  const documentSequence = useRef(0)
  const context = useRef({ projectCode, repository, readonly })
  context.current = { projectCode, repository, readonly }
  const actionLock = useRef(false)
  const submittingEditor = useRef<Editor | null>(null)
  const current = (
    project: string,
    repo: DeliveryWorkspaceRepository,
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
      const result = await repository.getDeliveryPreview(projectCode)
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
  async function refreshSummary() {
    const sequence = ++summarySequence.current
    const version = generation.current
    setSummaryLoading(true)
    try {
      const result = await repository.getDeliverySummary(projectCode)
      if (
        current(projectCode, repository, version) &&
        sequence === summarySequence.current
      ) {
        setSummary(result.data)
        setSummaryError('')
      }
    } catch (failure) {
      if (
        current(projectCode, repository, version) &&
        sequence === summarySequence.current
      )
        setSummaryError(errorText(failure))
    } finally {
      if (
        current(projectCode, repository, version) &&
        sequence === summarySequence.current
      )
        setSummaryLoading(false)
    }
  }
  async function refreshDocuments() {
    const sequence = ++documentSequence.current
    const version = generation.current
    try {
      const result =
        (await repository.listDocumentVersionOptions?.(projectCode)) ?? []
      if (
        current(projectCode, repository, version) &&
        sequence === documentSequence.current
      ) {
        setDocuments(result)
        setDocumentError('')
      }
    } catch (failure) {
      if (
        current(projectCode, repository, version) &&
        sequence === documentSequence.current
      )
        setDocumentError(`资料列表读取失败：${errorText(failure)}`)
    }
  }
  useEffect(() => {
    generation.current += 1
    setModel(null)
    setSummary(null)
    setDocuments([])
    setEditor(null)
    setError('')
    setSuccess('')
    setFormError('')
    setSummaryError('')
    setDocumentError('')
    setBusy(false)
    actionLock.current = false
    const restored = pendingMap(repository).get(projectCode)
    if (restored) {
      setModel(restored.snapshot)
      setLoading(false)
    } else void refresh().catch(() => undefined)
    void refreshSummary()
    void refreshDocuments()
    return () => {
      generation.current += 1
      requestSequence.current += 1
      summarySequence.current += 1
      documentSequence.current += 1
    }
  }, [projectCode, repository])
  useEffect(() => {
    if (readonly) setEditor(null)
  }, [readonly])
  const pending = pendingMap(repository).get(projectCode)
  useEffect(() => {
    if (priorPending.current && !pending && !actionLock.current)
      void refresh().catch(() => undefined)
    priorPending.current = Boolean(pending)
  }, [pending])
  const disabled = readonly || loading || !model || busy || Boolean(pending)
  const statusLabelsByTab: Record<string, Record<string, string>> = {
    commissioning: commissioningStatuses,
    changes: changeStatuses,
    acceptance: acceptanceStatuses,
    invoices: invoiceStatuses,
    'after-sales': afterSalesStatuses,
  }
  const statusFilter = statusFilters[activeTab] ?? ''
  const statusSearchProps = {
    statusLabels: statusLabelsByTab[activeTab],
    status: statusFilter,
    onStatusChange: (value: string) =>
      setStatusFilters((previous) => ({ ...previous, [activeTab]: value })),
  }
  const filterStatus = (row: { status: string }) =>
    !statusFilter || row.status === statusFilter
  const match = (...values: (string | null | undefined)[]) =>
    !search.trim() ||
    values.some((value) =>
      value?.toLowerCase().includes(search.trim().toLowerCase()),
    )
  function open(
    title: string,
    initial: Values,
    fields: Field[],
    submit: Editor['submit'],
    attachments: boolean | string = false,
    extra?: Editor['extra'],
  ) {
    if (disabled) return
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
        : title.startsWith('新增')
          ? title.replace('新增', '保存')
          : title,
      initial,
      fields,
      submit,
      attachments: Boolean(attachments),
      accept: typeof attachments === 'string' ? attachments : undefined,
      extra,
    })
  }
  async function create(
    kind: CreateKind,
    send: () => Promise<void>,
    discard: () => boolean,
  ) {
    const entry: PendingCreate = {
      kind,
      snapshot: model,
      editor: submittingEditor.current!,
      send,
      discard,
      inFlight: true,
    }
    pendingMap(repository).set(projectCode, entry)
    try {
      await send()
      pendingMap(repository).delete(projectCode)
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![408, 425, 429].includes(failure.status)
      )
        pendingMap(repository).delete(projectCode)
      throw failure
    } finally {
      entry.inFlight = false
      pendingRegistry.notify()
    }
  }
  async function save(values: Values, files: File[]) {
    if (!editor || context.current.readonly || actionLock.current) return
    const version = generation.current
    const recoverable = pendingMap(repository).get(projectCode)
    if (recoverable?.inFlight) return
    actionLock.current = true
    setBusy(true)
    setFormError('')
    setError('')
    setSuccess('')
    const submitted = {
      ...editor,
      initial: structuredClone(values),
      files: [...files],
    }
    submittingEditor.current = submitted
    const submission: PendingCreate = recoverable ?? {
      kind: 'mutation',
      snapshot: model,
      editor: submitted,
      send: () =>
        submitted.submit(structuredClone(submitted.initial), [
          ...submitted.files,
        ]),
      discard: () => false,
      inFlight: false,
    }
    submission.inFlight = true
    if (!recoverable) pendingMap(repository).set(projectCode, submission)
    try {
      if (recoverable) {
        await recoverable.send()
      } else await editor.submit(structuredClone(values), [...files])
      pendingMap(repository).delete(projectCode)
      clearEditorDraft(repository, projectCode, submission.editor.key)
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
          setSuccess('记录已保存，但刷新失败。请刷新后查看最新结果。')
      }
      if (current(projectCode, repository, version)) {
        void refreshSummary()
        void refreshDocuments()
      }
    } catch (failure) {
      if (
        (failure instanceof Error && failure.name === 'Error') ||
        (failure instanceof ApiError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          ![408, 425, 429].includes(failure.status))
      )
        pendingMap(repository).delete(projectCode)
      if (!current(projectCode, repository, version)) return
      const message =
        failure instanceof ApiError &&
        failure.errorCode === 'INVOICE_NUMBER_CONFLICT'
          ? '发票号码已存在，请核对后再保存'
          : failure instanceof ApiError &&
              failure.errorCode === 'WARRANTY_COVERAGE_MISMATCH'
            ? '保障方式与报修日期的质保判断不一致，请重新选择'
            : errorText(failure)
      setFormError(message)
      setError(message)
      const remains = pendingMap(repository).get(projectCode)
      if (remains) setEditor({ ...remains.editor, frozen: true })
      else if (recoverable) setEditor({ ...recoverable.editor, frozen: false })
    } finally {
      submission.inFlight = false
      pendingRegistry.notify()
      if (current(projectCode, repository, version)) {
        actionLock.current = false
        setBusy(false)
      }
    }
  }
  function discardPending() {
    if (!pending || pending.inFlight || readonly) return
    const version = generation.current
    modal.confirm({
      title: '放弃这笔待确认提交？',
      content:
        '请求可能已经保存。放弃后请先刷新并核对现有记录，再决定是否新增，避免重复记录。',
      okText: '放弃并刷新',
      cancelText: '保留提交',
      onOk: async () => {
        if (
          !current(projectCode, repository, version) ||
          context.current.readonly
        )
          return
        if (!pending.discard()) {
          setError('请求仍在进行，暂不能放弃')
          return
        }
        pendingMap(repository).delete(projectCode)
        clearEditorDraft(repository, projectCode, pending.editor.key)
        setEditor(null)
        setFormError('')
        await refresh().catch(() => undefined)
      },
    })
  }
  function openSignoff(discipline: DrawingDiscipline) {
    const row = model?.drawing_signoffs.find(
      (item) => item.discipline === discipline,
    )
    open(
      `${disciplines[discipline]}会签`,
      row
        ? { ...row }
        : {
            status: 'confirmed',
            confirmed_on: localISODate(),
            document_version_ids: [],
          },
      [
        choice('status', '会签状态', signoffs),
        {
          ...date('confirmed_on', '确认日期'),
          visible: (values) => values.status === 'confirmed',
        },
        {
          ...area('not_required_reason', '无需图纸原因', true),
          visible: (values) => values.status === 'not_required',
        },
        note,
        documentsField,
      ],
      async (values, files) => {
        const input: DrawingSignoffInput = {
          status: values.status as DrawingSignoffInput['status'],
          confirmed_on:
            values.status === 'confirmed'
              ? optionalText(values, 'confirmed_on')
              : null,
          not_required_reason:
            values.status === 'not_required'
              ? optionalText(values, 'not_required_reason')
              : null,
          notes: optionalText(values, 'notes'),
          document_version_ids: idsValue(values),
        }
        await repository.saveDrawingSignoff(
          projectCode,
          discipline,
          input,
          files,
        )
      },
      '.dwg,.dxf,.pdf,image/*,.zip,.rar,.7z',
    )
  }
  function openCommissioning(row?: DemoCommissioningSessionViewModel) {
    open(
      row ? '编辑调试记录' : '新增调试记录',
      row
        ? { ...row }
        : {
            started_at: localISODateTimeInput(),
            status: 'planned',
            document_version_ids: [],
          },
      [
        {
          key: 'started_at',
          label: '开始时间',
          type: 'datetime',
          required: true,
        },
        { key: 'ended_at', label: '结束时间', type: 'datetime' },
        choice('status', '调试状态', commissioningStatuses),
        area('summary', '调试内容'),
        area('issues', '问题与阻塞'),
        area('next_action', '下一步安排'),
        note,
        documentsField,
      ],
      async (values, files) => {
        const input: CommissioningSessionInput = {
          started_at: textValue(values, 'started_at'),
          ended_at: optionalText(values, 'ended_at'),
          status: values.status as CommissioningSessionInput['status'],
          summary: optionalText(values, 'summary'),
          issues: optionalText(values, 'issues'),
          next_action: optionalText(values, 'next_action'),
          notes: optionalText(values, 'notes'),
          document_version_ids: idsValue(values),
        }
        if (
          input.ended_at &&
          new Date(input.ended_at) < new Date(input.started_at)
        )
          throw new Error('结束时间不能早于开始时间')
        if (row)
          await repository.updateCommissioningSession(
            projectCode,
            row.session_id,
            input,
          )
        else
          await create(
            'commissioning',
            () =>
              repository.saveCommissioningSession(projectCode, input, files),
            () =>
              repository.discardSaveCommissioningSession(
                projectCode,
                input,
                files,
              ),
          )
      },
      !row ? '.pdf,.doc,.docx,.xls,.xlsx,image/*,.zip,.rar,.7z' : false,
    )
  }
  function openChange(row?: DemoEngineeringChangeViewModel) {
    open(
      row ? '编辑工程变更' : '提出工程变更',
      row
        ? {
            ...row,
            contract_delta: (row.contract_delta_cents / 100).toFixed(2),
            cost_delta: (row.estimated_cost_delta_cents / 100).toFixed(2),
          }
        : {
            source: 'customer_request',
            proposed_on: localISODate(),
            contract_delta: '0.00',
            cost_delta: '0.00',
            schedule_delta_days: 0,
            document_version_ids: [],
          },
      [
        choice('source', '变更来源', changeSources),
        { key: 'title', label: '变更标题', required: true },
        area('description', '变更内容', true),
        area('reason', '变更原因', true),
        money('contract_delta', '合同金额增减', true),
        money('cost_delta', '预计成本增减', true),
        {
          key: 'schedule_delta_days',
          label: '工期增减（天）',
          type: 'number',
          required: true,
        },
        date('proposed_on', '提出日期'),
        note,
        documentsField,
      ],
      async (values, files) => {
        const input: EngineeringChangeInput = {
          source: values.source as EngineeringChangeInput['source'],
          title: textValue(values, 'title'),
          description: textValue(values, 'description'),
          reason: textValue(values, 'reason'),
          contract_delta_cents: signedYuanToCents(
            textValue(values, 'contract_delta'),
          ),
          estimated_cost_delta_cents: signedYuanToCents(
            textValue(values, 'cost_delta'),
          ),
          schedule_delta_days: numberValue(values, 'schedule_delta_days'),
          proposed_on: textValue(values, 'proposed_on'),
          notes: optionalText(values, 'notes'),
          document_version_ids: idsValue(values),
        }
        if (row)
          await repository.updateEngineeringChange(
            projectCode,
            row.change_id,
            input,
          )
        else
          await create(
            'change',
            () => repository.saveEngineeringChange(projectCode, input, files),
            () =>
              repository.discardSaveEngineeringChange(
                projectCode,
                input,
                files,
              ),
          )
      },
      !row ? '.pdf,.doc,.docx,.xls,.xlsx,image/*,.zip,.rar,.7z' : false,
    )
  }
  function transitionChange(row: DemoEngineeringChangeViewModel) {
    open(
      '处理工程变更',
      { status: changeTransitions[row.status][0] },
      [
        {
          ...choice('status', '目标状态', changeStatuses),
          options: changeTransitions[row.status].map((value) => ({
            value,
            label: changeStatuses[value],
          })),
        },
        area('reason', '处理原因'),
      ],
      async (values) => {
        const status = values.status as EngineeringChangeStatus
        const version = generation.current
        if (['implemented', 'rejected', 'cancelled'].includes(status)) {
          const confirmed = await modal.confirm({
            title: `确认${changeStatuses[status]}工程变更？`,
            content: '保存后不能恢复到上一状态。',
            okText: '确认保存',
            cancelText: '返回检查',
          })
          if (!confirmed) throw new Error('未保存，可继续检查变更内容')
        }
        if (
          !current(projectCode, repository, version) ||
          context.current.readonly
        )
          throw new Error('项目状态已变化，请重新打开后操作')
        await repository.setEngineeringChangeStatus(
          projectCode,
          row.change_id,
          status,
          textValue(values, 'reason'),
        )
      },
    )
  }
  function openAcceptance(row?: DemoAcceptanceViewModel) {
    open(
      row ? '验收改期' : '安排验收',
      row
        ? { ...row }
        : { acceptance_type: 'pre_acceptance', scheduled_on: localISODate() },
      [
        choice('acceptance_type', '验收类型', acceptanceTypes),
        date('scheduled_on', '计划日期'),
        note,
        ...(row ? [area('reason', '改期原因', true)] : []),
      ],
      async (values) => {
        const input: AcceptanceInput = {
          acceptance_type:
            values.acceptance_type as AcceptanceInput['acceptance_type'],
          scheduled_on: textValue(values, 'scheduled_on'),
          notes: optionalText(values, 'notes'),
        }
        if (row)
          await repository.rescheduleAcceptance(
            projectCode,
            row.acceptance_id,
            input,
            textValue(values, 'reason'),
          )
        else
          await create(
            'acceptance',
            () => repository.saveAcceptance(projectCode, input),
            () => repository.discardSaveAcceptance(projectCode, input),
          )
      },
    )
  }
  const warrantyFields = (prefix = '', visible?: Field['visible']): Field[] => [
    { ...date(`${prefix}starts_on`, '质保开始日期'), visible },
    {
      key: `${prefix}duration_months`,
      label: '质保月数',
      type: 'number',
      required: true,
      min: 1,
      max: 120,
      visible,
    },
    { ...money(`${prefix}renewal_price`, '续保价格'), visible },
    { ...area(`${prefix}notes`, '质保备注'), visible },
  ]
  function completeAcceptance(row: DemoAcceptanceViewModel) {
    const needsWarranty = (values: Values) =>
      row.acceptance_type === 'final' &&
      ['passed', 'passed_with_punch'].includes(textValue(values, 'status'))
    open(
      '登记验收结果',
      {
        performed_on: row.performed_on ?? localISODate(),
        notes: row.notes,
        document_version_ids: row.document_version_ids,
        warranty_starts_on: localISODate(),
        warranty_duration_months: 12,
      },
      [
        choice('status', '真实验收结果', {
          passed: '通过',
          passed_with_punch: '带整改项通过',
          failed: '未通过',
        }),
        date('performed_on', '实际验收日期'),
        note,
        documentsField,
        ...warrantyFields('warranty_', needsWarranty),
      ],
      async (values, files) => {
        const input: DeliveryAcceptanceCompletionInput = {
          status: values.status as 'passed' | 'passed_with_punch' | 'failed',
          performed_on: textValue(values, 'performed_on'),
          notes: optionalText(values, 'notes'),
          document_version_ids: idsValue(values),
          warranty: needsWarranty(values)
            ? warrantyInput(values, 'warranty_')
            : null,
        }
        await repository.completeAcceptance(
          projectCode,
          row.acceptance_id,
          input,
          files,
        )
      },
      '.pdf,image/*',
      (values) =>
        needsWarranty(values) ? (
          <Alert
            type="info"
            showIcon
            title="最终验收通过将建立质保，请确认质保起始日期与期限。"
          />
        ) : null,
    )
  }
  function openWarranty() {
    const row = model?.warranty
    if (!row) return
    open(
      '编辑质保信息',
      {
        ...row,
        renewal_price:
          row.renewal_price_cents === null
            ? ''
            : (row.renewal_price_cents / 100).toFixed(2),
      },
      warrantyFields(),
      (values) => repository.updateWarranty(projectCode, warrantyInput(values)),
    )
  }
  function openInvoice(row?: DemoInvoiceViewModel) {
    open(
      row ? '补录发票资料' : '新增发票记录',
      row
        ? {
            ...row,
            amount:
              row.amount_cents === null
                ? ''
                : (row.amount_cents / 100).toFixed(2),
          }
        : {
            invoice_type: 'contract_payment',
            status: 'planned',
            document_version_ids: [],
          },
      [
        choice('invoice_type', '发票类型', invoiceTypes),
        choice('status', '发票状态', {
          planned: '计划中',
          requested: '已申请',
          recorded: '已登记',
        }),
        {
          ...date('requested_on', '申请日期'),
          visible: (values) => values.status !== 'planned',
        },
        {
          ...date('recorded_on', '登记日期'),
          visible: (values) => values.status === 'recorded',
        },
        {
          key: 'invoice_number',
          label: '发票号码',
          required: (values) => values.status === 'recorded',
        },
        {
          ...money('amount', '发票金额'),
          required: (values) => values.status === 'recorded',
        },
        { key: 'counterparty_name', label: '对方单位' },
        note,
        documentsField,
      ],
      async (values, files) => {
        const input = invoiceInput(values, files.length)
        if (row)
          await repository.updateInvoice(projectCode, row.invoice_id, input)
        else
          await create(
            'invoice',
            () => repository.saveInvoice(projectCode, input, files),
            () => repository.discardSaveInvoice(projectCode, input, files),
          )
      },
      !row ? '.pdf,image/*' : false,
    )
  }
  const covered = (reportedOn: string) =>
    Boolean(
      model?.warranty &&
      reportedOn >= model.warranty.starts_on &&
      reportedOn <= model.warranty.ends_on,
    )
  function openAfterSales(row?: DemoAfterSalesCaseViewModel) {
    open(
      row ? '编辑售后资料' : '登记售后',
      row ? { ...row } : { reported_on: localISODate() },
      [
        date('reported_on', '报修日期'),
        date('service_on', '服务日期', false),
        area('reason', '报修原因', true),
        { key: 'contact_name', label: '联系人' },
        { key: 'contact_phone', label: '联系电话' },
        {
          ...choice('coverage_type', '保障方式', coverageTypes),
          options: (values) =>
            options(coverageTypes).map((item) => ({
              ...item,
              disabled:
                item.value === 'warranty' &&
                !covered(textValue(values, 'reported_on')),
            })),
        },
        note,
      ],
      async (values) => {
        if (
          values.coverage_type === 'warranty' &&
          !covered(textValue(values, 'reported_on'))
        )
          throw new Error('报修日期不在质保期内，不能选择保内处理')
        const input: AfterSalesInput = {
          reported_on: textValue(values, 'reported_on'),
          service_on: optionalText(values, 'service_on'),
          reason: textValue(values, 'reason'),
          contact_name: textValue(values, 'contact_name'),
          contact_phone: textValue(values, 'contact_phone'),
          coverage_type:
            values.coverage_type as AfterSalesInput['coverage_type'],
          notes: optionalText(values, 'notes'),
        }
        if (row)
          await repository.updateAfterSalesCase(projectCode, row.case_id, input)
        else
          await create(
            'after-sales',
            () => repository.saveAfterSalesCase(projectCode, input),
            () => repository.discardSaveAfterSalesCase(projectCode, input),
          )
      },
      false,
      (values) => (
        <Alert
          showIcon
          type={
            covered(textValue(values, 'reported_on')) ? 'success' : 'warning'
          }
          title={`系统判断：${covered(textValue(values, 'reported_on')) ? '保内' : model?.warranty ? '过保' : '未建立质保'}`}
          description={
            model?.warranty
              ? `质保期：${model.warranty.starts_on} 至 ${model.warranty.ends_on}`
              : '当前项目尚未建立质保，不能选择保内处理。'
          }
        />
      ),
    )
  }
  function transitionAfterSales(row: DemoAfterSalesCaseViewModel) {
    open(
      '处理售后案件',
      {
        status: afterSalesTransitions[row.status][0],
        resolution: row.resolution,
      },
      [
        {
          ...choice('status', '处理状态', afterSalesStatuses),
          options: afterSalesTransitions[row.status].map((value) => ({
            value,
            label: afterSalesStatuses[value],
          })),
        },
        {
          ...area('resolution', '处理结果 / 取消原因'),
          required: (values) =>
            ['completed', 'cancelled'].includes(textValue(values, 'status')),
        },
      ],
      (values) =>
        repository.setAfterSalesStatus(
          projectCode,
          row.case_id,
          values.status as AfterSalesStatus,
          optionalText(values, 'resolution'),
        ),
    )
  }
  function withReason(
    title: string,
    submit: (reason: string) => Promise<void>,
  ) {
    open(title, {}, [area('reason', '原因', true)], (values) =>
      submit(textValue(values, 'reason')),
    )
  }
  const attachments = (ids: number[]) => (
    <AttachmentLinks
      projectCode={projectCode}
      ids={ids}
      documents={documents}
    />
  )
  const details = (pairs: [string, unknown][]) => (
    <Descriptions
      size="small"
      column={2}
      items={pairs.map(([label, value]) => ({
        key: label,
        label,
        children:
          typeof value === 'string' || typeof value === 'number'
            ? value || '—'
            : '—',
      }))}
    />
  )
  const emptyRecords = (
    description: string,
    label: string,
    action: () => void,
  ) => ({
    emptyText: (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          search.trim() || statusFilter ? '没有符合筛选条件的记录' : description
        }
      >
        {search.trim() || statusFilter ? (
          <Button
            onClick={() => {
              setSearch('')
              setStatusFilters((previous) => ({ ...previous, [activeTab]: '' }))
            }}
          >
            清除筛选
          </Button>
        ) : (
          !readonly && (
            <Button disabled={disabled} onClick={action}>
              {label}
            </Button>
          )
        )}
      </Empty>
    ),
  })
  const commissioningContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={() => openCommissioning()}
        >
          新增调试
        </Button>
        <Typography.Text type="secondary">
          待会签{' '}
          {
            (Object.keys(disciplines) as DrawingDiscipline[]).filter(
              (d) =>
                !model?.drawing_signoffs.some(
                  (row) => row.discipline === d && row.status !== 'pending',
                ),
            ).length
          }{' '}
          项 · 未完成调试{' '}
          {model?.commissioning_sessions.filter(
            (row) => !['completed', 'cancelled'].includes(row.status),
          ).length ?? 0}{' '}
          项
        </Typography.Text>
      </Space>
      <Row gutter={[12, 12]}>
        {(Object.keys(disciplines) as DrawingDiscipline[]).map((discipline) => {
          const row = model?.drawing_signoffs.find(
            (item) => item.discipline === discipline,
          )
          return (
            <Col xs={24} md={12} key={discipline}>
              <Card size="small" styles={{ body: { padding: '10px 12px' } }}>
                <Space
                  wrap
                  style={{ width: '100%', justifyContent: 'space-between' }}
                >
                  <Space>
                    <Typography.Text strong>
                      {disciplines[discipline]}
                    </Typography.Text>
                    <Tag color={statusColor(row?.status ?? 'pending')}>
                      {signoffs[row?.status ?? 'pending']}
                    </Tag>
                  </Space>
                  <Button
                    type="link"
                    disabled={disabled}
                    onClick={() => openSignoff(discipline)}
                  >
                    编辑会签
                  </Button>
                </Space>
                {row?.confirmed_on && (
                  <Typography.Text type="secondary">
                    确认于 {row.confirmed_on}
                  </Typography.Text>
                )}
                {(row?.not_required_reason || row?.notes) && (
                  <Typography.Paragraph style={{ marginBottom: 4 }}>
                    {[row.not_required_reason, row.notes]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography.Paragraph>
                )}
                {!!row?.document_version_ids.length && (
                  <div>{attachments(row.document_version_ids)}</div>
                )}
              </Card>
            </Col>
          )
        })}
      </Row>
      <RecordSearch
        {...statusSearchProps}
        label="搜索调试记录"
        value={search}
        onChange={setSearch}
        placeholder="调试内容、问题或下一步安排"
      />
      <Table<DemoCommissioningSessionViewModel>
        locale={emptyRecords('尚未登记调试记录', '登记第一条调试', () =>
          openCommissioning(),
        )}
        rowKey="session_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 900 }}
        dataSource={model?.commissioning_sessions.filter(
          (row) =>
            filterStatus(row) &&
            match(row.summary, row.issues, row.next_action, row.notes),
        )}
        columns={[
          {
            title: '调试时间',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>{formatChineseDateTime(row.started_at)}</span>
                <Typography.Text type="secondary">
                  {row.ended_at
                    ? `结束 ${formatChineseDateTime(row.ended_at)}`
                    : '尚未结束'}
                </Typography.Text>
              </Space>
            ),
          },
          statusColumn(commissioningStatuses),
          { title: '调试内容', dataIndex: 'summary', ellipsis: true },
          { title: '问题与阻塞', dataIndex: 'issues', ellipsis: true },
          {
            title: '操作',
            render: (_, row) => (
              <Button
                type="link"
                disabled={disabled}
                onClick={() => openCommissioning(row)}
              >
                编辑
              </Button>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Space orientation="vertical">
              {details([
                ['调试内容', row.summary],
                ['问题与阻塞', row.issues],
                ['下一步安排', row.next_action],
                ['备注', row.notes],
              ])}
              {attachments(row.document_version_ids)}
            </Space>
          ),
        }}
      />
    </Space>
  )
  const changesContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={disabled}
        onClick={() => openChange()}
      >
        提出工程变更
      </Button>
      <Space wrap>
        <Tag color="blue">
          待处理{' '}
          {model?.engineering_changes.filter((row) =>
            ['proposed', 'approved'].includes(row.status),
          ).length ?? 0}{' '}
          项
        </Tag>
        <RecordSearch
          {...statusSearchProps}
          label="搜索工程变更"
          value={search}
          onChange={setSearch}
          placeholder="标题、内容或原因"
        />
      </Space>
      <Table<DemoEngineeringChangeViewModel>
        locale={emptyRecords('尚无工程变更', '登记第一项变更', () =>
          openChange(),
        )}
        rowKey="change_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 800 }}
        dataSource={model?.engineering_changes.filter(
          (row) =>
            filterStatus(row) && match(row.title, row.description, row.reason),
        )}
        columns={[
          {
            title: '变更事项',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>{row.title}</Typography.Text>
                <Typography.Text type="secondary">
                  {row.proposed_on} · {changeSources[row.source]}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '合同增减',
            dataIndex: 'contract_delta_cents',
            render: formatMoney,
          },
          {
            title: '成本增减',
            dataIndex: 'estimated_cost_delta_cents',
            render: formatMoney,
          },
          {
            title: '工期增减',
            dataIndex: 'schedule_delta_days',
            render: (value) => `${value} 天`,
          },
          statusColumn(changeStatuses),
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={disabled || row.status !== 'proposed'}
                  onClick={() => openChange(row)}
                >
                  编辑
                </Button>
                <Button
                  type="link"
                  disabled={disabled || !changeTransitions[row.status].length}
                  onClick={() => transitionChange(row)}
                >
                  处理
                </Button>
              </Space>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Space orientation="vertical">
              {details([
                ['变更内容', row.description],
                ['变更原因', row.reason],
                ['备注', row.notes],
              ])}
              {attachments(row.document_version_ids)}
            </Space>
          ),
        }}
      />
    </Space>
  )
  const acceptanceContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={disabled}
        onClick={() => openAcceptance()}
      >
        安排验收
      </Button>
      <Space wrap>
        <Tag color="blue">
          待处理{' '}
          {model?.acceptances.filter((row) => row.status === 'scheduled')
            .length ?? 0}{' '}
          项
        </Tag>
        <RecordSearch
          {...statusSearchProps}
          label="搜索验收记录"
          value={search}
          onChange={setSearch}
          placeholder="验收类型、日期或备注"
        />
      </Space>
      <Table<DemoAcceptanceViewModel>
        locale={emptyRecords('尚未安排验收', '安排首次验收', () =>
          openAcceptance(),
        )}
        rowKey="acceptance_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 800 }}
        dataSource={model?.acceptances.filter(
          (row) =>
            filterStatus(row) &&
            match(
              acceptanceTypes[row.acceptance_type],
              row.notes,
              row.scheduled_on,
            ),
        )}
        columns={[
          {
            title: '类型',
            dataIndex: 'acceptance_type',
            render: (value: keyof typeof acceptanceTypes) =>
              acceptanceTypes[value],
          },
          { title: '计划日期', dataIndex: 'scheduled_on' },
          { title: '实际日期', dataIndex: 'performed_on' },
          statusColumn(acceptanceStatuses),
          { title: '备注', dataIndex: 'notes', ellipsis: true },
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={disabled || row.status !== 'scheduled'}
                  onClick={() => completeAcceptance(row)}
                >
                  登记结果
                </Button>
                <Button
                  type="link"
                  disabled={disabled || row.status !== 'scheduled'}
                  onClick={() => openAcceptance(row)}
                >
                  改期
                </Button>
                <Button
                  type="link"
                  danger
                  disabled={disabled || row.status !== 'scheduled'}
                  onClick={() =>
                    withReason('取消验收', (reason) =>
                      repository.cancelAcceptance(
                        projectCode,
                        row.acceptance_id,
                        reason,
                      ),
                    )
                  }
                >
                  取消
                </Button>
              </Space>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Space orientation="vertical">
              {details([
                ['备注', row.notes],
                ['取消原因', row.cancel_reason],
                ['取消时间', row.cancelled_at],
              ])}
              {attachments(row.document_version_ids)}
            </Space>
          ),
        }}
      />
      <Card
        size="small"
        title="尾款摘要"
        loading={summaryLoading}
        extra={
          <Button type="link" onClick={() => void refreshSummary()}>
            刷新摘要
          </Button>
        }
      >
        {summaryError ? (
          <Alert type="warning" title={summaryError} />
        ) : summary ? (
          <Descriptions
            size="small"
            items={[
              {
                key: 'date',
                label: '应收日期',
                children: summary.final_payment.due_on ?? '未设置',
              },
              {
                key: 'planned',
                label: '计划金额',
                children: formatMoney(
                  summary.final_payment.planned_amount_cents,
                ),
              },
              {
                key: 'paid',
                label: '已收金额',
                children: formatMoney(
                  summary.final_payment.received_amount_cents,
                ),
              },
              {
                key: 'outstanding',
                label: '未收金额',
                children: formatMoney(
                  summary.final_payment.outstanding_amount_cents,
                ),
              },
            ]}
          />
        ) : (
          <Empty description="暂无尾款摘要" />
        )}
      </Card>
      <Card
        size="small"
        title="质保信息"
        extra={
          model?.warranty && (
            <Button type="link" disabled={disabled} onClick={openWarranty}>
              编辑质保
            </Button>
          )
        }
      >
        {model?.warranty ? (
          <Space orientation="vertical">
            <Tag color={statusColor(model.warranty.status)}>
              {warrantyStatuses[model.warranty.status]}
            </Tag>
            {details([
              ['质保开始', model.warranty.starts_on],
              ['质保截止', model.warranty.ends_on],
              ['质保月数', `${model.warranty.duration_months} 个月`],
              ['剩余天数', model.warranty.days_remaining],
              [
                '续保价格',
                model.warranty.renewal_price_cents === null
                  ? '未填写'
                  : formatMoney(model.warranty.renewal_price_cents),
              ],
              ['备注', model.warranty.notes],
            ])}
          </Space>
        ) : (
          <Empty description="最终验收通过后建立质保" />
        )}
      </Card>
    </Space>
  )
  const invoicesContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={disabled}
        onClick={() => openInvoice()}
      >
        新增发票记录
      </Button>
      <Space wrap>
        <Tag color="blue">
          待处理{' '}
          {model?.invoices.filter((row) =>
            ['planned', 'requested'].includes(row.status),
          ).length ?? 0}{' '}
          项
        </Tag>
        <RecordSearch
          {...statusSearchProps}
          label="搜索发票记录"
          value={search}
          onChange={setSearch}
          placeholder="发票号码、单位或备注"
        />
      </Space>
      <Table<DemoInvoiceViewModel>
        locale={emptyRecords('尚无发票记录', '登记第一张发票', () =>
          openInvoice(),
        )}
        rowKey="invoice_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 800 }}
        dataSource={model?.invoices.filter(
          (row) =>
            filterStatus(row) &&
            match(row.invoice_number, row.counterparty_name, row.notes),
        )}
        columns={[
          {
            title: '发票 / 对方单位',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>
                  {row.invoice_number || '待补录号码'}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {invoiceTypes[row.invoice_type]} ·{' '}
                  {row.counterparty_name || '未填写单位'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '金额',
            dataIndex: 'amount_cents',
            render: (value) => (value === null ? '未填写' : formatMoney(value)),
          },
          {
            title: '申请 / 登记日期',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>申请 {row.requested_on || '未申请'}</span>
                <Typography.Text type="secondary">
                  登记 {row.recorded_on || '未登记'}
                </Typography.Text>
              </Space>
            ),
          },
          statusColumn(invoiceStatuses),
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={
                    disabled || !['planned', 'requested'].includes(row.status)
                  }
                  onClick={() => openInvoice(row)}
                >
                  补录
                </Button>
                <Button
                  type="link"
                  danger
                  disabled={disabled || row.status === 'void'}
                  onClick={() =>
                    withReason('作废发票', (reason) =>
                      repository.voidInvoice(
                        projectCode,
                        row.invoice_id,
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
            <Space orientation="vertical">
              {details([
                ['备注', row.notes],
                ['作废原因', row.void_reason],
              ])}
              {attachments(row.document_version_ids)}
            </Space>
          ),
        }}
      />
    </Space>
  )
  const afterSalesContent = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={disabled}
        onClick={() => openAfterSales()}
      >
        登记售后
      </Button>
      <Space wrap>
        <Tag color="blue">
          待处理{' '}
          {model?.after_sales.filter((row) =>
            ['open', 'in_progress'].includes(row.status),
          ).length ?? 0}{' '}
          项
        </Tag>
        <RecordSearch
          {...statusSearchProps}
          label="搜索售后记录"
          value={search}
          onChange={setSearch}
          placeholder="报修原因、联系人或电话"
        />
      </Space>
      <Table<DemoAfterSalesCaseViewModel>
        locale={emptyRecords('尚无售后记录', '登记首次报修', () =>
          openAfterSales(),
        )}
        rowKey="case_id"
        size="small"
        pagination={pagination}
        scroll={{ x: 800 }}
        dataSource={model?.after_sales.filter(
          (row) =>
            filterStatus(row) &&
            match(row.reason, row.contact_name, row.contact_phone, row.notes),
        )}
        columns={[
          {
            title: '报修 / 服务日期',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>报修 {row.reported_on}</span>
                <Typography.Text type="secondary">
                  服务 {row.service_on || '待安排'}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '原因', dataIndex: 'reason', ellipsis: true },
          {
            title: '联系人',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>{row.contact_name || '未填写'}</span>
                <Typography.Text type="secondary">
                  {row.contact_phone || '未填写电话'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '保障方式',
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <span>{coverageTypes[row.coverage_type]}</span>
                <Typography.Text type="secondary">
                  {row.is_under_warranty ? '保内' : '过保'}
                </Typography.Text>
              </Space>
            ),
          },
          statusColumn(afterSalesStatuses),
          {
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  disabled={
                    disabled || !['open', 'in_progress'].includes(row.status)
                  }
                  onClick={() => openAfterSales(row)}
                >
                  编辑
                </Button>
                <Button
                  type="link"
                  disabled={
                    disabled || !afterSalesTransitions[row.status].length
                  }
                  onClick={() => transitionAfterSales(row)}
                >
                  处理
                </Button>
              </Space>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) =>
            details([
              ['报修原因', row.reason],
              ['备注', row.notes],
              ['处理结果', row.resolution],
              [
                '完成时间',
                row.completed_at
                  ? formatChineseDateTime(row.completed_at)
                  : null,
              ],
            ]),
        }}
      />
    </Space>
  )
  const tabs = [
    {
      key: 'commissioning',
      label: '图纸与调试',
      children: commissioningContent,
    },
    { key: 'changes', label: '工程变更', children: changesContent },
    { key: 'acceptance', label: '验收与质保', children: acceptanceContent },
    { key: 'invoices', label: '发票', children: invoicesContent },
    { key: 'after-sales', label: '售后', children: afterSalesContent },
  ].filter(
    (tab) =>
      scope === 'all' ||
      (scope === 'commissioning'
        ? ['commissioning', 'changes'].includes(tab.key)
        : ['acceptance', 'invoices', 'after-sales'].includes(tab.key)),
  )
  return (
    <Space
      orientation="vertical"
      size={20}
      style={{ width: '100%' }}
      data-testid="react-delivery-workspace"
    >
      {modalHolder}
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Text type="secondary">
          质量记录、验收结果与售后跟进
        </Typography.Text>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          disabled={busy || Boolean(editor) || Boolean(pending)}
          onClick={() => {
            void refresh().catch(() => undefined)
            void refreshSummary()
            void refreshDocuments()
          }}
        >
          刷新
        </Button>
      </Space>
      {readonly && (
        <Alert type="info" showIcon title="项目已归档，本页仅供查看" />
      )}
      {model?.load_warnings?.map((warning) => (
        <Alert key={warning} type="warning" showIcon title={warning} />
      ))}
      {documentError && (
        <Alert
          type="warning"
          showIcon
          title={documentError}
          action={<Button onClick={() => void refreshDocuments()}>重试</Button>}
        />
      )}
      {error && <Alert type="error" showIcon title={error} />}
      {success && <Alert type="success" showIcon title={success} />}
      {pending && !readonly && (
        <Alert
          type="warning"
          showIcon
          title={`${pending.editor.title}：上次提交尚未确认`}
          description="保留原始内容和附件，重试不会另建一份相同记录。"
          action={
            <Space>
              <Button
                disabled={busy || pending.inFlight}
                onClick={() => setEditor({ ...pending.editor, frozen: true })}
              >
                恢复并重试
              </Button>
              {pending.kind !== 'mutation' && (
                <Button
                  danger
                  disabled={busy || pending.inFlight}
                  onClick={discardPending}
                >
                  放弃提交
                </Button>
              )}
            </Space>
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
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabs} />
      </Card>
      <ActionDrawer
        draftOwner={repository}
        draftKey={projectCode}
        editor={editor}
        busy={busy}
        error={formError}
        onClose={() => setEditor(null)}
        onSave={save}
        documents={documents}
      />
    </Space>
  )
}
