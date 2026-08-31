import { createRetriablePostSender, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  CrewAssignmentDto,
  CrewAssignmentInput,
  CrewAssignmentUpdateInput,
  LaborBatchDto,
  LaborBatchInput,
  LaborEntryDto,
  PaginationQuery,
  WorkerDeactivateInput,
  WorkerDto,
  WorkerInput,
  WorkerUpdateInput,
} from '../domain/operations-api'
import type { CrewAssignmentStatus, WorkerStatus } from '../domain/workforce'
import type { RepositoryResult } from './common'

export interface WorkerListQuery extends PaginationQuery {
  status?: WorkerStatus | 'all'
  query?: string
}

export interface CrewAssignmentListQuery extends PaginationQuery {
  status?: CrewAssignmentStatus | 'all'
}

export interface LaborEntryListQuery extends PaginationQuery {
  from?: string
  to?: string
  worker_id?: number
}

export interface WorkforceHttpRepository {
  listWorkers(query?: WorkerListQuery): Promise<RepositoryResult<PagedResult<WorkerDto>>>
  createWorker(input: WorkerInput): Promise<RepositoryResult<WorkerDto>>
  getWorker(workerId: number): Promise<RepositoryResult<WorkerDto>>
  updateWorker(workerId: number, input: WorkerUpdateInput): Promise<RepositoryResult<WorkerDto>>
  deactivateWorker(workerId: number, input: WorkerDeactivateInput): Promise<RepositoryResult<WorkerDto>>
  listCrewAssignments(projectCode: string, query?: CrewAssignmentListQuery): Promise<RepositoryResult<PagedResult<CrewAssignmentDto>>>
  createCrewAssignment(projectCode: string, input: CrewAssignmentInput): Promise<RepositoryResult<CrewAssignmentDto>>
  updateCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentUpdateInput): Promise<RepositoryResult<CrewAssignmentDto>>
  listLaborEntries(projectCode: string, query?: LaborEntryListQuery): Promise<RepositoryResult<PagedResult<LaborEntryDto>>>
  saveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): Promise<RepositoryResult<LaborBatchDto>>
  discardSaveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): boolean
}

class HttpWorkforceRepository implements WorkforceHttpRepository {
  private readonly postSender = createRetriablePostSender()

  async listWorkers(query: WorkerListQuery = {}): Promise<RepositoryResult<PagedResult<WorkerDto>>> {
    return live(await requestJson(withQuery('/api/workers', query)))
  }

  async createWorker(input: WorkerInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await this.postSender.send('/api/workers', input))
  }

  async getWorker(workerId: number): Promise<RepositoryResult<WorkerDto>> {
    return live(await requestJson(workerPath(workerId)))
  }

  async updateWorker(workerId: number, input: WorkerUpdateInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await requestJson(workerPath(workerId), { method: 'PUT', body: input }))
  }

  async deactivateWorker(workerId: number, input: WorkerDeactivateInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await this.postSender.send(`${workerPath(workerId)}/deactivate`, input))
  }

  async listCrewAssignments(projectCode: string, query: CrewAssignmentListQuery = {}): Promise<RepositoryResult<PagedResult<CrewAssignmentDto>>> {
    return live(await requestJson(withQuery(assignmentCollectionPath(projectCode), query)))
  }

  async createCrewAssignment(projectCode: string, input: CrewAssignmentInput): Promise<RepositoryResult<CrewAssignmentDto>> {
    return live(await this.postSender.send(assignmentCollectionPath(projectCode), input))
  }

  async updateCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentUpdateInput): Promise<RepositoryResult<CrewAssignmentDto>> {
    return live(await requestJson(`${assignmentCollectionPath(projectCode)}/${assignmentId}`, {
      method: 'PUT',
      body: input,
    }))
  }

  async listLaborEntries(projectCode: string, query: LaborEntryListQuery = {}): Promise<RepositoryResult<PagedResult<LaborEntryDto>>> {
    return live(await requestJson(withQuery(`${projectPath(projectCode)}/labor-entries`, query)))
  }

  async saveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): Promise<RepositoryResult<LaborBatchDto>> {
    return live(await this.postSender.send(`${projectPath(projectCode)}/labor-entries/batch`, input))
  }

  discardSaveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): boolean {
    return this.postSender.discard(`${projectPath(projectCode)}/labor-entries/batch`, input)
  }
}

export function createHttpWorkforceRepository(): WorkforceHttpRepository {
  return new HttpWorkforceRepository()
}

function workerPath(workerId: number): string {
  return `/api/workers/${workerId}`
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function assignmentCollectionPath(projectCode: string): string {
  return `${projectPath(projectCode)}/crew-assignments`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
