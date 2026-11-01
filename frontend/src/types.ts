import type { ProjectCompletionCheck } from './domain/contracts'

export type { ProjectCompletionCheck } from './domain/contracts'

export interface AccountUser {
  id: number
  username: string
  display_name: string
  is_owner: boolean
  group_id: number | null
  group_name: string | null
  revision: number
}
export interface ActivitySummaryData {
  created_by: string | null
  last_actor: string | null
  last_action: string | null
  last_at: string | null
}
export interface ActivityTracked { activity_summary?: ActivitySummaryData | null }
export interface SessionState {
  authenticated: boolean
  password_configured: boolean
  bootstrap_required?: boolean
  user?: AccountUser | null
  access_revision?: number
  permissions?: string[]
  project_ids?: number[] | null
}

export interface BackupRun {
  status: string
  started_at: string
  finished_at: string | null
  target_path: string
  error_message: string | null
}

export interface BackupSettings {
  enabled: boolean
  directory: string | null
  interval_hours: number
  retention_days: number
  last_run: BackupRun | null
}

export type BackupSettingsResponse = Omit<BackupSettings, 'last_run'>

export interface SchedulerStatus {
  alive: boolean
  last_error_at: string | null
  last_error_code: string | null
}

export interface SystemOverview {
  data_directory: string
  database_path: string
  backup: BackupSettings
  scheduler: SchedulerStatus
}

export interface BackupSettingsPayload {
  enabled: boolean
  directory: string | null
  interval_hours: number
  retention_days: number
}

export interface BackupCreated {
  path: string
  created_at: string
  warning?: string
}

export interface Company extends ActivityTracked {
  id: number
  name: string
  taxpayer_id: string | null
  registered_address: string | null
  registered_phone: string | null
  bank_name: string | null
  bank_account: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CompanySummary extends Company {
  revision: number
  contact_count: number
}

export interface Contact extends ActivityTracked {
  id: number
  company_id: number
  name: string
  phone: string | null
  email: string | null
  position: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface RevisionedContact extends Contact {
  revision: number
}

export interface CompanyDetail extends Company {
  revision: number
  contacts: RevisionedContact[]
}

export interface CompanyPayload {
  name: string
  taxpayer_id: string | null
  registered_address: string | null
  registered_phone: string | null
  bank_name: string | null
  bank_account: string | null
  notes: string | null
}

export interface ContactPayload {
  name: string
  phone: string | null
  email: string | null
  position: string | null
  notes: string | null
}

export interface CompanyUpdatePayload extends CompanyPayload {
  expected_revision: number
}

export interface ContactUpdatePayload extends ContactPayload {
  expected_revision: number
}

export type ProjectStatus = 'active' | 'archived'
export type ProjectCategory = 'standard' | 'trade'
export type ProjectFilter = ProjectStatus | 'all'

export interface Project extends ActivityTracked {
  id: number
  project_code: string
  project_category?: ProjectCategory
  company_id: number
  name: string
  description: string | null
  status: ProjectStatus
  archive_reason: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface ProjectSummary extends Project {
  company_name: string
}

export interface ProjectPayload {
  project_code: string
  project_category?: ProjectCategory
  company_id: number
  name: string
  description: string | null
}

export interface DocumentCategorySummary {
  category: string
  document_count: number
  version_count: number
}

export interface DocumentSummary {
  document_count: number
  version_count: number
  categories: DocumentCategorySummary[]
}

export interface ProjectDashboardData {
  project: Project
  company: Company | null
  contacts: Contact[]
  documents: DocumentSummary
  completion_check: ProjectCompletionCheck
}
