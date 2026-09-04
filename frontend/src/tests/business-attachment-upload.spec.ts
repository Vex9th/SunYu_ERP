import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { type UploadFile } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import BusinessAttachmentUpload from '../components/common/BusinessAttachmentUpload.vue'

function uploadFile(file: File, uid: number): UploadFile {
  return {
    name: file.name,
    percentage: 0,
    status: 'ready',
    size: file.size,
    raw: Object.assign(file, { uid }),
    uid,
  }
}

function mountUpload(props: Record<string, unknown> = {}): VueWrapper {
  return mount(BusinessAttachmentUpload, {
    props: {
      modelValue: [],
      testId: 'business-files',
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('BusinessAttachmentUpload', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('使用 Element Plus 拖拽上传并支持多次追加和移除', async () => {
    const wrapper = mountUpload({ accept: '.pdf,image/*' })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const first = new File(['pdf'], '报价单.pdf', { type: 'application/pdf' })
    const second = new File(['image'], '现场照片.png', { type: 'image/png' })

    upload.props('onChange')(uploadFile(first, 1), [uploadFile(first, 1)])
    await wrapper.setProps({ modelValue: [first] })
    upload.props('onChange')(uploadFile(second, 2), [uploadFile(first, 1), uploadFile(second, 2)])
    await wrapper.setProps({ modelValue: [first, second] })
    await nextTick()

    expect(upload.props('drag')).toBe(true)
    expect(upload.props('multiple')).toBe(true)
    expect(upload.props('autoUpload')).toBe(false)
    expect(wrapper.text()).toContain('报价单.pdf')
    expect(wrapper.text()).toContain('现场照片.png')
    expect(wrapper.text()).toContain('5 B')

    await wrapper.get('[data-testid="business-files-remove-0"]').trigger('click')
    const updates = wrapper.emitted('update:modelValue')
    expect(updates?.[updates.length - 1]).toEqual([[second]])
  })

  it('共享上传区域占满表单可用宽度，不在弹窗左侧缩成固定宽度', () => {
    const wrapper = mountUpload()

    expect(wrapper.get('[data-testid="business-files"]').classes()).toContain('business-attachment-upload')
    expect(wrapper.findComponent({ name: 'ElUpload' }).classes()).toContain('business-attachment-upload__control')
  })

  it('拒绝不符合 accept 的文件并明确提示支持格式', async () => {
    const wrapper = mountUpload({ accept: '.pdf,image/*' })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const invalid = new File(['sheet'], '报价明细.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    upload.props('onChange')(uploadFile(invalid, 1), [uploadFile(invalid, 1)])
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.get('[data-testid="business-files-error"]').text()).toContain('只支持 PDF、图片')
  })

  it('未出错时也常驻展示由 accept 计算的支持格式', () => {
    const wrapper = mountUpload({ accept: '.pdf,.doc,.docx,.xls,.xlsx,image/*' })

    expect(wrapper.text()).toContain('支持 PDF、DOC、DOCX、XLS、XLSX、图片')
  })

  it('拒绝的文件不会滞留在隐藏队列，之后仍可追加合法文件', async () => {
    const wrapper = mountUpload({ accept: '.pdf' })
    const input = wrapper.get('input[type="file"]')
    const invalid = new File(['sheet'], '错误格式.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const valid = new File(['pdf'], '合法附件.pdf', { type: 'application/pdf' })

    Object.defineProperty(input.element, 'files', { configurable: true, value: [invalid] })
    await input.trigger('change')
    await nextTick()
    Object.defineProperty(input.element, 'files', { configurable: true, value: [valid] })
    await input.trigger('change')
    await nextTick()

    const updates = wrapper.emitted('update:modelValue')
    expect(updates?.[updates.length - 1]).toEqual([[valid]])
  })

  it('同一批文件校验失败时精确移除非法项，不误删合法项', () => {
    const wrapper = mountUpload({ accept: '.pdf' })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const valid = uploadFile(new File(['pdf'], '合法附件.pdf', { type: 'application/pdf' }), 1)
    const invalid = uploadFile(new File(['sheet'], '错误格式.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 2)
    const uploadInstance = (upload.vm as unknown as {
      $: { exposed: { handleRemove: (file: UploadFile) => void } }
    }).$.exposed
    const handleRemove = vi.spyOn(uploadInstance, 'handleRemove')

    upload.props('onChange')(valid, [valid, invalid])

    expect(handleRemove).toHaveBeenCalledWith(invalid)
  })

  it('超过默认 20 个文件时拒绝新增并明确提示上限', async () => {
    const existing = Array.from({ length: 20 }, (_, index) => (
      new File([String(index)], `附件-${index + 1}.pdf`, { type: 'application/pdf' })
    ))
    const wrapper = mountUpload({ modelValue: existing, accept: '.pdf' })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const extra = new File(['extra'], '附件-21.pdf', { type: 'application/pdf' })
    const uploadFiles = [...existing.map((file, index) => uploadFile(file, index + 1)), uploadFile(extra, 21)]

    upload.props('onChange')(uploadFile(extra, 21), uploadFiles)
    await nextTick()

    expect(wrapper.get('[data-testid="business-files-error"]').text()).toContain('最多选择 20 个文件')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('有大小限制时拒绝超限文件；未配置时说明以后端限制为准', async () => {
    const wrapper = mountUpload({ accept: '.pdf', maxFileSizeBytes: 4 })
    const upload = wrapper.findComponent({ name: 'ElUpload' })
    const tooLarge = new File(['12345'], '大文件.pdf', { type: 'application/pdf' })

    upload.props('onChange')(uploadFile(tooLarge, 1), [uploadFile(tooLarge, 1)])
    await nextTick()

    expect(wrapper.get('[data-testid="business-files-error"]').text()).toContain('单个文件不能超过 4 B')
    await wrapper.setProps({ maxFileSizeBytes: undefined })
    expect(wrapper.text()).toContain('单个文件大小以后端限制为准')
    expect(wrapper.text()).toContain('保存后系统按项目/业务类型/日期自动命名，原文件名仍保留可追溯')
  })

  it('busy 时禁止选择和移除', async () => {
    const file = new File(['pdf'], '报价单.pdf', { type: 'application/pdf' })
    const wrapper = mountUpload({ modelValue: [file], busy: true })

    expect(wrapper.findComponent({ name: 'ElUpload' }).props('disabled')).toBe(true)
    expect(wrapper.get('[data-testid="business-files-remove-0"]').attributes('disabled')).toBeDefined()
  })

  it('多附件列表独立滚动，长文件名不会挤走移除按钮', () => {
    const file = new File(['pdf'], `${'超长合同文件名'.repeat(12)}.pdf`, { type: 'application/pdf' })
    const wrapper = mountUpload({ modelValue: [file] })

    expect(wrapper.get('[data-testid="business-files-list"]').classes()).toContain('business-attachment-upload__list')
    expect(wrapper.get('[data-testid="business-files-name-0"]').attributes('title')).toBe(file.name)
    expect(wrapper.get('[data-testid="business-files-name-0"]').classes()).toContain('business-attachment-upload__name')
    expect(wrapper.get('[data-testid="business-files-remove-0"]').classes()).toContain('business-attachment-upload__remove')
  })
})
