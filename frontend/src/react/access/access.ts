import type { AccountUser } from '../../types'
export interface ManagedAccount extends AccountUser {
  enabled: boolean
  created_at: string
  updated_at: string
}
export interface Workgroup {
  id: number
  name: string
  enabled: boolean
  archived: boolean
  member_count: number
  revision: number
  permission_keys: string[]
  project_ids: number[]
  created_at: string
  updated_at: string
}
export interface PermissionDefinition {
  key: string
  label: string
  module: string
  dependencies: string[]
  workflow_dependencies?: string[]
}
function dependencies(item: PermissionDefinition | undefined): string[] {
  return item ? [...item.dependencies, ...(item.workflow_dependencies ?? [])] : []
}
export function completePermissions(keys: string[], catalog: PermissionDefinition[]): string[] {
  return keys.reduce((result, key) => selectPermission(result, key, true, catalog), keys)
}
export function selectPermission(keys: string[], key: string, checked: boolean, catalog: PermissionDefinition[]): string[] {
  const selected = new Set(keys)
  const definitions = new Map(catalog.map(item => [item.key, item]))
  if (checked) {
    const visited = new Set<string>()
    const add = (value: string) => {
      if (visited.has(value)) return
      visited.add(value)
      selected.add(value)
      dependencies(definitions.get(value)).forEach(add)
    }
    add(key)
  } else {
    selected.delete(key)
    const removed = new Set([key])
    let changed = true
    while (changed) {
      changed = false
      for (const value of selected) if (dependencies(definitions.get(value)).some(dependency => removed.has(dependency))) {
        selected.delete(value)
        removed.add(value)
        changed = true
      }
    }
  }
  return [...selected].sort()
}
