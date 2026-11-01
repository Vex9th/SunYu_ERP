import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AccountUser, SessionState } from '../../types'
export interface AccessState {
  user: AccountUser | null
  namespace: string
  accessRevision: number
  can: (permission: string, projectId?: number) => boolean
  refresh: () => Promise<void>
}
const AccessContext = createContext<AccessState>({
  user: null,
  namespace: 'anonymous',
  accessRevision: 0,
  can: () => false,
  refresh: async () => undefined
})
export function AccessProvider({
  session,
  refresh,
  children
}: {
  session: SessionState
  refresh: () => Promise<void>
  children: ReactNode
}) {
  const value = useMemo<AccessState>(() => ({
    user: session.authenticated ? session.user ?? null : null,
    namespace: session.authenticated && session.user ? `user:${session.user.id}` : 'anonymous',
    accessRevision: session.access_revision ?? 0,
    can: (permission, projectId) => {
      if (!session.authenticated || !session.user) return false
      if (session.user.is_owner) return true
      if (!session.user.group_id || !session.permissions?.includes(permission)) return false
      return projectId === undefined || Boolean(session.project_ids?.includes(projectId))
    },
    refresh
  }), [session, refresh])
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}
export const useAccess = () => useContext(AccessContext)
