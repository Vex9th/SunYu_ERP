type ReloadGuard = { check: () => boolean; kind: 'draft' | 'pending' }
const reloadGuards = new Set<ReloadGuard>()

/** 保留于路由外的草稿、原请求也必须参与主动刷新检查。 */
export function registerReloadGuard(check: () => boolean, kind: ReloadGuard['kind']) {
  const guard = { check, kind }
  reloadGuards.add(guard)
  return () => { reloadGuards.delete(guard) }
}

export function reloadBlockReason(): string | null {
  const blocked = [...reloadGuards].filter(guard => guard.check())
  if (blocked.some(guard => guard.kind === 'pending')) return '业务请求仍在执行或结果尚未确认，请返回原页面核对后再刷新。'
  if (blocked.length) return '请先保存或处理未保存的修改，再刷新使用新版本。'
  return null
}

/** 请求闭包存放于内存台账；离开路由后仍需防止刷新丢失安全重试信息。 */
export function protectPendingWrites(hasPending: () => boolean, subscribe: (listener: () => void) => () => void) {
  const releaseGuard = registerReloadGuard(hasPending, 'pending')
  let attached = false
  const warn = (event: BeforeUnloadEvent) => {
    if (hasPending()) { event.preventDefault(); event.returnValue = '' }
  }
  const sync = () => {
    const pending = hasPending()
    if (pending && !attached) window.addEventListener('beforeunload', warn)
    if (!pending && attached) window.removeEventListener('beforeunload', warn)
    attached = pending
  }
  const unsubscribe = subscribe(sync)
  sync()
  return () => { releaseGuard(); unsubscribe(); window.removeEventListener('beforeunload', warn) }
}
