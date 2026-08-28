export interface SessionState {
  authenticated: boolean
  password_configured: boolean
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
  directory: string | null
  interval_hours: number
  retention_days: number
}

export interface BackupCreated {
  path: string
  created_at: string
  warning?: string
}

export interface Company {
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
  contact_count: number
}

export interface Contact {
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

export interface CompanyDetail extends Company {
  contacts: Contact[]
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

export type ProjectStatus = 'active' | 'archived'
export type ProjectFilter = ProjectStatus | 'all'

export interface Project {
  id: number
  project_code: string
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
  company: Company
  contacts: Contact[]
  documents: DocumentSummary
}
