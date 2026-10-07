import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Empty, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd'
import { CopyOutlined, DownloadOutlined, PrinterOutlined, ReloadOutlined, RotateRightOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import type { DocumentVersion } from '../../domain/contracts'
import { managedDocumentFilename, traceableDocumentFilename } from '../../domain/document-filenames'
import type { ProjectOperatingRepository } from '../../repositories/project-operating.live'
import { errorText, useProjectLoad } from './useProjectWork'
import './project.css'

export function previewKind(version: DocumentVersion, category: string): 'text' | 'image' | 'pdf' | 'unsupported' {
  const extension = managedDocumentFilename(version).split('.').pop()?.toLowerCase() ?? ''
  if (['txt', 'md', 'log', 'csv'].includes(extension) || (category === 'planning_minutes' && !managedDocumentFilename(version).includes('.'))) return 'text'
  if (['bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp'].includes(extension)) return 'image'
  return extension === 'pdf' ? 'pdf' : 'unsupported'
}
export function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB` }
export function documentVersionLink(origin: string, projectCode: string, documentId: number, versionId: number) {
  const link = new URL(`/projects/${encodeURIComponent(projectCode)}/documents/${documentId}`, origin)
  link.searchParams.set('version', String(versionId))
  return link.href
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function textFromBlob(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件内容读取失败')); reader.readAsText(blob) }) }
interface PreviewProps { projectCode: string; documentId: number; versionId: number | null; repository: ProjectOperatingRepository; onClose: () => void; onVersion: (id: number) => void }
export default function DocumentPreview({ projectCode, documentId, versionId, repository, onClose, onVersion }: PreviewProps) {
  const load = useProjectLoad(`${projectCode}:${documentId}`, () => repository.getDocument(projectCode, documentId), repository)
  const detail = load.data
  const versions = useMemo(() => [...(detail?.versions ?? [])].sort((a, b) => b.version_number - a.version_number), [detail])
  const version = versions.find(item => item.id === versionId) ?? versions[0]
  const kind = version ? previewKind(version, detail?.category ?? '') : 'unsupported'
  const tooLarge = Boolean(version && version.size_bytes > (kind === 'text' ? 5 : 100) * 1024 * 1024)
  const [url, setUrl] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadedVersionId, setLoadedVersionId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const marks = useRef<HTMLElement[]>([])
  const downloadAbort = useRef<AbortController | null>(null)
  useEffect(() => { if (version && version.id !== versionId) onVersion(version.id) }, [version, versionId, onVersion])
  useEffect(() => {
    const controller = new AbortController(); let alive = true; let objectUrl: string | null = null
    setLoadedVersionId(null); setUrl(null); setContent(''); setError(null); setNotice(null); setSearch(''); setScale(1); setRotation(0); setDownloadBusy(false)
    downloadAbort.current?.abort()
    if (!version || tooLarge || kind === 'unsupported') { setBusy(false); return () => { controller.abort() } }
    setBusy(true)
    void repository.downloadDocumentVersion(projectCode, documentId, version.id, controller.signal).then(async blob => {
      if (!alive) return
      if (kind === 'text') { const text = await textFromBlob(blob); if (alive) setContent(text) }
      else {
        const suffix = managedDocumentFilename(version).split('.').pop()?.toLowerCase() ?? ''
        const mime = kind === 'pdf' ? 'application/pdf' : ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif', png: 'image/png', webp: 'image/webp' }[suffix] ?? 'application/octet-stream')
        objectUrl = URL.createObjectURL(new Blob([blob], { type: mime })); setUrl(objectUrl)
      }
    }).catch(cause => { if (alive) setError(errorText(cause)) }).finally(() => { if (alive) { setLoadedVersionId(version.id); setBusy(false) } })
    return () => { alive = false; controller.abort(); downloadAbort.current?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [projectCode, documentId, version?.id, kind, tooLarge, refresh, repository])
  const segments = useMemo(() => {
    if (!search.trim()) return [{ value: content, matched: false }]
    const needle = search.trim().toLocaleLowerCase(); const lower = content.toLocaleLowerCase(); const parts: Array<{ value: string; matched: boolean }> = []; let offset = 0; let found = 0
    while ((found = lower.indexOf(needle, offset)) >= 0) { if (found > offset) parts.push({ value: content.slice(offset, found), matched: false }); parts.push({ value: content.slice(found, found + needle.length), matched: true }); offset = found + needle.length }
    parts.push({ value: content.slice(offset), matched: false }); return parts
  }, [content, search])
  const matchCount = segments.filter(part => part.matched).length
  useEffect(() => { setActiveMatch(0) }, [search])
  useEffect(() => { marks.current[activeMatch]?.scrollIntoView?.({ block: 'center' }) }, [activeMatch, search])
  async function download() {
    if (!version || downloadBusy) return
    const controller = new AbortController(); downloadAbort.current = controller; setDownloadBusy(true); setError(null)
    try { const blob = await repository.downloadDocumentVersion(projectCode, documentId, version.id, controller.signal); if (!controller.signal.aborted) saveBlob(blob, managedDocumentFilename(version)) }
    catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)) }
    finally { if (!controller.signal.aborted) setDownloadBusy(false) }
  }
  async function copy(value: string, message: string) { try { await navigator.clipboard.writeText(value); setNotice(message) } catch { setError('复制失败，请检查浏览器剪贴板权限') } }
  const previewLoading = load.loading || busy || Boolean(version && !tooLarge && kind !== 'unsupported' && loadedVersionId !== version.id)
  let matchIndex = -1
  return <Modal open title={<Space>{detail?.title ?? '文档预览'}{detail?.archived_at && <Tag>已归档</Tag>}</Space>} width="min(1400px, 96vw)" style={{ top: 24 }} footer={null} onCancel={onClose} className="project-document-preview" destroyOnHidden>
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      <Space wrap className="project-preview-actions"><Button onClick={onClose}>返回文件列表</Button><Typography.Text strong>查看版本</Typography.Text><Select aria-label="选择文档版本" style={{ minWidth: 260, maxWidth: '85vw' }} value={version?.id} options={versions.map(item => ({ value: item.id, label: `V${item.version_number}${item.id === versions[0]?.id ? '（最新）' : '（历史）'} · ${traceableDocumentFilename(item)}` }))} onChange={onVersion} /><Button icon={<DownloadOutlined />} disabled={!version} loading={downloadBusy} onClick={() => void download()}>下载原文件</Button><Button icon={<CopyOutlined />} disabled={!version} onClick={() => version && void copy(documentVersionLink(window.location.origin, projectCode, documentId, version.id), '文档链接已复制')}>复制此版本链接</Button><Button icon={<ReloadOutlined />} onClick={() => { load.reload(); setRefresh(value => value + 1) }}>刷新</Button></Space>
      {(load.error || error) && <Alert type="error" showIcon title={load.error ?? error} action={<Button onClick={() => { load.reload(); setRefresh(value => value + 1) }}>重试</Button>} />}{notice && <Alert type="success" title={notice} closable onClose={() => setNotice(null)} />}
      {version && <Typography.Text type={version.id === versions[0]?.id ? 'secondary' : 'warning'}>{version.id === versions[0]?.id ? '正在查看最新版本' : '正在查看历史版本'} · V{version.version_number} · {managedDocumentFilename(version)}</Typography.Text>}
      {version && <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[{ key: 'size', label: '大小', children: formatBytes(version.size_bytes) }, { key: 'date', label: '上传时间', children: new Date(version.created_at).toLocaleString('zh-CN') }, { key: 'notes', label: '版本说明', children: version.notes ?? '—' }, { key: 'hash', label: 'SHA-256', span: 3, children: <Typography.Text code style={{ wordBreak: 'break-all' }}>{version.sha256}</Typography.Text> }]} />}
      <Spin spinning={previewLoading} description="正在加载文件"><div className="project-preview-stage" aria-busy={previewLoading}>
        {!previewLoading && !load.error && version && (tooLarge || kind === 'unsupported') && <Empty description={tooLarge ? '文件较大，请下载原文件查看' : '此格式不支持在线预览，请下载查看'} />}
        {!previewLoading && !error && kind === 'text' && !tooLarge && <><Space wrap className="project-preview-toolbar"><Input.Search aria-label="搜索文件内容" placeholder="搜索文件内容" value={search} onChange={event => setSearch(event.target.value)} style={{ width: 260 }} /><span>{matchCount ? activeMatch + 1 : 0} / {matchCount}</span><Button disabled={!matchCount} onClick={() => setActiveMatch(value => (value + matchCount - 1) % matchCount)}>上一个</Button><Button disabled={!matchCount} onClick={() => setActiveMatch(value => (value + 1) % matchCount)}>下一个</Button><Button icon={<CopyOutlined />} onClick={() => void copy(content, '文档正文已复制')}>复制全文</Button><Button icon={<PrinterOutlined />} onClick={() => window.print()}>打印</Button></Space><pre className="project-preview-paper">{segments.map((part, index) => { if (!part.matched) return part.value; const current = ++matchIndex; return <mark key={index} ref={element => { if (element) marks.current[current] = element }} className={current === activeMatch ? 'active-match' : undefined}>{part.value}</mark> })}</pre></>}
        {!previewLoading && !error && kind === 'image' && url && <><Space className="project-preview-toolbar"><Button aria-label="缩小图片" icon={<ZoomOutOutlined />} onClick={() => setScale(value => Math.max(.25, value - .25))} /><span>{Math.round(scale * 100)}%</span><Button aria-label="放大图片" icon={<ZoomInOutlined />} onClick={() => setScale(value => Math.min(4, value + .25))} /><Button icon={<RotateRightOutlined />} onClick={() => setRotation(value => value + 90)}>旋转</Button></Space><div className="project-preview-image"><img src={url} alt={detail?.title ?? '文档图片'} style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }} /></div></>}
        {!previewLoading && !error && kind === 'pdf' && url && <iframe title={`${detail?.title ?? '文档'} PDF 预览`} src={url} className="project-preview-pdf" />}
      </div></Spin>
    </Space>
  </Modal>
}
