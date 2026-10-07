import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useLoad } from '../shared'

describe('React 请求生命周期', () => {
  it('切换项目后不显示上一项目的迟到响应', async () => {
    let resolveOld!: (value: string) => void
    const old = new Promise<string>((resolve) => {
      resolveOld = resolve
    })
    const { result, rerender } = renderHook(
      ({ code }) =>
        useLoad(
          () => (code === 'A' ? old : Promise.resolve('B 的项目')),
          [code],
        ),
      { initialProps: { code: 'A' } },
    )
    rerender({ code: 'B' })
    await waitFor(() => expect(result.current.data).toBe('B 的项目'))
    await act(async () => resolveOld('A 的项目'))
    expect(result.current.data).toBe('B 的项目')
  })

  it('失败显示原因，重新读取后清除错误并呈现数据', async () => {
    let fail = true
    const { result } = renderHook(() =>
      useLoad(async () => {
        if (fail) throw new Error('服务暂时不可用')
        return 42
      }, []),
    )
    await waitFor(() => expect(result.current.error).toBe('服务暂时不可用'))
    fail = false
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.data).toBe(42)
    expect(result.current.error).toBeNull()
  })
})
