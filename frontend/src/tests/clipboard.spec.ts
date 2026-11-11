import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../clipboard'

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const command = Object.getOwnPropertyDescriptor(document, 'execCommand')
function install(value: unknown, exec = vi.fn(() => true)) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
  return exec
}
afterEach(() => {
  document.body.replaceChildren()
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (command) Object.defineProperty(document, 'execCommand', command)
  else Reflect.deleteProperty(document, 'execCommand')
})

describe('浏览器文本复制', () => {
  it('支持标准 API 时直接复制，不创建临时输入框', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const exec = install({ writeText })
    await copyText('中文链接')
    expect(writeText).toHaveBeenCalledWith('中文链接')
    expect(exec).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
  })
  it('HTTP 复制恢复输入焦点与选区，移除临时节点', async () => {
    const exec = install(undefined)
    const input = document.createElement('input')
    input.value = 'already edited'
    document.body.appendChild(input)
    input.focus(); input.setSelectionRange(2, 5, 'backward')
    await copyText('复制内容')
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 5, 'backward'])
    expect(document.querySelector('textarea')).toBeNull()
  })
  it('拒绝复制时返回失败且清理临时节点', async () => {
    install(undefined, vi.fn(() => false))
    await expect(copyText('内容')).rejects.toThrow('浏览器未允许复制')
    expect(document.querySelector('textarea')).toBeNull()
  })
  it('标准 API 拒绝时保留失败，不绕过权限或误报成功', async () => {
    const failure = new DOMException('denied', 'NotAllowedError')
    const exec = install({ writeText: vi.fn().mockRejectedValue(failure) })
    await expect(copyText('内容')).rejects.toBe(failure)
    expect(exec).not.toHaveBeenCalled()
  })
})
