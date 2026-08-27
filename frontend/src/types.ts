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

export interface SystemOverview {
  data_directory: string
  database_path: string
  backup: BackupSettings
}

export interface BackupSettingsPayload {
  directory: string | null
  interval_hours: number
  retention_days: number
}

export interface BackupCreated {
  path: string
  created_at: string
}
