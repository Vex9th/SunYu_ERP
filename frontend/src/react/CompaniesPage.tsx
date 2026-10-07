import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  UserAddOutlined,
} from '@ant-design/icons'
import { ApiError, requestJson, requestVoid } from '../api'
import type {
  CompanyDetail,
  CompanyPayload,
  CompanySummary,
  ContactPayload,
  RevisionedContact,
} from '../types'
import {
  errorText,
  ErrorNotice,
  isUncertain,
  PageHeader,
  RefreshButton,
  Section,
  useLoad,
  useWorkspaceValue,
  LoadingBlock,
} from './shared'
import styles from './Workspace.module.css'

import {
  clearPendingCreate,
  companyFields,
  companyPayload,
  contactFields,
  contactPayload,
  listPendingCreates,
  prepareCompanyCreate,
  prepareContactCreate,
  readPendingCreate,
  sendPendingCreate,
  storePendingCreate,
  text,
  type PendingCreate,
} from './companyWrites'

type CompanyEditorTarget =
  | { kind: 'company'; record: CompanySummary | CompanyDetail | null }
  | {
      kind: 'contact'
      companyId: number
      companyName: string
      record: RevisionedContact | null
    }
type DeleteTarget =
  | { kind: 'company'; record: CompanyDetail }
  | {
      kind: 'contact'
      companyId: number
      companyName: string
      record: RevisionedContact
    }
function targetFromPending(pending: PendingCreate): CompanyEditorTarget {
  return pending.companyId === undefined
    ? { kind: 'company', record: null }
    : {
        kind: 'contact',
        companyId: pending.companyId,
        companyName: `公司 #${pending.companyId}`,
        record: null,
      }
}

export default function CompaniesPage() {
  const { message } = App.useApp()
  const list = useLoad(
    () => requestJson<CompanySummary[]>('/api/companies'),
    [],
  )
  const [search, setSearch] = useWorkspaceValue('q', '')
  const [selectedValue, setSelectedValue] = useWorkspaceValue('company', '')
  const selected = Number(selectedValue) > 0 ? Number(selectedValue) : null
  const setSelected = (value: number | null) =>
    setSelectedValue(value ? String(value) : '')
  const detail = useLoad(
    () =>
      selected
        ? requestJson<CompanyDetail>(`/api/companies/${selected}`)
        : Promise.resolve(null),
    [selected],
  )
  const [pendingCreates, setPendingCreates] = useState(listPendingCreates)
  const [editor, setEditor] = useState<CompanyEditorTarget | null>(() => {
    const pending = listPendingCreates()[0]
    return pending ? targetFromPending(pending) : null
  })
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null)
  async function refresh() {
    await Promise.all([list.reload(), detail.reload()])
  }
  const filtered = (list.data ?? []).filter((company) =>
    [
      company.name,
      company.taxpayer_id,
      company.registered_phone,
      company.notes,
    ].some((value) => value?.toLowerCase().includes(search.toLowerCase())),
  )

  return (
    <div className={styles.stack}>
      <PageHeader
        eyebrow="CONTACTS / 基础资料"
        title="公司与联系人"
        description="客户、供应商与项目联系信息，统一维护。"
        extra={
          <>
            <RefreshButton onClick={refresh} loading={list.loading} />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setEditor({ kind: 'company', record: null })}
            >
              新增公司
            </Button>
          </>
        }
      />
      <ErrorNotice error={list.error} retry={list.reload} />
      {!editor && pendingCreates.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="有上次结果尚未确认的创建请求"
          description={
            <Space wrap>
              {pendingCreates.map((pending) => (
                <Button
                  key={pending.path}
                  onClick={() => setEditor(targetFromPending(pending))}
                >
                  恢复
                  {pending.companyId === undefined
                    ? '公司'
                    : `公司 #${pending.companyId} 的联系人`}
                  创建
                </Button>
              ))}
            </Space>
          }
        />
      )}
      <Section>
        <div className={styles.toolbar}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索公司、税号或电话"
            aria-label="搜索公司"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ maxWidth: 340 }}
          />
          <span className={styles.subtle}>{filtered.length} 家公司</span>
        </div>
        <Table<CompanySummary>
          rowKey="id"
          loading={list.loading}
          dataSource={filtered}
          size="middle"
          scroll={{ x: 620 }}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            hideOnSinglePage: true,
          }}
          columns={[
            {
              title: '公司名称',
              dataIndex: 'name',
              width: 270,
              render: (name: string, row) => (
                <>
                  <Button
                    type="link"
                    style={{ padding: 0, fontWeight: 600 }}
                    onClick={() => setSelected(row.id)}
                  >
                    {name}
                  </Button>
                  <div className={styles.subtle}>
                    税号：{row.taxpayer_id || '未填写'}
                  </div>
                </>
              ),
            },
            {
              title: '公司电话',
              dataIndex: 'registered_phone',
              render: (value: string) => value || '—',
            },
            {
              title: '联系人',
              dataIndex: 'contact_count',
              width: 90,
              render: (value: number, row) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => value ? setSelected(row.id) : setEditor({kind:'contact', companyId:row.id, companyName:row.name, record:null})}
                >
                  {value ? `${value} 位联系人` : '添加联系人'}
                </Button>
              ),
            },
            {
              title: '操作',
              key: 'actions',
              width: 155,
              fixed: 'right',
              render: (_, row) => (
                <Space>
                  <Button size="small" onClick={() => setSelected(row.id)}>
                    查看资料
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    aria-label={`编辑公司${row.name}`}
                    onClick={() => setEditor({ kind: 'company', record: row })}
                  />
                </Space>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <Empty
                description={
                  search
                    ? '没有匹配的公司'
                    : '添加客户或供应商，为项目建立基础资料'
                }
              />
            ),
          }}
        />
      </Section>
      {selected && (
        <Drawer
          open
          title={detail.data?.name ?? '公司详情'}
          size={820}
          onClose={() => setSelected(null)}
        >
          {!detail.data && detail.loading && <LoadingBlock />}
          <ErrorNotice error={detail.error} retry={detail.reload} />
          {detail.data && (
            <Space orientation="vertical" size={24} style={{ width: '100%' }}>
              <Descriptions
                column={{ xs: 1, sm: 2, lg: 3 }}
                items={companyFields
                  .filter(([key]) => key !== 'name')
                  .map(([key, label]) => ({
                    key,
                    label,
                    children: detail.data?.[key] || '—',
                  }))}
              />
              <Space wrap>
                <Button
                  icon={<EditOutlined />}
                  onClick={() =>
                    setEditor({ kind: 'company', record: detail.data })
                  }
                >
                  编辑公司资料
                </Button>
                <Button
                  icon={<UserAddOutlined />}
                  type="primary"
                  onClick={() =>
                    detail.data &&
                    setEditor({
                      kind: 'contact',
                      companyId: detail.data.id,
                      companyName: detail.data.name,
                      record: null,
                    })
                  }
                >
                  添加联系人
                </Button>
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    detail.data &&
                    setDeleting({ kind: 'company', record: detail.data })
                  }
                >
                  删除公司
                </Button>
              </Space>
              <Table<RevisionedContact>
                rowKey="id"
                size="small"
                dataSource={detail.data.contacts}
                pagination={false}
                scroll={{ x: 630 }}
                columns={[
                  { title: '姓名', dataIndex: 'name' },
                  { title: '职位', dataIndex: 'position' },
                  {
                    title: '电话',
                    dataIndex: 'phone',
                    render: (value: string) =>
                      value ? <a href={`tel:${value}`}>{value}</a> : '—',
                  },
                  {
                    title: '邮箱',
                    dataIndex: 'email',
                    render: (value: string) =>
                      value ? <a href={`mailto:${value}`}>{value}</a> : '—',
                  },
                  { title: '备注', dataIndex: 'notes' },
                  {
                    title: '操作',
                    key: 'actions',
                    render: (_, row) => (
                      <Space>
                        <Button
                          type="link"
                          size="small"
                          onClick={() =>
                            detail.data &&
                            setEditor({
                              kind: 'contact',
                              companyId: detail.data.id,
                              companyName: detail.data.name,
                              record: row,
                            })
                          }
                        >
                          编辑
                        </Button>
                        <Button
                          type="link"
                          danger
                          size="small"
                          onClick={() =>
                            detail.data &&
                            setDeleting({
                              kind: 'contact',
                              companyId: detail.data.id,
                              companyName: detail.data.name,
                              record: row,
                            })
                          }
                        >
                          删除
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            </Space>
          )}
        </Drawer>
      )}
      {editor && (
        <CompanyEditor
          key={`${editor.kind}:${editor.kind === 'contact' ? editor.companyId : ''}:${editor.record?.id ?? 'new'}`}
          target={editor}
          onClose={() => {
            setEditor(null)
            setPendingCreates(listPendingCreates())
          }}
          onSaved={(result) => {
            if (editor.kind === 'company' && !editor.record)
              setSelected(result.id)
            setPendingCreates(listPendingCreates())
            setEditor(null)
            void refresh()
            void message.success('已保存')
          }}
        />
      )}
      {deleting && (
        <CompanyDeleteDialog
          key={`${deleting.kind}:${deleting.record.id}`}
          target={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            if (deleting.kind === 'company') setSelected(null)
            setDeleting(null)
            void refresh()
            void message.success('已删除')
          }}
        />
      )}
    </div>
  )
}

function CompanyEditor({
  target,
  onClose,
  onSaved,
}: {
  target: CompanyEditorTarget
  onClose: () => void
  onSaved: (result: CompanyDetail | RevisionedContact) => void
}) {
  const fields = target.kind === 'company' ? companyFields : contactFields
  const companyId =
    target.kind === 'contact' ? target.companyId : target.record?.id
  const [pending, setPending] = useState<PendingCreate | null>(() =>
    target.record
      ? null
      : readPendingCreate(
          target.kind === 'contact' ? target.companyId : undefined,
        ),
  )
  const initial = Object.fromEntries(
    fields.map(([key]) => [
      key,
      (
        (pending?.payload ?? target.record) as unknown as Record<
          string,
          unknown
        > | null
      )?.[key] ?? '',
    ]),
  )
  const [form] = Form.useForm<Record<string, unknown>>()
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [persistenceWarning, setPersistenceWarning] = useState(false)
  const [latest, setLatest] = useState<
    CompanyDetail | RevisionedContact | null
  >(null)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [missing, setMissing] = useState(false)
  const [uncertainUpdate, setUncertainUpdate] = useState<{
    payload: CompanyPayload | ContactPayload
    revision: number
  } | null>(null)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const dirty = useRef(false)
  const { modal } = App.useApp()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const locked = busy || Boolean(pending) || Boolean(uncertainUpdate)
  const path =
    target.kind === 'company'
      ? `/api/companies/${target.record?.id}`
      : `/api/companies/${target.companyId}/contacts/${target.record?.id}`
  const label = target.kind === 'company' ? '公司' : '联系人'

  async function refreshConflict() {
    if (!target.record || companyId === undefined) return
    setRefreshRequired(true)
    setLatest(null)
    setMissing(false)
    try {
      const company = await requestJson<CompanyDetail>(
        `/api/companies/${companyId}`,
      )
      if (!mounted.current) return
      const current =
        target.kind === 'company'
          ? company
          : company.contacts.find((contact) => contact.id === target.record!.id)
      if (!current) {
        setMissing(true)
        setRefreshRequired(false)
        setError(
          '该联系人已被其他窗口删除，你填写的草稿仍保留，但不能继续覆盖。',
        )
        return
      }
      setLatest(current)
      setRefreshRequired(false)
      setError(
        `${label}已被其他窗口修改。服务器最新值已列出，你填写的草稿仍保留；核对后明确确认才会覆盖。`,
      )
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        setMissing(true)
        setRefreshRequired(false)
        setError(`${label}已被删除，草稿仍保留，但不能继续覆盖。`)
      } else
        setError(
          `最新资料读取失败，草稿已保留：${errorText(cause)}。请重新读取后核对。`,
        )
    }
  }
  async function retryRefresh() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await refreshConflict()
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function submit(values: Record<string, unknown>) {
    if (busyRef.current || refreshRequired || missing) return
    const payload =
      pending?.payload ??
      uncertainUpdate?.payload ??
      (target.kind === 'company'
        ? companyPayload(values)
        : contactPayload(values))
    const create = target.record
      ? null
      : (pending ??
        (target.kind === 'company'
          ? prepareCompanyCreate(payload as CompanyPayload)
          : prepareContactCreate(target.companyId, payload as ContactPayload)))
    const revision =
      uncertainUpdate?.revision ?? latest?.revision ?? target.record?.revision
    busyRef.current = true
    setBusy(true)
    setError(null)
    if (create) {
      const persisted = storePendingCreate(create)
      setPersistenceWarning(!persisted)
      setPending(create)
    }
    try {
      const result = create
        ? await sendPendingCreate(create)
        : await requestJson<CompanyDetail | RevisionedContact>(path, {
            method: 'PUT',
            body: { ...payload, expected_revision: revision },
          })
      if (create) clearPendingCreate(create.companyId)
      if (mounted.current) onSaved(result)
    } catch (cause) {
      if (create && !isUncertain(cause)) clearPendingCreate(create.companyId)
      if (!mounted.current) return
      if (create) {
        if (!isUncertain(cause)) setPending(null)
        setError(errorText(cause))
      } else if (
        cause instanceof ApiError &&
        cause.errorCode === 'REVISION_CONFLICT'
      ) {
        setUncertainUpdate(null)
        await refreshConflict()
      } else {
        if (isUncertain(cause) && revision !== undefined)
          setUncertainUpdate({ payload, revision })
        else setUncertainUpdate(null)
        setError(errorText(cause))
      }
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function close() {
    if (busyRef.current) return
    if (dirty.current && !pending && !uncertainUpdate) {
      modal.confirm({
        title: '放弃尚未保存的草稿？',
        content: '关闭后未保存的修改将丢失。',
        okText: '放弃草稿',
        cancelText: '继续编辑',
        onOk: onClose,
      })
      return
    }
    if (uncertainUpdate) {
      setError('本次修改结果尚未确认，请先原样重试或核对服务器最新资料。')
      return
    }
    onClose()
  }
  const conflictRows = latest
    ? fields.map(([key, fieldLabel]) => {
        const draftValue = text(draft[key])
        const serverValue = text(
          (latest as unknown as Record<string, unknown>)[key],
        )
        return {
          key,
          label: fieldLabel,
          draft: draftValue ?? '未录入',
          server: serverValue ?? '未录入',
          different: draftValue !== serverValue,
        }
      })
    : []
  return (
    <Drawer
      open
      title={`${target.record ? '编辑' : '新增'}${label}${target.kind === 'contact' ? ` · ${target.companyName}` : ''}`}
      size={650}
      onClose={close}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={
        <Space wrap>
          <Button disabled={busy} onClick={close}>
            {pending ? '稍后处理' : '取消'}
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={refreshRequired || missing}
            onClick={() =>
              pending || uncertainUpdate ? void submit(draft) : form.submit()
            }
          >
            {pending || uncertainUpdate
              ? '原样重试'
              : latest
                ? '确认覆盖最新资料'
                : '保存'}
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <ErrorNotice error={error} />
        {pending && (
          <Alert
            type="warning"
            showIcon
            title="创建结果尚未确认，原请求已保留"
            description={
              persistenceWarning
                ? '字段已冻结，原样重试沿用同一幂等键；浏览器未能持久化凭据，请勿刷新此页。'
                : '字段已冻结。原样重试沿用同一幂等键，即使整页刷新也不会自动创建新请求。'
            }
            action={
              <Popconfirm
                title={`放弃结果未知的${label}创建？`}
                description="原请求可能已经成功；放弃后再次保存可能生成重复记录，请先核对台账。"
                okText="放弃并继续修改"
                cancelText="保留原请求"
                disabled={busy}
                onConfirm={() => {
                  clearPendingCreate(pending.companyId)
                  setPending(null)
                  setError(null)
                  setPersistenceWarning(false)
                }}
              >
                <Button danger disabled={busy}>
                  放弃原请求
                </Button>
              </Popconfirm>
            }
          />
        )}
        {persistenceWarning && (
          <Alert
            type="warning"
            showIcon
            title="浏览器无法保存重试凭据，请勿刷新此页"
            description="本页仍保留原内容与幂等键。确认本次结果后再离开。"
          />
        )}
        {uncertainUpdate && (
          <Alert
            type="warning"
            showIcon
            title="修改结果尚未确认，原内容与版本已冻结"
            description="请原样重试；如果服务器已保存，将读取最新资料供你核对。"
          />
        )}
        {refreshRequired && (
          <Button loading={busy} onClick={() => void retryRefresh()}>
            重新读取最新资料
          </Button>
        )}
        {latest && (
          <>
            <Typography.Text strong>
              冲突对照 · 服务器版本 R{latest.revision}
            </Typography.Text>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={conflictRows}
              columns={[
                { title: '字段', dataIndex: 'label', width: 115 },
                {
                  title: '我的草稿',
                  dataIndex: 'draft',
                  render: (value: string, row) => (
                    <Typography.Text strong={row.different}>
                      {value}
                    </Typography.Text>
                  ),
                },
                {
                  title: '服务器最新值',
                  dataIndex: 'server',
                  render: (value: string, row) => (
                    <Space>
                      {row.different && <Tag color="warning">不同</Tag>}
                      <span>{value}</span>
                    </Space>
                  ),
                },
              ]}
            />
            <Button onClick={() => void retryRefresh()} loading={busy}>
              重新核对最新资料
            </Button>
          </>
        )}
        <Form
          form={form}
          layout="vertical"
          initialValues={initial}
          disabled={locked || missing}
          onValuesChange={() => {
            dirty.current = true
            setDraft(form.getFieldsValue())
          }}
          onFinish={(values) => void submit(values)}
        >
          {fields.map(([key, fieldLabel]) => (
            <Form.Item
              key={key}
              name={key}
              label={fieldLabel}
              rules={
                key === 'name'
                  ? [
                      {
                        required: true,
                        whitespace: true,
                        message: `请输入${fieldLabel}`,
                      },
                    ]
                  : key === 'email'
                    ? [{ type: 'email', message: '请输入有效邮箱' }]
                    : undefined
              }
            >
              {key === 'notes' ? (
                <Input.TextArea rows={3} />
              ) : (
                <Input maxLength={key === 'name' ? 200 : 500} />
              )}
            </Form.Item>
          ))}
        </Form>
      </Space>
    </Drawer>
  )
}

function CompanyDeleteDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget
  onClose: () => void
  onDeleted: () => void
}) {
  const [current, setCurrent] = useState<
    CompanyDetail | RevisionedContact | null
  >(target.record)
  const [conflicted, setConflicted] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const companyId =
    target.kind === 'company' ? target.record.id : target.companyId
  const path = `/api/companies/${companyId}${target.kind === 'contact' ? `/contacts/${target.record.id}` : ''}`
  const fields = target.kind === 'company' ? companyFields : contactFields
  async function refreshLatest() {
    setRefreshRequired(true)
    try {
      const company = await requestJson<CompanyDetail>(
        `/api/companies/${companyId}`,
      )
      if (!mounted.current) return
      const record =
        target.kind === 'company'
          ? company
          : (company.contacts.find(
              (contact) => contact.id === target.record.id,
            ) ?? null)
      setCurrent(record)
      setConflicted(true)
      setRefreshRequired(false)
      setError(
        record
          ? '资料刚被其他窗口修改，已读取最新资料。请核对后再次明确确认删除。'
          : '该联系人已被其他窗口删除，无需再次删除。',
      )
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        setCurrent(null)
        setRefreshRequired(false)
        setError('该资料已被其他窗口删除。')
      } else
        setError(`最新资料读取失败，请重新读取后再确认：${errorText(cause)}`)
    }
  }
  async function retryRead() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await refreshLatest()
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function remove() {
    if (busyRef.current || refreshRequired || !current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await requestVoid(path, {
        method: 'DELETE',
        body: { expected_revision: current.revision },
      })
      if (mounted.current) onDeleted()
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.errorCode === 'REVISION_CONFLICT')
        await refreshLatest()
      else setError(errorText(cause))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={`删除${target.kind === 'company' ? '公司' : '联系人'}“${current?.name ?? target.record.name}”？`}
      onCancel={onClose}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={
        <Space>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          {refreshRequired && (
            <Button loading={busy} onClick={() => void retryRead()}>
              重新读取最新资料
            </Button>
          )}
          <Button
            danger
            type="primary"
            loading={busy}
            disabled={refreshRequired || !current}
            onClick={() => void remove()}
          >
            {conflicted ? '按最新版本确认删除' : '确认删除'}
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <ErrorNotice error={error} />
        <Alert
          type="warning"
          title={
            target.kind === 'company'
              ? '已关联项目的公司不能删除。删除前请确认不再使用。'
              : `删除后联系人将从 ${target.companyName} 的资料中移除。`
          }
        />
        {current && (
          <Descriptions
            column={1}
            size="small"
            items={[
              ...fields.map(([key, label]) => ({
                key,
                label,
                children:
                  text((current as unknown as Record<string, unknown>)[key]) ??
                  '未录入',
              })),
              {
                key: 'revision',
                label: '当前版本',
                children: `R${current.revision}`,
              },
            ]}
          />
        )}
      </Space>
    </Modal>
  )
}
