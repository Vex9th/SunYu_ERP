import { createRetriablePostSender, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  CrewAssignmentDto,
  InventoryAdjustmentDto,
  InventoryAdjustmentInput,
  InventoryAdjustmentReversalInput,
  InventoryIssueDto,
  InventoryIssueInput,
  InventoryIssueReversalInput,
  InventoryItemDetailDto,
  InventoryItemDto,
  InventoryItemInput,
  InventoryItemUpdateInput,
  InventoryMovementDto,
  PaginationQuery,
} from '../domain/operations-api'
import type { ProjectSummary } from '../types'
import type { RepositoryResult } from './common'

export interface InventoryListQuery extends PaginationQuery {
  query?: string
  status?: 'all' | 'in_stock' | 'out_of_stock'
}

export interface InventoryIssueProjectOption {
  project_code: string
  name: string
}

export interface InventoryIssueWorkerOption {
  worker_id: number
  name: string
  role: string
}

export interface InventoryHttpRepository {
  listInventoryItems(query?: InventoryListQuery): Promise<RepositoryResult<PagedResult<InventoryItemDto>>>
  createInventoryItem(input: InventoryItemInput): Promise<RepositoryResult<InventoryItemDto>>
  getInventoryItem(itemId: number): Promise<RepositoryResult<InventoryItemDetailDto>>
  updateInventoryItem(itemId: number, input: InventoryItemUpdateInput): Promise<RepositoryResult<InventoryItemDto>>
  listInventoryMovements(itemId: number, query?: PaginationQuery): Promise<RepositoryResult<PagedResult<InventoryMovementDto>>>
  createInventoryAdjustment(input: InventoryAdjustmentInput): Promise<RepositoryResult<InventoryAdjustmentDto>>
  reverseInventoryAdjustment(adjustmentId: number, input: InventoryAdjustmentReversalInput): Promise<RepositoryResult<InventoryAdjustmentDto>>
  createProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): Promise<RepositoryResult<InventoryIssueDto>>
  listIssueProjects(): Promise<RepositoryResult<InventoryIssueProjectOption[]>>
  listProjectIssueWorkers(projectCode: string): Promise<RepositoryResult<InventoryIssueWorkerOption[]>>
  reverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): Promise<RepositoryResult<InventoryIssueDto>>
  discardCreateInventoryItem(input: InventoryItemInput): boolean
  discardCreateInventoryAdjustment(input: InventoryAdjustmentInput): boolean
  discardReverseInventoryAdjustment(adjustmentId: number, input: InventoryAdjustmentReversalInput): boolean
  discardCreateProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): boolean
  discardReverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): boolean
}

class HttpInventoryRepository implements InventoryHttpRepository {
  private readonly postSender = createRetriablePostSender()

  async listInventoryItems(query: InventoryListQuery = {}): Promise<RepositoryResult<PagedResult<InventoryItemDto>>> {
    return live(await requestJson(withQuery('/api/inventory/items', query)))
  }

  async createInventoryItem(input: InventoryItemInput): Promise<RepositoryResult<InventoryItemDto>> {
    return live(await this.postSender.send(INVENTORY_ITEMS_PATH, input))
  }

  async getInventoryItem(itemId: number): Promise<RepositoryResult<InventoryItemDetailDto>> {
    return live(await requestJson(itemPath(itemId)))
  }

  async updateInventoryItem(itemId: number, input: InventoryItemUpdateInput): Promise<RepositoryResult<InventoryItemDto>> {
    return live(await requestJson(itemPath(itemId), { method: 'PUT', body: input }))
  }

  async listInventoryMovements(itemId: number, query: PaginationQuery = {}): Promise<RepositoryResult<PagedResult<InventoryMovementDto>>> {
    return live(await requestJson(withQuery(`${itemPath(itemId)}/movements`, query)))
  }

  async createInventoryAdjustment(input: InventoryAdjustmentInput): Promise<RepositoryResult<InventoryAdjustmentDto>> {
    return live(await this.postSender.send(INVENTORY_ADJUSTMENTS_PATH, input))
  }

  async reverseInventoryAdjustment(adjustmentId: number, input: InventoryAdjustmentReversalInput): Promise<RepositoryResult<InventoryAdjustmentDto>> {
    return live(await this.postSender.send(inventoryAdjustmentReversePath(adjustmentId), input))
  }

  async createProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): Promise<RepositoryResult<InventoryIssueDto>> {
    return live(await this.postSender.send(projectInventoryIssuesPath(projectCode), input))
  }

  async listIssueProjects(): Promise<RepositoryResult<InventoryIssueProjectOption[]>> {
    const projects = await requestJson<ProjectSummary[]>('/api/projects?status=active')
    return live(projects.map((project) => ({ project_code: project.project_code, name: project.name })))
  }

  async listProjectIssueWorkers(projectCode: string): Promise<RepositoryResult<InventoryIssueWorkerOption[]>> {
    const assignments = await requestJson<PagedResult<CrewAssignmentDto>>(withQuery(
      `/api/projects/${encodeURIComponent(projectCode)}/crew-assignments`,
      { page: 1, page_size: 200, status: 'all' },
    ))
    const workers = new Map<number, InventoryIssueWorkerOption>()
    for (const assignment of assignments.items) {
      if (!['planned', 'active'].includes(assignment.status)) continue
      workers.set(assignment.worker_id, {
        worker_id: assignment.worker_id,
        name: assignment.worker_name,
        role: assignment.role,
      })
    }
    return live([...workers.values()])
  }

  async reverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): Promise<RepositoryResult<InventoryIssueDto>> {
    return live(await this.postSender.send(projectInventoryIssueReversePath(projectCode, issueId), input))
  }

  discardCreateInventoryItem(input: InventoryItemInput): boolean {
    return this.postSender.discard(INVENTORY_ITEMS_PATH, input)
  }

  discardCreateInventoryAdjustment(input: InventoryAdjustmentInput): boolean {
    return this.postSender.discard(INVENTORY_ADJUSTMENTS_PATH, input)
  }

  discardReverseInventoryAdjustment(adjustmentId: number, input: InventoryAdjustmentReversalInput): boolean {
    return this.postSender.discard(inventoryAdjustmentReversePath(adjustmentId), input)
  }

  discardCreateProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): boolean {
    return this.postSender.discard(projectInventoryIssuesPath(projectCode), input)
  }

  discardReverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): boolean {
    return this.postSender.discard(projectInventoryIssueReversePath(projectCode, issueId), input)
  }
}

const INVENTORY_ITEMS_PATH = '/api/inventory/items'
const INVENTORY_ADJUSTMENTS_PATH = '/api/inventory/adjustments'

export function createHttpInventoryRepository(): InventoryHttpRepository {
  return new HttpInventoryRepository()
}

function itemPath(itemId: number): string {
  return `/api/inventory/items/${itemId}`
}

function inventoryAdjustmentReversePath(adjustmentId: number): string {
  return `${INVENTORY_ADJUSTMENTS_PATH}/${adjustmentId}/reverse`
}

function projectInventoryIssuesPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}/inventory-issues`
}

function projectInventoryIssueReversePath(projectCode: string, issueId: number): string {
  return `${projectInventoryIssuesPath(projectCode)}/${issueId}/reverse`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
