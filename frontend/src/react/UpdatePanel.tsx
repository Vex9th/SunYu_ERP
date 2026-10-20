import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Modal, Progress, Space, Tag } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { ApiError, requestJson } from '../api'
import { formatChineseDateTime } from '../domain/dates'
import { errorText, Section } from './shared'
import styles from './UpdatePanel.module.css'

export interface UpdateStatus {
  job_id: string
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'stopping' | 'backing_up' | 'installing' | 'restarting' | 'success' | 'failed'
  message: string
  progress: number
  current_version: string
  latest_version: string
  update_available: boolean
  busy: boolean
  error: string
  checked_at: string
  can_install: boolean
  disabled_reason: string
  supported: boolean
  recovery_required?: boolean
}

interface PendingInstall { job_id: string; previous_job_id: string }
interface UpdatePanelProps {
  installBlockedReason?: string | null
  onInstallBusyChange?: (busy: boolean) => void
}
const PENDING_KEY = 'sunyu-update-install'
const POLL_INTERVAL = 2000
const RECONNECT_LIMIT = 60_000
const installingPhases = new Set<UpdateStatus['phase']>(['downloading', 'stopping', 'backing_up', 'installing', 'restarting'])
const phaseLabels: Record<UpdateStatus['phase'], string> = {
  idle: '尚无可用更新', checking: '检查中', available: '发现新版本', downloading: '正在下载',
  stopping: '正在停止服务', backing_up: '正在准备恢复文件', installing: '正在安装',
  restarting: '正在启动新版', success: '更新完成', failed: '更新未完成',
}

function updateMessage(value: string): string {
  if (value.includes('TLS handshake timeout'))
    return '连接 GitHub 下载服务超时，请检查网络后重试。'
  // 兼容旧更新器保存的错误，避免临时下载签名撑坏页面或展示给用户。
  return value.replace(/https?:\/\/[^\s"<>]+/g, (address) => {
    try { return new URL(address).hostname } catch { return '官方更新地址' }
  })
}

function readPending(): PendingInstall | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null')
    if (value && typeof value === 'object' && 'job_id' in value && 'previous_job_id' in value
      && typeof value.job_id === 'string' && typeof value.previous_job_id === 'string')
      return { job_id: value.job_id, previous_job_id: value.previous_job_id }
  } catch { /* 浏览器禁止会话存储时，当前页面仍可完成状态核对。 */ }
  return null
}

export default function UpdatePanel({ installBlockedReason, onInstallBusyChange }: UpdatePanelProps = {}) {
  const pending = useRef<PendingInstall | null>(readPending())
  const [installPending, setInstallPending] = useState(Boolean(pending.current))
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const latestStatus = useRef<UpdateStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [originalResultUnknown, setOriginalResultUnknown] = useState(false)
  const [paused, setPaused] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const operation = useRef(false)
  const disconnectedSince = useRef<number | null>(null)
  const props = useRef({ installBlockedReason, onInstallBusyChange })
  props.current = { installBlockedReason, onInstallBusyChange }

  function remember(value: PendingInstall | null) {
    pending.current = value
    setInstallPending(Boolean(value))
    try {
      if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value))
      else sessionStorage.removeItem(PENDING_KEY)
    } catch { /* 状态仍由服务端保存；离页后会先读取服务端任务。 */ }
  }
  function statusPath() {
    return pending.current?.job_id
      ? `/api/system/updates?job_id=${encodeURIComponent(pending.current.job_id)}`
      : '/api/system/updates'
  }
  function active(current: AbortController) {
    return controller.current === current && !current.signal.aborted
  }
  function stop() {
    controller.current?.abort()
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  function reconnect(message: string) {
    disconnectedSince.current ??= Date.now()
    if (Date.now() - disconnectedSince.current >= RECONNECT_LIMIT) {
      setPaused(true)
      setProblem('暂时无法确认更新结果，已停止自动查询。服务可能仍在更新，请恢复连接后继续查询，不要重复安装。')
      return false
    }
    setProblem(message)
    return true
  }
  function consume(next: UpdateStatus) {
    latestStatus.current = next
    setStatus(next)
    setProblem(null)
    const expected = pending.current
    if (expected) {
      if (expected.job_id && next.job_id !== expected.job_id) {
        setPaused(true)
        setProblem('更新任务记录已变化，原任务结果尚未确认。请核对当前版本后继续查询。')
        return false
      }
      if (!expected.job_id) {
        if (!next.job_id || next.job_id === expected.previous_job_id)
          return reconnect('安装请求结果尚未确认，正在查询服务状态；不会重复提交安装。')
        remember({ ...expected, job_id: next.job_id })
      }
      if (!next.busy && (next.phase === 'success' || next.phase === 'failed')) {
        remember(null)
        setOriginalResultUnknown(false)
      }
      else if (!next.busy)
        return reconnect('安装任务尚未返回明确结果，正在继续查询；不会重复提交安装。')
    } else if (next.busy && installingPhases.has(next.phase)) {
      remember({ job_id: next.job_id, previous_job_id: '' })
    }
    disconnectedSince.current = null
    setPaused(false)
    return next.busy
  }
  function schedule(current: AbortController) {
    if (!active(current)) return
    timer.current = setTimeout(() => { timer.current = null; void read(current) }, POLL_INTERVAL)
  }
  async function readFailure(cause: unknown, current: AbortController) {
    if (cause instanceof ApiError && cause.status === 410 && pending.current) {
      if (reconnect('服务端尚未找到原任务记录，正在继续核对；不会重复安装。')) {
        schedule(current)
      } else {
        // 可能是未被服务端接受的请求，或更早的结果被后续安装替换。
        // 只核对当前状态并解除旧页面等待，不能宣称原任务成功。
        try {
          const next = await requestJson<UpdateStatus>('/api/system/updates', { signal: current.signal, timeoutMs: 10_000 })
          if (!active(current)) return
          remember(null)
          if (consume(next)) schedule(current)
          setOriginalResultUnknown(true)
        } catch {
          if (active(current)) setProblem('无法核对当前版本，请恢复连接后继续查询。')
        }
      }
    } else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
      setPaused(true)
      setProblem('无法查询更新状态，请重新登录后继续查询；安装结果尚未确认。')
    } else if (pending.current || latestStatus.current?.busy) {
      if (reconnect('服务暂时无法连接，正在重新连接并核对原任务；不会重复安装。')) schedule(current)
    } else {
      setPaused(true)
      setProblem(errorText(cause))
    }
  }
  async function read(current: AbortController) {
    try {
      const next = await requestJson<UpdateStatus>(statusPath(), { signal: current.signal, timeoutMs: 10_000 })
      if (!active(current)) return
      if (consume(next)) schedule(current)
    } catch (cause) {
      if (!active(current)) return
      await readFailure(cause, current)
    } finally {
      if (active(current)) { setLoading(false); operation.current = false }
    }
  }
  async function submit(action: 'check' | 'install', current: AbortController) {
    try {
      const next = await requestJson<UpdateStatus>(`/api/system/updates/${action}`, {
        method: 'POST', signal: current.signal, timeoutMs: 10_000,
        body: action === 'install' ? { job_id: pending.current?.job_id } : undefined,
      })
      if (!active(current)) return
      if (action === 'install' && pending.current)
        remember({ ...pending.current, job_id: next.job_id })
      if (consume(next)) schedule(current)
    } catch (cause) {
      if (!active(current)) return
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        if (action === 'install') remember(null)
        setProblem(errorText(cause))
        if (cause.status === 409) await read(current)
      } else if (action === 'install') {
        if (reconnect('安装请求结果尚未确认，正在重新连接并核对状态；不会重复提交安装。')) schedule(current)
      } else {
        setPaused(true)
        setProblem(`检查结果尚未确认，请继续查询更新状态。${errorText(cause)}`)
      }
    } finally {
      if (active(current)) { setLoading(false); operation.current = false }
    }
  }
  function begin(action: 'load' | 'check' | 'install' | 'resume') {
    if (operation.current) return
    if (action === 'install' && (!latestStatus.current?.supported || !latestStatus.current.can_install
      || !latestStatus.current.update_available && !latestStatus.current.recovery_required
      || props.current.installBlockedReason || pending.current || latestStatus.current.busy)) return
    if (action === 'check' && (pending.current || latestStatus.current?.busy || latestStatus.current?.recovery_required || !latestStatus.current?.supported)) return
    stop()
    const current = new AbortController()
    controller.current = current
    operation.current = true
    disconnectedSince.current = null
    setLoading(true)
    setProblem(null)
    setPaused(false)
    if (action === 'install') {
      setOriginalResultUnknown(false)
      remember({ job_id: crypto.randomUUID(), previous_job_id: latestStatus.current?.job_id ?? '' })
      void submit(action, current)
    } else if (action === 'check') {
      setOriginalResultUnknown(false)
      void submit(action, current)
    }
    else if (action === 'resume') void read(current)
    else void (async () => {
      const hadPending = Boolean(pending.current)
      try {
        const next = await requestJson<UpdateStatus>(statusPath(), { signal: current.signal, timeoutMs: 10_000 })
        if (!active(current)) return
        const keepPolling = consume(next)
        if (keepPolling) schedule(current)
        else if (!hadPending && !pending.current && next.supported && !next.busy && !next.recovery_required && next.phase !== 'success')
          await submit('check', current)
      } catch (cause) {
        if (!active(current)) return
        await readFailure(cause, current)
      } finally {
        if (active(current)) { setLoading(false); operation.current = false }
      }
    })()
  }

  useEffect(() => {
    begin('load')
    return () => { stop(); operation.current = false }
  }, [])
  const installing = installPending || Boolean(status?.recovery_required || status?.busy && installingPhases.has(status.phase))
  useEffect(() => { props.current.onInstallBusyChange?.(installing) }, [installing])
  const unavailableReason = status && (!status.supported || !status.can_install)
    ? status.disabled_reason || '请在运行程序的本机打开设置页安装更新。' : null
  const blockedReason = installBlockedReason || unavailableReason
  const installDisabled = loading || !status?.supported || !status.can_install || !status.update_available && !status.recovery_required
    || status.busy || installPending || Boolean(installBlockedReason)
  const completed = status?.phase === 'success' && !installPending && !status.recovery_required && !originalResultUnknown
  const installLabel = status?.recovery_required ? '继续恢复更新'
    : status?.phase === 'failed' && !installPending ? '重试更新' : '一键更新'

  return <Section title="软件更新" description="优先从蓝奏下载，异常时回退 GitHub。检查更新仅作提示，安装需确认。">
    <div className={styles.content}>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: 'current', label: '当前版本', children: status?.current_version || '正在读取' },
        { key: 'latest', label: '最新版本', children: status?.latest_version || '尚未检查' },
        { key: 'checked', label: '最近检查', children: formatChineseDateTime(status?.checked_at || null) },
        { key: 'phase', label: '更新状态', children: <Tag color={status?.phase === 'failed' ? 'error' : completed ? 'success' : status?.update_available ? 'blue' : undefined}>{status ? status.phase === 'idle' && !status.checked_at ? '尚未检查' : phaseLabels[status.phase] : '正在读取'}</Tag> },
      ]} />
      {status?.message && status.message !== status.error && <p className={styles.message} aria-live="polite">{updateMessage(status.message)}</p>}
      {status?.busy && <Progress percent={Math.max(0, Math.min(100, status.progress))} status={status.phase === 'checking' ? 'normal' : 'active'} aria-label="更新进度" />}
      {problem && <Alert type="warning" showIcon title={problem} />}
      {originalResultUnknown && <Alert type="warning" showIcon title="原任务结果已无法确认，已重新读取当前版本和任务状态；没有重新提交安装。" />}
      {status?.error && <Alert className={styles.error} type="error" showIcon title={updateMessage(status.error)} />}
      {blockedReason && <Alert type="info" showIcon title={blockedReason} />}
      {completed && <Alert type="success" showIcon title="更新已完成，请保存其他页面的工作后刷新使用新版。" />}
      <Space wrap>
        <Button aria-label="检查更新" icon={<ReloadOutlined />} loading={loading && !installPending || status?.phase === 'checking' && status.busy}
          disabled={loading || Boolean(status?.busy) || installPending || Boolean(status?.recovery_required) || status?.supported === false}
          onClick={() => begin('check')}>检查更新</Button>
        <Button aria-label={installLabel} type="primary" icon={<CloudDownloadOutlined />} disabled={installDisabled}
          onClick={() => { if (!installDisabled && !operation.current) setConfirming(true) }}>
          {installLabel}
        </Button>
        {paused && <Button onClick={() => begin('resume')} loading={loading}>继续查询更新状态</Button>}
        {status?.phase === 'failed' && !status.busy && !installPending && !status.recovery_required && (
          <>
            <Button href="https://urldown.lanzouw.com/b019w91rof" target="_blank" rel="noopener noreferrer">
              蓝奏下载（提取码 hru1）
            </Button>
            <Button href="https://github.com/Vex9th/SunYu_ERP/releases/latest" target="_blank" rel="noopener noreferrer">
              手动下载完整包
            </Button>
          </>
        )}
        {completed && <Button disabled={Boolean(installBlockedReason)} onClick={() => {
          if (!props.current.installBlockedReason) window.location.reload()
        }}>刷新使用新版</Button>}
      </Space>
    </div>
    <Modal title="更新前请保存工作" open={confirming} okText="开始更新" cancelText="暂不更新"
      okButtonProps={{ disabled: installDisabled }} onCancel={() => setConfirming(false)}
      onOk={() => { if (!installDisabled) { setConfirming(false); begin('install') } }}>
      <p>请确认其他页面及其他使用者已保存工作。安装时服务会短暂停止；此页会继续查询进度，完成后由你选择刷新。</p>
      {blockedReason && <Alert type="info" showIcon title={blockedReason} />}
    </Modal>
  </Section>
}
