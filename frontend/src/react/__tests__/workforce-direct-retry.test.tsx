import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import WorkforceWorkspace from '../workforce/WorkforceWorkspace'
import { createHttpWorkforceWorkspaceRepository } from '../../repositories/workforce.live'
import type { WorkerStatus } from '../../domain/workforce'

beforeAll(() => {
  const computedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element) => computedStyle(element)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true
      },
    }),
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const projectCode = 'DIRECT-RETRY'
const date = '2026-10-06'
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 })
const page = (items: unknown[]) =>
  response({ items, total: items.length, page: 1, page_size: 200 })
function serverFixture(
  kind: 'assignment' | 'deactivate' | 'reactivate' | 'report',
) {
  let committed = false
  const worker = () => ({
    id: 1,
    name: '维护施工员',
    phone: null,
    notes: null,
    status: (kind === 'reactivate'
      ? committed
        ? 'active'
        : 'inactive'
      : kind === 'deactivate' && committed
        ? 'inactive'
        : 'active') as WorkerStatus,
    revision: committed ? 2 : 1,
    created_at: '',
    updated_at: '',
  })
  const assignment = () => ({
    id: 7,
    project_code: projectCode,
    worker_id: 1,
    worker_name: '维护施工员',
    role: '安装',
    scheduled_start_on: date,
    scheduled_end_on: '9999-12-31',
    pay_basis: 'daily',
    rate_cents: 30000,
    notes: null,
    status: kind === 'assignment' && committed ? 'active' : 'planned',
    revision: committed ? 2 : 1,
    created_at: '',
    updated_at: '',
  })
  const report = () => ({
    id: 9,
    project_code: projectCode,
    work_date: date,
    location: null,
    weather: null,
    work_summary: '安装完成',
    blockers: null,
    next_plan: null,
    notes: null,
    status: kind === 'report' && committed ? 'confirmed' : 'draft',
    versions: [],
    events: [],
    confirmed_at: null,
    revision: committed ? 2 : 1,
    created_at: '',
    updated_at: '',
  })
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (request, init) => {
      const path = String(request)
      if (init?.method === 'POST') {
        if (!committed) {
          committed = true
          throw new TypeError('服务端已提交，响应丢失')
        }
        return response(
          kind === 'assignment'
            ? assignment()
            : kind === 'report'
              ? report()
              : worker(),
        )
      }
      if (path === '/api/workers/1') return response(worker())
      if (path.startsWith('/api/workers?')) return page([worker()])
      if (path.includes('/crew-assignments?')) return page([assignment()])
      if (path.includes('/site-daily-reports?')) return page([report()])
      if (
        path.includes('/labor-entries?') ||
        path.includes('/material-advances?')
      )
        return page([])
      throw new Error(`unexpected ${path}`)
    })
  vi.stubGlobal('fetch', fetchMock)
  return {
    writes: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => init!),
  }
}

describe('施工直接操作的原请求恢复', () => {
  const cases = [
    {
      kind: 'assignment',
      label: '开始项目安排',
      tab: '项目安排',
      button: /^开\s*始$/,
      confirm: false,
    },
    {
      kind: 'deactivate',
      label: '停用施工员',
      tab: '施工员档案',
      button: /^停\s*用$/,
      confirm: true,
    },
    {
      kind: 'reactivate',
      label: '启用施工员',
      tab: '施工员档案',
      button: /^启\s*用$/,
      confirm: true,
    },
    {
      kind: 'report',
      label: '确认日报',
      tab: '施工日报',
      button: /^确\s*认$/,
      confirm: true,
    },
  ] as const
  it.each(cases)(
    '$label 响应丢失且刷新到新状态后，重挂页面仍可原样重试',
    async ({ kind, tab, button, confirm }) => {
      const server = serverFixture(kind)
      const repository = createHttpWorkforceWorkspaceRepository()
      const element = (
        <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
          <WorkforceWorkspace
            projectCode={projectCode}
            repository={repository}
          />
        </ConfigProvider>
      )
      const firstView = render(element)
      fireEvent.click(await screen.findByRole('tab', { name: tab }))
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: button }).hasAttribute('disabled'),
        ).toBe(false),
      )
      fireEvent.click(screen.getByRole('button', { name: button }))
      if (confirm)
        fireEvent.click(
          await screen.findByRole('button', { name: /^确\s*定$/ }),
        )
      await screen.findByRole('button', { name: '恢复并重试' })
      expect(server.writes()).toHaveLength(1)
      expect(
        screen.getByRole('button', { name: /刷新/ }).hasAttribute('disabled'),
      ).toBe(true)
      firstView.unmount()

      // 模拟其他界面刷新缓存：服务端状态和 revision 已经发生变化。
      const refreshed = (await repository.getWorkforcePreview(projectCode)).data
      if (kind === 'assignment')
        expect(refreshed.crew_assignments[0]?.status).toBe('active')
      else if (kind === 'report')
        expect(refreshed.site_daily_reports[0]?.status).toBe('confirmed')
      else
        expect(refreshed.workers[0]?.status).toBe(
          kind === 'deactivate' ? 'inactive' : 'active',
        )

      render(element)
      fireEvent.click(await screen.findByRole('button', { name: '恢复并重试' }))
      fireEvent.click(await screen.findByRole('button', { name: '重试原提交' }))
      await waitFor(() => expect(server.writes()).toHaveLength(2))
      const [first, retry] = server.writes()
      expect(retry!.body).toBe(first!.body)
      expect(new Headers(retry!.headers).get('Idempotency-Key')).toBe(
        new Headers(first!.headers).get('Idempotency-Key'),
      )
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '恢复并重试' })).toBeNull(),
      )
      await screen.findByText('记录已保存')
    },
  )
})
