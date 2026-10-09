import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { App } from 'antd'
import { useBlocker } from 'react-router-dom'

type Check = () => boolean
const UnsavedChangesContext = createContext<Set<Check> | null>(null)

/** 一个路由阻拦器统一管理当前页面的多个编辑器，覆盖链接、页签和浏览器后退。 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const checks = useRef(new Set<Check>())
  const blocker = useBlocker(() => [...checks.current].some(check => check()))
  const { modal } = App.useApp()
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const dialog = modal.confirm({
      title: '离开并放弃未保存的修改？',
      content: '继续编辑会保留当前输入。已提交但结果未确认的请求仍可回到原页面核对。',
      okText: '放弃并离开',
      cancelText: '继续编辑',
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    })
    return () => dialog.destroy()
  }, [blocker, modal])
  return <UnsavedChangesContext.Provider value={checks.current}>{children}</UnsavedChangesContext.Provider>
}

export function useUnsavedChanges(shouldBlock: Check) {
  const checks = useContext(UnsavedChangesContext)
  const latest = useRef(shouldBlock)
  latest.current = shouldBlock
  useEffect(() => {
    const check = () => latest.current()
    checks?.add(check)
    const warn = (event: BeforeUnloadEvent) => {
      if (!check()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      checks?.delete(check)
      window.removeEventListener('beforeunload', warn)
    }
  }, [checks])
}
