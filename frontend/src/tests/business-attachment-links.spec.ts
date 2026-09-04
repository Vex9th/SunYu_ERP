import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'

import BusinessAttachmentLinks from '../components/common/BusinessAttachmentLinks.vue'

describe('BusinessAttachmentLinks', () => {
  it('业务记录直接显示附件名称和可下载地址', () => {
    const wrapper = mount(BusinessAttachmentLinks, {
      props: {
        projectCode: 'SY/2026-001',
        versionIds: [12, 13],
        options: [{ value: 12, label: '报价单 V1 · 正式报价.pdf' }],
        testId: 'quote-files',
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="quote-files-12"]').text()).toContain('正式报价.pdf')
    expect(wrapper.get('[data-testid="quote-files-12"]').attributes('href'))
      .toBe('/api/projects/SY%2F2026-001/document-versions/12/download')
    expect(wrapper.get('[data-testid="quote-files-13"]').text()).toContain('附件 2')
  })
})
