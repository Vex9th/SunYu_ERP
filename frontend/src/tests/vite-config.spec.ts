// @vitest-environment node

import { describe, expect, it } from 'vitest'

import config from '../../vite.config'

describe('Vite development server', () => {
  it('将 API 请求代理到本地 Python 服务', () => {
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
