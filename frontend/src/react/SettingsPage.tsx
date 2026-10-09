import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Alert,
  App,
  Button,
  Descriptions,
  Collapse,
  Space,
  Form,
  Input,
  InputNumber,
  Switch,
  Tag,
} from 'antd'
import { CloudDownloadOutlined, SaveOutlined } from '@ant-design/icons'
import { ApiError, requestJson } from '../api'
import type {
  BackupSettingsPayload,
  BackupSettingsResponse,
  SystemOverview,
} from '../types'
import { formatChineseDateTime } from '../domain/dates'
import {
  errorText,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefreshButton,
  Section,
  StatusTag,
  useLoad,
} from './shared'
import styles from './Workspace.module.css'

type SettingsOperationKind = 'save' | 'backup'
interface SettingsOperationResult {
  saved?: BackupSettingsResponse
  warning?: string
}
type SettingsOperation =
  | { kind: SettingsOperationKind; status: 'running'; phase?: string }
  | {
      kind: SettingsOperationKind
      status: 'success'
      result: SettingsOperationResult
    }
  | { kind: SettingsOperationKind; status: 'failed'; error: string }

// 请求由页面外持有；路由卸载不会解除保存与备份之间的互斥锁。
let settingsOperation: SettingsOperation | null = null
let settingsDraft: BackupSettingsPayload | null = null
const operationListeners = new Set<() => void>()
function subscribeOperation(listener: () => void) {
  operationListeners.add(listener)
  return () => {
    operationListeners.delete(listener)
  }
}
function operationSnapshot() {
  return settingsOperation
}
function publishOperation(next: SettingsOperation | null) {
  settingsOperation = next
  operationListeners.forEach((listener) => listener())
}
async function runOperation(
  kind: SettingsOperationKind,
  execute: () => Promise<SettingsOperationResult>,
) {
  if (settingsOperation) return
  publishOperation({ kind, status: 'running' })
  try {
    publishOperation({ kind, status: 'success', result: await execute() })
  } catch (cause) {
    publishOperation({ kind, status: 'failed', error: errorText(cause) })
  }
}

async function pollBackupTask(taskId: string): Promise<SettingsOperationResult> {
  let consecutiveFailures = 0
  for (;;) {
    try {
      const task = await requestJson<{
        status: string; phase: string; warning?: string; error_code?: string
      }>(`/api/system/backup-tasks/${taskId}`)
      consecutiveFailures = 0
      if (task.status === 'success') {
        sessionStorage.removeItem('sunyu-backup-task')
        return { warning: task.warning }
      }
      if (task.status === 'failed' || task.status === 'interrupted') {
        sessionStorage.removeItem('sunyu-backup-task')
        throw new Error(`备份${task.status === 'interrupted' ? '被服务重启中断' : '失败'}：${task.error_code ?? '请检查服务日志'}`)
      }
      publishOperation({ kind: 'backup', status: 'running', phase: task.phase === 'queued' ? '等待当前备份任务完成' : task.phase === 'cleaning' ? '备份已创建，正在检查并清理过期备份' : '正在创建并校验备份' })
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        sessionStorage.removeItem('sunyu-backup-task')
        throw new Error('备份任务记录不存在，执行结果无法确认。已停止自动查询，请核对最近备份。')
      }
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403))
        throw new Error('无法读取备份状态，请重新登录后返回此页查询。执行结果尚未确认。')
      if (cause instanceof Error && /^备份(失败|被服务重启中断)/.test(cause.message)) throw cause
      consecutiveFailures += 1
      if (consecutiveFailures >= 5)
        throw new Error('暂时无法确认备份结果，已停止自动查询。请恢复连接后重新打开设置页，继续核对任务状态。')
      // 状态请求失败不代表后台任务失败，恢复连接后继续查询真实结果。
      publishOperation({ kind: 'backup', status: 'running', phase: '暂时无法读取状态，正在重新连接；后台任务可能仍在执行' })
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export default function SettingsPage() {
  const overview = useLoad(
    () => requestJson<SystemOverview>('/api/system/overview'),
    [],
  )
  const [form] = Form.useForm<BackupSettingsPayload>()
  const operation = useSyncExternalStore(subscribeOperation, operationSnapshot)
  const pendingTaskId = sessionStorage.getItem('sunyu-backup-task')
  const saving = operation?.status === 'running' && operation.kind === 'save'
  const backingUp =
    operation?.status === 'running' && operation.kind === 'backup'
  const dirty = useRef(Boolean(settingsDraft))
  const [formDirty, setFormDirty] = useState(Boolean(settingsDraft))
  const [error, setError] = useState<string | null>(null)
  const { message } = App.useApp()
  useEffect(() => {
    const pendingTask = sessionStorage.getItem('sunyu-backup-task')
    if (pendingTask && settingsOperation?.status !== 'running') {
      publishOperation(null)
      void runOperation('backup', () => pollBackupTask(pendingTask))
    }
  }, [])

  useEffect(() => {
    if (settingsDraft) form.setFieldsValue(settingsDraft)
    else if (overview.data && !dirty.current)
      form.setFieldsValue(overview.data.backup)
  }, [overview.data, form])

  useEffect(() => {
    if (
      !operation ||
      operation.status === 'running' ||
      settingsOperation !== operation
    )
      return
    // 只有当前挂载的设置页消费结果，旧页面不再刷新或触发消息。
    publishOperation(null)
    if (operation.status === 'failed') {
      setError(operation.error)
      return
    }
    if (operation.result.saved) {
      settingsDraft = null
      dirty.current = false
      setFormDirty(false)
      form.setFieldsValue(operation.result.saved)
      void message.success('备份设置已保存')
    } else if (operation.result.warning) {
      void message.warning('备份已完成，历史备份清理失败，请检查备份目录')
    } else {
      void message.success('备份已完成')
    }
    void overview.reload()
  }, [operation, form, message, overview.reload])

  useEffect(() => {
    if (!formDirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [formDirty])

  function restoreSaved() {
    if (!overview.data || saving || backingUp) return
    settingsDraft = null
    dirty.current = false
    setFormDirty(false)
    form.setFieldsValue(overview.data.backup)
  }

  function save(values: BackupSettingsPayload) {
    if (settingsOperation) return
    const input: BackupSettingsPayload = {
      enabled: values.enabled,
      directory: values.directory?.trim() || null,
      interval_hours: values.interval_hours,
      retention_days: values.retention_days,
    }
    setError(null)
    void runOperation('save', async () => {
      const saved = await requestJson<BackupSettingsResponse>(
        '/api/system/backup-settings',
        {
          method: 'PUT',
          body: input,
        },
      )
      return { saved }
    })
  }
  function backup() {
    const pendingTask = sessionStorage.getItem('sunyu-backup-task')
    if (settingsOperation || (!pendingTask && (dirty.current || !overview.data?.backup.directory)))
      return
    setError(null)
    void runOperation('backup', async () => {
      if (pendingTask) return pollBackupTask(pendingTask)
      let started: { task_id: string }
      try {
        started = await requestJson<{ task_id: string }>(
          '/api/system/backup-tasks', { method: 'POST' },
        )
      } catch (cause) {
        throw new Error(`备份任务提交结果尚未确认。请刷新核对最近备份；再次点击会接续正在执行的任务。${errorText(cause)}`)
      }
      sessionStorage.setItem('sunyu-backup-task', started.task_id)
      return pollBackupTask(started.task_id)
    })
  }
  return (
    <div className={styles.stack}>
      <PageHeader
        eyebrow="SYSTEM / 数据与备份"
        title="系统设置"
        description="查看本机数据位置，安排定时备份。"
        extra={
          <RefreshButton loading={overview.loading} onClick={overview.reload} />
        }
      />
      <ErrorNotice error={overview.error} retry={overview.reload} />
      <ErrorNotice error={error} />
      {!overview.data && overview.loading && <LoadingBlock />}
      {overview.data && (
        <>
          <Section
            title="自动备份"
            description="将备份保存到本机可访问的独立目录。"
            extra={
              <Tag color={overview.data.scheduler.alive ? 'green' : 'orange'}>
                {overview.data.scheduler.alive ? '调度正常' : '调度未运行'}
              </Tag>
            }
          >
            {!overview.data.scheduler.alive && (
              <Alert
                type="warning"
                showIcon
                title="自动备份调度未运行"
                description="请检查服务状态；也可以先手动备份。"
                style={{ marginBottom: 20 }}
              />
            )}
            <Form<BackupSettingsPayload>
              form={form}
              onValuesChange={(_, values) => {
                settingsDraft = structuredClone(values)
                dirty.current = true
                setFormDirty(true)
              }}
              layout="vertical"
              onFinish={(values) => void save(values)}
              style={{ maxWidth: 650 }}
              disabled={saving || backingUp}
            >
              <Form.Item
                name="enabled"
                label="启用自动备份"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                name="directory"
                label="备份目录"
                dependencies={['enabled']}
                rules={[
                  ({ getFieldValue }) => ({
                    validator: (_, value: string) =>
                      !getFieldValue('enabled') || value?.trim()
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error('启用自动备份时，请填写备份目录'),
                          ),
                  }),
                ]}
              >
                <Input placeholder="输入当前主机可访问的目录" />
              </Form.Item>
              <div className={styles.formGrid}>
                <Form.Item
                  name="interval_hours"
                  label="备份间隔（小时）"
                  rules={[
                    {
                      required: true,
                      type: 'integer',
                      min: 1,
                      max: 8760,
                      message: '请输入 1 至 8760 的整数',
                    },
                  ]}
                >
                  <InputNumber
                    min={1}
                    max={8760}
                    precision={0}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                <Form.Item
                  name="retention_days"
                  label="保留天数"
                  extra="0 表示不自动清理。"
                  rules={[
                    {
                      required: true,
                      type: 'integer',
                      min: 0,
                      max: 3650,
                      message: '请输入 0 至 3650 的整数',
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    max={3650}
                    precision={0}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </div>
              <Space wrap>
                <Button
                  htmlType="submit"
                  aria-label="保存设置"
                  type="primary"
                  loading={saving}
                  icon={<SaveOutlined />}
                >
                  保存设置
                </Button>
                {formDirty && (
                  <Button onClick={restoreSaved}>恢复已保存设置</Button>
                )}
              </Space>
              {formDirty && (
                <p className={styles.subtle}>
                  有未保存的修改，切换页面后可继续编辑。
                </p>
              )}
            </Form>
          </Section>
          <Section
            title="最近一次备份"
            extra={
              <Button
                icon={<CloudDownloadOutlined />}
                loading={backingUp}
                disabled={
                  saving ||
                  backingUp ||
                  (!pendingTaskId && (formDirty || !overview.data.backup.directory))
                }
                onClick={() => void backup()}
              >
                {pendingTaskId ? '继续查询' : '立即备份'}
              </Button>
            }
          >
            {backingUp && (
              <Alert type="info" showIcon title={operation?.status === 'running' ? operation.phase ?? '正在提交备份任务' : '正在备份'} style={{ marginBottom: 16 }} />
            )}
            {(formDirty || !overview.data.backup.directory) && (
              <Alert
                type="info"
                showIcon
                title={
                  formDirty
                    ? '备份设置有未保存的修改，请先保存后备份。'
                    : '请先配置并保存备份目录。'
                }
                style={{ marginBottom: 16 }}
              />
            )}
            <Descriptions
              column={{ xs: 1, sm: 2 }}
              items={[
                {
                  key: 'time',
                  label: '执行时间',
                  children: formatChineseDateTime(
                    overview.data.backup.last_run?.finished_at ??
                      overview.data.backup.last_run?.started_at ??
                      null,
                  ),
                },
                {
                  key: 'status',
                  label: '执行状态',
                  children: overview.data.backup.last_run ? (
                    <StatusTag value={overview.data.backup.last_run.status} />
                  ) : (
                    '尚未执行'
                  ),
                },
                {
                  key: 'path',
                  label: '备份位置',
                  span: 'filled',
                  children: overview.data.backup.last_run?.target_path ?? '—',
                },
              ]}
            />
            {overview.data.backup.last_run?.error_message && (
              <Alert
                type="error"
                title={overview.data.backup.last_run.error_message}
                showIcon
              />
            )}
          </Section>
          <Collapse
            items={[
              {
                key: 'storage',
                label: '本机数据存放位置',
                children: (
                  <Descriptions
                    column={1}
                    items={[
                      {
                        key: 'data',
                        label: '数据目录',
                        children: overview.data.data_directory,
                      },
                      {
                        key: 'database',
                        label: '数据库路径',
                        children: overview.data.database_path,
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  )
}
