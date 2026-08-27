import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import App from '../App.vue'

describe('App', () => {
  it('shows the Element Plus development status page', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [ElementPlus],
      },
    })

    expect(wrapper.get('[data-testid="development-status"]').text()).toContain(
      '开发环境已就绪',
    )
    expect(wrapper.find('.el-card').exists()).toBe(true)
  })
})
