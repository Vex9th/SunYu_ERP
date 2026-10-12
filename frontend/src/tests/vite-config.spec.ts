// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

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


afterEach(() => vi.unstubAllEnvs())
describe('Vite 模块前端版本路径', () => {
  it('生产资源固定到当前发布版本，开发路径保持根目录', async () => {
    vi.stubEnv('SUNYU_VERSION', '1.3.0')
    const production = await (typeof configExport === 'function' ? configExport({ command: 'build', mode: 'production' }) : configExport)
    const development = await (typeof configExport === 'function' ? configExport({ command: 'serve', mode: 'development' }) : configExport)
    expect(production).toMatchObject({ base: '/__frontend/1.3.0/', define: { __APP_VERSION__: '"1.3.0"' } })
    expect(development.base).toBe('/')
  })
  it('无发布版本标记的源码以开发版本构建', async () => {
    vi.stubEnv('SUNYU_VERSION', '')
    const config = await (typeof configExport === 'function' ? configExport({ command: 'build', mode: 'production' }) : configExport)
    expect(config).toMatchObject({ base: '/', define: { __APP_VERSION__: '"dev"' } })
  })
  it('拒绝可导致资源路径逃逸的版本标记', () => {
    vi.stubEnv('SUNYU_VERSION', '../../other')
    expect(() => typeof configExport === 'function' && configExport({ command: 'build', mode: 'production' })).toThrow('SUNYU_VERSION')
  })
})
