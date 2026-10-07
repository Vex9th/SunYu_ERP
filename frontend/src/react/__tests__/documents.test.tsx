import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { WorkspaceNavigationProvider } from '../navigationState'
import ProjectDocuments from '../project/ProjectDocuments'
import { documentVersionLink, previewKind } from '../project/DocumentPreview'
import { documentFixture, installProjectDom, projectRepository } from './project-fixtures'

beforeAll(installProjectDom)
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function mount(repository: ReturnType<typeof projectRepository>, route = '/projects/SY-A/documents', readonly = false) { return render(<MemoryRouter initialEntries={[route]}><Routes><Route path="/projects/:projectCode/documents/:documentId?" element={<ProjectDocuments projectCode="SY-A" repository={repository} readonly={readonly} />} /></Routes></MemoryRouter>) }
describe('React 项目文件', () => {
  it('会议纪要以真实文本文件创建，上传内容与标题完整保留', async () => {
    const repository = projectRepository(); mount(repository)
    await screen.findByText('现场会议纪要')
    fireEvent.click(screen.getByRole('button', { name: /写会议纪要$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('标题'), { target: { value: '策划会议' } })
    fireEvent.change(within(dialog).getByLabelText('会议纪要正文'), { target: { value: '讨论安装进度，周五验收。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存$/ }))
    await waitFor(() => expect(repository.createDocument).toHaveBeenCalledTimes(1))
    const input = vi.mocked(repository.createDocument).mock.calls[0][1]
    expect(input).toMatchObject({ category: 'planning_minutes', title: '策划会议', notes: null })
    expect(input.file.name).toBe('planning-minutes.txt')
    expect(input.file.type).toBe('text/plain')
    expect(await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(input.file) })).toBe('讨论安装进度，周五验收。')
  })
  it('追加纪要版本携带当前文档 revision', async () => {
    const repository = projectRepository(); mount(repository)
    fireEvent.click(await screen.findByRole('button', { name: '追加版本' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('会议纪要正文'), { target: { value: '第二次会议' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存$/ }))
    await waitFor(() => expect(repository.addDocumentVersion).toHaveBeenCalledWith('SY-A', 6, expect.objectContaining({ expected_revision: 7, file: expect.any(File) })))
  })
  it('文档深链接读取对应文档版本，文本安全显示并可搜索', async () => {
    const repository = projectRepository(); mount(repository, '/projects/SY-A/documents/6?version=22')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('会议记录：安装计划与验收计划。')
    expect(repository.getDocument).toHaveBeenCalledWith('SY-A', 6)
    expect(repository.downloadDocumentVersion).toHaveBeenCalledWith('SY-A', 6, 22, expect.any(AbortSignal))
    fireEvent.change(within(dialog).getByLabelText('搜索文件内容'), { target: { value: '计划' } })
    await within(dialog).findByText('1 / 2')
    expect(dialog.querySelectorAll('mark')).toHaveLength(2)
    expect(previewKind({ ...documentFixture.versions[0], managed_filename: 'unsafe.html', content_type: 'text/html' }, 'other')).toBe('unsupported')
  })
  it('归档模式保留下载入口，禁用新建与纪要写入', async () => {
    const repository = projectRepository(); mount(repository, undefined, true)
    await screen.findByText('现场会议纪要')
    expect((screen.getByRole('button', { name: /新增文件$/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '追加版本' })).toBeNull()
    expect(screen.getByRole('button', { name: '预览 / 版本' })).toBeTruthy()
  })
  it('文件创建结果未知时保留原 File 对象，切换页面后仍能安全重试', async () => {
    const repository = projectRepository()
    vi.mocked(repository.createDocument).mockRejectedValueOnce(new ApiError('连接中断', 0))
    const view = mount(repository)
    await screen.findByText('现场会议纪要')
    fireEvent.click(screen.getByRole('button', { name: /新增文件$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('标题'), { target: { value: '测试图纸' } })
    const file = new File(['drawing'], 'drawing.pdf', { type: 'application/pdf' })
    fireEvent.change(dialog.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await within(dialog).findByText('drawing.pdf')
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存$/ }))
    await screen.findByText('创建文件的结果尚未确认')
    const original = vi.mocked(repository.createDocument).mock.calls[0][1]
    view.unmount()
    mount(repository)
    fireEvent.click(await screen.findByRole('button', { name: '重试原请求' }))
    await waitFor(() => expect(repository.createDocument).toHaveBeenCalledTimes(2))
    expect(vi.mocked(repository.createDocument).mock.calls[1][1]).toBe(original)
    expect(vi.mocked(repository.createDocument).mock.calls[1][1].file).toBe(file)
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试原请求' })).toBeNull())
  })
  it('搜索请求携带后台过滤并从第一页开始', async () => {
    const repository = projectRepository(); mount(repository)
    await screen.findByText('现场会议纪要')
    const search = screen.getByLabelText('搜索文档')
    fireEvent.change(search, { target: { value: '验收安排' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', charCode: 13 })
    await waitFor(() => expect(repository.listDocuments).toHaveBeenLastCalledWith('SY-A', expect.objectContaining({ search: '验收安排', archived: 'active', page: 1, page_size: 20 })))
  })
  it('读取失败可重试，不显示空数据成功状态', async () => {
    const repository = projectRepository()
    vi.mocked(repository.listDocuments).mockRejectedValueOnce(new ApiError('文档读取失败', 503))
    mount(repository)
    await screen.findByText('文档读取失败')
    expect((screen.getByRole('button', { name: /新增文件$/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await screen.findByText('现场会议纪要')
    expect((screen.getByRole('button', { name: /新增文件$/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('复制链接明确绑定项目、文档与所选版本，不依赖地址栏更新时序', () => {
    expect(documentVersionLink('https://erp.example', 'SY A', 6, 22)).toBe('https://erp.example/projects/SY%20A/documents/6?version=22')
  })

  it('预览加载过程中不会闪现不支持格式提示', async () => {
    const repository = projectRepository()
    let resolve!: (value: typeof documentFixture) => void
    vi.mocked(repository.getDocument).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    mount(repository, '/projects/SY-A/documents/6')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('此格式不支持在线预览，请下载查看')).toBeNull()
    expect(dialog.querySelector('[aria-busy="true"]')).toBeTruthy()
    await act(async () => resolve(documentFixture))
    await within(dialog).findByText('会议记录：安装计划与验收计划。')
    expect(within(dialog).queryByText('此格式不支持在线预览，请下载查看')).toBeNull()
  })
  it('从筛选结果打开和关闭预览，保留搜索、分类与页码', async () => {
    const repository = projectRepository()
    const Location = () => { const location = useLocation(); return <output aria-label="当前位置">{location.pathname}{location.search}</output> }
    render(<MemoryRouter initialEntries={['/projects/DOC-CONTEXT/documents?q=现场&category=planning_minutes&page=2']}><WorkspaceNavigationProvider><Location /><Routes><Route path="/projects/:projectCode/documents/:documentId?" element={<ProjectDocuments projectCode="DOC-CONTEXT" repository={repository} />} /></Routes></WorkspaceNavigationProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: '预览 / 版本' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('会议记录：安装计划与验收计划。')
    expect(screen.getByLabelText('当前位置').textContent).toContain('version=22')
    fireEvent.click(within(dialog).getByRole('button', { name: '返回文件列表' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByLabelText('搜索文档')).toHaveProperty('value', '现场')
    expect(screen.getByLabelText('当前位置').textContent).toContain('category=planning_minutes')
    expect(screen.getByLabelText('当前位置').textContent).toContain('page=2')
    expect(screen.getByLabelText('当前位置').textContent).not.toContain('version=')
    expect(repository.listDocuments).toHaveBeenLastCalledWith('DOC-CONTEXT', expect.objectContaining({ search: '现场', category: 'planning_minutes', page: 2 }))
    fireEvent.change(screen.getByLabelText('搜索文档'), { target: { value: '验收' } })
    fireEvent.keyDown(screen.getByLabelText('搜索文档'), { key: 'Enter', code: 'Enter', charCode: 13 })
    await waitFor(() => expect(repository.listDocuments).toHaveBeenLastCalledWith('DOC-CONTEXT', expect.objectContaining({ search: '验收', category: 'planning_minutes', page: 1 })))
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }))
    await waitFor(() => expect(repository.listDocuments).toHaveBeenLastCalledWith('DOC-CONTEXT', expect.objectContaining({ search: '', category: '', archived: 'active', page: 1 })))
  })
  it('取消已编辑文档先确认，继续编辑保留草稿', async () => {
    const repository = projectRepository(); mount(repository)
    fireEvent.click(await screen.findByRole('button', { name: /编\s*辑$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('标题'), { target: { value: '尚未保存的纪要' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }))
    expect(within(dialog).getByLabelText('标题')).toHaveProperty('value', '尚未保存的纪要')
    expect(repository.createDocument).not.toHaveBeenCalled()
  })

})
