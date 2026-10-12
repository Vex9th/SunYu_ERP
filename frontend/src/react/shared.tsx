import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
  type ReactNode,
} from 'react'
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { ApiError } from '../api'
import styles from './Workspace.module.css'
export { useWorkspaceTab, useWorkspaceValue } from './navigationState'

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请稍后重试'
export const isUncertain = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status === 0 ||
  error.status >= 500 ||
  [408, 425, 429].includes(error.status)
export const nullable = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const businessMessages: Record<string, string> = {
  'Backup requires attention': '备份需要关注',
  'Backup is not configured': '尚未配置自动备份',
  'Last backup failed': '最近一次备份失败',
  'No successful backup': '尚无成功备份记录',
  'Backup history is invalid': '备份记录异常，请检查设置',
  'Last successful backup is overdue': '最近一次成功备份已超出计划时间',
  'Project stage is blocked': '项目阶段受阻',
  'Receivable is overdue': '收款节点已逾期',
  'Final delivery is upcoming': '项目即将到达交付日期',
  advance: '预付款',
  progress: '进度款',
  final: '尾款',
}
export const businessText = (value: string | null): string =>
  value
    ? (businessMessages[value] ??
      value
        .split(', ')
        .map((item) => stageLabels[item] ?? businessMessages[item] ?? item)
        .join('、'))
    : ''

export function useLoad<T>(
  loader: () => Promise<T>,
  dependencies: DependencyList,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const version = useRef(0)
  const loadRef = useRef(loader)
  loadRef.current = loader
  const reload = useCallback(async () => {
    const request = ++version.current
    setLoading(true)
    setError(null)
    try {
      const result = await loadRef.current()
      if (request === version.current) setData(result)
      return request === version.current ? result : null
    } catch (cause) {
      if (request === version.current) setError(errorText(cause))
      return null
    } finally {
      if (request === version.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    setData(null)
    void reload()
    return () => {
      version.current += 1
    }
  }, dependencies)
  return { data, setData, error, loading, reload }
}

export function PageHeader({
  eyebrow,
  title,
  description,
  extra,
}: {
  eyebrow?: string
  title: string
  description?: string
  extra?: ReactNode
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </header>
  )
}

export function Section({
  title,
  description,
  extra,
  children,
  className = '',
}: {
  title?: string
  description?: string
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`${styles.section} ${className}`}>
      {(title || extra) && (
        <div className={styles.sectionHeader}>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {extra}
        </div>
      )}
      {children}
    </section>
  )
}

export function ErrorNotice({
  error,
  retry,
}: {
  error: string | null | undefined
  retry?: () => unknown
}) {
  return error ? (
    <Alert
      type="error"
      showIcon
      title={error}
      action={
        retry && (
          <Button size="small" onClick={() => void retry()}>
            重新读取
          </Button>
        )
      }
    />
  ) : null
}

export function LoadingBlock() {
  return (
    <Section>
      <Skeleton active paragraph={{ rows: 5 }} />
    </Section>
  )
}
export function RefreshButton({
  onClick,
  loading,
  label = '刷新',
}: {
  onClick: () => unknown
  loading?: boolean
  label?: string
}) {
  return (
    <Button
      icon={<ReloadOutlined />}
      loading={loading}
      onClick={() => void onClick()}
    >
      {label}
    </Button>
  )
}

export const stageLabels: Record<string, string> = {
  planning: '项目规划',
  site_survey: '现场测绘',
  quotation: '我方报价',
  technical_agreement: '技术协议',
  contract: '合同签订',
  advance_payment: '预付款',
  mechanical_design: '机械设计',
  electrical_design: '电气设计',
  procurement: '采购',
  staffing: '人员排单',
  mechanical_signoff: '机械图纸会签',
  electrical_signoff: '电气图纸会签',
  construction: '施工',
  progress_payment: '进度款',
  commissioning: '调试',
  acceptance: '验收',
  final_payment: '尾款',
  closeout: '收尾',
}

export function StatusTag({ value }: { value: string }) {
  const labels: Record<string, string> = {
    active: '进行中',
    archived: '已归档',
    pending: '未开始',
    in_progress: '进行中',
    blocked: '受阻',
    completed: '已完成',
    skipped: '已跳过',
    cancelled: '已取消',
    success: '成功',
    failed: '失败',
    running: '进行中',
  }
  const colors: Record<string, string> = {
    active: 'blue',
    in_progress: 'blue',
    completed: 'green',
    success: 'green',
    blocked: 'orange',
    failed: 'red',
  }
  return <Tag color={colors[value]}>{labels[value] ?? value}</Tag>
}

type EditorValues = Record<string, unknown>
interface EditorRequest {
  values: EditorValues
  run: () => Promise<unknown>
  busy: boolean
  completed?: boolean
  result?: unknown
  error?: string
  definitive?: boolean
}
const pendingEditors = new Map<string, EditorRequest>()
const editorDrafts = new Map<
  string,
  { values: EditorValues; revision?: number }
>()
const editorListeners = new Set<() => void>()
function notifyEditors() {
  editorListeners.forEach((listener) => listener())
}
function subscribeEditors(listener: () => void) {
  editorListeners.add(listener)
  return () => {
    editorListeners.delete(listener)
  }
}

export function EntityEditor<T extends EditorValues>({
  title,
  cacheKey,
  initialValues,
  recordRevision,
  onSubmit,
  onSaved,
  onClose,
  children,
  width = 560,
}: {
  title: string
  cacheKey: string
  initialValues: T
  recordRevision?: number
  onSubmit: (values: T) => Promise<unknown>
  onSaved?: (result: unknown) => unknown
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const [form] = Form.useForm<T>()
  const { message, modal } = App.useApp()
  const pending = useSyncExternalStore(
    subscribeEditors,
    () => pendingEditors.get(cacheKey),
    () => undefined,
  )
  const busy = Boolean(pending?.busy)
  const locked = Boolean(pending)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(editorDrafts.has(cacheKey))
  const [draftRevision, setDraftRevision] = useState(
    editorDrafts.get(cacheKey)?.revision ?? recordRevision,
  )
  const versionChanged =
    dirty &&
    !locked &&
    recordRevision !== undefined &&
    draftRevision !== recordRevision
  function acceptLatest(useDraft: boolean) {
    if (!useDraft) {
      form.setFieldsValue(initialValues)
      editorDrafts.delete(cacheKey)
      setDirty(false)
    } else {
      editorDrafts.set(cacheKey, {
        values: structuredClone(form.getFieldsValue()),
        revision: recordRevision,
      })
    }
    setDraftRevision(recordRevision)
    setError(null)
  }
  const closeEditor = () => {
    if (busy) return
    if (dirty && !locked) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '继续编辑可保留当前内容，放弃后无法恢复。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: () => {
          editorDrafts.delete(cacheKey)
          onClose()
        },
      })
      return
    }
    onClose()
  }
  useEffect(() => {
    if (!pending || pendingEditors.get(cacheKey) !== pending) return
    if (pending.completed) {
      pendingEditors.delete(cacheKey)
      editorDrafts.delete(cacheKey)
      notifyEditors()
      void message.success('已保存')
      onClose()
      void onSaved?.(pending.result)
    } else if (pending.definitive) {
      setError(pending.error ?? '保存失败，请检查后重新提交')
      pendingEditors.delete(cacheKey)
      notifyEditors()
    }
  }, [pending, cacheKey, message, onClose, onSaved])
  useEffect(() => {
    if ((!pending || pending.completed) && !dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending, dirty])
  async function submit(values: T) {
    if (pendingEditors.get(cacheKey)?.busy || versionChanged) return
    setError(null)
    const payload = structuredClone(values)
    const original = pendingEditors.get(cacheKey) ?? {
      values: payload,
      run: () => onSubmit(payload),
      busy: false,
    }
    const running = { ...original, busy: true, error: undefined }
    pendingEditors.set(cacheKey, running)
    notifyEditors()
    try {
      const result = await running.run()
      pendingEditors.set(cacheKey, {
        ...running,
        busy: false,
        completed: true,
        result,
      })
      notifyEditors()
    } catch (cause) {
      pendingEditors.set(cacheKey, {
        ...running,
        busy: false,
        error: errorText(cause),
        definitive: !isUncertain(cause),
      })
      notifyEditors()
    }
  }
  return (
    <Drawer
      open
      title={title}
      size={width}
      onClose={closeEditor}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={
        <Space>
          <Button onClick={closeEditor} disabled={busy}>
            取消
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={versionChanged}
            onClick={() =>
              pending ? void submit(pending.values as T) : form.submit()
            }
          >
            {locked ? '原样重试' : '保存'}
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <ErrorNotice error={pending?.error ?? error} />
        {versionChanged && (
          <Alert
            type="warning"
            showIcon
            title="记录已更新，请核对草稿"
            description="当前内容来自之前的草稿。你可以载入最新记录重新编辑，或在确认后使用草稿覆盖当前表单中的字段。"
            action={
              <Space wrap>
                <Button onClick={() => acceptLatest(false)}>
                  载入最新内容
                </Button>
                <Button
                  onClick={() =>
                    modal.confirm({
                      title: '确认使用旧草稿？',
                      content:
                        '保存时将使用当前草稿中的字段覆盖最新记录，请先确认没有遗漏其他人的修改。',
                      okText: '保留草稿',
                      cancelText: '继续核对',
                      onOk: () => acceptLatest(true),
                    })
                  }
                >
                  使用草稿内容
                </Button>
              </Space>
            }
          />
        )}

        {dirty && !locked && (
          <span className={styles.subtle}>
            有未保存的修改，保存后才会写入记录。
          </span>
        )}
        {locked && !busy && (
          <Alert
            type="warning"
            showIcon
            title="上次提交结果尚未确认"
            description="已保留原始内容，点击原样重试可确认结果。请勿重复新建。"
            action={
              <Button
                size="small"
                onClick={() =>
                  modal.confirm({
                    title: '放弃这次未确认的提交？',
                    content:
                      '请先核对业务记录：服务器可能已经保存。放弃后再次新建可能产生重复记录。',
                    okText: '确认放弃',
                    cancelText: '保留请求',
                    onOk: () => {
                      if (!pendingEditors.get(cacheKey)?.busy) {
                        pendingEditors.delete(cacheKey)
                        editorDrafts.delete(cacheKey)
                        notifyEditors()
                        setError(null)
                        onClose()
                      }
                    },
                  })
                }
              >
                放弃请求
              </Button>
            }
          />
        )}
        <Form<T>
          form={form}
          layout="vertical"
          initialValues={
            pending?.values ??
            editorDrafts.get(cacheKey)?.values ??
            initialValues
          }
          onValuesChange={(_, values) => {
            setDirty(true)
            const revision = dirty ? draftRevision : recordRevision
            setDraftRevision(revision)
            editorDrafts.set(cacheKey, {
              values: structuredClone(values),
              revision,
            })
          }}
          scrollToFirstError={{ focus: true }}
          onFinish={(values) => void submit(values)}
          disabled={busy || locked}
          requiredMark="optional"
        >
          {children}
        </Form>
      </Space>
    </Drawer>
  )
}

export function DataValue({
  label,
  value,
  note,
}: {
  label: string
  value: ReactNode
  note?: string
}) {
  return (
    <div className={styles.metric}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}
