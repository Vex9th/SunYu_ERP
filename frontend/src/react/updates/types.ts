export type UpdateComponent = 'frontend' | 'backend' | 'application'
export type InstallBlockReason = 'unsupported_runtime' | 'not_supervised' | 'client_unavailable' | 'non_loopback_peer' | 'non_loopback_host'
export type UpdateJobStatus = 'checking' | 'downloading' | 'verifying' | 'backing_up' | 'installing' | 'restarting' | 'cleaning' | 'success' | 'failed' | 'manual_recovery'
export interface UpdateJob {
  id: string
  request_id?: string
  phase?: string
  progress?: number
  status: UpdateJobStatus
  component: UpdateComponent | null
  version: string | null
  message: string
  error?: string
}
export interface UpdateState {
  supported: boolean
  can_install: boolean
  install_block_reason?: InstallBlockReason | null
  current: { backend: string | null; frontend: string | null; application?: string | null }
  frontend_version: string | null
  latest: null | {
    version: string
    notes: string
    components: Partial<Record<UpdateComponent, { version: string; url: string; sha256: string }>>
  }
  preferences: { auto_check: boolean; ignored_version: string | null }
  job: UpdateJob | null
  requested_job?: UpdateJob | null
}
export const isRunningJob = (job: UpdateJob | null | undefined) => Boolean(job && ['checking', 'downloading', 'verifying', 'backing_up', 'installing', 'restarting', 'cleaning'].includes(job.status))
