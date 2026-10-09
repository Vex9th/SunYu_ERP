/** 请求闭包存放于内存台账；离开路由后仍需防止刷新丢失安全重试信息。 */
export function protectPendingWrites(hasPending: () => boolean, subscribe: (listener: () => void) => () => void) {
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
  return () => { unsubscribe(); window.removeEventListener('beforeunload', warn) }
}
