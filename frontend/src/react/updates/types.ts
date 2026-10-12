export type UpdateComponent = 'frontend' | 'backend'
export type UpdateJobStatus = 'checking' | 'downloading' | 'ready' | 'installing' | 'success' | 'failed' | 'manual_recovery'
export interface UpdateJob {
  id: string
  status: UpdateJobStatus
  component: UpdateComponent | null
  version: string | null
  message: string
}
export interface UpdateState {
  supported: boolean
  can_install: boolean
  current: { backend: string | null; frontend: string | null }
  frontend_version: string | null
  latest: null | {
    version: string
    notes: string
    components: Partial<Record<UpdateComponent, { version: string; url: string; sha256: string }>>
  }
  preferences: { auto_check: boolean; ignored_version: string | null }
  job: UpdateJob | null
}
export const isRunningJob = (job: UpdateJob | null | undefined) => Boolean(job && ['checking', 'downloading', 'installing'].includes(job.status))
