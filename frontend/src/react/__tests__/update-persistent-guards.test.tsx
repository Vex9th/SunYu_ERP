import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider, Form, Input } from 'antd'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installProjectDom } from './project-fixtures'
import { reloadBlockReason } from '../pendingUnload'
import { createPendingRegistry } from '../workforce/ui'
import { EntityEditor } from '../shared'

beforeAll(installProjectDom)
afterEach(cleanup)
describe('更新刷新保留跨页面业务状态', () => {
  it('劳务交付请求注册表存在未知请求时刷新被阻止，核对清除后解除', () => {
    const registry = createPendingRegistry<{ inFlight: boolean }>()
    const entries = registry.forOwner({})
    entries.set('P1', { inFlight: false })
    try { expect(reloadBlockReason()).toEqual(expect.stringMatching(/业务请求仍在执行或结果尚未确认/)) }
    finally { entries.delete('P1') }
    expect(reloadBlockReason()).toBeNull()
  })
  it('普通资料编辑器卸载后仍保留草稿刷新阻拦', async () => {
    const mountEditor = () => render(<ConfigProvider theme={{ token: { motion: false } }}><App><EntityEditor title="测试资料" cacheKey="update-guard-editor" initialValues={{ name: '初始资料' }} onClose={() => {}} onSubmit={async () => ({})}><Form.Item name="name" label="名称"><Input /></Form.Item></EntityEditor></App></ConfigProvider>)
    const page = mountEditor()
    fireEvent.change(await screen.findByLabelText(/名称/), { target: { value: '尚未保存资料' } })
    page.unmount()
    expect(reloadBlockReason()).toEqual(expect.stringMatching(/未保存/))
    mountEditor()
    fireEvent.click(screen.getByRole('button', { name: /取.*消/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }))
    expect(reloadBlockReason()).toBeNull()
  })
})
