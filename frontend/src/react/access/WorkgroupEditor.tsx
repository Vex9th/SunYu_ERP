import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Divider, Form, Input, Popconfirm, Select, Space, Switch, Typography } from 'antd'
import { requestJson } from '../../api'
import type { ProjectSummary } from '../../types'
import { OperationHistory } from '../activity/OperationHistory'
import { selectPermission, type PermissionDefinition, type Workgroup } from './access'
export function WorkgroupEditor({
  group,
  catalog,
  projects,
  onSaved
}: {
  group: Workgroup
  catalog: PermissionDefinition[]
  projects: ProjectSummary[]
  onSaved: () => Promise<unknown>
}) {
  const [name, setName] = useState(group.name)
  const [enabled, setEnabled] = useState(group.enabled)
  const [keys, setKeys] = useState(group.permission_keys)
  const [projectIds, setProjectIds] = useState(group.project_ids)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setName(group.name)
    setEnabled(group.enabled)
    setKeys(group.permission_keys)
    setProjectIds(group.project_ids)
    setError('')
  }, [group])
  async function save(mode: 'profile' | 'access' | 'archive') {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await requestJson(`/api/workgroups/${group.id}${mode === 'access' ? '/access' : ''}`, {
        method: mode === 'access' ? 'PUT' : mode === 'archive' ? 'DELETE' : 'PATCH',
        body: {
          expected_revision: group.revision,
          ...(mode === 'access' ? {
            permission_keys: keys,
            project_ids: projectIds
          } : mode === 'profile' ? {
            name: name.trim(),
            enabled
          } : {})
        }
      })
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  const modules = [...new Set(catalog.map(item => item.module))]
  return <Space orientation="vertical" style={{
    width: '100%'
  }} size={16}>
    <div>
      <Typography.Title level={4} style={{
        margin: 0
      }}>{group.name}</Typography.Title>
      <Typography.Text type="secondary">{group.member_count} 位成员 · 修改后成员在下一次请求时使用新权限</Typography.Text>
      <OperationHistory resourceType="workgroup" resourceId={group.id} />
    </div>
    {error && <Alert showIcon type="error" title={error} />}
    <Form layout="vertical" disabled={busy}>
      <Space wrap align="end">
        <Form.Item label="工作组名称" style={{
          margin: 0
        }}>
          <Input aria-label="工作组名称" value={name} maxLength={100} onChange={event => setName(event.target.value)} />
        </Form.Item>
        <Form.Item label="工作组状态" style={{
          margin: 0
        }}>
          <Switch checked={enabled} checkedChildren="启用" unCheckedChildren="停用" onChange={setEnabled} />
        </Form.Item>
        <Button loading={busy} disabled={!name.trim()} onClick={() => void save('profile')}>保存名称与状态</Button>
      </Space>
    </Form>
    <Divider style={{
      margin: '4px 0'
    }} />
    <div>
      <Typography.Title level={5}>可见项目</Typography.Title>
      <Select aria-label="可见项目" mode="multiple" style={{
        width: '100%'
      }} disabled={busy} placeholder="未选择项目时无法访问项目业务" value={projectIds} optionFilterProp="label" onChange={setProjectIds} options={projects.map(project => ({
        value: project.id,
        label: `${project.project_code} · ${project.name}`
      }))} />
    </div>
    <div>
      <Typography.Title level={5}>可见内容</Typography.Title>
      <Space wrap>{catalog.filter(item => item.key.endsWith('.view') || item.module === '敏感数据').map(item => <Checkbox key={item.key} disabled={busy} checked={keys.includes(item.key)} onChange={event => setKeys(current => selectPermission(current, item.key, event.target.checked, catalog))}>{item.label}</Checkbox>)}</Space>
    </div>
    <div>
      <Typography.Title level={5}>允许操作</Typography.Title>
      <Typography.Paragraph type="secondary">勾选操作会自动补充必要的查看权限；取消查看权限也会移除依赖它的操作。</Typography.Paragraph>{modules.map(module => {
        const actions = catalog.filter(item => item.module === module && !item.key.endsWith('.view') && item.module !== '敏感数据')
        return actions.length ? <div key={module} style={{
          marginBottom: 14
        }}>
          <Typography.Text strong>{module}</Typography.Text>
          <div>
            <Space wrap>{actions.map(item => <Checkbox key={item.key} disabled={busy} checked={keys.includes(item.key)} onChange={event => setKeys(current => selectPermission(current, item.key, event.target.checked, catalog))}>{item.label}</Checkbox>)}</Space>
          </div>
        </div> : null
      })}</div>
    <Space wrap>
      <Button type="primary" loading={busy} onClick={() => void save('access')}>保存项目与权限</Button>
      <Popconfirm title="归档这个空工作组？" description="历史记录仍保留原组名与编号。" onConfirm={() => save('archive')}>
        <Button danger disabled={busy || group.member_count > 0}>归档工作组</Button>
      </Popconfirm>{group.member_count > 0 && <Typography.Text type="secondary">归档前请先转出组内成员</Typography.Text>}</Space>
  </Space>
}
