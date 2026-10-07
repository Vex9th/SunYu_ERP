import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthPage } from '../AuthPage'
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  })
})
afterEach(async () => {
  cleanup()
  // Ant Design 校验反馈的延时更新需在 jsdom 销毁前完成。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
})
describe('登录和首次设置', () => {
  it('首次设置必须确认相同的六位数字密码', async () => {
    const submit = vi.fn()
    render(
      <AuthPage
        passwordConfigured={false}
        busy={false}
        error={null}
        onSubmit={submit}
      />,
    )
    fireEvent.change(screen.getByLabelText('访问密码'), {
      target: { value: '123456' },
    })
    fireEvent.change(screen.getByLabelText('再次输入密码'), {
      target: { value: '654321' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建密码并进入' }))
    await screen.findByText('两次输入的密码不一致')
    expect(submit).not.toHaveBeenCalled()
  })
  it('输入有效密码提交，服务端错误可见', async () => {
    const submit = vi.fn()
    render(
      <AuthPage
        passwordConfigured
        busy={false}
        error="密码不正确"
        onSubmit={submit}
      />,
    )
    expect(screen.getByText('密码不正确')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('访问密码'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('123456'))
  })
})
