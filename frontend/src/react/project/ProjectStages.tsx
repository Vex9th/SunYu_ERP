import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Drawer, Empty, Form, Input, Modal, Progress, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { CalendarOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons'
import type { ProjectStage, ProjectStageStatus } from '../../domain/contracts'
import { formatChineseDateTime } from '../../domain/dates'
import type { ProjectStageRepository } from '../../repositories/project'
import { createHttpProjectOperatingRepository } from '../../repositories/project-operating.live'
import { useWorkspaceTab } from '../shared'
import { nullable, useProjectLoad, useProjectWrite, type ProjectProps } from './useProjectWork'
import './project.css'

const repositoryDefault = createHttpProjectOperatingRepository()
export const stageLabels: Record<string, string> = { planning: '项目规划', site_survey: '现场测绘', quotation: '我方报价', technical_agreement: '技术协议', contract: '合同签订', advance_payment: '预付款', mechanical_design: '机械设计', electrical_design: '电气设计', procurement: '采购', staffing: '人员排单', mechanical_signoff: '机械图纸会签', electrical_signoff: '电气图纸会签', construction: '施工', progress_payment: '进度款', commissioning: '调试', acceptance: '验收', final_payment: '尾款', closeout: '收尾' }
const statusLabels: Record<ProjectStageStatus, string> = { pending: '未开始', in_progress: '进行中', blocked: '受阻', completed: '已完成', skipped: '已跳过' }
const colors = { pending: 'default', in_progress: 'processing', blocked: 'error', completed: 'success', skipped: 'warning' }
export const stageTransitions: Record<ProjectStageStatus, ProjectStageStatus[]> = { pending: ['in_progress', 'skipped'], in_progress: ['blocked', 'completed', 'skipped'], blocked: ['in_progress', 'skipped'], completed: ['in_progress'], skipped: ['in_progress'] }
export function stageReasonRequired(from: ProjectStageStatus, to: ProjectStageStatus) { return to === 'blocked' || to === 'skipped' || (to === 'in_progress' && ['blocked', 'completed', 'skipped'].includes(from)) }
interface StageForm { planned_start_on?: string; planned_end_on?: string; notes?: string; to_status: ProjectStageStatus; reason?: string }

export default function ProjectStages({ projectCode, readonly = false, repository = repositoryDefault }: ProjectProps & { repository?: ProjectStageRepository }) {
  const load = useProjectLoad(projectCode, async () => (await repository.listProjectStages(projectCode)).data, repository)
  const [view, setView] = useWorkspaceTab('section', ['current', 'plan', 'history'], 'current')
  const [selection, setSelection] = useState<{ stage: ProjectStage; mode: 'schedule' | 'transition' } | null>(null)
  const [form] = Form.useForm<StageForm>()
  const [modal, modalContext] = Modal.useModal()
  const dirty = useRef(false)
  const target = Form.useWatch('to_status', form)
  const write = useProjectWrite(`stages:${projectCode}`, () => { setSelection(null); load.reload() })
  useEffect(() => { setSelection(null); form.resetFields(); dirty.current = false }, [projectCode, form])
  function open(stage: ProjectStage, mode: 'schedule' | 'transition') {
    write.clearError(); form.resetFields(); form.setFieldsValue({ planned_start_on: stage.planned_start_on ?? '', planned_end_on: stage.planned_end_on ?? '', notes: stage.notes ?? '', to_status: stageTransitions[stage.status][0], reason: '' }); dirty.current = false; setSelection({ stage, mode })
  }
  function close() {
    if (write.busy) return
    if (dirty.current && !write.locked) { modal.confirm({ title: '放弃尚未保存的修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: () => setSelection(null) }); return }
    setSelection(null)
  }
  function save(values: StageForm) {
    if (!selection || readonly || write.locked) return
    const { stage, mode } = selection
    if (mode === 'schedule') {
      if (values.planned_start_on && values.planned_end_on && values.planned_end_on < values.planned_start_on) { form.setFields([{ name: 'planned_end_on', errors: ['计划结束日期不能早于开始日期'] }]); return }
      const input = { planned_start_on: nullable(values.planned_start_on), planned_end_on: nullable(values.planned_end_on), notes: nullable(values.notes), expected_revision: stage.revision }
      write.submit('保存阶段计划', () => repository.updateStageSchedule(projectCode, stage.stage_code, input))
    } else {
      const input = { to_status: values.to_status, occurred_at: new Date().toISOString(), reason: nullable(values.reason), expected_revision: stage.revision }
      write.submit('变更阶段状态', () => repository.transitionStage(projectCode, stage.stage_code, input))
    }
  }
  const stages = load.data ?? []
  const complete = stages.filter(stage => stage.status === 'completed').length
  const history = stages.filter(stage => ['completed', 'skipped'].includes(stage.status))
  const active = stages.filter(stage => ['in_progress', 'blocked'].includes(stage.status))
  const upcoming = stages.filter(stage => stage.status === 'pending')
  const next = upcoming[0]
  const current = stages.filter(stage => active.includes(stage) || stage === next)
  const shown = view === 'plan' ? stages : view === 'history' ? history : current
  const disabled = readonly || write.locked || load.loading || Boolean(load.error)
  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>{modalContext}
    {readonly && <Alert type="info" showIcon title="项目已归档，阶段记录只读" />}
    {load.error && <Alert type="error" showIcon title={load.error} action={<Button onClick={load.reload}>重试</Button>} />}{!selection && write.notice}
    <Card size="small" title="项目阶段" extra={<Button icon={<ReloadOutlined />} onClick={load.reload} disabled={write.busy}>刷新</Button>}>
      <div className="project-stage-summary"><div><Typography.Text strong>{complete} / {stages.length} 阶段完成</Typography.Text><Progress percent={stages.length ? Math.round(complete / stages.length * 100) : 0} size="small" /></div><Space wrap><Tag color="processing">正在推进 {active.filter(stage => stage.status === 'in_progress').length}</Tag><Tag color={active.some(stage => stage.status === 'blocked') ? 'error' : 'default'}>受阻 {active.filter(stage => stage.status === 'blocked').length}</Tag><Tag>待开始 {upcoming.length}</Tag></Space></div>
      <Tabs activeKey={view} onChange={setView} items={[{ key: 'current', label: `当前待办 (${current.length})` }, { key: 'plan', label: `完整计划 (${stages.length})` }, { key: 'history', label: `完成 / 跳过 (${history.length})` }]} />
      <Table<ProjectStage> size="small" rowKey="stage_code" loading={load.loading} dataSource={shown} pagination={false} scroll={{ x: 680 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={view === 'current' ? '当前没有待推进阶段，可在完整计划中查看全部记录' : '暂无阶段记录'} /> }} columns={[
        { title: '阶段与状态', width: 230, render: (_, stage) => <Space orientation="vertical" size={5}><Space wrap><Typography.Text type="secondary">{String(stages.indexOf(stage) + 1).padStart(2, '0')}</Typography.Text><Typography.Text strong>{stageLabels[stage.stage_code] ?? stage.stage_code}</Typography.Text></Space><Space wrap><Tag color={colors[stage.status]}>{statusLabels[stage.status]}</Tag>{stage === next && <Tag color="blue">下一步</Tag>}</Space>{stage.status_reason && <Typography.Paragraph className="project-record-note" type={stage.status === 'blocked' ? 'danger' : undefined}>{stage.status_reason}</Typography.Paragraph>}</Space> },
        { title: '计划与记录', render: (_, stage) => <div className="project-stage-dates"><span>{stage.planned_start_on || stage.planned_end_on ? `${stage.planned_start_on ?? '待定'} → ${stage.planned_end_on ?? '待定'}` : <Typography.Text type="secondary">尚未安排日期</Typography.Text>}</span>{stage.started_at && <Typography.Text type="secondary">开始：{formatChineseDateTime(stage.started_at)}</Typography.Text>}{stage.blocked_at && stage.status === 'blocked' && <Typography.Text type="danger">受阻：{formatChineseDateTime(stage.blocked_at)}</Typography.Text>}{stage.completed_at && <Typography.Text type="secondary">完成：{formatChineseDateTime(stage.completed_at)}</Typography.Text>}{stage.notes && <span className="project-record-note">{stage.notes}</span>}</div> },
        { title: '操作', key: 'actions', width: 176, render: (_, stage) => <Space><Button size="small" icon={<CalendarOutlined />} disabled={disabled} onClick={() => open(stage, 'schedule')}>计划</Button><Button size="small" type={stage === next || stage.status === 'blocked' ? 'primary' : 'default'} icon={<SwapOutlined />} disabled={disabled} onClick={() => open(stage, 'transition')}>状态</Button></Space> },
      ]} />
      {view === 'current' && upcoming.length > 1 && <div className="project-stage-upcoming"><Typography.Text type="secondary">后续待做</Typography.Text><Space wrap size={[8, 6]}>{upcoming.slice(1).map(stage => <Button key={stage.stage_code} type="text" size="small" onClick={() => setView('plan')}>{stageLabels[stage.stage_code] ?? stage.stage_code}</Button>)}</Space><Button type="link" size="small" onClick={() => setView('plan')}>查看完整计划</Button></div>}
    </Card>
    <Drawer forceRender open={Boolean(selection)} title={`${selection?.mode === 'schedule' ? '编辑计划' : '变更状态'} · ${stageLabels[selection?.stage.stage_code ?? ''] ?? ''}`} onClose={close} closable={!write.busy} mask={{ closable: !write.busy }} keyboard={!write.busy} size={480} footer={<Space><Button disabled={write.busy} onClick={close}>取消</Button><Button type="primary" onClick={() => form.submit()} loading={write.busy} disabled={readonly || write.locked}>保存</Button></Space>}>
      {write.notice}<Form form={form} layout="vertical" onFinish={save} onValuesChange={() => { dirty.current = true }} disabled={readonly || write.locked}>
        {selection?.mode === 'schedule' ? <><Form.Item label="计划开始" name="planned_start_on"><Input type="date" /></Form.Item><Form.Item label="计划结束" name="planned_end_on"><Input type="date" /></Form.Item><Form.Item label="计划说明" name="notes"><Input.TextArea rows={4} maxLength={5000} /></Form.Item></> : <><Alert style={{ marginBottom: 20 }} type="info" title={`当前状态：${selection ? statusLabels[selection.stage.status] : ''}`} description={selection?.stage.status_reason ?? undefined} /><Form.Item label="变更为" name="to_status" rules={[{ required: true }]}><Select options={(selection ? stageTransitions[selection.stage.status] : []).map(value => ({ value, label: statusLabels[value] }))} /></Form.Item><Form.Item label="原因" name="reason" rules={[{ required: Boolean(selection && target && stageReasonRequired(selection.stage.status, target)), whitespace: true, message: '请填写阻塞、跳过或重新打开阶段的原因' }]}><Input.TextArea rows={4} maxLength={5000} placeholder="说明阻塞、跳过或重新打开的具体原因" /></Form.Item><Typography.Text type="secondary">状态变更保留发生时间与原因，当前版本 R{selection?.stage.revision}。</Typography.Text></>}
      </Form>
    </Drawer>
  </Space>
}
