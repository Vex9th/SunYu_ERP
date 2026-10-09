import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from 'react-router-dom'
import { useRef } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installProjectDom } from './project-fixtures'
import { UnsavedChangesProvider, useUnsavedChanges } from '../unsavedChanges'

beforeAll(installProjectDom)
afterEach(cleanup)
function Editor() {
  const dirty = useRef(false)
  const navigate = useNavigate()
  useUnsavedChanges(() => dirty.current)
  return <><input aria-label="草稿" onChange={() => { dirty.current = true }} />
    <Link to="/other">切换页面</Link><button onClick={() => navigate(-1)}>后退</button></>
}
function mount() {
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [
    { path: '/edit', element: <Editor /> }, { path: '/other', element: <p>其他页面</p> },
  ] }], { initialEntries: ['/other', '/edit'], initialIndex: 1 })
  render(<ConfigProvider theme={{ token: { motion: false } }}><App><RouterProvider router={router} /></App></ConfigProvider>)
  return router
}
describe('统一未保存内容保护', () => {
  it.each(['切换页面', '后退'])('%s 时可以留下继续编辑，确认放弃后才离开', async action => {
    const router = mount()
    fireEvent.change(screen.getByLabelText('草稿'), { target: { value: '未保存的会议纪要' } })
    fireEvent.click(screen.getByText(action))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/edit')
    expect((screen.getByLabelText('草稿') as HTMLInputElement).value).toBe('未保存的会议纪要')
    fireEvent.click(screen.getByText(action))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并离开' }))
    await screen.findByText('其他页面')
  })
  it('无修改直接离开；刷新警告实时读取表单并在卸载后清除', async () => {
    mount()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    fireEvent.change(screen.getByLabelText('草稿'), { target: { value: '内容' } })
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    cleanup()
    const unloaded = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unloaded)
    expect(unloaded.defaultPrevented).toBe(false)
    mount()
    fireEvent.click(screen.getByText('切换页面'))
    expect(await screen.findByText('其他页面')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
