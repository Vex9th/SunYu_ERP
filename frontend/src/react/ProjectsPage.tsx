import { useEffect, useState } from 'react'
import {
  Button,
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
  PlusOutlined,
  SearchOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { createRetriablePostSender, requestJson } from '../api'
import type { CompanySummary, ProjectSummary } from '../types'
import { formatChineseDate } from '../domain/dates'
import {
  EntityEditor,
  ErrorNotice,
  nullable,
  PageHeader,
  RefreshButton,
  Section,
  StatusTag,
  useLoad,
  useWorkspaceTab,
  useWorkspaceValue,
} from './shared'
import styles from './Workspace.module.css'
const posts = createRetriablePostSender()

export default function ProjectsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useWorkspaceTab(
    'status',
    ['active', 'archived', 'all'],
    'active',
  )
  const [search, setSearch] = useWorkspaceValue('q', '')
  const [companyFilter, setCompanyFilter] = useWorkspaceValue('customer', '')
  const company = Number(companyFilter) || undefined
  const [pageValue, setPage] = useWorkspaceValue('page', '1')
  const [pageSizeValue, setPageSize] = useWorkspaceValue('pageSize', '10')
  const pageSize = [10, 20, 50].includes(Number(pageSizeValue))
    ? Number(pageSizeValue)
    : 10
  const [creating, setCreating] = useState(params.get('create') === '1')
  const projects = useLoad(
    () => requestJson<ProjectSummary[]>(`/api/projects?status=${status}`),
    [status],
  )
  const companies = useLoad(
    () => requestJson<CompanySummary[]>('/api/companies'),
    [],
  )
  useEffect(() => {
    if (params.get('create') === '1') setCreating(true)
  }, [params])
  const filtered = (projects.data ?? []).filter(
    (project) =>
      (!company || project.company_id === company) &&
      `${project.name} ${project.project_code} ${project.company_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  return (
    <div className={styles.stack}>
      <PageHeader
        eyebrow="PROJECTS / 项目管理"
        title="项目中心"
        description="从立项到交付，管理每一个项目的完整过程。"
        extra={
          <>
            <RefreshButton
              onClick={projects.reload}
              loading={projects.loading}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              新建项目
            </Button>
          </>
        }
      />
      <ErrorNotice error={projects.error} retry={projects.reload} />
      <ErrorNotice error={companies.error} retry={companies.reload} />
      <Section>
        <Tabs
          activeKey={status}
          onChange={(value) => {
            setStatus(value)
            setPage('1')
          }}
          items={[
            { key: 'active', label: '进行中' },
            { key: 'archived', label: '已归档' },
            { key: 'all', label: '全部项目' },
          ]}
        />
        <div className={styles.toolbar}>
          <Space wrap>
            <Input
              prefix={<SearchOutlined />}
              value={search}
              allowClear
              onChange={(event) => {
                setSearch(event.target.value)
                setPage('1')
              }}
              placeholder="搜索项目名称、编号或客户"
              aria-label="搜索项目"
              style={{ width: 290 }}
            />
            <Select
              placeholder="全部客户"
              allowClear
              value={company}
              onChange={(value) => {
                setCompanyFilter(value ? String(value) : '')
                setPage('1')
              }}
              aria-label="筛选客户公司"
              showSearch
              optionFilterProp="label"
              style={{ width: 200 }}
              options={companies.data?.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            />
          </Space>
          <span className={styles.subtle}>{filtered.length} 个项目</span>
        </div>
        <Table<ProjectSummary>
          size="middle"
          rowKey="project_code"
          dataSource={filtered}
          loading={projects.loading}
          scroll={{ x: 640 }}
          pagination={{
            current: Math.max(
              1,
              Math.min(
                Number(pageValue) || 1,
                Math.ceil(filtered.length / pageSize) || 1,
              ),
            ),
            pageSize,
            pageSizeOptions: [10, 20, 50],
            onChange: (page, size) => {
              setPage(String(size === pageSize ? page : 1))
              setPageSize(String(size))
            },
            showSizeChanger: true,
            hideOnSinglePage: true,
          }}
          locale={{
            emptyText: (
              <Empty
                description={
                  search || company ? '没有符合筛选条件的项目' : '当前没有项目'
                }
              >
                {search || company ? (
                  <Button
                    onClick={() => {
                      setSearch('')
                      setCompanyFilter('')
                      setPage('1')
                    }}
                  >
                    清除筛选
                  </Button>
                ) : status === 'archived' ? (
                  <Button onClick={() => setStatus('active')}>
                    查看进行中项目
                  </Button>
                ) : (
                  <Button type="primary" onClick={() => setCreating(true)}>
                    新建项目
                  </Button>
                )}
              </Empty>
            ),
          }}
          columns={[
            {
              title: '项目名称',
              key: 'project',
              width: 280,
              render: (_, row) => (
                <>
                  <Link
                    className={styles.projectName}
                    to={`/projects/${encodeURIComponent(row.project_code)}`}
                  >
                    {row.name}
                  </Link>
                  <div className={styles.subtle}>
                    {row.project_code} · {row.company_name}
                  </div>
                  {row.description && (
                    <span className={styles.subtle}>
                      {row.description.slice(0, 35)}
                    </span>
                  )}
                </>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (value: string) => <StatusTag value={value} />,
            },
            {
              title: '创建日期',
              dataIndex: 'created_at',
              render: formatChineseDate,
            },
            {
              title: '操作',
              key: 'actions',
              width: 110,
              fixed: 'right',
              render: (_, row) => (
                <Link to={`/projects/${encodeURIComponent(row.project_code)}`}>
                  <Button
                    type="link"
                    icon={<ArrowRightOutlined />}
                    iconPlacement="end"
                  >
                    进入项目
                  </Button>
                </Link>
              ),
            },
          ]}
        />
      </Section>
      {creating && (
        <EntityEditor
          title="新建项目"
          cacheKey="create-project"
          initialValues={{
            project_code: '',
            name: '',
            company_id: undefined as number | undefined,
            description: '',
          }}
          onClose={() => {
            setCreating(false)
            if (params.has('create')) {
              const next = new URLSearchParams(params)
              next.delete('create')
              setParams(next, { replace: true })
            }
          }}
          onSubmit={async (values) => {
            return posts.send<ProjectSummary>('/api/projects', {
              project_code: values.project_code.trim(),
              name: values.name.trim(),
              company_id: values.company_id,
              description: nullable(values.description),
            })
          }}
          onSaved={(result) =>
            navigate(
              `/projects/${encodeURIComponent((result as ProjectSummary).project_code)}`,
            )
          }
        >
          <Form.Item
            name="project_code"
            label="项目编号"
            extra="创建后不可更改，用于关联项目文件与业务记录。"
            rules={[
              { required: true, whitespace: true, message: '请输入项目编号' },
              {
                pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
                message: '请使用英文字母、数字、短横线或下划线',
              },
            ]}
          >
            <Input placeholder="例如 SY-2026-001" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, whitespace: true, message: '请输入项目名称' },
            ]}
          >
            <Input placeholder="例如 自动化装配线改造" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="company_id"
            label="客户公司"
            rules={[{ required: true, message: '请选择客户公司' }]}
            extra={
              !companies.data?.length && (
                <Link to="/companies">先添加客户公司</Link>
              )
            }
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择客户公司"
              loading={companies.loading}
              options={companies.data?.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="description" label="项目说明">
            <Input.TextArea
              rows={4}
              placeholder="项目目标、交付范围或其他需要记录的信息"
            />
          </Form.Item>
        </EntityEditor>
      )}
    </div>
  )
}
