import { describe, expect, it } from 'vitest'
import mainSource from '../main.ts?raw'

describe('Element Plus 中文环境', () => {
  it('应用入口注册简体中文 locale', () => {
    expect(mainSource).toContain("element-plus/es/locale/lang/zh-cn")
    expect(mainSource).toMatch(/\.use\(ElementPlus,\s*\{\s*locale:\s*zhCn\s*\}\)/)
  })
})
