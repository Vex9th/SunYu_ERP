import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkspaceNavigationProvider,
  useWorkspaceTab,
  useWorkspaceValue,
} from '../navigationState'

afterEach(cleanup)

function Screen() {
  const location = useLocation()
  const navigate = useNavigate()
  const [section, setSection] = useWorkspaceTab(
    'section',
    ['current', 'history'],
    'current',
  )
  const [query, setQuery] = useWorkspaceValue('q', '')
  const [page, setPage] = useWorkspaceValue('page', '1')
  return (
    <>
      <output aria-label="页面状态">
        {JSON.stringify({ section, query, page })}
      </output>
      <output aria-label="地址">
        {location.pathname}
        {location.search}
      </output>
      <button
        onClick={() => {
          setQuery('传感器')
          setPage('1')
        }}
      >
        搜索
      </button>
      <button onClick={() => setSection('history')}>历史</button>
      <button onClick={() => navigate(-1)}>后退</button>
      <button onClick={() => navigate(1)}>前进</button>
      <Link to="/projects/B/workforce">项目 B</Link>
      <Link to="/projects/A/workforce">项目 A</Link>
      <Link to="/projects/A/documents/2">预览</Link>
    </>
  )
}
function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceNavigationProvider>
        <Screen />
      </WorkspaceNavigationProvider>
    </MemoryRouter>,
  )
}
const state = () => JSON.parse(screen.getByLabelText('页面状态').textContent!)

describe('工作区导航上下文', () => {
  it('搜索和重置页码一起更新时保留两项参数及其它筛选', () => {
    mount('/projects/C/documents?q=旧内容&page=3&category=planning_minutes')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(state()).toMatchObject({ query: '传感器', page: '1' })
    expect(screen.getByLabelText('地址').textContent).toContain(
      'category=planning_minutes',
    )
  })
  it('浏览器后退和前进恢复默认页签与历史页签', async () => {
    mount('/projects/D/workforce')
    fireEvent.click(screen.getByRole('button', { name: '历史' }))
    expect(state().section).toBe('history')
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    await waitFor(() => expect(state().section).toBe('current'))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    await waitFor(() => expect(state().section).toBe('history'))
  })
  it('跨项目不会带入筛选，返回原项目恢复其状态', () => {
    mount('/projects/A/workforce?q=张师傅&section=history&page=2')
    fireEvent.click(screen.getByRole('link', { name: '项目 B' }))
    expect(state()).toEqual({ query: '', section: 'current', page: '1' })
    fireEvent.click(screen.getByRole('link', { name: '项目 A' }))
    expect(state()).toEqual({ query: '张师傅', section: 'history', page: '2' })
  })
  it('文档预览与列表共享筛选上下文', () => {
    mount('/projects/A/documents?q=电气图纸&page=3')
    fireEvent.click(screen.getByRole('link', { name: '预览' }))
    expect(state()).toMatchObject({ query: '电气图纸', page: '3' })
  })
})
