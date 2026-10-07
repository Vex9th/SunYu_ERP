import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Alert, Button, Form, Input, Modal, Select, Space, Upload, Typography, type FormInstance } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { RcFile } from 'antd/es/upload'
import { mutationLedger, type PendingMutation } from './model'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'

export type FormValues = Record<string, unknown>
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'
export function useBusinessActions(scope: string, refresh: () => Promise<void>, committed: () => void) {
  const revision = useSyncExternalStore(mutationLedger.subscribe, mutationLedger.snapshot)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const current = useRef(scope)
  current.current = scope
  const mounted = useRef(true)
  const completion = useRef({ scope, item: mutationLedger.lastCompleted(scope) })
  if (completion.current.scope !== scope) completion.current = { scope, item: mutationLedger.lastCompleted(scope) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setError(''); setNotice('') }, [scope])
  useEffect(() => {
    const item = mutationLedger.lastCompleted(scope)
    if (!item || completion.current.item === item) return
    completion.current = { scope, item }
    committed(); setNotice(`${item.title}已保存`)
    void refresh().catch((failure) => {
      if (mounted.current && current.current === scope) setError(`${item.title}已保存，但刷新失败：${errorText(failure)}。请刷新查看，不要重复登记。`)
    })
  }, [revision, scope])
  const pending = mutationLedger.get(scope)
  async function perform(item: PendingMutation): Promise<boolean> {
    const owner = scope
    const isCurrent = () => mounted.current && current.current === owner
    setError(''); setNotice('')
    try {
      await mutationLedger.run(item)
      if (!isCurrent() || !item.committed) return false
      return true
    } catch (failure) { if (isCurrent()) setError(errorText(failure)); return false }
  }
  return {
    error, setError, notice, pending, busy: Boolean(pending?.busy),
    run: async (title: string, execute: () => Promise<unknown>, discard?: () => boolean) => {
      try { return await perform(mutationLedger.start(scope, title, execute, discard)) }
      catch (failure) { setError(errorText(failure)); return false }
    },
    retry: () => pending ? perform(pending) : Promise.resolve(false),
    discard: () => { if (pending && !mutationLedger.discard(pending)) setError('原请求暂时无法放弃，请保留并原样重试') },
  }
}
export function ActionFeedback({ actions, readonly = false }: { actions: ReturnType<typeof useBusinessActions>; readonly?: boolean }) {
  const [modal, context] = Modal.useModal()
  return <Space orientation="vertical" style={{ width: '100%' }}>
    {context}
    {actions.error && <Alert type="error" showIcon title={actions.error} />}
    {actions.notice && <Alert type="success" showIcon title={actions.notice} />}
    {actions.pending && <Alert type="warning" showIcon title={actions.pending.busy ? `${actions.pending.title}正在保存` : `${actions.pending.title}结果未知，原始请求已保留`}
      description="重新进入本页后仍可使用原请求重试。重试不会改变原项目、内容或附件。" action={<Space>
        <Button disabled={readonly} loading={actions.busy} onClick={() => void actions.retry()}>原样重试</Button>
        {actions.pending.discardRequest && <Button danger disabled={actions.busy || readonly} onClick={() => modal.confirm({ title: '放弃结果未知的请求？', content: '放弃后将无法安全重试原请求。请先核实原业务是否已保存，避免重复登记。', okText: '确认放弃', cancelText: '继续保留', onOk: actions.discard })}>放弃请求</Button>}
      </Space>} />}
  </Space>
}
export function FormModal({ title, form, open, onClose, onSubmit, children, busy, locked, error, width = 680, submitText = '保存' }: {
  title: string; form: FormInstance; open: boolean; onClose: () => void; onSubmit: (values: FormValues) => void | Promise<void>;
  children: ReactNode; busy: boolean; locked?: boolean; error?: string; width?: number; submitText?: string
}) {
  const [modal, context] = Modal.useModal()
  function close() {
    if (busy) return
    if (form.isFieldsTouched()) modal.confirm({ title: '关闭当前表单？', content: locked ? '原请求仍会保留，可在页面顶部原样重试。' : '未保存的内容将丢失。', okText: '关闭', cancelText: '继续填写', onOk: onClose })
    else onClose()
  }
  return <>{context}<Modal title={title} open={open} onCancel={close} width={width} mask={{ closable: false }} keyboard={!busy} closable={!busy} destroyOnHidden
    footer={<Space><Button disabled={busy} onClick={close}>取消</Button><Button type="primary" loading={busy} disabled={locked} onClick={() => form.submit()}>{submitText}</Button></Space>}>
    <Space orientation="vertical" style={{ width: '100%' }}>{error && <Alert type="error" showIcon title={error} />}
      <Form form={form} layout="vertical" disabled={busy || locked} onFinish={onSubmit}>{children}</Form>
    </Space>
  </Modal></>
}
export function TextField({ name, label, required = false, type, placeholder, extra }: { name: string | (string | number)[]; label: string; required?: boolean; type?: 'date' | 'datetime-local' | 'number' | 'textarea'; placeholder?: string; extra?: ReactNode }) {
  return <Form.Item name={name} label={label} extra={extra} rules={required ? [{ required: true, whitespace: true, transform: (value: unknown) => typeof value === 'number' ? String(value) : value, message: `请填写${label}` }] : []}>
    {type === 'textarea' ? <Input.TextArea rows={3} /> : <Input type={type ?? 'text'} placeholder={placeholder} autoComplete="off" />}
  </Form.Item>
}
export function AttachmentField({ files, onChange, options, disabled = false }: { files: File[]; onChange: (files: File[]) => void; options: DocumentVersionOption[]; disabled?: boolean }) {
  return <>
    <Form.Item label="上传附件"><Upload.Dragger disabled={disabled} multiple beforeUpload={() => false} fileList={files.map((file, index) => ({ uid: String(index), name: file.name, originFileObj: file as RcFile }))}
      onChange={(info) => onChange(info.fileList.map((file) => file.originFileObj).filter((file): file is NonNullable<typeof file> => Boolean(file)))}>
      <p className="ant-upload-drag-icon"><InboxOutlined /></p><p>点击或拖入文件，与业务记录一并保存</p>
    </Upload.Dragger></Form.Item>
    <Form.Item name="document_version_ids" label="关联已有资料"><Select mode="multiple" options={options} placeholder="可选，关联已上传的项目资料" optionFilterProp="label" disabled={disabled} /></Form.Item>
  </>
}
export function AttachmentLinks({ projectCode, ids = [], options }: { projectCode: string; ids?: number[]; options: DocumentVersionOption[] }) {
  return ids.length ? <Space wrap>{ids.map((id) => <Typography.Link key={id} href={`/api/projects/${encodeURIComponent(projectCode)}/document-versions/${id}/download`} target="_blank" rel="noreferrer">{options.find((item) => item.value === id)?.label ?? `附件 #${id}`}</Typography.Link>)}</Space> : <Typography.Text type="secondary">无附件</Typography.Text>
}
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = filename
  document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
