import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  DatePicker,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Typography,
  Upload,
} from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'

export type Values = Record<string, unknown>
export const textValue = (values: Values, key: string): string =>
  String(values[key] ?? '').trim()
export const optionalText = (values: Values, key: string): string | null =>
  textValue(values, key) || null
export const numberValue = (values: Values, key: string): number =>
  Number(values[key] ?? 0)
export const idsValue = (
  values: Values,
  key = 'document_version_ids',
): number[] => (values[key] as number[] | undefined) ?? []
export const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败，请稍后重试'

// 待确认请求独立于页面生命周期，返回页面后仍能收到请求完成通知。
export function createPendingRegistry<T>() {
  const owners = new WeakMap<object, Map<string, T>>()
  const listeners = new Set<() => void>()
  let revision = 0
  const notify = () => {
    revision += 1
    listeners.forEach((listener) => listener())
  }
  class ObservableMap extends Map<string, T> {
    override set(key: string, value: T) {
      super.set(key, value)
      notify()
      return this
    }
    override delete(key: string) {
      const deleted = super.delete(key)
      if (deleted) notify()
      return deleted
    }
  }
  return {
    forOwner(owner: object) {
      let entries = owners.get(owner)
      if (!entries) {
        entries = new ObservableMap()
        owners.set(owner, entries)
      }
      return entries
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => revision,
    notify,
  }
}

export interface Field {
  key: string
  label: string
  type?:
    | 'text'
    | 'textarea'
    | 'date'
    | 'datetime'
    | 'number'
    | 'select'
    | 'money'
    | 'documents'
  required?: boolean | ((values: Values) => boolean)
  disabled?: boolean | ((values: Values) => boolean)
  visible?: (values: Values) => boolean
  options?:
    | { value: string | number; label: string; disabled?: boolean }[]
    | ((
        values: Values,
      ) => { value: string | number; label: string; disabled?: boolean }[])
  min?: number
  max?: number
  help?: string
  group?: string
}

export function RecordSearch({
  value,
  onChange,
  placeholder,
  label = '搜索记录',
  statusLabels,
  status,
  onStatusChange,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label?: string
  statusLabels?: Record<string, string>
  status?: string
  onStatusChange?: (value: string) => void
}) {
  return (
    <Space wrap>
      <Typography.Text>{label}</Typography.Text>
      <Input.Search
        aria-label={label}
        placeholder={placeholder}
        allowClear
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: 300, maxWidth: '100%' }}
      />
      {statusLabels && (
        <>
          <Typography.Text>状态</Typography.Text>
          <Select
            aria-label={`${label}状态`}
            style={{ width: 140 }}
            value={status || ''}
            onChange={onStatusChange}
            options={[
              { value: '', label: '全部状态' },
              ...options(statusLabels),
            ]}
          />
        </>
      )}
    </Space>
  )
}

const editorDrafts = new WeakMap<object, Map<string, Editor>>()
export const getEditorDraft = (owner: object, key: string) =>
  editorDrafts.get(owner)?.get(key)
export function clearEditorDraft(
  owner: object,
  key: string,
  editorKey?: string,
) {
  const drafts = editorDrafts.get(owner)
  if (!editorKey || drafts?.get(key)?.key === editorKey) drafts?.delete(key)
}
function keepEditorDraft(owner: object, key: string, editor: Editor) {
  let drafts = editorDrafts.get(owner)
  if (!drafts) {
    drafts = new Map()
    editorDrafts.set(owner, drafts)
  }
  drafts.set(key, editor)
}

export function DateInput({
  value,
  onChange,
  time = false,
  disabled,
  id,
}: {
  value?: string
  onChange?: (value: string) => void
  time?: boolean
  disabled?: boolean
  id?: string
}) {
  return (
    <DatePicker
      id={id}
      style={{ width: '100%' }}
      value={value ? dayjs(value) : null}
      disabled={disabled}
      showTime={time}
      format={time ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'}
      onChange={(value) =>
        onChange?.(
          value
            ? value.format(time ? 'YYYY-MM-DDTHH:mm:ss' : 'YYYY-MM-DD')
            : '',
        )
      }
    />
  )
}

export function AttachmentLinks({
  projectCode,
  ids,
  documents = [],
}: {
  projectCode: string
  ids: readonly number[]
  documents?: readonly DocumentVersionOption[]
}) {
  if (!ids.length)
    return (
      <span style={{ color: 'var(--ant-color-text-tertiary, #8c8c8c)' }}>
        无附件
      </span>
    )
  return (
    <Space wrap>
      {ids.map((id, index) => (
        <a
          key={id}
          href={`/api/projects/${encodeURIComponent(projectCode)}/document-versions/${id}/download`}
          download={
            documents.find((item) => item.value === id)?.label ??
            `附件 ${index + 1}`
          }
        >
          {documents.find((item) => item.value === id)?.label ??
            `附件 ${index + 1}`}
        </a>
      ))}
    </Space>
  )
}

export interface Editor {
  key: string
  title: string
  initial: Values
  fields: Field[]
  attachments?: boolean
  accept?: string
  files?: File[]
  extra?: (values: Values) => ReactNode
  submit: (values: Values, files: File[]) => Promise<void>
  frozen?: boolean
  draft?: boolean
  submitLabel?: string
}

export function ActionDrawer({
  editor,
  busy,
  error,
  onClose,
  onSave,
  documents = [],
  draftOwner,
  draftKey,
}: {
  editor: Editor | null
  busy: boolean
  error: string
  onClose: () => void
  onSave: (values: Values, files: File[]) => Promise<void>
  documents?: DocumentVersionOption[]
  draftOwner?: object
  draftKey?: string
}) {
  const [form] = Form.useForm<Values>()
  const [files, setFiles] = useState<File[]>([])
  const [uploadError, setUploadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [modal, modalHolder] = Modal.useModal()
  const values = Form.useWatch([], form) ?? editor?.initial ?? {}
  const editorRef = useRef(editor)
  editorRef.current = editor
  useEffect(() => {
    form.resetFields()
    form.setFieldsValue(editor?.initial ?? {})
    setFiles(editor?.files ?? [])
    setUploadError('')
    setDirty(Boolean(editor?.draft))
  }, [editor?.key, form])
  useEffect(() => {
    if (!editor || (!dirty && !busy)) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [editor, dirty, busy])
  const rememberDraft = (next: Values, nextFiles = files) => {
    setDirty(true)
    if (editor && !editor.frozen && draftOwner && draftKey)
      keepEditorDraft(draftOwner, draftKey, {
        ...editor,
        initial: structuredClone({ ...editor.initial, ...next }),
        files: nextFiles,
        draft: true,
      })
  }
  const discardAndClose = () => {
    if (draftOwner && draftKey) clearEditorDraft(draftOwner, draftKey)
    onClose()
  }
  const close = () => {
    if (busy) return
    if (!dirty || editor?.frozen) {
      discardAndClose()
      return
    }
    const current = editor
    modal.confirm({
      title: '放弃未保存的内容？',
      content: '关闭后，本次未保存的修改将丢失。',
      okText: '放弃并关闭',
      cancelText: '继续填写',
      onOk: () => {
        if (editorRef.current === current) discardAndClose()
      },
    })
  }
  return (
    <>
      {modalHolder}
      <Drawer
        open={Boolean(editor)}
        title={editor?.title}
        size={620}
        onClose={close}
        maskClosable={!busy}
        keyboard={!busy}
        closable={!busy}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="primary"
              loading={busy}
              onClick={() => {
                if (editor?.frozen) void onSave({}, files)
                else form.submit()
              }}
            >
              {editor?.frozen
                ? '重试原提交'
                : (editor?.submitLabel ?? '保存修改')}
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          {error && <Alert showIcon type="error" title={error} />}
          {editor?.frozen && (
            <Alert
              showIcon
              type="warning"
              title="上次请求结果尚未确认"
              description="提交内容及附件已锁定。重试会沿用原请求，避免重复建立记录；也可关闭抽屉，稍后在页面顶部继续重试。"
            />
          )}
          <Form
            form={form}
            layout="vertical"
            disabled={busy || editor?.frozen}
            onValuesChange={(_, next) => rememberDraft(next)}
            onFinish={(next) => void onSave({ ...editor?.initial, ...next }, files)}
          >
            {Array.from(
              new Set(
                editor?.fields
                  .filter((field) => !field.visible || field.visible(values))
                  .map(
                    (field) =>
                      field.group ??
                      (field.key.startsWith('warranty_')
                        ? '质保安排'
                        : ['notes', 'document_version_ids'].includes(field.key)
                          ? '补充资料'
                          : '基本信息'),
                  ),
              ),
            )
              .sort(
                (a, b) => Number(a === '补充资料') - Number(b === '补充资料'),
              )
              .map((group) => (
                <div key={group}>
                  <Divider
                    titlePlacement="left"
                    style={{ margin: '8px 0 16px' }}
                  >
                    {group}
                  </Divider>
                  {editor?.fields
                    .filter(
                      (field) =>
                        (field.group ??
                          (field.key.startsWith('warranty_')
                            ? '质保安排'
                            : ['notes', 'document_version_ids'].includes(
                                  field.key,
                                )
                              ? '补充资料'
                              : '基本信息')) === group &&
                        (!field.visible || field.visible(values)),
                    )
                    .sort(
                      (a, b) =>
                        Number(Boolean(b.required)) -
                        Number(Boolean(a.required)),
                    )
                    .map((field) => {
                      const disabled =
                        typeof field.disabled === 'function'
                          ? field.disabled(values)
                          : field.disabled
                      const required =
                        typeof field.required === 'function'
                          ? field.required(values)
                          : field.required
                      const choice =
                        typeof field.options === 'function'
                          ? field.options(values)
                          : field.options
                      return (
                        <Form.Item
                          key={field.key}
                          name={field.key}
                          label={field.label}
                          help={field.help}
                          rules={
                            required
                              ? [
                                  {
                                    required: true,
                                    message: `请填写${field.label}`,
                                  },
                                ]
                              : undefined
                          }
                        >
                          {field.type === 'date' ||
                          field.type === 'datetime' ? (
                            <DateInput
                              time={field.type === 'datetime'}
                              disabled={disabled}
                            />
                          ) : field.type === 'number' ? (
                            <InputNumber
                              min={field.min}
                              max={field.max}
                              precision={0}
                              style={{ width: '100%' }}
                              disabled={disabled}
                            />
                          ) : field.type === 'select' ? (
                            <Select
                              options={choice}
                              disabled={disabled}
                              showSearch
                              optionFilterProp="label"
                            />
                          ) : field.type === 'documents' ? (
                            <Select
                              mode="multiple"
                              options={documents}
                              disabled={disabled}
                              optionFilterProp="label"
                              placeholder="关联已有资料"
                            />
                          ) : field.type === 'textarea' ? (
                            <Input.TextArea
                              autoSize={{ minRows: 2, maxRows: 6 }}
                              disabled={disabled}
                            />
                          ) : (
                            <Input
                              disabled={disabled}
                              inputMode={
                                field.type === 'money' ? 'decimal' : undefined
                              }
                              suffix={field.type === 'money' ? '元' : undefined}
                            />
                          )}
                        </Form.Item>
                      )
                    })}
                </div>
              ))}
            {editor?.extra?.(values)}
            {editor?.attachments && (
              <Form.Item
                label="上传附件"
                extra="最多 20 个文件；保存业务记录时一并上传。"
              >
                <Upload
                  multiple
                  accept={editor.accept}
                  beforeUpload={(file, batch) => {
                    if (file === batch[0]) setUploadError('')
                    if (files.length + batch.length > 20) {
                      setUploadError(
                        '最多选择 20 个文件，请先移除不需要的文件。',
                      )
                      return Upload.LIST_IGNORE
                    }
                    const rules = editor.accept?.toLowerCase().split(',') ?? []
                    const accepted =
                      !rules.length ||
                      rules.some((rule) =>
                        rule.startsWith('.')
                          ? file.name.toLowerCase().endsWith(rule)
                          : rule.endsWith('/*')
                            ? file.type
                                .toLowerCase()
                                .startsWith(rule.slice(0, -1))
                            : file.type.toLowerCase() === rule,
                      )
                    if (!accepted) {
                      setUploadError(
                        `${file.name} 格式不支持，请选择 ${editor.accept} 文件。`,
                      )
                      return Upload.LIST_IGNORE
                    }
                    return false
                  }}
                  maxCount={20}
                  fileList={files.map((file, index) => ({
                    uid: `${index}`,
                    name: file.name,
                    originFileObj:
                      file as import('antd').UploadFile['originFileObj'],
                  }))}
                  onChange={({ fileList }) => {
                    const selected = fileList.flatMap((item) =>
                      item.originFileObj ? [item.originFileObj as File] : [],
                    )
                    setFiles(selected)
                    rememberDraft(form.getFieldsValue(true), selected)
                  }}
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>
                {uploadError && <Alert type="error" title={uploadError} />}
              </Form.Item>
            )}
          </Form>
        </Space>
      </Drawer>
    </>
  )
}
