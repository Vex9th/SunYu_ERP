import { useAccess } from './access/AccessProvider'
import { ActivitySummary } from './activity/ActivitySummary'
import { OperationHistory } from './activity/OperationHistory'
import { RouterButton } from './RouterButton'
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
  projectCategoryLabels,
  projectStageLabel,
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
  const { can } = useAccess()
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
    () => can('companies.view') ? requestJson<CompanySummary[]>('/api/companies') : Promise.resolve([]),
    [],
  )
  const [action, setAction] = useState<'edit' | 'close' | 'restore' | null>(
    null,
  )
  const data = dashboard.data
  const readonly = data?.project.status === 'archived'
  const base = `/projects/${encodeURIComponent(projectCode)}`
  const tabPermissions: Record<string, string[]> = { '': ['projects.view'], stages: ['project_stages.view'], documents: ['documents.view'], commercial: ['quotes.view', 'contracts.view', 'customer_receipts.view'], procurement: ['procurement.lines.view', 'procurement.orders.view'], workforce: ['workforce.view', 'dispatches.view', 'site_reports.view', 'material_advances.view'], delivery: ['documents.view', 'engineering_changes.view', 'acceptance.view', 'warranty.view', 'after_sales.view', 'customer_invoices.view'] }
  const allowedTab = (key: string) => tabPermissions[key]?.some(permission => can(permission, data?.project.id)) ?? false
  return (
    <div className={styles.stack}>
      <ErrorNotice error={dashboard.error} retry={dashboard.reload} />
      {!data && dashboard.loading && <LoadingBlock />}
      {data && can('projects.view', data.project.id) && (
        <>
          <section className={styles.projectContext}>
            <div className={styles.toolbar}>
              <div className={styles.projectHeader}>
                <RouterButton to="/projects" type="text" icon={<ArrowLeftOutlined />} aria-label="返回项目中心" />
                <span className={styles.projectAvatar}>
                  <FolderOpenOutlined />
                </span>
                <div>
                  <div className={styles.projectTitle}>
                    <h1>{data.project.name}</h1>
                    <Tag>{projectCategoryLabels[data.project.project_category ?? 'standard']}</Tag>
                    <StatusTag value={data.project.status} />
                  </div>
                  <div className={styles.projectMeta}>
                    <span>{data.project.project_code}</span>
                    <span>{data.project.company_name}</span>
                    <span>
                      创建于 {formatChineseDateTime(data.project.created_at)}
                    </span>
                  </div>
                </div>
              </div>
              <Space wrap>
                <OperationHistory resourceType="project" resourceId={data.project.id} />
                <ActivitySummary summary={data.project.activity_summary} />
                <RefreshButton
                  label="刷新概况"
                  loading={dashboard.loading}
                  onClick={dashboard.reload}
                />
                {!readonly && can('projects.edit', data.project.id) && (
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => setAction('edit')}
                  >
                    编辑项目
                  </Button>
                )}
                {readonly && can('projects.restore', data.project.id) ? (
                  <Button
                    icon={<UndoOutlined />}
                    onClick={() => setAction('restore')}
                  >
                    恢复项目
                  </Button>
                ) : !readonly && can('projects.close', data.project.id) && (
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
              items={tabs.filter(tab => allowedTab(tab.key))}
            />
          </section>
          <Suspense fallback={<LoadingBlock />}>
            {!allowedTab(activeTab) && <Alert type="warning" showIcon title="无权查看此模块，请联系主账号调整工作组权限" />}
            {activeTab === '' && <ProjectOverview data={data} />}
            {activeTab === 'stages' && allowedTab('stages') && (
              <ProjectStages projectId={data.project.id} projectCode={projectCode} category={data.project.project_category} readonly={readonly} />
            )}
            {activeTab === 'documents' && allowedTab('documents') && (
              <ProjectDocuments projectCode={projectCode} readonly={readonly} />
            )}
            {activeTab === 'commercial' && allowedTab('commercial') && (
              <ProjectCommercial
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'procurement' && allowedTab('procurement') && (
              <ProcurementWorkspace
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'workforce' && allowedTab('workforce') && (
              <WorkforceWorkspace
                projectCode={projectCode}
                readonly={readonly}
              />
            )}
            {activeTab === 'delivery' && allowedTab('delivery') && (
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
                          {data.project.project_category === 'trade'
                            ? `签收阶段：${data.completion_check.final_acceptance_ready ? '已完成 / 跳过' : '未完成'}`
                            : `最终验收：${data.completion_check.final_acceptance_ready ? '已通过' : '未通过'}`}
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
                          description={data.project.project_category === 'trade'
                            ? '五个项目阶段（含签收）和应收款均处理完成后，才能以完工方式关闭。'
                            : '项目阶段、最终验收和应收款均处理完成后，才能以完工方式关闭。'}
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
  const { can } = useAccess()
  const money = (value: number | null | undefined, permission: string) => can(permission, data.project.id) ? formatMoney(value ?? null) : '无权限'
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
      {can('project_stages.view', data.project.id) && <div className={styles.currentProgress}>
        <div>
          <span className={styles.subtle}>
            {archived ? '归档项目' : '当前阶段'} · {complete} /{' '}
            {data.stages.length} 已完成
          </span>
          <h2>
            {current
              ? projectStageLabel(current.stage_code, data.project.project_category)
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
        <RouterButton disabled={!can('project_stages.view')} to={`${base}/stages`} type="primary" icon={<ArrowRightOutlined />}>
          {archived
            ? '查看阶段记录'
            : current?.status === 'blocked'
              ? '处理阶段阻塞'
              : '查看并更新进度'}
        </RouterButton>
      </div>}
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
                    {businessText(todo.description, data.project.project_category)}
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
            permission: 'procurement.lines.view',
            to: 'procurement?section=lists',
            title: '采购与到货',
            note: '物料清单、采购单、付款',
          },
          {
            permission: 'workforce.view',
            to: 'workforce?section=labor',
            title: '施工与上工',
            note: '人员安排、每日上工记录',
          },
          {
            permission: 'customer_receipts.view',
            to: 'commercial?section=receivables',
            title: '合同与收款',
            note: '收款计划、实际到账',
          },
          {
            permission: 'acceptance.view',
            to: 'delivery?section=acceptance',
            title: '验收与售后',
            note: '交付记录、发票、质保',
          },
        ].filter(item => can(item.permission, data.project.id)).map((item) => (
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
          value={money(data.profit?.contracted_amount_cents, 'contracts.view')}
          note={`已到账 ${money(data.receivables.received_amount_cents, 'customer_receipts.view')}`}
        />
        <DataValue
          label="待收款"
          value={
            can('customer_receipts.view', data.project.id) ? <Link to={`${base}/commercial?section=receivables`}>
              {money(data.receivables.outstanding_receivable_cents, 'customer_receipts.view')}
            </Link> : '无权限'
          }
        />
        <DataValue
          label="实际成本"
          value={money(data.costs.total_cents, 'sensitive.profit_summary')}
          note={
            can('sensitive.profit_summary', data.project.id) ? (data.costs.completeness === 'complete'
              ? '成本记录完整'
              : '部分成本尚未记录') : undefined
          }
        />
        <DataValue
          label="实际利润"
          value={money(data.profit?.actual_profit_cents, 'sensitive.profit_summary')}
          note={can('sensitive.profit_summary') ? `利润率 ${formatBasisPoints(data.profit?.margin_basis_points)}` : undefined}
        />
      </div>
      {can('sensitive.profit_summary', data.project.id) && <Section title="成本明细">
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
      </Section>}
      <Section
        title="项目资料与联系信息"
        extra={
          can('documents.view') && <Link to={`${base}/documents`}>
            查看 {data.documents.document_count} 份文件 <ArrowRightOutlined />
          </Link>
        }
      >
        <p style={{ marginTop: 0 }}>
          {data.project.description || '尚未填写项目说明，可在上方编辑项目。'}
        </p>
        {!can('companies.view') || !data.company ? <span className={styles.subtle}>无权查看客户公司与联系人</span> : data.contacts.length ? (
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
        {can('companies.view') && data.company && <Collapse
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
                      children: can('sensitive.company_banking') ? data.company.bank_name || '—' : '无权限',
                    },
                    {
                      key: 'account',
                      label: '银行账号',
                      children: can('sensitive.company_banking') ? data.company.bank_account || '—' : '无权限',
                    },
                  ]}
                />
              ),
            },
          ]}
        />}
      </Section>
    </div>
  )
}
