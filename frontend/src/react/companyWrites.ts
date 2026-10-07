import { createPlannedPostRequest } from '../api'
import type { CompanyDetail, CompanyPayload, ContactPayload, RevisionedContact } from '../types'

export const companyFields = [['name', '公司名称'], ['taxpayer_id', '纳税人识别号'], ['registered_address', '注册地址'], ['registered_phone', '公司电话'], ['bank_name', '开户银行'], ['bank_account', '银行账号'], ['notes', '备注']] as const
export const contactFields = [['name', '姓名'], ['position', '职位'], ['phone', '电话'], ['email', '邮箱'], ['notes', '备注']] as const
export const COMPANY_PENDING_KEY = 'sunyu-erp:pending-create:company'
export const CONTACT_PENDING_PREFIX = 'sunyu-erp:pending-create:contact:'
type IdempotencyKey = `${string}-${string}-${string}-${string}-${string}`
export type PendingCompanyCreate = { path: '/api/companies'; payload: CompanyPayload; idempotencyKey: IdempotencyKey; uncertain: true; companyId?: never }
export type PendingContactCreate = { companyId: number; path: string; payload: ContactPayload; idempotencyKey: IdempotencyKey; uncertain: true }
export type PendingCreate = PendingCompanyCreate | PendingContactCreate
const memory = new Map<string, PendingCreate>()
const inFlight = new Map<string, Promise<CompanyDetail | RevisionedContact>>()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const pendingStorageKey = (companyId?: number) => companyId === undefined ? COMPANY_PENDING_KEY : `${CONTACT_PENDING_PREFIX}${companyId}`
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { const actual = Object.keys(value); return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) }
function validPayload(value: unknown, fields: readonly (readonly [string, string])[]): boolean {
  return object(value) && exactKeys(value, fields.map(([key]) => key)) && typeof value.name === 'string' && Boolean(value.name.trim()) && fields.every(([key]) => key === 'name' || value[key] === null || typeof value[key] === 'string')
}
export function parsePendingCreate(value: unknown, companyId?: number): PendingCreate | null {
  const path = companyId === undefined ? '/api/companies' : `/api/companies/${companyId}/contacts`
  if (!object(value) || !exactKeys(value, companyId === undefined ? ['path', 'payload', 'idempotencyKey', 'uncertain'] : ['companyId', 'path', 'payload', 'idempotencyKey', 'uncertain']) || value.path !== path || value.uncertain !== true || typeof value.idempotencyKey !== 'string' || !uuidPattern.test(value.idempotencyKey)) return null
  if (companyId !== undefined && (!Number.isSafeInteger(companyId) || companyId <= 0 || value.companyId !== companyId)) return null
  if (!validPayload(value.payload, companyId === undefined ? companyFields : contactFields)) return null
  return value as unknown as PendingCreate
}
export function clearPendingCreate(companyId?: number): void {
  const key = pendingStorageKey(companyId); memory.delete(key)
  try { sessionStorage.removeItem(key) } catch { /* 禁用存储时仍移除内存中的凭据。 */ }
}
export function readPendingCreate(companyId?: number): PendingCreate | null {
  const key = pendingStorageKey(companyId)
  if (memory.has(key)) return memory.get(key)!
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return null
    const parsed = parsePendingCreate(JSON.parse(raw), companyId)
    if (!parsed) { clearPendingCreate(companyId); return null }
    return parsed
  } catch { clearPendingCreate(companyId); return null }
}
export function listPendingCreates(): PendingCreate[] {
  const ids = new Set<number>()
  for (const pending of memory.values()) if (pending.companyId !== undefined) ids.add(pending.companyId)
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    for (const key of keys) {
      if (!key?.startsWith(CONTACT_PENDING_PREFIX)) continue
      const suffix = key.slice(CONTACT_PENDING_PREFIX.length); const id = Number(suffix)
      if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== suffix) { sessionStorage.removeItem(key); continue }
      ids.add(id)
    }
  } catch { /* 存储不可用时仍可恢复本页保留的原请求。 */ }
  return [readPendingCreate(), ...Array.from(ids).sort((a, b) => a - b).map(readPendingCreate)].filter((pending): pending is PendingCreate => pending !== null)
}
export function storePendingCreate(pending: PendingCreate): boolean {
  const key = pendingStorageKey(pending.companyId)
  memory.set(key, pending)
  try { sessionStorage.setItem(key, JSON.stringify(pending)); return true } catch { return false }
}
export function prepareCompanyCreate(payload: CompanyPayload): PendingCompanyCreate { return { path: '/api/companies', payload: structuredClone(payload), idempotencyKey: crypto.randomUUID(), uncertain: true } }
export function prepareContactCreate(companyId: number, payload: ContactPayload): PendingContactCreate { return { companyId, path: `/api/companies/${companyId}/contacts`, payload: structuredClone(payload), idempotencyKey: crypto.randomUUID(), uncertain: true } }
export function sendPendingCreate(pending: PendingCreate): Promise<CompanyDetail | RevisionedContact> {
  const key = pendingStorageKey(pending.companyId)
  const existing = inFlight.get(key)
  if (existing) return existing
  const request = createPlannedPostRequest<CompanyDetail | RevisionedContact>(pending.path, pending.payload, pending.idempotencyKey).send()
  inFlight.set(key, request)
  void request.finally(() => { if (inFlight.get(key) === request) inFlight.delete(key) }).catch(() => undefined)
  return request
}
export function companyPayload(values: Record<string, unknown>): CompanyPayload { return Object.fromEntries(companyFields.map(([key]) => [key, key === 'name' ? String(values[key] ?? '').trim() : text(values[key])])) as unknown as CompanyPayload }
export function contactPayload(values: Record<string, unknown>): ContactPayload { return Object.fromEntries(contactFields.map(([key]) => [key, key === 'name' ? String(values[key] ?? '').trim() : text(values[key])])) as unknown as ContactPayload }
export const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
