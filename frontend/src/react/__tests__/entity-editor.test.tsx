import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { App, Form, Input } from 'antd'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EntityEditor } from '../shared'
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) =>
    computedStyle(element),
  )
})
afterEach(cleanup)

describe('表单跨页面写入隔离', () => {
  it('未保存内容跨卸载恢复，取消必须明确选择放弃且不提交', async () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn()
    const editor = () => (
      <App>
        <EntityEditor
          title="编辑草稿"
          cacheKey="test:draft-retention"
          initialValues={{ name: '原内容' }}
          onClose={onClose}
          onSubmit={onSubmit}
        >
          <Form.Item name="name" label="名称">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>
    )
    const first = render(editor())
    fireEvent.change(screen.getByLabelText(/名称/), {
      target: { value: '尚未提交的项目' },
    })
    first.unmount()
    const second = render(editor())
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe(
      '尚未提交的项目',
    )
    fireEvent.click(screen.getByRole('button', { name: /取.*消/ }))
    expect(await screen.findByRole('button', { name: '继续编辑' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull(),
    )
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe(
      '尚未提交的项目',
    )
    fireEvent.click(screen.getByRole('button', { name: /取.*消/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSubmit).not.toHaveBeenCalled()
    second.unmount()
    render(editor())
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe(
      '原内容',
    )
  })

  it('请求结果未知后重新打开，重试原 payload 与原 revision', async () => {
    const submitted: unknown[] = []
    let attempts = 0
    const first = render(
      <App>
        <EntityEditor
          title="测试编辑"
          cacheKey="test:revision"
          initialValues={{ name: '原内容' }}
          onClose={() => {}}
          onSubmit={async (values) => {
            submitted.push({ ...values, expected_revision: 1 })
            if (++attempts === 1) throw new Error('网络断开')
          }}
        >
          <Form.Item name="name" label="名称">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>,
    )
    fireEvent.click(screen.getByRole('button', { name: /保.*存/ }))
    await screen.findByText('网络断开')
    first.unmount()
    const replacement = vi.fn()
    render(
      <App>
        <EntityEditor
          title="测试编辑"
          cacheKey="test:revision"
          initialValues={{ name: '新读取内容' }}
          onClose={() => {}}
          onSubmit={replacement}
        >
          <Form.Item name="name" label="名称">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>,
    )
    fireEvent.click(screen.getByRole('button', { name: '原样重试' }))
    await waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[0]).toEqual(submitted[1])
    expect(replacement).not.toHaveBeenCalled()
  })

  it('离开页面后迟到的保存结果不会触发跳转或刷新当前页面', async () => {
    let resolve!: (value: unknown) => void
    const waiting = new Promise((done) => {
      resolve = done
    })
    const onSaved = vi.fn()
    const result = render(
      <App>
        <EntityEditor
          title="新建"
          cacheKey="test:navigation"
          initialValues={{ name: 'A' }}
          onClose={() => {}}
          onSubmit={() => waiting}
          onSaved={onSaved}
        >
          <Form.Item name="name">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>,
    )
    fireEvent.click(screen.getByRole('button', { name: /保.*存/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /原样重试/ })).toBeTruthy(),
    )
    result.unmount()
    await act(async () => resolve({ id: 1 }))
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('原页面卸载期间重新打开，迟到成功由当前表单消费且不会再提交', async () => {
    let resolve!: (value: unknown) => void
    const waiting = new Promise((done) => {
      resolve = done
    })
    const oldSaved = vi.fn()
    const newSaved = vi.fn()
    const closed = vi.fn()
    const first = render(
      <App>
        <EntityEditor
          title="新建项目"
          cacheKey="test:late-reopen"
          initialValues={{ name: 'A' }}
          onClose={() => {}}
          onSubmit={() => waiting}
          onSaved={oldSaved}
        >
          <Form.Item name="name">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>,
    )
    fireEvent.click(screen.getByRole('button', { name: /保.*存/ }))
    await screen.findByRole('button', { name: /原样重试/ })
    first.unmount()
    render(
      <App>
        <EntityEditor
          title="新建项目"
          cacheKey="test:late-reopen"
          initialValues={{ name: 'B' }}
          onClose={closed}
          onSubmit={vi.fn()}
          onSaved={newSaved}
        >
          <Form.Item name="name">
            <Input />
          </Form.Item>
        </EntityEditor>
      </App>,
    )
    await act(async () => resolve({ id: 123 }))
    await waitFor(() => expect(newSaved).toHaveBeenCalledWith({ id: 123 }))
    expect(closed).toHaveBeenCalledTimes(1)
    expect(oldSaved).not.toHaveBeenCalled()
  })
})
