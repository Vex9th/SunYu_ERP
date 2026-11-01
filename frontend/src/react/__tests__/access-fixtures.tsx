import { render as testingRender, type RenderOptions } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { SessionState } from '../../types'
import { AccessProvider } from '../access/AccessProvider'
export const ownerSession: SessionState = { authenticated: true, password_configured: true, bootstrap_required: false, user: { id: 1, username: 'test-owner', display_name: '合成主账号', is_owner: true, group_id: null, group_name: null, revision: 1 }, access_revision: 1, permissions: [], project_ids: null }
export function render(ui: ReactNode, options?: RenderOptions) {
  const wrap = (content: ReactNode) => <AccessProvider session={ownerSession} refresh={async () => undefined}>{content}</AccessProvider>
  const result = testingRender(wrap(ui), options)
  return { ...result, rerender: (content: ReactNode) => result.rerender(wrap(content)) }
}
