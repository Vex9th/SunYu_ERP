export type DataSource = 'live' | 'demo'

export interface RepositoryResult<T> {
  source: DataSource
  data: T
}
