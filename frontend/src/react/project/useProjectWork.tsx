import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { ApiError } from '../../api'

export const errorText = (error: unknown): string => error instanceof Error ? error.message : '操作失败，请重试'
export const nullable = (value?: string | null): string | null => value?.trim() || null
export interface ProjectProps { projectCode: string; readonly?: boolean }

/** A result-unknown request keeps its original payload and idempotency key across tab switches. */
interface PendingWrite { title: string; run: () => Promise<unknown>; discard?: () => boolean; busy: boolean; error?: string }
const pending = new Map<string, PendingWrite>()
const listeners = new Set<() => void>()
const successListeners = new Set<(scope: string) => void>()
function publish() { listeners.forEach((listener) => listener()) }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function unknownResult(error: unknown) { return !(error instanceof ApiError) || error.status === 0 || [408, 425, 429].includes(error.status) || error.status >= 500 }

export function useProjectWrite(scope: string, onSaved: () => void) {
  const context = useRef(scope)
  context.current = scope
  const mounted = useRef(true)
  const saved = useRef(onSaved)
  saved.current = onSaved
  const [error, setError] = useState<string | null>(null)
  const job = useSyncExternalStore(subscribe, () => pending.get(scope), () => undefined)
  useEffect(() => { mounted.current = true; setError(null); const success = (target: string) => { if (target === scope) saved.current() }; successListeners.add(success); return () => { mounted.current = false; successListeners.delete(success) } }, [scope])
  async function execute(write: PendingWrite) {
    const target = scope
    if (pending.get(target)?.busy) return
    const running = { ...write, busy: true, error: undefined }
    pending.set(target, running); publish(); setError(null)
    try {
      await running.run()
      pending.delete(target); publish()
      successListeners.forEach(listener => listener(target))
      window.dispatchEvent(new CustomEvent('project-data-changed', { detail: { projectCode: target.slice(target.indexOf(':') + 1) } }))
    } catch (cause) {
      if (unknownResult(cause)) pending.set(target, { ...running, busy: false, error: errorText(cause) })
      else pending.delete(target)
      publish()
      if (mounted.current && context.current === target) setError(errorText(cause))
    }
  }
  function submit(title: string, run: () => Promise<unknown>, discard?: () => boolean) {
    if (pending.has(scope)) return
    void execute({ title, run, discard, busy: false })
  }
  function abandon() {
    if (!job?.discard || job.busy) return
    if (!job.discard()) { setError('原请求仍在处理中，暂时不能放弃'); return }
    pending.delete(scope); publish(); setError(null); saved.current()
  }
  return {
    locked: Boolean(job), busy: Boolean(job?.busy), error, clearError: () => setError(null), submit,
    notice: job && !job.busy ? <Alert type="warning" showIcon title={`${job.title}的结果尚未确认`} description={<Space wrap><span>{job.error}。请使用原请求安全重试，确认结果前暂不提交新操作。</span><Button onClick={() => void execute(job)}>重试原请求</Button>{job.discard && <Popconfirm title="放弃此请求的安全重试？" description="原请求可能已经保存。放弃后将刷新台账，请先核对记录再重新提交。" okText="放弃并核对台账" cancelText="保留原请求" onConfirm={abandon}><Button danger>放弃原请求</Button></Popconfirm>}</Space>} /> : error ? <Alert type="error" showIcon title={error} closable onClose={() => setError(null)} /> : null,
  }
}

export function useProjectLoad<T>(projectCode: string, loader: () => Promise<T>, identity?: object) {
  const [state, setState] = useState<{ key: string; identity?: object; data: T | null; loading: boolean; error: string | null }>({ key: projectCode, identity, data: null, loading: true, error: null })
  const [tick, setTick] = useState(0)
  const latest = useRef(loader); latest.current = loader
  useEffect(() => {
    let alive = true
    setState({ key: projectCode, identity, data: null, loading: true, error: null })
    void latest.current().then(data => { if (alive) setState({ key: projectCode, identity, data, loading: false, error: null }) }).catch(cause => { if (alive) setState({ key: projectCode, identity, data: null, loading: false, error: errorText(cause) }) })
    return () => { alive = false }
  }, [projectCode, identity, tick])
  const current = state.key === projectCode && state.identity === identity
  return { data: current ? state.data : null, loading: !current || state.loading, error: current ? state.error : null, reload: () => setTick(value => value + 1) }
}
