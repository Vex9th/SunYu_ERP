// @vitest-environment node

import { describe, expect, it } from 'vitest'

import configExport from '../../vite.config'

describe('Vite development server', () => {
  it('将 API 请求代理到本地 Python 服务', async () => {
    const config = await (typeof configExport === 'function' ? configExport({ command: 'serve', mode: 'development' }) : configExport)
    expect(config).toMatchObject({
      server: {
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:8765',
          },
        },
      },
    })
  })
})
