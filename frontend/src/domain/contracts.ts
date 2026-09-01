export type ISODate = string
export type ISODateTime = string
export type MoneyCents = number
export type BasisPoints = number
export type DecimalString = string
export type Revision = number

export interface ApiErrorPayload {
  detail: string
  error_code?: string
  field_errors?: unknown
  current_revision?: number
}

export interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface CompanyRecord {
  id: number
  name: string
  taxpayer_id: string | null
  registered_address: string | null
  registered_phone: string | null
  bank_name: string | null
  bank_account: string | null
  notes: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface ContactRecord {
  id: number
  company_id: number
  name: string
  phone: string | null
  email: string | null
  position: string | null
  notes: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type ProjectStatus = 'active' | 'archived'
export type ClosureType = 'cancelled' | 'completed'

export interface ProjectDetail {
  id: number
  project_code: string
  company_id: number
  company_name: string
  name: string
  description: string | null
  status: ProjectStatus
  closure_type: ClosureType | null
  archive_reason: string | null
  archived_at: ISODateTime | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type ProjectStageStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'skipped'

export interface ProjectStage {
  stage_code: string
  status: ProjectStageStatus
  status_reason: string | null
  planned_start_on: ISODate | null
  planned_end_on: ISODate | null
  started_at: ISODateTime | null
  blocked_at: ISODateTime | null
  completed_at: ISODateTime | null
  notes: string | null
  revision: number
}

export interface DashboardDocumentSummary {
  document_count: number
  version_count: number
  categories: Array<{
    category: string
    document_count: number
    version_count: number
  }>
}

export interface DocumentVersion {
  id: number
  version_number: number
  original_filename: string
  content_type: string
  size_bytes: number
  sha256: string
  notes: string | null
  created_at: ISODateTime
}

export interface DocumentSummary {
  id: number
  project_code: string
  category: string
  title: string
  notes: string | null
  latest_version_number: number
  archived_at: ISODateTime | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface DocumentDetail extends DocumentSummary {
  versions: DocumentVersion[]
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'withdrawn'

export interface Quote {
  id: number
  project_code: string
  version_number: number
  status: QuoteStatus
  quote_date: ISODate
  amount_cents: MoneyCents
  valid_until: ISODate | null
  notes: string | null
  document_version_ids: number[]
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type ContractStatus = 'draft' | 'signed' | 'completed' | 'terminated'

export interface ContractAllocation {
  id: number
  contract_id: number
  project_code: string
  amount_cents: MoneyCents
}

export interface Contract {
  id: number
  contract_no: string
  title: string
  customer_company_id: number
  customer_company_name: string
  status: ContractStatus
  signed_on: ISODate | null
  total_amount_cents: MoneyCents
  final_delivery_on: ISODate | null
  allocations: ContractAllocation[]
  notes: string | null
  document_version_ids: number[]
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type PaymentMilestone = 'advance' | 'progress' | 'final'
export type PaymentTermStatus = 'unplanned' | 'scheduled' | 'partial' | 'paid'
export type ReceiptStatus = 'active' | 'voided'
export type PaymentMethod = 'bank_transfer' | 'cash' | 'other'

export interface PaymentTerm {
  id: number | null
  milestone: PaymentMilestone
  due_on: ISODate | null
  planned_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  outstanding_amount_cents: MoneyCents
  term_fulfillment_basis_points: BasisPoints | null
  status: PaymentTermStatus
  is_overdue: boolean
  notes: string | null
  revision: number | null
}

export interface Receipt {
  id: number
  project_code: string
  contract_allocation_id: number | null
  milestone: PaymentMilestone
  received_on: ISODate
  amount_cents: MoneyCents
  payment_method: PaymentMethod
  reference_no: string | null
  notes: string | null
  status: ReceiptStatus
  voided_on: ISODate | null
  void_reason: string | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface PaymentOverview {
  contracted_amount_cents: MoneyCents
  receivable_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  allocated_received_amount_cents: MoneyCents
  unallocated_received_amount_cents: MoneyCents
  outstanding_receivable_cents: MoneyCents
  contract_collection_basis_points: BasisPoints | null
  terms: PaymentTerm[]
  receipts: Receipt[]
}

export type CostCompleteness = 'unavailable' | 'partial' | 'complete'

export interface ProjectCostSummary {
  material_consumed_cents: MoneyCents | null
  labor_cents: MoneyCents | null
  field_material_cents: MoneyCents | null
  total_cents: MoneyCents | null
  procurement_committed_cents: MoneyCents | null
  procurement_received_cents: MoneyCents | null
  procurement_paid_cents: MoneyCents | null
  completeness: CostCompleteness
}

export interface ProjectProfitSummary {
  contracted_amount_cents: MoneyCents
  actual_cost_cents: MoneyCents | null
  actual_profit_cents: MoneyCents | null
  margin_basis_points: BasisPoints | null
}

export interface DashboardTodo {
  code: string
  severity: 'info' | 'warning' | 'danger'
  project_code: string | null
  due_on: ISODate | null
  title: string
  description: string | null
}

export interface ProjectDashboard {
  project: ProjectDetail
  company: CompanyRecord
  contacts: ContactRecord[]
  documents: DashboardDocumentSummary
  stages: ProjectStage[]
  commercial: {
    accepted_quote: Quote | null
    contracts: Contract[]
  }
  costs: ProjectCostSummary
  profit: ProjectProfitSummary
  receivables: PaymentOverview
  todos: DashboardTodo[]
}

export interface DashboardProjectRow {
  project: ProjectDetail
  current_stage: ProjectStage | null
  contracted_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  outstanding_receivable_cents: MoneyCents
  final_delivery_on: ISODate | null
  actual_profit_cents: MoneyCents | null
}

export interface GlobalDashboard {
  generated_at: ISODateTime
  summary: {
    active_project_count: number
    overdue_receivable_count: number
    upcoming_delivery_count: number
    contracted_amount_cents: MoneyCents
    received_amount_cents: MoneyCents
    outstanding_receivable_cents: MoneyCents
  }
  projects: DashboardProjectRow[]
  todos: DashboardTodo[]
  backup: {
    healthy: boolean
    last_success_at: ISODateTime | null
    message: string | null
  }
}

export type ProjectOperatingSnapshot = Pick<
  ProjectDashboard,
  'stages' | 'commercial' | 'costs' | 'profit' | 'receivables' | 'todos'
>
