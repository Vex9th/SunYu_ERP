import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Divider, Form, Input, Popconfirm, Select, Space, Switch, Typography } from 'antd'
import { requestJson } from '../../api'
import type { ProjectSummary } from '../../types'
import { OperationHistory } from '../activity/OperationHistory'
import { completePermissions, selectPermission, type PermissionDefinition, type Workgroup } from './access'
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
  const [success, setSuccess] = useState('')
  const completeKeys = completePermissions(keys, catalog)
  const missingKeys = completeKeys.filter(key => !keys.includes(key))
  function select(key: string, checked: boolean) {
    setKeys(current => selectPermission(current, key, checked, catalog))
    setError('')
    setSuccess('')
  }
  useEffect(() => {
    setName(group.name)
    setEnabled(group.enabled)
    setKeys(group.permission_keys)
    setProjectIds(group.project_ids)
    setError('')
  }, [group])
  async function save(mode: 'profile' | 'access' | 'archive') {
    if (busy) return
    if (mode === 'access' && missingKeys.length) {
      setError('请先补齐所需权限，或取消依赖这些权限的操作')
      return
    }
    setBusy(true)
    setError('')
    setSuccess('')
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
      setSuccess(mode === 'access' ? '项目与权限已保存' : mode === 'profile' ? '名称与状态已保存' : '工作组已归档')
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
    {success && <Alert showIcon type="success" title={success} />}
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
      }} disabled={busy} placeholder="未选择项目时无法访问项目业务" value={projectIds} optionFilterProp="label" onChange={ids => { setProjectIds(ids); setSuccess('') }} options={projects.map(project => ({
        value: project.id,
        label: `${project.project_code} · ${project.name}`
      }))} />
      {completeKeys.includes('projects.view') && !projectIds.length && <Alert type="warning" showIcon title="尚未选择可见项目，成员将无法访问项目及采购等项目业务。" style={{ marginTop: 8 }} />}
    </div>
    <div>
      <Typography.Title level={5}>可见内容</Typography.Title>
      <Space wrap>{catalog.filter(item => item.key.endsWith('.view') || item.module === '敏感数据').map(item => <Checkbox key={item.key} disabled={busy} checked={keys.includes(item.key)} onChange={event => select(item.key, event.target.checked)}>{item.label}</Checkbox>)}</Space>
    </div>
    <div>
      <Typography.Title level={5}>允许操作</Typography.Title>
      <Typography.Paragraph type="secondary">勾选操作会联动项目入口、选料、供应商及必要的价格查看权限，请核对后保存。取消必要的查看权限会同时取消依赖操作。项目库存管理用于领用与冲销；新增物料、修改库存或调整数量需勾选“管理共享库存”。</Typography.Paragraph>
      {missingKeys.length > 0 && <Alert type="warning" showIcon title="部分操作缺少必要权限" description={`缺少：${missingKeys.map(key => catalog.find(item => item.key === key)?.label ?? key).join('、')}。补齐后请核对勾选项，再保存项目与权限。`} action={<Button onClick={() => { setKeys(completeKeys); setError(''); setSuccess('') }}>补齐所需权限</Button>} style={{ marginBottom: 16 }} />}
      {modules.map(module => {
        const actions = catalog.filter(item => item.module === module && !item.key.endsWith('.view') && item.module !== '敏感数据')
        return actions.length ? <div key={module} style={{
          marginBottom: 14
        }}>
          <Typography.Text strong>{module}</Typography.Text>
          <div>
            <Space wrap>{actions.map(item => <Checkbox key={item.key} disabled={busy} checked={keys.includes(item.key)} onChange={event => select(item.key, event.target.checked)}>{item.label}</Checkbox>)}</Space>
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
