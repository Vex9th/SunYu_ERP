import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElSelect } from 'element-plus'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectDocumentPreview from '../components/project/ProjectDocumentPreview.vue'
import projectDocumentPreviewSource from '../components/project/ProjectDocumentPreview.vue?raw'
import ProjectDocumentsPanel from '../components/project/ProjectDocumentsPanel.vue'
import type { DocumentDetail, DocumentSummary, DocumentVersion } from '../domain/contracts'
import type { ProjectOperatingRepository } from '../repositories/project-operating.live'

const mountedPreviews: VueWrapper[] = []

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function version(
  id: number,
  versionNumber: number,
  filename: string,
  contentType: string,
  sizeBytes = 100,
): DocumentVersion {
  return {
    id,
    version_number: versionNumber,
    original_filename: filename,
    content_type: contentType,
    size_bytes: sizeBytes,
    sha256: 'a'.repeat(64),
    notes: null,
    created_at: '2026-09-03T08:00:00+08:00',
  }
}

function detail(
  id: number,
  title: string,
  versions: DocumentVersion[],
  category = 'other',
): DocumentDetail {
  return {
    id,
    project_code: 'SY-2026-001',
    category,
    title,
    notes: null,
    latest_version_number: Math.max(...versions.map((item) => item.version_number)),
    archived_at: null,
    revision: 1,
    created_at: '2026-09-03T08:00:00+08:00',
    updated_at: '2026-09-03T08:00:00+08:00',
    versions,
  }
}

function summary(document: DocumentDetail): DocumentSummary {
  const { versions: _versions, ...result } = document
  return result
}

function repository(
  getDocument: ProjectOperatingRepository['getDocument'],
  downloadDocumentVersion: ProjectOperatingRepository['downloadDocumentVersion'],
): ProjectOperatingRepository {
  return { getDocument, downloadDocumentVersion } as ProjectOperatingRepository
}

function mountPreview(
  props: {
    documentId: number
    documents: DocumentSummary[]
    repository: ProjectOperatingRepository
    versionId?: number | null
  },
): VueWrapper {
  const wrapper = mount(ProjectDocumentPreview, {
    attachTo: document.body,
    props: { projectCode: 'SY-2026-001', versionId: null, ...props },
    global: { plugins: [ElementPlus] },
  })
  mountedPreviews.push(wrapper)
  return wrapper
}

function screen(testId: string): DOMWrapper<Element> {
  return screenSelector(`[data-testid="${testId}"]`)
}

function screenSelector(selector: string): DOMWrapper<Element> {
  const element = document.body.querySelector(selector)
  if (!element) throw new Error(`Missing screen element: ${selector}`)
  return new DOMWrapper(element)
}

describe('project document preview workbench', () => {
  afterEach(() => {
    for (const wrapper of mountedPreviews.splice(0)) {
      if (wrapper.exists()) wrapper.unmount()
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('读取真实文字纪要并提供搜索、复制和打印', async () => {
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    const getDocument = vi.fn().mockResolvedValue(minutes)
    const download = vi.fn().mockResolvedValue(new Blob([
      '客户确认交付日期\n交付前完成安全检查\n交付日期不变',
    ], { type: 'text/plain' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)

    mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(getDocument, download),
    })
    await settle()

    expect(screen('document-preview-text').text()).toContain('客户确认交付日期')
    await screen('document-preview-search').setValue('交付日期')
    expect(screen('document-preview-search-summary').text()).toContain('2 处')
    await screen('document-preview-copy').trigger('click')
    await screen('document-preview-print').trigger('click')

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('客户确认交付日期'))
    expect(print).toHaveBeenCalledOnce()
  })

  it('复制失败时显示错误提示而不是成功提示', async () => {
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) },
    })
    mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(
        vi.fn().mockResolvedValue(minutes),
        vi.fn().mockResolvedValue(new Blob(['纪要内容'], { type: 'text/plain' })),
      ),
    })
    await settle()

    await screen('document-preview-copy').trigger('click')
    await settle()

    expect(screenSelector('.document-preview .el-alert').classes()).toContain('el-alert--error')
    expect(screenSelector('.document-preview .el-alert').text()).toContain('复制失败')
  })

  it('页头始终提供版本选择器并可切换版本', async () => {
    const minutes = detail(12, '多版本纪要', [
      version(31, 1, 'minutes-v1.txt', 'text/plain'),
      version(32, 2, 'minutes-v2.txt', 'text/plain'),
    ], 'planning_minutes')
    const download = vi.fn().mockImplementation(async (
      _projectCode: string,
      _documentId: number,
      versionId: number,
    ) => new Blob([`V${versionId} 内容`], { type: 'text/plain' }))
    const wrapper = mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(vi.fn().mockResolvedValue(minutes), download),
      versionId: 32,
    })
    await settle()

    const selector = wrapper.findComponent(ElSelect)
    expect(selector.exists()).toBe(true)
    selector.vm.$emit('change', 31)
    await settle()

    expect(wrapper.emitted('navigate')).toContainEqual([12, 31])
    expect(screen('document-preview-text').text()).toBe('V31 内容')
  })

  it('使用 Element Plus 全屏对话框承载预览并 teleport 到应用根节点之外', async () => {
    const app = document.createElement('div')
    app.id = 'app'
    document.body.append(app)
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    const wrapper = mount(ProjectDocumentPreview, {
      attachTo: app,
      props: {
        projectCode: 'SY-2026-001',
        versionId: null,
        documentId: minutes.id,
        documents: [summary(minutes)],
        repository: repository(
          vi.fn().mockResolvedValue(minutes),
          vi.fn().mockResolvedValue(new Blob(['纪要内容'], { type: 'text/plain' })),
        ),
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    const workbench = document.body.querySelector('[data-testid="document-preview-workbench"]')
    const dialog = workbench?.closest('[role="dialog"]')
    const overlay = workbench?.closest('.document-preview-overlay')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.el-dialog.is-fullscreen')).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('项目资料预览')
    expect(dialog?.contains(document.activeElement)).toBe(true)
    expect(document.body.contains(overlay ?? null)).toBe(true)
    expect(app.contains(workbench)).toBe(false)

    wrapper.unmount()
  })

  it('打印样式会解除 Element Plus 外层定位和全屏对话框高度限制', () => {
    expect(projectDocumentPreviewSource).toMatch(
      /:global\(\.document-preview-overlay \.el-overlay-dialog\)\s*\{[^}]*position:\s*static\s*!important;[^}]*overflow:\s*visible\s*!important;/s,
    )
    expect(projectDocumentPreviewSource).toMatch(
      /:global\(\.document-preview-dialog\.el-dialog\.is-fullscreen\)\s*\{[^}]*height:\s*auto\s*!important;[^}]*overflow:\s*visible\s*!important;/s,
    )
  })

  it('图片和 PDF 切换时释放旧 Blob URL', async () => {
    const drawing = detail(12, '现场照片', [
      version(31, 1, 'site.png', 'image/png'),
      version(32, 2, 'acceptance.pdf', 'application/pdf'),
    ])
    const getDocument = vi.fn().mockResolvedValue(drawing)
    const download = vi.fn().mockImplementation(async (
      _projectCode: string,
      _documentId: number,
      versionId: number,
    ) => versionId === 31
      ? new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
      : new Blob(['%PDF-1.7'], { type: 'application/pdf' }))
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:image-preview')
      .mockReturnValueOnce('blob:pdf-preview')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const wrapper = mountPreview({
      documentId: drawing.id,
      documents: [summary(drawing)],
      repository: repository(getDocument, download),
      versionId: 31,
    })
    await settle()
    expect(screen('document-preview-image').attributes('src')).toBe('blob:image-preview')

    await wrapper.setProps({ versionId: 32 })
    await settle()
    expect(screen('document-preview-pdf').attributes('src')).toBe('blob:pdf-preview')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-preview')
  })

  it.each([
    ['伪装 PDF', 'spoofed.pdf', 'application/pdf'],
    ['伪装图片', 'spoofed.png', 'image/png'],
  ])('%s 会被阻止且不会生成可执行预览地址', async (_label, filename, contentType) => {
    const unsafe = detail(12, '不可信文件', [version(31, 1, filename, contentType)])
    const createObjectURL = vi.fn(() => 'blob:unsafe')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    mountPreview({
      documentId: unsafe.id,
      documents: [summary(unsafe)],
      repository: repository(
        vi.fn().mockResolvedValue(unsafe),
        vi.fn().mockResolvedValue(new Blob(['<script>alert(1)</script>'], { type: contentType })),
      ),
    })
    await settle()

    expect(screenSelector('.document-preview .el-result__subtitle').text())
      .toContain('文件内容与扩展名不匹配')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('卸载预览时释放当前 Blob URL', async () => {
    const drawing = detail(12, '现场照片', [version(31, 1, 'site.png', 'image/png')])
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:image-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const wrapper = mountPreview({
      documentId: drawing.id,
      documents: [summary(drawing)],
      repository: repository(
        vi.fn().mockResolvedValue(drawing),
        vi.fn().mockResolvedValue(new Blob([
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ], { type: 'image/png' })),
      ),
    })
    await settle()

    wrapper.unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-preview')
  })

  it('切换版本和卸载时会取消尚未完成的预览下载', async () => {
    const minutes = detail(12, '多版本纪要', [
      version(31, 1, 'minutes-v1.txt', 'text/plain'),
      version(32, 2, 'minutes-v2.txt', 'text/plain'),
    ], 'planning_minutes')
    const signals: AbortSignal[] = []
    const download = vi.fn().mockImplementation((
      _projectCode: string,
      _documentId: number,
      _versionId: number,
      signal?: AbortSignal,
    ) => {
      if (!signal) throw new Error('preview request requires AbortSignal')
      signals.push(signal)
      return new Promise<Blob>(() => undefined)
    })
    const wrapper = mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(vi.fn().mockResolvedValue(minutes), download),
      versionId: 31,
    })
    await settle()
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

    await wrapper.setProps({ versionId: 32 })
    await settle()
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    wrapper.unmount()
    expect(signals[1]?.aborted).toBe(true)
  })

  it('会议纪要分类中的 PDF 版本仍按 PDF 预览', async () => {
    const minutesPdf = detail(
      12,
      '客户签字版会议纪要',
      [version(31, 1, 'signed-minutes.pdf', 'application/pdf')],
      'planning_minutes',
    )
    const download = vi.fn().mockResolvedValue(new Blob(['%PDF-1.7'], { type: 'application/pdf' }))
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:minutes-pdf'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })

    mountPreview({
      documentId: minutesPdf.id,
      documents: [summary(minutesPdf)],
      repository: repository(vi.fn().mockResolvedValue(minutesPdf), download),
    })
    await settle()

    expect(screen('document-preview-pdf').attributes('src'))
      .toBe('blob:minutes-pdf')
  })

  it('不支持格式和超大文件不会自动读入内存', async () => {
    const cad = detail(12, '机械总图', [version(31, 1, 'layout.dwg', 'application/acad')])
    const hugePdf = detail(13, '超大验收包', [
      version(32, 1, 'acceptance.pdf', 'application/pdf', 101 * 1024 * 1024),
    ])
    const getDocument = vi.fn().mockImplementation(async (_projectCode: string, documentId: number) => (
      documentId === cad.id ? cad : hugePdf
    ))
    const download = vi.fn().mockResolvedValue(new Blob(['download']))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:download') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountPreview({
      documentId: cad.id,
      documents: [summary(cad), summary(hugePdf)],
      repository: repository(getDocument, download),
    })
    await settle()

    expect(screen('document-preview-unsupported').text()).toContain('当前格式不支持网页预览')
    expect(download).not.toHaveBeenCalled()
    await wrapper.setProps({ documentId: hugePdf.id })
    await settle()
    expect(screen('document-preview-too-large').text()).toContain('文件过大')
    expect(download).not.toHaveBeenCalled()

    await screen('document-preview-download').trigger('click')
    await settle()
    expect(download).toHaveBeenCalledWith('SY-2026-001', 13, 32)
  })

  it('项目或文档切换后忽略旧请求的迟到结果', async () => {
    let resolveOld!: (value: DocumentDetail) => void
    const oldRequest = new Promise<DocumentDetail>((resolve) => { resolveOld = resolve })
    const old = detail(12, 'A 项目纪要', [version(31, 1, 'planning-minutes.txt', 'text/plain')], 'planning_minutes')
    const current = detail(22, 'B 项目纪要', [version(41, 1, 'planning-minutes.txt', 'text/plain')], 'planning_minutes')
    const getDocument = vi.fn().mockImplementation(async (_projectCode: string, documentId: number) => (
      documentId === 12 ? oldRequest : current
    ))
    const download = vi.fn().mockResolvedValue(new Blob(['B 项目内容'], { type: 'text/plain' }))
    const wrapper = mountPreview({
      documentId: 12,
      documents: [summary(old), summary(current)],
      repository: repository(getDocument, download),
    })

    await wrapper.setProps({ documentId: 22 })
    await settle()
    resolveOld(old)
    await settle()

    expect(screenSelector('.document-preview__identity').text()).toContain('B 项目纪要')
    expect(screen('document-preview-text').text()).toBe('B 项目内容')
    expect(download).toHaveBeenCalledWith('SY-2026-001', 22, 41, expect.any(AbortSignal))
    expect(download).not.toHaveBeenCalledWith('SY-2026-001', 12, 31)
  })

  it('Esc 可以退出独立预览', async () => {
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    const wrapper = mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(
        vi.fn().mockResolvedValue(minutes),
        vi.fn().mockResolvedValue(new Blob(['纪要'], { type: 'text/plain' })),
      ),
    })
    await settle()

    screen('document-preview-close').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    )
    await settle()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('点击返回只发送一次关闭事件', async () => {
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    const wrapper = mountPreview({
      documentId: minutes.id,
      documents: [summary(minutes)],
      repository: repository(
        vi.fn().mockResolvedValue(minutes),
        vi.fn().mockResolvedValue(new Blob(['纪要'], { type: 'text/plain' })),
      ),
    })
    await settle()

    await screen('document-preview-close').trigger('click')
    await settle()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('从资料台账进入独立地址，关闭和浏览器后退都回到资料列表', async () => {
    const minutes = detail(
      12,
      '项目启动会纪要',
      [version(31, 1, 'planning-minutes.txt', 'text/plain', 48)],
      'planning_minutes',
    )
    const projectRepository = {
      listDocuments: vi.fn().mockResolvedValue({ items: [summary(minutes)], page: 1, page_size: 100, total: 1 }),
      getDocument: vi.fn().mockResolvedValue(minutes),
      downloadDocumentVersion: vi.fn().mockResolvedValue(new Blob(['纪要真实内容'], { type: 'text/plain' })),
    } as unknown as ProjectOperatingRepository
    const Empty = defineComponent({ template: '<div />' })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/projects/:projectCode/documents', name: 'project-documents', component: Empty },
        { path: '/projects/:projectCode/documents/:documentId', name: 'project-document', component: Empty },
      ],
    })
    await router.push('/projects/SY-2026-001/documents')
    await router.isReady()
    const wrapper = mount(ProjectDocumentsPanel, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository: projectRepository },
      global: { plugins: [ElementPlus, router] },
    })
    await settle()

    await wrapper.get('[data-testid="document-preview-open-12"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents/12?version=31')
    expect(screen('document-preview-text').text()).toBe('纪要真实内容')

    router.back()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents')
      expect(document.body.querySelector('[data-testid="document-preview-workbench"]')).toBeNull()
    })

    await wrapper.get('[data-testid="document-preview-open-12"]').trigger('click')
    await settle()
    await screen('document-preview-close').trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents')
    expect(document.body.querySelector('[data-testid="document-preview-workbench"]')).toBeNull()
  })
})
