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
}
export function selectPermission(keys: string[], key: string, checked: boolean, catalog: PermissionDefinition[]): string[] {
  const selected = new Set(keys)
  const definitions = new Map(catalog.map(item => [item.key, item]))
  if (checked) {
    const add = (value: string) => {
      if (selected.has(value)) return
      selected.add(value)
      definitions.get(value)?.dependencies.forEach(add)
    }
    add(key)
  } else {
    selected.delete(key)
    let changed = true
    while (changed) {
      changed = false
      for (const value of selected) if (definitions.get(value)?.dependencies.some(dependency => !selected.has(dependency))) {
        selected.delete(value)
        changed = true
      }
    }
  }
  return [...selected].sort()
}
