import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd'
import { FileAddOutlined, FileTextOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { DocumentSummary } from '../../domain/contracts'
import { createHttpProjectOperatingRepository, type DocumentArchiveFilter, type ProjectOperatingRepository } from '../../repositories/project-operating.live'
import DocumentPreview from './DocumentPreview'
import { useWorkspaceValue } from '../shared'
import { useUnsavedChanges } from '../unsavedChanges'
import './project.css'
import { nullable, useProjectLoad, useProjectWrite, type ProjectProps } from './useProjectWork'

const repositoryDefault = createHttpProjectOperatingRepository()
export const documentCategories: Record<string, string> = { planning_minutes: '项目策划纪要', site_survey: '现场勘查', quotation: '报价资料', technical_agreement: '技术协议', contract: '项目合同', mechanical_design: '机械设计', electrical_design: '电气设计', procurement_list: '采购清单', procurement_contract: '采购合同', mechanical_signoff: '机械会签', electrical_signoff: '电气会签', construction: '施工资料', commissioning: '调试资料', acceptance: '验收资料', invoice: '发票资料', warranty: '质保资料', after_sales: '售后资料', other: '其他' }
type Mode = 'create' | 'edit' | 'version' | 'archive' | 'minutes' | 'minutesVersion'
interface DocumentForm { category: string; title: string; notes?: string; reason?: string; content?: string }
export default function ProjectDocuments({ projectCode, readonly = false, repository = repositoryDefault }: ProjectProps & { repository?: ProjectOperatingRepository }) {
  const params = useParams(); const navigate = useNavigate(); const [searchParams, setSearchParams] = useSearchParams()
  const routedId = Number(params.documentId); const documentId = Number.isSafeInteger(routedId) && routedId > 0 ? routedId : null
  const rawVersion = Number(searchParams.get('version')); const versionId = Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : null
  const [search, setSearch] = useWorkspaceValue('q', '')
  const [category, setCategory] = useWorkspaceValue('category', '')
  const [archive, setArchive] = useWorkspaceValue('archive', 'active')
  const [pageValue, setPageValue] = useWorkspaceValue('page', '1')
  const [sizeValue, setSizeValue] = useWorkspaceValue('pageSize', '20')
  const filters = { search, category: Object.prototype.hasOwnProperty.call(documentCategories, category) ? category : '', archived: (['active', 'archived', 'all'].includes(archive) ? archive : 'active') as DocumentArchiveFilter, page: Number.isSafeInteger(Number(pageValue)) && Number(pageValue) > 0 ? Number(pageValue) : 1, page_size: [20, 50, 100, 200].includes(Number(sizeValue)) ? Number(sizeValue) : 20 }
  const [searchDraft, setSearchDraft] = useState(search)
  useEffect(() => setSearchDraft(search), [search])
  const load = useProjectLoad(`${projectCode}:${JSON.stringify(filters)}`, () => repository.listDocuments(projectCode, filters), repository)
  useEffect(() => { if (load.data && filters.page > 1 && load.data.items.length === 0) setPageValue(String(Math.max(1, Math.ceil(load.data.total / filters.page_size)))) }, [load.data, filters.page, filters.page_size])
  function resetFilters() { setSearch(''); setCategory(''); setArchive('active'); setPageValue('1'); setSearchDraft('') }
  const [dialog, setDialog] = useState<{ mode: Mode; document?: DocumentSummary } | null>(null)
  const [files, setFiles] = useState<UploadFile[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [form] = Form.useForm<DocumentForm>()
  const [modal, modalContext] = Modal.useModal()
  const draftDirty = useRef(false)
  const write = useProjectWrite(`documents:${projectCode}`, () => { setDialog(null); setFiles([]); load.reload() })
  useUnsavedChanges(() => Boolean(dialog) && (draftDirty.current || write.busy))
  useEffect(() => { setDialog(null); setFiles([]); setFileError(null); form.resetFields(); draftDirty.current = false }, [projectCode, form])
  function open(mode: Mode, document?: DocumentSummary) {
    write.clearError(); setFileError(null); setFiles([]); form.resetFields(); form.setFieldsValue({ category: document?.category ?? 'other', title: document?.title ?? '', notes: document?.notes ?? '', reason: '', content: '' }); draftDirty.current = false; setDialog({ mode, document })
  }
  function close() {
    if (write.busy) return
    if (draftDirty.current && !write.locked) { modal.confirm({ title: '放弃尚未保存的修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: () => setDialog(null) }); return }
    setDialog(null)
  }
  function documentPath(id?: number) {
    const query = new URLSearchParams(searchParams); query.delete('version')
    return { pathname: `/projects/${encodeURIComponent(projectCode)}/documents${id ? `/${id}` : ''}`, search: query.toString() }
  }
  function preview(id: number) { navigate(documentPath(id)) }
  function save(values: DocumentForm) {
    if (!dialog || readonly || write.locked) return
    const doc = dialog.document; const mode = dialog.mode
    const file = files[0]?.originFileObj
    if (['create', 'version'].includes(mode) && !file) { setFileError('请选择要上传的文件'); return }
    setFileError(null)
    if (mode === 'create' || mode === 'minutes') {
      const input = { category: mode === 'minutes' ? 'planning_minutes' : values.category, title: values.title.trim(), notes: nullable(values.notes), file: mode === 'minutes' ? new File([values.content!.trim()], 'planning-minutes.txt', { type: 'text/plain' }) : file! }
      write.submit(mode === 'minutes' ? '创建会议纪要' : '创建文件', () => repository.createDocument(projectCode, input), () => repository.discardCreateDocument(projectCode, input))
    } else if (doc && (mode === 'version' || mode === 'minutesVersion')) {
      const input = { notes: nullable(values.notes), expected_revision: doc.revision, file: mode === 'minutesVersion' ? new File([values.content!.trim()], 'planning-minutes.txt', { type: 'text/plain' }) : file! }
      write.submit('上传文档版本', () => repository.addDocumentVersion(projectCode, doc.id, input), () => repository.discardAddDocumentVersion(projectCode, doc.id, input))
    } else if (doc && mode === 'edit') {
      const input = { title: values.title.trim(), notes: nullable(values.notes), expected_revision: doc.revision }
      write.submit('修改文件信息', () => repository.updateDocument(projectCode, doc.id, input))
    } else if (doc && mode === 'archive') {
      const input = { reason: values.reason!.trim(), expected_revision: doc.revision }
      write.submit('归档文件', () => repository.archiveDocument(projectCode, doc.id, input))
    }
  }
  const titles: Record<Mode, string> = { create: '新增文件', edit: '编辑文件信息', version: '上传新版本', archive: '归档文件', minutes: '新建项目会议纪要', minutesVersion: '追加会议纪要版本' }
  const mode = dialog?.mode
  const disabled = readonly || write.locked || load.loading || Boolean(load.error)
  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>{modalContext}
    {readonly && <Alert type="info" showIcon title="项目已归档，文件与历史版本仍可预览和下载" />}
    {load.error && <Alert type="error" showIcon title={load.error} action={<Button onClick={load.reload}>重新读取</Button>} />}{!dialog && write.notice}
    <Card size="small" title="项目文件台账" extra={<Space><Button icon={<ReloadOutlined />} onClick={load.reload}>刷新</Button><Button icon={<FileTextOutlined />} disabled={disabled} onClick={() => open('minutes')}>写会议纪要</Button><Button type="primary" icon={<FileAddOutlined />} disabled={disabled} onClick={() => open('create')}>新增文件</Button></Space>}>
      <div className="project-list-toolbar"><Input.Search aria-label="搜索文档" placeholder="标题、备注或正文关键词" enterButton="搜索" maxLength={200} allowClear value={searchDraft} onChange={event => setSearchDraft(event.target.value)} onSearch={value => { setSearch(value.trim()); setPageValue('1') }} className="project-document-search" /><Space wrap><Select aria-label="文档类别筛选" value={filters.category} style={{ width: 165 }} options={[{ value: '', label: '全部类别' }, ...Object.entries(documentCategories).map(([value, label]) => ({ value, label }))]} onChange={value => { setCategory(value); setPageValue('1') }} /><Select aria-label="文档归档筛选" value={filters.archived} style={{ width: 130 }} options={[{ value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' }, { value: 'all', label: '全部状态' }]} onChange={value => { setArchive(value); setPageValue('1') }} /><Button onClick={resetFilters} disabled={!search && !filters.category && filters.archived === 'active'}>重置筛选</Button></Space></div>
      {search && <Typography.Paragraph type="secondary">搜索“{search}”{load.data ? `，找到 ${load.data.total} 份文件` : ''}</Typography.Paragraph>}
      <Table size="small" rowKey="id" loading={load.loading} dataSource={load.data?.items ?? []} scroll={{ x: 780 }} pagination={{ current: filters.page, pageSize: filters.page_size, total: load.data?.total ?? 0, showSizeChanger: true, showTotal: total => `共 ${total} 份文件`, pageSizeOptions: [20, 50, 100, 200], onChange: (page, page_size) => { setPageValue(String(page_size === filters.page_size ? page : 1)); setSizeValue(String(page_size)) } }} columns={[
        { title: '文件标题', dataIndex: 'title', width: 300, render: (_, doc) => <Space orientation="vertical" size={0}><Button type="link" style={{ padding: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => preview(doc.id)}>{doc.title}</Button><Typography.Text type="secondary">{doc.search_excerpt ?? doc.notes ?? ''}</Typography.Text></Space> },
        { title: '类别 / 版本', width: 155, render: (_, doc) => <Space orientation="vertical" size={4}><span>{documentCategories[doc.category] ?? doc.category}</span><Space size={4}><Tag>V{doc.latest_version_number}</Tag>{doc.archived_at && <Tag>已归档</Tag>}</Space></Space> },
        { title: '更新时间', dataIndex: 'updated_at', width: 170, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
        { title: '操作', width: 255, fixed: 'right', render: (_, doc) => <Space wrap size={4}><Button size="small" onClick={() => preview(doc.id)}>预览 / 版本</Button>{!readonly && !doc.archived_at && <><Button size="small" disabled={disabled} onClick={() => open('edit', doc)}>编辑</Button><Button size="small" disabled={disabled} onClick={() => open(doc.category === 'planning_minutes' ? 'minutesVersion' : 'version', doc)}>追加版本</Button><Button size="small" danger disabled={disabled} onClick={() => open('archive', doc)}>归档</Button></>}</Space> },
      ]} />
    </Card>
    <Drawer forceRender title={mode ? titles[mode] : ''} open={Boolean(dialog)} onClose={close} closable={!write.busy} mask={{ closable: !write.busy }} keyboard={!write.busy} size={620} footer={<Space><Button disabled={write.busy} onClick={close}>取消</Button><Button type="primary" danger={mode === 'archive'} loading={write.busy} disabled={readonly || write.locked} onClick={() => form.submit()}>{mode === 'archive' ? '确认归档' : '保存'}</Button></Space>}>
      <Space orientation="vertical" style={{ width: '100%' }}>{write.notice}{fileError && <Alert type="error" title={fileError} />}{dialog?.document && <Alert type="info" title={`${dialog.document.title} · V${dialog.document.latest_version_number} / R${dialog.document.revision}`} />}
      {mode === 'archive' && <Alert type="warning" showIcon title="归档后停止编辑，历史版本仍保留；此操作不可撤销。" />}
      <Form form={form} layout="vertical" disabled={readonly || write.locked} onFinish={save} onValuesChange={() => { draftDirty.current = true }}>
        {mode === 'create' && <Form.Item label="文件类别" name="category" rules={[{ required: true }]}><Select options={Object.entries(documentCategories).map(([value, label]) => ({ value, label }))} /></Form.Item>}
        {['create', 'edit', 'minutes'].includes(mode ?? '') && <Form.Item label="标题" name="title" rules={[{ required: true, whitespace: true, message: '请填写文件标题' }]}><Input maxLength={200} /></Form.Item>}
        {['minutes', 'minutesVersion'].includes(mode ?? '') && <Form.Item label="会议纪要正文" name="content" rules={[{ required: true, whitespace: true, message: '请填写会议纪要内容' }]}><Input.TextArea rows={14} placeholder="会议时间、参会人员、讨论内容、决议与待办" /></Form.Item>}
        {['create', 'version'].includes(mode ?? '') && <Form.Item label="上传文件" required><Upload.Dragger fileList={files} maxCount={1} beforeUpload={() => false} onChange={({ fileList }) => { setFiles(fileList); setFileError(null); draftDirty.current = true }} disabled={readonly || write.locked}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p>点击选择文件，或拖入此区域</p><p className="ant-upload-hint">原文件与历史版本将完整保留</p></Upload.Dragger></Form.Item>}
        {mode !== 'archive' && <Form.Item name="notes" label={['version', 'minutesVersion'].includes(mode ?? '') ? '版本说明' : '备注'}><Input.TextArea rows={3} maxLength={5000} /></Form.Item>}
        {mode === 'archive' && <Form.Item label="归档原因" name="reason" rules={[{ required: true, whitespace: true, message: '请填写归档原因' }]}><Input.TextArea rows={4} maxLength={5000} /></Form.Item>}
      </Form></Space>
    </Drawer>
    {documentId && <DocumentPreview key={`${projectCode}:${documentId}`} projectCode={projectCode} documentId={documentId} versionId={versionId} repository={repository} onClose={() => navigate(documentPath())} onVersion={id => { if (id !== versionId) { const next = new URLSearchParams(searchParams); next.set('version', String(id)); setSearchParams(next, { replace: true }) } }} />}
  </Space>
}
