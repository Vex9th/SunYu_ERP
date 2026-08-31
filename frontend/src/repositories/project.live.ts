import { createPlannedPostRequest, requestJson } from '../api'
import type { ProjectStage } from '../domain/contracts'
import type { RepositoryResult } from './common'
import type { StageScheduleInput, StageTransitionInput } from './project'

export interface ProjectStageHttpRepository {
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

class HttpProjectStageRepository implements ProjectStageHttpRepository {
  async listProjectStages(projectCode: string): Promise<RepositoryResult<ProjectStage[]>> {
    return live(await requestJson<ProjectStage[]>(stageCollectionPath(projectCode)))
  }

  async updateStageSchedule(
    projectCode: string,
    stageCode: string,
    input: StageScheduleInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const data = await requestJson<ProjectStage>(stagePath(projectCode, stageCode), {
      method: 'PUT',
      body: input,
    })
    return live(data)
  }

  async transitionStage(
    projectCode: string,
    stageCode: string,
    input: StageTransitionInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const data = await createPlannedPostRequest<ProjectStage>(
      `${stagePath(projectCode, stageCode)}/transition`,
      input,
    ).send()
    return live(data)
  }
}

export function createHttpProjectStageRepository(): ProjectStageHttpRepository {
  return new HttpProjectStageRepository()
}

function stageCollectionPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}/stages`
}

function stagePath(projectCode: string, stageCode: string): string {
  return `${stageCollectionPath(projectCode)}/${encodeURIComponent(stageCode)}`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
