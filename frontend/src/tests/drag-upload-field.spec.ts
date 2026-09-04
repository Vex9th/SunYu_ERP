import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { type UploadFile } from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'

import DragUploadField from '../components/common/DragUploadField.vue'

function uploadFile(file: File): UploadFile {
  return {
    name: file.name,
    percentage: 0,
    status: 'ready',
    size: file.size,
    raw: Object.assign(file, { uid: Date.now() }),
    uid: Date.now(),
  }
}

function mountField(props: Record<string, unknown> = {}): VueWrapper {
  return mount(DragUploadField, {
    props: {
      modelValue: null,
      testId: 'test-upload',
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('DragUploadField', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('使用 Element Plus 拖拽上传并向父级提交单个文件', async () => {
    const wrapper = mountField()
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const file = new File(['drawing'], '现场测绘.dwg', { type: 'application/acad' })

    expect(upload.exists()).toBe(true)
    expect(upload.props('drag')).toBe(true)
    upload.props('onChange')(uploadFile(file), [uploadFile(file)])
    await wrapper.setProps({ modelValue: file })
    await nextTick()

    const updates = wrapper.emitted('update:modelValue')
    expect(updates?.[updates.length - 1]).toEqual([file])
    expect(wrapper.get('[data-testid="test-upload-file-name"]').text()).toBe('现场测绘.dwg')
    expect(wrapper.get('[data-testid="test-upload-file-meta"]').text()).toContain('DWG')
    expect(wrapper.get('[data-testid="test-upload-file-meta"]').text()).toContain('7 B')
  })

  it('第二次选择会替换旧文件且可以移除', async () => {
    const wrapper = mountField()
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const first = new File(['one'], '初版.pdf', { type: 'application/pdf' })
    const replacement = new File(['second'], '终版.pdf', { type: 'application/pdf' })

    upload.props('onChange')(uploadFile(first), [uploadFile(first)])
    await wrapper.setProps({ modelValue: first })
    const replacementRaw = Object.assign(replacement, { uid: Date.now() })
    upload.props('onExceed')([replacementRaw], [uploadFile(first)])
    await wrapper.setProps({ modelValue: replacement })

    expect(wrapper.text()).not.toContain('初版.pdf')
    expect(wrapper.text()).toContain('终版.pdf')

    await wrapper.get('[data-testid="test-upload-remove"]').trigger('click')
    const updates = wrapper.emitted('update:modelValue')
    expect(updates?.[updates.length - 1]).toEqual([null])
  })

  it('拖入不符合 accept 的文件时拒绝并显示可读错误', async () => {
    const wrapper = mountField({
      accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const invalid = new File(['csv'], '采购清单.csv', { type: 'text/csv' })

    upload.props('onChange')(uploadFile(invalid), [uploadFile(invalid)])
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.get('[data-testid="test-upload-error"]').text()).toContain('只支持 XLSX')
    expect(wrapper.find('[data-testid="test-upload-file-name"]').exists()).toBe(false)
  })

  it('父级清空文件后同步清空内部列表和错误', async () => {
    const Host = defineComponent({
      components: { DragUploadField },
      setup() {
        const file = ref<File | null>(new File(['pdf'], '合同.pdf', { type: 'application/pdf' }))
        return { file }
      },
      template: `
        <DragUploadField v-model="file" test-id="parent-upload" />
        <button data-testid="parent-clear" @click="file = null">清空</button>
      `,
    })
    const wrapper = mount(Host, { global: { plugins: [ElementPlus] } })

    expect(wrapper.text()).toContain('合同.pdf')
    await wrapper.get('[data-testid="parent-clear"]').trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="parent-upload-file-name"]').exists()).toBe(false)
  })

  it('disabled 或 busy 时不能选择和移除文件', async () => {
    const selected = new File(['pdf'], '合同.pdf', { type: 'application/pdf' })
    const wrapper = mountField({ modelValue: selected, disabled: true })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const replacement = new File(['new'], '新合同.pdf', { type: 'application/pdf' })

    expect(upload.props('disabled')).toBe(true)
    expect(wrapper.get('[data-testid="test-upload-remove"]').attributes('disabled')).toBeDefined()
    upload.props('onChange')(uploadFile(replacement), [uploadFile(replacement)])
    await nextTick()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await wrapper.setProps({ disabled: false, busy: true })
    expect(wrapper.findComponent({ name: 'ElUpload' }).props('disabled')).toBe(true)
  })
})
