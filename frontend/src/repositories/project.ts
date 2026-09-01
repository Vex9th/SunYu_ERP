import { requestJson } from '../api'
import type {
  DocumentDetail,
  GlobalDashboard,
  PagedResult,
  ProjectOperatingSnapshot,
  ProjectStage,
  ProjectStageStatus,
} from '../domain/contracts'
import type { ProjectDashboardData } from '../types'
import type { RepositoryResult } from './common'

export interface ProjectRepository {
  getBaseDashboard(projectCode: string): Promise<RepositoryResult<ProjectDashboardData>>
}

export interface ProjectStageRepository {
  listProjectStages(projectCode: string): Promise<RepositoryResult<ProjectStage[]>>
  updateStageSchedule(
    projectCode: string,
    stageCode: string,
    input: StageScheduleInput,
  ): Promise<RepositoryResult<ProjectStage>>
  transitionStage(
    projectCode: string,
    stageCode: string,
    input: StageTransitionInput,
  ): Promise<RepositoryResult<ProjectStage>>
}

export interface ProjectOperatingRepository
  extends Pick<ProjectStageRepository, 'updateStageSchedule' | 'transitionStage'> {
  getOperatingSnapshot(projectCode: string): Promise<RepositoryResult<ProjectOperatingSnapshot>>
  getGlobalDashboard(): Promise<RepositoryResult<GlobalDashboard>>
  getDocumentLedger(projectCode: string): Promise<RepositoryResult<PagedResult<DocumentDetail>>>
}

export interface StageScheduleInput {
  planned_start_on: string | null
  planned_end_on: string | null
  notes: string | null
  expected_revision: number
}

export interface StageTransitionInput {
  to_status: ProjectStageStatus
  occurred_at: string
  reason: string | null
  expected_revision: number
}

class HttpProjectRepository implements ProjectRepository {
  async getBaseDashboard(projectCode: string): Promise<RepositoryResult<ProjectDashboardData>> {
    const data = await requestJson<ProjectDashboardData>(
      `/api/projects/${encodeURIComponent(projectCode)}/dashboard`,
    )
    return { source: 'live', data }
  }
}

export function createHttpProjectRepository(): ProjectRepository {
  return new HttpProjectRepository()
}
