import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, requestJson } from '../../api'
import { errorText } from '../shared'
import { useRefreshBlockReason } from '../unsavedChanges'
import { isRunningJob, type UpdateState } from './types'

const endpoint = '/api/system/updates'
const checkInterval = 6 * 60 * 60 * 1000
interface UpdatesContextValue {
  state: UpdateState | null
  loading: boolean
  busy: boolean
  uncertain: boolean
  connectionError: string | null
  actionError: string | null
  refreshError: string | null
  pageVersion: string
  dismissed: string | null
  dismiss: (version: string) => void
  read: () => Promise<void>
  check: () => Promise<void>
  update: () => Promise<void>
  importPackage: (file: File) => Promise<void>
  preferences: (patch: Partial<UpdateState['preferences']>) => Promise<void>
  refreshPage: () => void
}
const UpdatesContext = createContext<UpdatesContextValue | null>(null)
export const useUpdates = () => useContext(UpdatesContext)

/** Provider 随登录态存在；路由切换不会丢失任务状态，重启断线只重查不重提。 */
export function UpdatesProvider({ children, pageVersion = __APP_VERSION__ }: { children: ReactNode; pageVersion?: string }) {
  const [state, setState] = useState<UpdateState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [pollRevision, setPollRevision] = useState(0)
  const current = useRef<UpdateState | null>(null)
  const mounted = useRef(false)
  const actionBusy = useRef(false)
  const reading = useRef(false)
  const generation = useRef(0)
  const confirmsUncertainRequest = useRef<((next: UpdateState) => boolean) | null>(null)
  const pendingRequestID = useRef<string | null>(null)
  const getRefreshBlockReason = useRefreshBlockReason()
  const accept = useCallback((next: UpdateState) => {
    if (confirmsUncertainRequest.current?.(next)) {
      confirmsUncertainRequest.current = null
      pendingRequestID.current = null
      setUncertain(false)
      setActionError(null)
      setRefreshError(null)
    }
    current.current = next
    setState(next)
    setConnectionError(null)
  }, [])
  const read = useCallback(async () => {
    if (reading.current || actionBusy.current) return
    reading.current = true
    const epoch = generation.current
    try {
      const next = await requestJson<UpdateState>(pendingRequestID.current ? `${endpoint}?request_id=${encodeURIComponent(pendingRequestID.current)}` : endpoint, { timeoutMs: 8000 })
      if (mounted.current && epoch === generation.current) accept(next)
    } catch (cause) {
      if (mounted.current && epoch === generation.current) setConnectionError(errorText(cause))
    } finally {
      reading.current = false
      if (mounted.current) { setLoading(false); setPollRevision(value => value + 1) }
    }
  }, [accept])
  const action = useCallback(async (path: string, body?: unknown, method: 'POST' | 'PATCH' = 'POST') => {
    if (actionBusy.current || confirmsUncertainRequest.current || !current.current?.supported) return
    if (path !== '/check' && !current.current.can_install) return
    if (isRunningJob(current.current.job) || current.current.job?.status === 'manual_recovery') return
    if (path === '/update' || path === '/import') {
      const reason = getRefreshBlockReason()
      if (reason) { setActionError(reason.replace('再刷新使用新版本', '再开始更新')); return }
    }
    actionBusy.current = true
    const requestID = crypto.randomUUID()
    confirmsUncertainRequest.current = null
    generation.current++
    setBusy(true)
    setActionError(null)
    if (path === '/check') {
      try { sessionStorage.setItem('sunyu-update-checked-at', String(Date.now())) } catch { /* 存储不可用时仍允许手动检查。 */ }
    }
    try {
      const next = await requestJson<UpdateState>(`${endpoint}${path}`, { method, body, headers: { 'X-Update-Request-ID': requestID }, timeoutMs: path === '/import' ? 120000 : 15000 })
      if (mounted.current) accept(next)
    } catch (cause) {
      if (mounted.current) {
        const resultUnknown = !(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500 || [408, 425, 429].includes(cause.status)
        setActionError(resultUnknown ? `提交结果尚未确认，正在查询后台任务；请勿重复提交。${errorText(cause)}` : errorText(cause))
        if (resultUnknown) {
          pendingRequestID.current = path === '/preferences' ? null : requestID
          confirmsUncertainRequest.current = path === '/preferences'
            ? next => Object.entries(body as Partial<UpdateState['preferences']>).every(([key, value]) => next.preferences[key as keyof UpdateState['preferences']] === value)
            // 只有服务端持久化的同一请求能确认受理，旧任务和其他窗口不能解除保护。
            : next => (next.requested_job ?? next.job)?.request_id === requestID
          setUncertain(true)
          setConnectionError(errorText(cause))
        }
      }
    } finally {
      actionBusy.current = false
      if (mounted.current) { setBusy(false); void read() }
    }
  }, [accept, read, getRefreshBlockReason])
  const check = useCallback(async () => {
    await action('/check')
  }, [action])

  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false; generation.current++ }
  }, [read])
  useEffect(() => {
    if (loading || busy || state?.supported === false) return
    const timer = setTimeout(() => void read(), connectionError ? 3000 : uncertain || isRunningJob(state?.job) ? 1500 : 30000)
    return () => clearTimeout(timer)
  }, [state, loading, busy, uncertain, connectionError, read, pollRevision])
  const lastAutoCheck = useRef(0)
  useEffect(() => {
    if (!state?.supported || !state.preferences.auto_check || busy || uncertain || connectionError || isRunningJob(state.job) || state.job?.status === 'manual_recovery') return
    let stored = 0
    try { stored = Number(sessionStorage.getItem('sunyu-update-checked-at')) || 0 } catch { /* 无存储时使用当前登录会话的检查间隔。 */ }
    if (Date.now() - Math.max(stored, lastAutoCheck.current) < checkInterval) return
    lastAutoCheck.current = Date.now()
    void check()
  }, [state, busy, uncertain, connectionError, check])

  return <UpdatesContext.Provider value={{
    state, loading, busy, uncertain, connectionError, actionError, refreshError, pageVersion, dismissed,
    dismiss: setDismissed, read, check,
    update: () => action('/update'),
    importPackage: file => { const body = new FormData(); body.set('file', file, file.name); return action('/import', body) },
    preferences: patch => action('/preferences', patch, 'PATCH'),
    refreshPage: () => {
      const reason = getRefreshBlockReason()
      if (reason) { setRefreshError(reason); return }
      if (actionBusy.current || confirmsUncertainRequest.current || connectionError || isRunningJob(current.current?.job)) {
        setRefreshError('更新任务尚未确认完成，请等待连接恢复并确认任务结果后刷新。')
        return
      }
      window.location.reload()
    },
  }}>{children}</UpdatesContext.Provider>
}
