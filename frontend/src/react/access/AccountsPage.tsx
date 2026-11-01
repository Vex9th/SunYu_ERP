import { useState } from 'react'
import { Alert, Button, Col, Descriptions, Empty, Form, Input, List, Modal, Row, Select, Space, Table, Tabs, Tag } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { createRetriablePostSender, requestJson } from '../../api'
import type { ProjectSummary } from '../../types'
import { ErrorNotice, PageHeader, RefreshButton, Section, useLoad } from '../shared'
import { OperationHistory } from '../activity/OperationHistory'
import { useAccess } from './AccessProvider'
import { WorkgroupEditor } from './WorkgroupEditor'
import type { ManagedAccount, PermissionDefinition, Workgroup } from './access'
const posts = createRetriablePostSender()
type Editor = {
  kind: 'account'
  account?: ManagedAccount
} | {
  kind: 'reset'
  account: ManagedAccount
} | {
  kind: 'group'
}
export default function AccountsPage() {
  const {
    user,
    refresh
  } = useAccess()
  return user?.is_owner ? <AccountAdministration /> : <Section title="我的账号">
    <Descriptions column={1} items={[{
      key: 'name',
      label: '备注名',
      children: user?.display_name || user?.username
    }, {
      key: 'login',
      label: '登录名',
      children: user?.username
    }, {
      key: 'group',
      label: '工作组',
      children: user?.group_name ?? '尚未分配工作组'
    }]} />
    <Alert type="info" showIcon title={user?.group_id ? '需要调整权限时，请联系主账号。' : '尚未分配工作组，请联系主账号分配工作组与项目。'} action={<Button onClick={() => void refresh()}>刷新权限</Button>} />
  </Section>
}
function AccountAdministration() {
  const {
    refresh: refreshSession
  } = useAccess()
  const load = useLoad(async () => {
    const [accounts, groups, catalog, projects] = await Promise.all([requestJson<ManagedAccount[]>('/api/accounts'), requestJson<Workgroup[]>('/api/workgroups'), requestJson<PermissionDefinition[]>('/api/permissions/catalog'), requestJson<ProjectSummary[]>('/api/projects?status=all')])
    return {
      accounts,
      groups,
      catalog,
      projects
    }
  }, [])
  const [selected, setSelected] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm()
  const group = load.data?.groups.find(item => item.id === selected) ?? load.data?.groups.find(item => !item.archived)
  function open(next: Editor) {
    setEditor(next)
    setError('')
    form.resetFields()
    if (next.kind === 'account' && next.account) form.setFieldsValue(next.account)
  }
  async function save(values: Record<string, unknown>) {
    if (!editor || busy) return
    setBusy(true)
    setError('')
    try {
      if (editor.kind === 'group') await posts.send('/api/workgroups', {
        name: String(values.name).trim()
      }); else if (editor.kind === 'reset') await posts.send(`/api/accounts/${editor.account.id}/reset-password`, {
        password: values.password,
        expected_revision: editor.account.revision
      }); else if (editor.account) await requestJson(`/api/accounts/${editor.account.id}`, {
        method: 'PATCH',
        body: {
          display_name: String(values.display_name).trim(),
          group_id: values.group_id ?? null,
          expected_revision: editor.account.revision
        }
      }); else await posts.send('/api/accounts', {
        username: String(values.username).trim(),
        display_name: String(values.display_name).trim(),
        password: values.password,
        group_id: values.group_id ?? null
      })
      setEditor(null)
      form.resetFields()
      await load.reload()
      await refreshSession()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  async function toggle(account: ManagedAccount) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await requestJson(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: {
          enabled: !account.enabled,
          expected_revision: account.revision
        }
      })
      await load.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }
  return <Space orientation="vertical" size={20} style={{
    width: '100%'
  }}>
    <PageHeader title="账号与权限" description="按工作组分配项目、可见内容和业务操作。转组不会改变项目资料或历史操作人。" extra={<RefreshButton loading={load.loading} onClick={load.reload} />} />
    <ErrorNotice error={load.error} retry={load.reload} />{!editor && error && <Alert type="error" title={error} />}
    <Tabs items={[{
      key: 'accounts',
      label: '账号',
      children: <Section title="账号列表" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => open({
        kind: 'account'
      })}>创建账号</Button>}>
        <Table<ManagedAccount> rowKey="id" loading={load.loading} dataSource={load.data?.accounts} scroll={{
          x: 850
        }} columns={[{
          title: '登录名',
          dataIndex: 'username'
        }, {
          title: '备注名',
          dataIndex: 'display_name'
        }, {
          title: '工作组',
          render: (_, account) => account.is_owner ? <Tag color="blue">主账号</Tag> : account.group_name || <Tag>未分组</Tag>
        }, {
          title: '状态',
          render: (_, account) => <Tag color={account.enabled ? 'success' : 'default'}>{account.enabled ? '启用' : '停用'}</Tag>
        }, {
          title: '操作',
          render: (_, account) => <Space wrap>
            <Button size="small" disabled={busy} onClick={() => open({
              kind: 'account',
              account
            })}>{account.is_owner ? '修改备注' : '备注 / 转组'}</Button>
            <Button size="small" disabled={busy} onClick={() => open({
              kind: 'reset',
              account
            })}>重置密码</Button>
            <Button size="small" danger={account.enabled} disabled={busy || account.is_owner} onClick={() => void toggle(account)}>{account.enabled ? '停用' : '启用'}</Button>
            <OperationHistory resourceType="account" resourceId={account.id} />
          </Space>
        }]} />
      </Section>
    }, {
      key: 'groups',
      label: '工作组与授权',
      children: <Section title="工作组" extra={<Button icon={<PlusOutlined />} onClick={() => open({
        kind: 'group'
      })}>创建工作组</Button>}>
        <Row gutter={[24, 24]}>
          <Col xs={24} md={6}>
            <List dataSource={load.data?.groups.filter(item => !item.archived)} locale={{
              emptyText: '尚未创建工作组'
            }} renderItem={item => <List.Item>
              <Button block type={group?.id === item.id ? 'primary' : 'text'} onClick={() => setSelected(item.id)}>{item.name}（{item.member_count}）{!item.enabled && ' · 停用'}</Button>
            </List.Item>} />
          </Col>
          <Col xs={24} md={18}>{group && load.data ? <WorkgroupEditor key={group.id} group={group} catalog={load.data.catalog} projects={load.data.projects} onSaved={load.reload} /> : <Empty description="创建工作组后选择可见项目和业务权限" />}</Col>
        </Row>
      </Section>
    }]} />
    <Modal open={Boolean(editor)} title={editor?.kind === 'group' ? '创建工作组' : editor?.kind === 'reset' ? `重置密码 · ${editor.account.display_name}` : editor?.account ? '备注与工作组' : '创建账号'} confirmLoading={busy} onOk={() => form.submit()} onCancel={() => {
      if (!busy) setEditor(null)
    }} cancelButtonProps={{
      disabled: busy
    }} mask={{
      closable: !busy
    }} destroyOnHidden>
      {error && <Alert type="error" showIcon title={error} style={{
        marginBottom: 16
      }} />}<Form form={form} layout="vertical" disabled={busy} onFinish={save}>
        {editor?.kind === 'group' ? <Form.Item label="组名" name="name" rules={[{
          required: true,
          whitespace: true,
          message: '请输入组名'
        }]}>
          <Input maxLength={100} />
        </Form.Item> : <>
          {editor?.kind === 'account' && <>{!editor.account && <Form.Item name="username" label="登录名" rules={[{
            required: true,
            whitespace: true,
            message: '请输入登录名'
          }]}>
            <Input autoComplete="off" maxLength={64} />
          </Form.Item>}<Form.Item name="display_name" label="备注名" rules={[{
            required: true,
            whitespace: true,
            message: '请输入备注名'
          }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="group_id" label="工作组">
              <Select disabled={editor.account?.is_owner} allowClear placeholder="不分组（无业务权限）" options={load.data?.groups.filter(item => !item.archived).map(item => ({
                value: item.id,
                label: `${item.name}${item.enabled ? '' : '（已停用）'}`
              }))} />
            </Form.Item>
          </>}
          {(editor?.kind === 'reset' || editor?.kind === 'account' && !editor.account) && <>
            <Form.Item name="password" label="新密码" rules={[{
              required: true,
              message: '请输入密码'
            }, {
              min: 8,
              max: 128,
              message: '密码为 8～128 个字符'
            }]}>
              <Input.Password autoComplete="new-password" maxLength={128} />
            </Form.Item>{editor?.kind === 'reset' && <Alert type="warning" showIcon title="重置后该账号所有已登录会话立即失效。" />}</>}
        </>}
      </Form>
    </Modal>
  </Space>
}
