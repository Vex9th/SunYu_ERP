import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installProjectDom } from './project-fixtures'
import { useProjectWrite } from '../project/useProjectWork'
import { mutationLedger } from '../procurement/model'

beforeAll(installProjectDom)
afterEach(cleanup)
function reloadIsProtected() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
function Writer({ run }: { run: () => Promise<unknown> }) {
  const write = useProjectWrite('unload-test:project', () => {})
  return <><button onClick={() => write.submit('保存', run)}>提交</button>{write.notice}</>
}
function mountWriter(run: () => Promise<unknown>) {
  return render(<ConfigProvider theme={{ token: { motion: false } }}><App><Writer run={run} /></App></ConfigProvider>)
}
describe('结果未知请求的浏览器刷新保护', () => {
  it('商务和文档的原请求在页面卸载后继续受保护，重试确认后解除', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValue(undefined)
    const page = mountWriter(run)
    fireEvent.click(screen.getByText('提交'))
    await screen.findByText('保存的结果尚未确认')
    page.unmount()
    expect(reloadIsProtected()).toBe(true)
    mountWriter(run)
    fireEvent.click(screen.getByRole('button', { name: '重试原请求' }))
    await waitFor(() => expect(screen.queryByText('保存的结果尚未确认')).toBeNull())
    expect(reloadIsProtected()).toBe(false)
  })
  it('没有打开表单的采购请求也受到保护，主动放弃后解除', async () => {
    const job = mutationLedger.start('unload-test:procurement', '确认清单', async () => { throw new Error('连接中断') }, () => true)
    await expect(mutationLedger.run(job)).rejects.toThrow('连接中断')
    try { expect(reloadIsProtected()).toBe(true) }
    finally { mutationLedger.discard(job) }
    expect(reloadIsProtected()).toBe(false)
  })
})
