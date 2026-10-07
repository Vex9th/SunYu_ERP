import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Collapse,
  Dropdown,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd'
import {
  ArrowLeftOutlined,
  EditOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  UndoOutlined,
  MoreOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiError, requestJson } from '../api'
import type { CompanySummary } from '../types'
import type { ProjectDashboard } from '../domain/contracts'
import { formatMoney, formatBasisPoints } from '../domain/formatters'
import { formatChineseDate, formatChineseDateTime } from '../domain/dates'
import { createHttpProjectOperatingRepository } from '../repositories/project-operating.live'
import {
  businessText,
  DataValue,
  EntityEditor,
  ErrorNotice,
  LoadingBlock,
  nullable,
  RefreshButton,
  Section,
  StatusTag,
  stageLabels,
  useLoad,
} from './shared'
import styles from './Workspace.module.css'
import { todoDestination } from './workflowLinks'

const ProjectStages = lazy(() => import('./project/ProjectStages'))
const ProjectDocuments = lazy(() => import('./project/ProjectDocuments'))
const ProjectCommercial = lazy(() => import('./project/ProjectCommercial'))
const ProcurementWorkspace = lazy(
  () => import('./procurement/ProcurementWorkspace'),
)
const WorkforceWorkspace = lazy(() => import('./workforce/WorkforceWorkspace'))
const DeliveryWorkspace = lazy(() => import('./delivery/DeliveryWorkspace'))
const repository = createHttpProjectOperatingRepository()
const tabs = [
  { key: '', label: '项目概览' },
  { key: 'stages', label: '阶段计划' },
  { key: 'documents', label: '资料文件' },
  { key: 'commercial', label: '报价与收款' },
  { key: 'procurement', label: '采购管理' },
  { key: 'workforce', label: '人员与施工' },
  { key: 'delivery', label: '交付与售后' },
]

export default function ProjectPage() {
  const { projectCode = '' } = useParams()
  return <ProjectWorkspace key={projectCode} projectCode={projectCode} />
}

function ProjectWorkspace({ projectCode }: { projectCode: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const activeTab = location.pathname.split('/')[3] ?? ''
  const dashboard = useLoad(
    () => repository.getProjectDashboard(projectCode),
    [projectCode, activeTab],
  )
  useEffect(() => {
    const refresh = (event: Event) => {
      if (
        (event as CustomEvent<{ projectCode: string }>).detail?.projectCode ===
        projectCode
      )
        void dashboard.reload()
    }
    window.addEventListener('project-data-changed', refresh)
    return () => window.removeEventListener('project-data-changed', refresh)
  }, [projectCode, dashboard.reload])
  const companies = useLoad(
    () => requestJson<CompanySummary[]>('/api/companies'),
    [],
  )
  const [action, setAction] = useState<'edit' | 'close' | 'restore' | null>(
    null,
  )
  const data = dashboard.data
  const readonly = data?.project.status === 'archived'
  const base = `/projects/${encodeURIComponent(projectCode)}`
  return (
    <div className={styles.stack}>
      <ErrorNotice error={dashboard.error} retry={dashboard.reload} />
      {!data && dashboard.loading && <LoadingBlock />}
      {data && (
        <>
          <section className={styles.projectContext}>
            <div className={styles.toolbar}>
              <div className={styles.projectHeader}>
                <Link to="/projects" aria-label="返回项目中心">
                  <Button
                    type="text"
                    icon={<ArrowLeftOutlined />}
                    aria-label="返回项目中心"
                  />
                </Link>
                <span className={styles.projectAvatar}>
                  <FolderOpenOutlined />
                </span>
                <div>
                  <div className={styles.projectTitle}>
                    <h1>{data.project.name}</h1>
                    <StatusTag value={data.project.status} />
                  </div>
                  <div className={styles.projectMeta}>
                    <span>{data.project.project_code}</span>
                    <span>{data.company.name}</span>
                    <span>
                      创建于 {formatChineseDateTime(data.project.created_at)}
                    </span>
                  </div>
                </div>
              </div>
              <Space wrap>
                <RefreshButton
                  loading={dashboard.loading}
                  onClick={dashboard.reload}
                />
                {!readonly && (
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => setAction('edit')}
                  >
                    编辑项目
                  </Button>
                )}
                {readonly ? (
                  <Button
                    icon={<UndoOutlined />}
                    onClick={() => setAction('restore')}
                  >
                    恢复项目
                  </Button>
                ) : (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'close', label: '关闭项目', danger: true },
                      ],
                      onClick: () => setAction('close'),
                    }}
                  >
                    <Button icon={<MoreOutlined />} aria-label="更多项目操作">
                      更多
                    </Button>
                  </Dropdown>
                )}
              </Space>
            </div>
            {readonly && (
              <Alert
                type="info"
                showIcon
                title="项目已归档，业务记录只读"
                description={data.project.archive_reason}
                style={{ marginBottom: 18 }}
              />
            )}
            <Tabs
              className={styles.projectTabs}
              activeKey={activeTab}
              onChange={(key) => navigate(key ? `${base}/${key}` : base)}
              items={tabs}
            />
          </section>
          <Suspense fallback={<LoadingBlock />}>
            {activeTab === '' && <ProjectOverview data={data} />}
            {activeTab === 'stages' && (
              <ProjectStages projectCode={projectCode} readonly={readonly} />
            )}
            {activeTab === 'documents' && (
              <ProjectDocuments projectCode={projectCode} readonly={readonly} />
            )}
            {activeTab === 'commercial' && (
              <ProjectCommercial
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'procurement' && (
              <ProcurementWorkspace
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'workforce' && (
              <WorkforceWorkspace
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'delivery' && (
              <DeliveryWorkspace
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
          </Suspense>
          {action && (
            <EntityEditor
          recordRevision={data.project.revision}
              key={action}
              title={
                {
                  edit: '编辑项目',
                  close: '关闭并归档项目',
                  restore: '恢复项目',
                }[action]
              }
              cacheKey={`project:${projectCode}:${action}`}
              initialValues={{
                name: data.project.name,
                company_id: data.project.company_id,
                description: data.project.description ?? '',
                closure_type: undefined as
                  'cancelled' | 'completed' | undefined,
                reason: '',
              }}
              onClose={() => setAction(null)}
              onSubmit={async (values) => {
                try {
                  if (action === 'edit')
                    await repository.updateProject(projectCode, {
                      name: values.name.trim(),
                      company_id: values.company_id,
                      description: nullable(values.description),
                      expected_revision: data.project.revision,
                    })
                  if (action === 'close')
                    await repository.closeProject(projectCode, {
                      closure_type: values.closure_type!,
                      reason: values.reason.trim(),
                      expected_revision: data.project.revision,
                    })
                  if (action === 'restore')
                    await repository.restoreProject(projectCode, {
                      reason: values.reason.trim(),
                      expected_revision: data.project.revision,
                    })
                } catch (cause) {
                  if (
                    cause instanceof ApiError &&
                    (cause.status === 409 || cause.status === 422)
                  )
                    await dashboard.reload()
                  throw cause
                }
              }}
              onSaved={dashboard.reload}
            >
              {action === 'edit' ? (
                <>
                  <ErrorNotice
                    error={companies.error}
                    retry={companies.reload}
                  />
                  <Form.Item
                    name="name"
                    label="项目名称"
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        message: '请输入项目名称',
                      },
                    ]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="company_id"
                    label="客户公司"
                    rules={[{ required: true, message: '请选择客户公司' }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={companies.data?.map((company) => ({
                        value: company.id,
                        label: company.name,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item name="description" label="项目说明">
                    <Input.TextArea rows={4} />
                  </Form.Item>
                </>
              ) : (
                <>
                  {action === 'close' && (
                    <>
                      <Form.Item
                        name="closure_type"
                        label="关闭类型"
                        rules={[{ required: true, message: '请选择关闭类型' }]}
                      >
                        <Select
                          placeholder="明确选择项目完成或取消"
                          options={[
                            { value: 'cancelled', label: '项目取消' },
                            {
                              value: 'completed',
                              label: '项目完成',
                              disabled: !data.completion_check?.ready,
                            },
                          ]}
                        />
                      </Form.Item>
                      <Space wrap style={{ marginBottom: 16 }}>
                        <Tag
                          color={
                            data.completion_check.stages_ready
                              ? 'green'
                              : 'orange'
                          }
                        >
                          项目阶段：
                          {data.completion_check.stages_ready
                            ? '已完成'
                            : '未完成'}
                        </Tag>
                        <Tag
                          color={
                            data.completion_check.final_acceptance_ready
                              ? 'green'
                              : 'orange'
                          }
                        >
                          最终验收：
                          {data.completion_check.final_acceptance_ready
                            ? '已通过'
                            : '未通过'}
                        </Tag>
                        <Tag
                          color={
                            data.completion_check.receivables_ready
                              ? 'green'
                              : 'orange'
                          }
                        >
                          应收款：
                          {data.completion_check.receivables_ready
                            ? '已结清'
                            : '未结清'}
                        </Tag>
                      </Space>
                      {!data.completion_check?.ready && (
                        <Alert
                          type="warning"
                          title="暂不满足完工条件"
                          description="项目阶段、最终验收和应收款均处理完成后，才能以完工方式关闭。"
                          style={{ marginBottom: 18 }}
                        />
                      )}
                    </>
                  )}
                  <Form.Item
                    name="reason"
                    label={action === 'close' ? '关闭原因' : '恢复原因'}
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        message: '请填写原因',
                      },
                    ]}
                  >
                    <Input.TextArea rows={4} />
                  </Form.Item>
                </>
              )}
            </EntityEditor>
          )}
        </>
      )}
    </div>
  )
}

function ProjectOverview({ data }: { data: ProjectDashboard }) {
  const base = `/projects/${encodeURIComponent(data.project.project_code)}`
  const remaining = data.stages.filter(
    (stage) => !['completed', 'skipped'].includes(stage.status),
  )
  const current =
    remaining.find((stage) =>
      ['in_progress', 'blocked'].includes(stage.status),
    ) ?? remaining[0]
  const complete = data.stages.length - remaining.length
  const archived = data.project.status === 'archived'
  return (
    <div className={styles.stack}>
      <div className={styles.currentProgress}>
        <div>
          <span className={styles.subtle}>
            {archived ? '归档项目' : '当前阶段'} · {complete} /{' '}
            {data.stages.length} 已完成
          </span>
          <h2>
            {current
              ? (stageLabels[current.stage_code] ?? current.stage_code)
              : '全部阶段已完成'}
          </h2>
          <p>
            {current?.status === 'blocked'
              ? current.status_reason || '当前阶段受阻，请核对原因'
              : current?.planned_end_on
                ? `计划完成 ${formatChineseDate(current.planned_end_on)}`
                : '查看阶段计划，安排接下来的工作'}
          </p>
        </div>
        <Link to={`${base}/stages`}>
          <Button type="primary" icon={<ArrowRightOutlined />}>
            {archived
              ? '查看阶段记录'
              : current?.status === 'blocked'
                ? '处理阶段阻塞'
                : '查看并更新进度'}
          </Button>
        </Link>
      </div>
      {data.todos.length > 0 && (
        <Section title={`项目待办 · ${data.todos.length} 项`}>
          <div className={styles.attentionList}>
            {data.todos.map((todo, index) => (
              <Link
                className={styles.attentionItem}
                to={todoDestination(todo)}
                key={`${todo.code}-${index}`}
              >
                <span>
                  <strong>{businessText(todo.title)}</strong>
                  <small>
                    {businessText(todo.description)}
                    {todo.due_on
                      ? ` · 截止 ${formatChineseDate(todo.due_on)}`
                      : ''}
                  </small>
                </span>
                <ArrowRightOutlined />
              </Link>
            ))}
          </div>
        </Section>
      )}
      <div className={styles.taskGrid}>
        {[
          {
            to: 'procurement?section=lists',
            title: '采购与到货',
            note: '物料清单、采购单、付款',
          },
          {
            to: 'workforce?section=labor',
            title: '施工与上工',
            note: '人员安排、每日上工记录',
          },
          {
            to: 'commercial?section=receivables',
            title: '合同与收款',
            note: '收款计划、实际到账',
          },
          {
            to: 'delivery?section=acceptance',
            title: '验收与售后',
            note: '交付记录、发票、质保',
          },
        ].map((item) => (
          <Link
            key={item.to}
            className={styles.taskLink}
            to={`${base}/${item.to}`}
          >
            <span>
              <strong>{item.title}</strong>
              <small>{item.note}</small>
            </span>
            <ArrowRightOutlined />
          </Link>
        ))}
      </div>
      <div className={styles.metrics}>
        <DataValue
          label="合同金额"
          value={formatMoney(data.profit.contracted_amount_cents)}
          note={`已到账 ${formatMoney(data.receivables.received_amount_cents)}`}
        />
        <DataValue
          label="待收款"
          value={
            <Link to={`${base}/commercial?section=receivables`}>
              {formatMoney(data.receivables.outstanding_receivable_cents)}
            </Link>
          }
        />
        <DataValue
          label="实际成本"
          value={formatMoney(data.costs.total_cents)}
          note={
            data.costs.completeness === 'complete'
              ? '成本记录完整'
              : '部分成本尚未记录'
          }
        />
        <DataValue
          label="实际利润"
          value={formatMoney(data.profit.actual_profit_cents)}
          note={`利润率 ${formatBasisPoints(data.profit.margin_basis_points)}`}
        />
      </div>
      <Section title="成本明细">
        <Descriptions
          column={{ xs: 1, sm: 2, xl: 3 }}
          items={[
            {
              key: 'material',
              label: '材料领用',
              children: formatMoney(data.costs.material_consumed_cents),
            },
            {
              key: 'labor',
              label: '人员成本',
              children: formatMoney(data.costs.labor_cents),
            },
            {
              key: 'field',
              label: '现场材料',
              children: formatMoney(data.costs.field_material_cents),
            },
            {
              key: 'ordered',
              label: '采购承诺金额',
              children: formatMoney(data.costs.procurement_committed_cents),
            },
            {
              key: 'received',
              label: '采购到货金额',
              children: formatMoney(data.costs.procurement_received_cents),
            },
            {
              key: 'paid',
              label: '采购已付款',
              children: formatMoney(data.costs.procurement_paid_cents),
            },
          ]}
        />
      </Section>
      <Section
        title="项目资料与联系信息"
        extra={
          <Link to={`${base}/documents`}>
            查看 {data.documents.document_count} 份文件 <ArrowRightOutlined />
          </Link>
        }
      >
        <p style={{ marginTop: 0 }}>
          {data.project.description || '尚未填写项目说明，可在上方编辑项目。'}
        </p>
        {data.contacts.length ? (
          <div className={styles.contactList}>
            {data.contacts.map((contact) => (
              <div className={styles.contactItem} key={contact.id}>
                <strong>
                  {contact.name} <small>{contact.position}</small>
                </strong>
                {contact.phone && (
                  <a href={`tel:${contact.phone}`}>{contact.phone}</a>
                )}
                {contact.email && (
                  <a href={`mailto:${contact.email}`}>{contact.email}</a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Space>
            <span className={styles.subtle}>尚未登记项目联系人</span>
            <Link to={`/companies?company=${data.company.id}`}>
              到客户公司添加
            </Link>
          </Space>
        )}
        <Collapse
          ghost
          style={{ marginTop: 14 }}
          items={[
            {
              key: 'invoice',
              label: `客户开票资料 · ${data.company.name}`,
              children: (
                <Descriptions
                  column={{ xs: 1, sm: 2 }}
                  items={[
                    {
                      key: 'name',
                      label: '公司名称',
                      children: data.company.name,
                    },
                    {
                      key: 'tax',
                      label: '纳税人识别号',
                      children: data.company.taxpayer_id || '—',
                    },
                    {
                      key: 'address',
                      label: '注册地址',
                      children: data.company.registered_address || '—',
                    },
                    {
                      key: 'phone',
                      label: '公司电话',
                      children: data.company.registered_phone || '—',
                    },
                    {
                      key: 'bank',
                      label: '开户银行',
                      children: data.company.bank_name || '—',
                    },
                    {
                      key: 'account',
                      label: '银行账号',
                      children: data.company.bank_account || '—',
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Section>
    </div>
  )
}
