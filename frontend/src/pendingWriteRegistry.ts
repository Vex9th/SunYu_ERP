import { ref } from 'vue'

export const defaultProjectCommercialPendingOwner = Object.freeze({})
export const defaultDeliveryPendingOwner = Object.freeze({})
export const defaultProcurementPendingOwner = Object.freeze({})
export const defaultProjectDocumentsPendingOwner = Object.freeze({})

const pendingWrites = new WeakMap<object, Map<string, unknown>>()
const revision = ref(0)

export function projectCommercialPendingKey(kind: 'quote' | 'contract', projectCode: string): string {
  return pendingWriteKey('project-commercial', kind, projectCode)
}

export function deliveryPendingKey(
  kind: 'commissioning' | 'change' | 'acceptance' | 'after-sales' | 'invoice',
  projectCode: string,
): string {
  return pendingWriteKey('delivery', kind, projectCode)
}

export function procurementPendingKey(
  kind: 'list' | 'line' | 'order' | 'receipt' | 'payment' | 'invoice',
  projectCode: string,
): string {
  return pendingWriteKey('procurement', kind, projectCode)
}

export function projectDocumentsPendingKey(
  kind: 'create' | 'version' | 'minutes-create' | 'minutes-version',
  projectCode: string,
  documentId: number | null = null,
): string {
  return pendingWriteKey('project-documents', kind, projectCode, documentId)
}

function pendingWriteKey(scope: string, kind: string, projectCode: string, subjectId?: number | null): string {
  return JSON.stringify([scope, kind, projectCode, subjectId ?? null])
}

export function getPendingWrite<T>(owner: object, key: string): T | null {
  revision.value
  return (pendingWrites.get(owner)?.get(key) as T | undefined) ?? null
}

export function setPendingWrite<T>(owner: object, key: string, value: T): void {
  const ownerWrites = pendingWrites.get(owner) ?? new Map<string, unknown>()
  ownerWrites.set(key, value)
  pendingWrites.set(owner, ownerWrites)
  revision.value += 1
}

export function clearPendingWrite<T>(owner: object, key: string, expected: T): boolean {
  const ownerWrites = pendingWrites.get(owner)
  if (ownerWrites?.get(key) !== expected) return false
  ownerWrites.delete(key)
  if (ownerWrites.size === 0) pendingWrites.delete(owner)
  revision.value += 1
  return true
}
