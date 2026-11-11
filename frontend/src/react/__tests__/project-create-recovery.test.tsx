import { render } from './access-fixtures'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setAccountNamespace } from '../../api'
import ProjectsPage from '../ProjectsPage'
import { installProjectDom } from './project-fixtures'

beforeAll(installProjectDom)
afterEach(() => { cleanup(); setAccountNamespace(null); vi.unstubAllGlobals() })
describe('新建项目断网恢复', () => {
  it('明确放弃原请求后可新建不同项目，生成新的幂等键', async () => {
    setAccountNamespace(999)
    const sent: { code: string; key: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body))
        sent.push({ code: body.project_code, key: new Headers(options.headers).get('Idempotency-Key') })
        if (sent.length === 1) throw new TypeError('offline')
        return new Response(JSON.stringify(body), { status: 201 })
      }
      return new Response(JSON.stringify(String(path).startsWith('/api/companies') ? [{ id: 1, name: '合成客户' }] : []))
    }))
    render(<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App><MemoryRouter initialEntries={['/projects?create=1']}><Routes>
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:projectCode" element={<div>已进入新项目</div>} />
    </Routes></MemoryRouter></App></ConfigProvider>)
    async function fill(code: string) {
      fireEvent.change(await screen.findByLabelText('项目编号'), { target: { value: code } })
      fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: code } })
      fireEvent.mouseDown(screen.getByLabelText('客户公司'))
      fireEvent.click(await screen.findByRole('option', { name: '合成客户' }))
      fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    }
    await fill('PROJECT-A')
    fireEvent.click(await screen.findByRole('button', { name: '放弃请求' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认放弃' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: /新建项目$/ })[0]!)
    await fill('PROJECT-B')
    expect(await screen.findByText('已进入新项目')).toBeTruthy()
    expect(sent.map(item => item.code)).toEqual(['PROJECT-A', 'PROJECT-B'])
    expect(sent[0]!.key).toBeTruthy()
    expect(sent[1]!.key).not.toBe(sent[0]!.key)
  })
})
