import { Alert, Button, Empty, Input, Segmented, Space, Tag } from 'antd'
import {
  ArrowRightOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Link } from 'react-router-dom'
import { requestJson } from '../api'
import type { GlobalDashboard } from '../domain/contracts'
import { formatMoney } from '../domain/formatters'
import { formatChineseDate } from '../domain/dates'
import {
  businessText,
  DataValue,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefreshButton,
  Section,
  stageLabels,
  useLoad,
  useWorkspaceTab,
  useWorkspaceValue,
} from './shared'
import { todoDestination } from './workflowLinks'
import styles from './Workspace.module.css'

export default function HomePage() {
  const dashboard = useLoad(
    () => requestJson<GlobalDashboard>('/api/dashboard'),
    [],
  )
  const [query, setQuery] = useWorkspaceValue('q', '')
  const [filter, setFilter] = useWorkspaceTab(
    'view',
    ['all', 'attention'],
    'all',
  )
  const data = dashboard.data
  const projectTodos = data?.todos.filter((todo) => todo.project_code) ?? []
  const projects = (data?.projects ?? []).filter(
    (row) =>
      `${row.project.name} ${row.project.project_code} ${row.project.company_name}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (filter === 'all' ||
        projectTodos.some(
          (todo) => todo.project_code === row.project.project_code,
        )),
  )
  return (
    <div className={styles.stack}>
      <PageHeader
        title="工作台"
        description="先看待办，再进入项目处理。"
        extra={
          <>
            <RefreshButton
              onClick={dashboard.reload}
              loading={dashboard.loading}
            />
            <Link to="/projects?create=1">
              <Button type="primary" icon={<PlusOutlined />}>
                新建项目
              </Button>
            </Link>
          </>
        }
      />
      <ErrorNotice error={dashboard.error} retry={dashboard.reload} />
      {!data && dashboard.loading && <LoadingBlock />}
      {data && (
        <>
          <div className={styles.metrics}>
            <DataValue
              label="进行中项目"
              value={`${data.summary.active_project_count} 个`}
              note={`${data.summary.upcoming_delivery_count} 个近期交付`}
            />
            <DataValue
              label="合同金额"
              value={formatMoney(data.summary.contracted_amount_cents)}
              note="已分配到项目的合同金额"
            />
            <DataValue
              label="已收款"
              value={formatMoney(data.summary.received_amount_cents)}
              note="实际到账"
            />
            <DataValue
              label="待收款"
              value={formatMoney(data.summary.outstanding_receivable_cents)}
              note={`${data.summary.overdue_receivable_count} 个节点逾期`}
            />
          </div>
          {projectTodos.length > 0 && (
            <Section title={`需要处理 · ${projectTodos.length} 项`}>
              <div className={styles.attentionList}>
                {projectTodos.map((todo, index) => (
                  <Link
                    className={styles.attentionItem}
                    key={`${todo.code}-${index}`}
                    to={todoDestination(todo)}
                  >
                    <span>
                      <strong>{businessText(todo.title)}</strong>
                      <small>
                        {todo.project_code} · {businessText(todo.description)}
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
          <Section
            title="项目一览"
            extra={
              <Link to="/projects">
                管理全部项目 <ArrowRightOutlined />
              </Link>
            }
          >
            <div className={styles.toolbar}>
              <Input
                aria-label="搜索工作台项目"
                prefix={<SearchOutlined />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                allowClear
                placeholder="项目名称、编号或客户"
                style={{ maxWidth: 340 }}
              />
              <Segmented
                aria-label="项目关注范围"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `全部 ${data.projects.length}` },
                  {
                    value: 'attention',
                    label: `有待办 ${new Set(projectTodos.map((item) => item.project_code)).size}`,
                  },
                ]}
              />
            </div>
            {projects.length ? (
              <ul className={styles.projectList}>
                {projects.map((row) => {
                  const base = `/projects/${encodeURIComponent(row.project.project_code)}`
                  const count = projectTodos.filter(
                    (item) => item.project_code === row.project.project_code,
                  ).length
                  return (
                    <li
                      key={row.project.project_code}
                      className={styles.projectRow}
                    >
                      <div className={styles.projectIdentity}>
                        <Link className={styles.projectName} to={base}>
                          {row.project.name}
                        </Link>
                        <span className={styles.subtle}>
                          {row.project.company_name}
                        </span>
                        <small>{row.project.project_code}</small>
                      </div>
                      <div className={styles.rowFact}>
                        <span>当前进度</span>
                        <strong>
                          {stageLabels[row.current_stage?.stage_code ?? ''] ??
                            '尚未开始'}
                        </strong>
                        {count > 0 && <Tag color="orange">{count} 项待办</Tag>}
                      </div>
                      <div className={styles.rowFact}>
                        <span>待收 / 合同金额</span>
                        <Link to={`${base}/commercial?section=receivables`}>
                          {formatMoney(row.outstanding_receivable_cents)}
                        </Link>
                        <small>
                          合同 {formatMoney(row.contracted_amount_cents)}
                        </small>
                      </div>
                      <div className={styles.rowFact}>
                        <span>交付 / 实际利润</span>
                        <strong>
                          {formatChineseDate(row.final_delivery_on)}
                        </strong>
                        <small>
                          利润 {formatMoney(row.actual_profit_cents)}
                        </small>
                      </div>
                      <Link
                        className={styles.rowEnter}
                        to={base}
                        aria-label={`进入${row.project.name}`}
                      >
                        <Button
                          icon={<ArrowRightOutlined />}
                          aria-label={`打开${row.project.name}`}
                        />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <Empty
                description={
                  query || filter !== 'all'
                    ? '没有符合条件的项目'
                    : '还没有项目'
                }
              >
                {query || filter !== 'all' ? (
                  <Button
                    onClick={() => {
                      setQuery('')
                      setFilter('all')
                    }}
                  >
                    清除筛选
                  </Button>
                ) : (
                  <Link to="/projects?create=1">
                    <Button type="primary">新建项目</Button>
                  </Link>
                )}
              </Empty>
            )}
          </Section>
          {!data.backup.healthy && (
            <Alert
              type="warning"
              showIcon
              title={businessText(data.backup.message) || '请检查备份设置'}
              action={
                <Link to="/settings">
                  <Button size="small">设置备份</Button>
                </Link>
              }
            />
          )}
        </>
      )}
    </div>
  )
}
