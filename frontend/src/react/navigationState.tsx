import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'

type WorkspaceNavigation = {
  scope: string
  search: URLSearchParams
  update: (name: string, value: string, replace?: boolean) => void
}
const NavigationContext = createContext<WorkspaceNavigation | null>(null)
const remembered = new Map<string, string>()

export function WorkspaceNavigationProvider({
  children,
}: {
  children: ReactNode
}) {
  const { pathname } = useLocation()
  const [search, setSearch] = useSearchParams()
  const latestSearch = useRef(search)
  latestSearch.current = search
  // 文档详情属于同一个文件列表，打开预览时保留筛选上下文。
  const scope = pathname.replace(/(\/documents)\/\d+$/, '$1')
  return (
    <NavigationContext.Provider
      value={{
        scope,
        search,
        update: (name, value, replace = name !== 'section') => {
          const next = new URLSearchParams(latestSearch.current)
          next.set(name, value)
          latestSearch.current = next
          setSearch(next, { replace })
        },
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

export function useWorkspaceValue(
  name: string,
  fallback: string,
): [string, (value: string) => void] {
  const context = useContext(NavigationContext)
  const [local, setLocal] = useState(fallback)
  const key = context ? `${context.scope}:${name}` : ''
  const value = context
    ? (context.search.get(name) ?? remembered.get(key) ?? fallback)
    : local
  const missing = Boolean(context && !context.search.has(name))
  useEffect(() => {
    if (!context) return
    remembered.set(key, value)
    // 首次进入也写明当前状态；否则后退到无参数地址时会误用后来记住的页签。
    if (missing) context.update(name, value, true)
  }, [key, value, missing])
  return [
    value,
    (next: string) => {
      if (context) {
        remembered.set(key, next)
        context.update(name, next)
      } else setLocal(next)
    },
  ]
}

export function useWorkspaceTab(
  name: string,
  allowed: readonly string[],
  fallback: string,
): [string, (value: string) => void] {
  const [value, setValue] = useWorkspaceValue(name, fallback)
  return [
    allowed.includes(value) ? value : fallback,
    (next) => setValue(allowed.includes(next) ? next : fallback),
  ]
}
