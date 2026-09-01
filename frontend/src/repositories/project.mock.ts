import type {
  DocumentDetail,
  GlobalDashboard,
  PagedResult,
  ProjectDetail,
  ProjectOperatingSnapshot,
  ProjectStage,
  ProjectStageStatus,
} from '../domain/contracts'
import type { RepositoryResult } from './common'
import type { ProjectOperatingRepository, StageScheduleInput, StageTransitionInput } from './project'

const allowedStageTransitions: Record<ProjectStageStatus, ProjectStageStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['blocked', 'completed', 'skipped'],
  blocked: ['in_progress', 'skipped'],
  completed: ['in_progress'],
  skipped: ['in_progress'],
}

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class MockProjectRepository implements ProjectOperatingRepository {
  readonly source = 'demo' as const
  private readonly snapshots = new Map<string, ProjectOperatingSnapshot>()
  private readonly documentLedgers = new Map<string, PagedResult<DocumentDetail>>()
  private readonly projects = new Map<string, ProjectDetail>()

  async openProject(record: ProjectDetail): Promise<RepositoryResult<ProjectDetail>> {
    const stored = cloneData(record)
    this.projects.set(record.project_code, stored)
    return { source: this.source, data: cloneData(stored) }
  }

  async updateProject(
    projectCode: string,
    input: { company_id: number; name: string; description: string | null; expected_revision: number },
  ): Promise<RepositoryResult<ProjectDetail>> {
    const project = this.findProject(projectCode)
    this.assertProjectRevision(project, input.expected_revision)
    const name = input.name.trim()
    if (!name) throw new Error('请填写项目名称')
    Object.assign(project, {
      company_id: input.company_id,
      name,
      description: input.description,
      revision: project.revision + 1,
      updated_at: new Date().toISOString(),
    })
    return { source: this.source, data: cloneData(project) }
  }

  async closeProject(
    projectCode: string,
    input: { closure_type: ProjectDetail['closure_type']; reason: string; expected_revision: number },
  ): Promise<RepositoryResult<ProjectDetail>> {
    const project = this.findProject(projectCode)
    this.assertProjectRevision(project, input.expected_revision)
    if (project.status !== 'active') throw new Error('项目已经完结')
    if (!input.closure_type || !input.reason.trim()) throw new Error('请选择完结类型并填写原因')
    const closedAt = new Date().toISOString()
    Object.assign(project, {
      status: 'archived' as const,
      closure_type: input.closure_type,
      archive_reason: input.reason.trim(),
      archived_at: closedAt,
      revision: project.revision + 1,
      updated_at: closedAt,
    })
    return { source: this.source, data: cloneData(project) }
  }

  async getOperatingSnapshot(projectCode: string): Promise<RepositoryResult<ProjectOperatingSnapshot>> {
    const snapshot = this.ensureSnapshot(projectCode)
    return { source: this.source, data: cloneData(snapshot) }
  }

  async getGlobalDashboard(): Promise<RepositoryResult<GlobalDashboard>> {
    return { source: this.source, data: createGlobalDashboard() }
  }

  async getDocumentLedger(
    projectCode: string,
  ): Promise<RepositoryResult<PagedResult<DocumentDetail>>> {
    const ledger = this.documentLedgers.get(projectCode) ?? createDocumentLedger(projectCode)
    this.documentLedgers.set(projectCode, ledger)
    return { source: this.source, data: cloneData(ledger) }
  }

  async updateStageSchedule(
    projectCode: string,
    stageCode: string,
    input: StageScheduleInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const stage = this.findStage(projectCode, stageCode)
    this.assertRevision(stage, input.expected_revision)
    if (input.planned_start_on && input.planned_end_on && input.planned_start_on > input.planned_end_on) {
      throw new Error('计划开始日期不能晚于计划完成日期')
    }
    Object.assign(stage, {
      planned_start_on: input.planned_start_on,
      planned_end_on: input.planned_end_on,
      notes: input.notes,
      revision: stage.revision + 1,
    })
    return { source: this.source, data: cloneData(stage) }
  }

  async transitionStage(
    projectCode: string,
    stageCode: string,
    input: StageTransitionInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const stage = this.findStage(projectCode, stageCode)
    this.assertRevision(stage, input.expected_revision)
    if (!allowedStageTransitions[stage.status].includes(input.to_status)) {
      throw new Error('当前阶段不允许流转到该状态')
    }
    const reasonRequired = input.to_status === 'blocked'
      || input.to_status === 'skipped'
      || ((stage.status === 'completed' || stage.status === 'skipped') && input.to_status === 'in_progress')
    if (reasonRequired && !input.reason?.trim()) throw new Error('此状态流转必须填写原因')

    stage.status = input.to_status
    stage.status_reason = input.reason?.trim() || null
    if (input.to_status === 'in_progress') {
      stage.started_at = input.occurred_at
      stage.blocked_at = null
      stage.completed_at = null
    } else if (input.to_status === 'blocked') {
      stage.blocked_at = input.occurred_at
      stage.completed_at = null
    } else if (input.to_status === 'completed') {
      stage.completed_at = input.occurred_at
      stage.blocked_at = null
    } else if (input.to_status === 'skipped') {
      stage.completed_at = input.occurred_at
      stage.blocked_at = null
    }
    stage.revision += 1
    return { source: this.source, data: cloneData(stage) }
  }

  private ensureSnapshot(projectCode: string): ProjectOperatingSnapshot {
    const snapshot = this.snapshots.get(projectCode) ?? createOperatingSnapshot(projectCode)
    this.snapshots.set(projectCode, snapshot)
    return snapshot
  }

  private findStage(projectCode: string, stageCode: string): ProjectStage {
    const stage = this.ensureSnapshot(projectCode).stages.find((item) => item.stage_code === stageCode)
    if (!stage) throw new Error('未找到项目阶段')
    return stage
  }

  private assertRevision(stage: ProjectStage, expectedRevision: number): void {
    if (stage.revision !== expectedRevision) throw new Error('记录已更新，请刷新后重试')
  }

  private findProject(projectCode: string): ProjectDetail {
    const project = this.projects.get(projectCode)
    if (!project) throw new Error('未找到演示项目')
    return project
  }

  private assertProjectRevision(project: ProjectDetail, expectedRevision: number): void {
    if (project.revision !== expectedRevision) throw new Error('项目已更新，请刷新后重试')
  }
}

function createProjectDetail(projectCode: string): ProjectDetail {
  return {
    id: 21,
    project_code: projectCode,
    company_id: 1,
    company_name: '演示客户单位',
    name: '自动化装配线改造',
    description: '装配线节拍与电气控制系统升级',
    status: 'active',
    closure_type: null,
    archive_reason: null,
    archived_at: null,
    revision: 4,
    created_at: '2026-08-01T01:00:00+00:00',
    updated_at: '2026-08-28T08:30:00+00:00',
  }
}

function createGlobalDashboard(): GlobalDashboard {
  const projectCode = 'SY-2026-001'
  const operating = createOperatingSnapshot(projectCode)
  return {
    generated_at: '2026-08-28T08:30:00+00:00',
    summary: {
      active_project_count: 1,
      overdue_receivable_count: 1,
      upcoming_delivery_count: 1,
      contracted_amount_cents: operating.profit.contracted_amount_cents,
      received_amount_cents: operating.receivables.received_amount_cents,
      outstanding_receivable_cents: operating.receivables.outstanding_receivable_cents,
    },
    projects: [{
      project: createProjectDetail(projectCode),
      current_stage: operating.stages.find((stage) => stage.status === 'in_progress') ?? null,
      contracted_amount_cents: operating.profit.contracted_amount_cents,
      received_amount_cents: operating.receivables.received_amount_cents,
      outstanding_receivable_cents: operating.receivables.outstanding_receivable_cents,
      final_delivery_on: operating.commercial.contracts[0]?.final_delivery_on ?? null,
      actual_profit_cents: operating.profit.actual_profit_cents,
    }],
    todos: operating.todos,
    backup: {
      healthy: true,
      last_success_at: '2026-08-28T02:00:00+00:00',
      message: null,
    },
  }
}

function createDocumentLedger(projectCode: string): PagedResult<DocumentDetail> {
  return {
    items: [{
      id: 101,
      project_code: projectCode,
      category: 'site_survey',
      title: '现场测绘记录',
      notes: '客户接口尺寸复核记录',
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-05T02:00:00+00:00',
      updated_at: '2026-08-05T02:00:00+00:00',
      versions: [{
        id: 1001,
        version_number: 1,
        original_filename: 'site-survey-v1.pdf',
        content_type: 'application/pdf',
        size_bytes: 248000,
        sha256: 'demo-site-survey-v1',
        notes: '首次归档',
        created_at: '2026-08-05T02:00:00+00:00',
      }],
    }],
    total: 1,
    page: 1,
    page_size: 50,
  }
}

const previewProjectRepository = new MockProjectRepository()

export function createPreviewProjectRepository(): MockProjectRepository {
  return previewProjectRepository
}

function createOperatingSnapshot(projectCode: string): ProjectOperatingSnapshot {
  const now = '2026-08-28T08:30:00+00:00'
  const stage = (
    stage_code: string,
    status: ProjectOperatingSnapshot['stages'][number]['status'],
    revision: number,
  ): ProjectOperatingSnapshot['stages'][number] => ({
    stage_code,
    status,
    status_reason: status === 'blocked' ? '等待客户确认现场接口尺寸' : null,
    planned_start_on: null,
    planned_end_on: null,
    started_at: status === 'pending' ? null : now,
    blocked_at: status === 'blocked' ? now : null,
    completed_at: status === 'completed' ? now : null,
    notes: null,
    revision,
  })

  return {
    stages: [
      stage('planning', 'completed', 2),
      stage('site_survey', 'completed', 3),
      stage('quotation', 'completed', 4),
      stage('technical_agreement', 'completed', 2),
      stage('contract', 'completed', 3),
      stage('advance_payment', 'completed', 2),
      stage('mechanical_design', 'in_progress', 5),
      stage('electrical_design', 'blocked', 4),
      stage('procurement', 'in_progress', 3),
      stage('staffing', 'pending', 1),
      stage('mechanical_signoff', 'pending', 1),
      stage('electrical_signoff', 'pending', 1),
      stage('construction', 'pending', 1),
      stage('progress_payment', 'pending', 1),
      stage('commissioning', 'pending', 1),
      stage('acceptance', 'pending', 1),
      stage('final_payment', 'pending', 1),
      stage('closeout', 'pending', 1),
    ],
    commercial: {
      accepted_quote: {
        id: 11,
        project_code: projectCode,
        version_number: 3,
        status: 'accepted',
        quote_date: '2026-08-08',
        amount_cents: 286000000,
        valid_until: '2026-09-08',
        notes: '最终技术方案报价',
        document_version_ids: [],
        revision: 4,
        created_at: now,
        updated_at: now,
      },
      contracts: [{
        id: 21,
        contract_no: 'SYHT-2026-018',
        title: '自动化装配线改造合同',
        customer_company_id: 1,
        customer_company_name: '演示客户单位',
        status: 'signed',
        signed_on: '2026-08-18',
        total_amount_cents: 268000000,
        final_delivery_on: '2026-11-30',
        allocations: [{ id: 31, contract_id: 21, project_code: projectCode, amount_cents: 268000000 }],
        notes: null,
        document_version_ids: [],
        revision: 3,
        created_at: now,
        updated_at: now,
      }],
    },
    costs: {
      material_consumed_cents: 48600000,
      labor_cents: 21800000,
      field_material_cents: 9600000,
      total_cents: 80000000,
      procurement_committed_cents: 152000000,
      procurement_received_cents: 88000000,
      procurement_paid_cents: 65000000,
      completeness: 'complete',
    },
    profit: {
      contracted_amount_cents: 268000000,
      actual_cost_cents: 80000000,
      actual_profit_cents: 188000000,
      margin_basis_points: 7015,
    },
    receivables: {
      contracted_amount_cents: 268000000,
      receivable_amount_cents: 268000000,
      received_amount_cents: 134000000,
      allocated_received_amount_cents: 134000000,
      unallocated_received_amount_cents: 0,
      outstanding_receivable_cents: 134000000,
      contract_collection_basis_points: 5000,
      terms: [
        {
          id: 41,
          milestone: 'advance',
          due_on: '2026-08-20',
          planned_amount_cents: 80400000,
          received_amount_cents: 80400000,
          outstanding_amount_cents: 0,
          term_fulfillment_basis_points: 10000,
          status: 'paid',
          is_overdue: false,
          notes: null,
          revision: 2,
        },
        {
          id: 42,
          milestone: 'progress',
          due_on: '2026-10-15',
          planned_amount_cents: 107200000,
          received_amount_cents: 53600000,
          outstanding_amount_cents: 53600000,
          term_fulfillment_basis_points: 5000,
          status: 'partial',
          is_overdue: false,
          notes: null,
          revision: 2,
        },
        {
          id: 43,
          milestone: 'final',
          due_on: '2026-12-15',
          planned_amount_cents: 80400000,
          received_amount_cents: 0,
          outstanding_amount_cents: 80400000,
          term_fulfillment_basis_points: 0,
          status: 'scheduled',
          is_overdue: false,
          notes: null,
          revision: 1,
        },
      ],
      receipts: [],
    },
    todos: [
      {
        code: 'STAGE_BLOCKED',
        severity: 'danger',
        project_code: projectCode,
        due_on: '2026-09-02',
        title: '电气设计等待接口确认',
        description: '客户现场接口尺寸尚未确认。',
      },
      {
        code: 'DELIVERY_UPCOMING',
        severity: 'warning',
        project_code: projectCode,
        due_on: '2026-11-30',
        title: '关注最终交付日期',
        description: '当前仍有多个阶段尚未开始。',
      },
    ],
  }
}
