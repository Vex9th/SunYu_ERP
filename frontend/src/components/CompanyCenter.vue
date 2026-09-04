<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'

import { ApiError, createPlannedPostRequest, requestJson, requestVoid } from '../api'
import type {
  CompanyDetail,
  CompanyPayload,
  CompanySummary,
  ContactPayload,
  RevisionedContact,
} from '../types'

const emit = defineEmits<{
  'session-expired': [message: string]
}>()

const COMPANY_PENDING_CREATE_KEY = 'sunyu-erp:pending-create:company'
const CONTACT_PENDING_CREATE_PREFIX = 'sunyu-erp:pending-create:contact:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type IdempotencyKey = `${string}-${string}-${string}-${string}-${string}`

interface PendingCompanyCreate {
  path: '/api/companies'
  payload: CompanyPayload
  idempotencyKey: IdempotencyKey
  uncertain: true
}

interface PendingContactCreate {
  companyId: number
  path: string
  payload: ContactPayload
  idempotencyKey: IdempotencyKey
  uncertain: true
}

interface ConflictRow {
  key: string
  label: string
  draft: string
  latest: string
  different: boolean
}

const companyConflictFields = [
  ['name', '公司名称'],
  ['taxpayer_id', '纳税人识别号'],
  ['registered_address', '注册地址'],
  ['registered_phone', '注册电话'],
  ['bank_name', '开户行'],
  ['bank_account', '银行账号'],
  ['notes', '备注'],
] as const satisfies readonly (readonly [keyof CompanyPayload, string])[]

const contactConflictFields = [
  ['name', '姓名'],
  ['phone', '电话'],
  ['email', '邮箱'],
  ['position', '职务'],
  ['notes', '备注'],
] as const satisfies readonly (readonly [keyof ContactPayload, string])[]

const companies = ref<CompanySummary[]>([])
const loading = ref(true)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const companyBusy = ref(false)
const contactBusy = ref(false)
const searchQuery = ref('')
const actionNotice = ref<string | null>(null)
const refreshWarning = ref<string | null>(null)
const filteredCompanies = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  if (!query) return companies.value
  return companies.value.filter((company) => [
    company.name,
    company.taxpayer_id,
    company.registered_phone,
  ].some((value) => value?.toLocaleLowerCase('zh-CN').includes(query)))
})

const companyDialogVisible = ref(false)
const editingCompanyId = ref<number | null>(null)
const editingCompanyRevision = ref<number | null>(null)
const companyConflictLatest = ref<CompanyDetail | null>(null)
const companyConflictRefreshRequired = ref(false)
const companyCreateUncertain = ref(false)
const companyPendingCreate = ref<PendingCompanyCreate | null>(null)
const companyFormLocked = computed(
  () => companyBusy.value || (editingCompanyId.value === null && companyCreateUncertain.value),
)
const companyValidationError = ref<string | null>(null)
const companyForm = reactive({
  name: '',
  taxpayer_id: '',
  registered_address: '',
  registered_phone: '',
  bank_name: '',
  bank_account: '',
  notes: '',
})
const companyConflictRows = computed<ConflictRow[]>(() => {
  const latest = companyConflictLatest.value
  if (!latest) return []
  return companyConflictFields.map(([key, label]) => {
    const draft = normalizeDraftValue(companyForm[key])
    const serverValue = latest[key]
    const latestValue = typeof serverValue === 'string' ? serverValue : null
    return {
      key,
      label,
      draft: displayConflictValue(draft),
      latest: displayConflictValue(latestValue),
      different: draft !== latestValue,
    }
  })
})

const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const detail = ref<CompanyDetail | null>(null)
const selectedDetailCompanyId = ref<number | null>(null)
let detailLoadVersion = 0
let companyDialogVersion = 0
let companyMutationVersion = 0
let contactDialogVersion = 0
let contactMutationVersion = 0
let companyDeleteVersion = 0
let contactDeleteVersion = 0
let companyFormBaseline = ''
let contactFormBaseline = ''

const contactDialogVisible = ref(false)
const editingContactId = ref<number | null>(null)
const editingContactRevision = ref<number | null>(null)
const contactConflictLatest = ref<RevisionedContact | null>(null)
const contactConflictRefreshRequired = ref(false)
const contactCreateUncertain = ref(false)
const contactPendingCreate = ref<PendingContactCreate | null>(null)
const contactFormLocked = computed(
  () => contactBusy.value || (editingContactId.value === null && contactCreateUncertain.value),
)
const contactValidationError = ref<string | null>(null)
const contactForm = reactive({
  name: '',
  phone: '',
  email: '',
  position: '',
  notes: '',
})
const contactConflictRows = computed<ConflictRow[]>(() => {
  const latest = contactConflictLatest.value
  if (!latest) return []
  return contactConflictFields.map(([key, label]) => {
    const draft = normalizeDraftValue(contactForm[key])
    const serverValue = latest[key]
    const latestValue = typeof serverValue === 'string' ? serverValue : null
    return {
      key,
      label,
      draft: displayConflictValue(draft),
      latest: displayConflictValue(latestValue),
      different: draft !== latestValue,
    }
  })
})

const companyDeleteVisible = ref(false)
const companyDeleteTarget = ref<CompanySummary | null>(null)
const companyDeleteRefreshRequired = ref(false)
const contactDeleteVisible = ref(false)
const contactDeleteTarget = ref<RevisionedContact | null>(null)
const contactDeleteRefreshRequired = ref(false)
let companyLoadVersion = 0

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function handleSessionError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  emit('session-expired', error.message)
  return true
}

function isUncertainMutation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === 0 || error.status >= 500 || [408, 425, 429].includes(error.status)
}

function isRevisionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.errorCode === 'REVISION_CONFLICT'
}

function optional(value: string): string | null {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeDraftValue(value: string): string | null {
  return optional(value)
}

function displayConflictValue(value: string | null): string {
  return value ?? '未录入'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isCompanyPayload(value: unknown): value is CompanyPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, companyConflictFields.map(([key]) => key))) return false
  return typeof value.name === 'string'
    && value.name.trim().length > 0
    && isNullableString(value.taxpayer_id)
    && isNullableString(value.registered_address)
    && isNullableString(value.registered_phone)
    && isNullableString(value.bank_name)
    && isNullableString(value.bank_account)
    && isNullableString(value.notes)
}

function isContactPayload(value: unknown): value is ContactPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, contactConflictFields.map(([key]) => key))) return false
  return typeof value.name === 'string'
    && value.name.trim().length > 0
    && isNullableString(value.phone)
    && isNullableString(value.email)
    && isNullableString(value.position)
    && isNullableString(value.notes)
}

function readStoredValue(key: string): unknown {
  try {
    const serialized = sessionStorage.getItem(key)
    return serialized === null ? null : JSON.parse(serialized)
  } catch {
    removeStoredValue(key)
    return null
  }
}

function writeStoredValue(key: string, value: unknown): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function removeStoredValue(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // 浏览器禁用会话存储时，内存中的待重试记录仍保持锁定。
  }
}

function parseStoredCompanyCreate(value: unknown): PendingCompanyCreate | null {
  if (!isRecord(value)
    || value.path !== '/api/companies'
    || value.uncertain !== true
    || typeof value.idempotencyKey !== 'string'
    || !UUID_PATTERN.test(value.idempotencyKey)
    || !isCompanyPayload(value.payload)) return null
  return {
    path: value.path,
    payload: value.payload,
    idempotencyKey: value.idempotencyKey as IdempotencyKey,
    uncertain: true,
  }
}

function parseStoredContactCreate(value: unknown, companyId: number): PendingContactCreate | null {
  const expectedPath = `/api/companies/${companyId}/contacts`
  if (!isRecord(value)
    || value.companyId !== companyId
    || value.path !== expectedPath
    || value.uncertain !== true
    || typeof value.idempotencyKey !== 'string'
    || !UUID_PATTERN.test(value.idempotencyKey)
    || !isContactPayload(value.payload)) return null
  return {
    companyId,
    path: expectedPath,
    payload: value.payload,
    idempotencyKey: value.idempotencyKey as IdempotencyKey,
    uncertain: true,
  }
}

function contactPendingStorageKey(companyId: number): string {
  return `${CONTACT_PENDING_CREATE_PREFIX}${companyId}`
}

function clearCompanyPendingCreate(): void {
  removeStoredValue(COMPANY_PENDING_CREATE_KEY)
  companyPendingCreate.value = null
  companyCreateUncertain.value = false
}

function clearContactPendingCreate(companyId?: number): void {
  const pendingCompanyId = companyId ?? contactPendingCreate.value?.companyId
  if (pendingCompanyId !== undefined) removeStoredValue(contactPendingStorageKey(pendingCompanyId))
  contactPendingCreate.value = null
  contactCreateUncertain.value = false
}

function applyCompanyPayload(payload: CompanyPayload): void {
  companyForm.name = payload.name
  companyForm.taxpayer_id = payload.taxpayer_id ?? ''
  companyForm.registered_address = payload.registered_address ?? ''
  companyForm.registered_phone = payload.registered_phone ?? ''
  companyForm.bank_name = payload.bank_name ?? ''
  companyForm.bank_account = payload.bank_account ?? ''
  companyForm.notes = payload.notes ?? ''
}

function applyContactPayload(payload: ContactPayload): void {
  contactForm.name = payload.name
  contactForm.phone = payload.phone ?? ''
  contactForm.email = payload.email ?? ''
  contactForm.position = payload.position ?? ''
  contactForm.notes = payload.notes ?? ''
}

function companyPayload(): CompanyPayload | null {
  const name = companyForm.name.trim()
  if (!name) {
    companyValidationError.value = '请输入公司名称'
    return null
  }
  companyValidationError.value = null
  return {
    name,
    taxpayer_id: optional(companyForm.taxpayer_id),
    registered_address: optional(companyForm.registered_address),
    registered_phone: optional(companyForm.registered_phone),
    bank_name: optional(companyForm.bank_name),
    bank_account: optional(companyForm.bank_account),
    notes: optional(companyForm.notes),
  }
}

function contactPayload(): ContactPayload | null {
  const name = contactForm.name.trim()
  if (!name) {
    contactValidationError.value = '请输入联系人姓名'
    return null
  }
  contactValidationError.value = null
  return {
    name,
    phone: optional(contactForm.phone),
    email: optional(contactForm.email),
    position: optional(contactForm.position),
    notes: optional(contactForm.notes),
  }
}

async function loadCompanies(): Promise<boolean> {
  const version = ++companyLoadVersion
  loading.value = true
  listError.value = null
  try {
    const response = await requestJson<CompanySummary[]>('/api/companies')
    if (version === companyLoadVersion) companies.value = response
    return version === companyLoadVersion
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== companyLoadVersion) return false
    if (companies.value.length === 0) companies.value = []
    if (!isSessionError) listError.value = errorMessage(error)
    return false
  } finally {
    if (version === companyLoadVersion) loading.value = false
  }
}

function resetCompanyForm(): void {
  companyForm.name = ''
  companyForm.taxpayer_id = ''
  companyForm.registered_address = ''
  companyForm.registered_phone = ''
  companyForm.bank_name = ''
  companyForm.bank_account = ''
  companyForm.notes = ''
  companyValidationError.value = null
}

function companyFormFingerprint(): string {
  return JSON.stringify(companyForm)
}

function contactFormFingerprint(): string {
  return JSON.stringify(contactForm)
}

function confirmDirtyClose(dirty: boolean, done: () => void): void {
  if (!dirty) {
    done()
    return
  }
  void ElMessageBox.confirm(
    '关闭后未保存的内容会丢失，确定关闭吗？',
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => done()).catch(() => undefined)
}

function openCompanyCreate(): void {
  if (companyCreateUncertain.value) {
    companyDialogVisible.value = true
    return
  }
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  actionError.value = null
  actionNotice.value = null
  refreshWarning.value = null
  editingCompanyId.value = null
  editingCompanyRevision.value = null
  companyConflictLatest.value = null
  companyConflictRefreshRequired.value = false
  clearCompanyPendingCreate()
  resetCompanyForm()
  companyFormBaseline = companyFormFingerprint()
  companyDialogVisible.value = true
}

function openCompanyEdit(company: CompanySummary): void {
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  actionError.value = null
  editingCompanyId.value = company.id
  editingCompanyRevision.value = company.revision
  companyConflictLatest.value = null
  companyConflictRefreshRequired.value = false
  applyCompanyPayload(company)
  companyFormBaseline = companyFormFingerprint()
  companyValidationError.value = null
  companyDialogVisible.value = true
}

async function saveCompany(): Promise<void> {
  if (companyBusy.value) return
  if (companyConflictRefreshRequired.value) {
    actionError.value = '必须先重新读取服务器最新资料，才能继续保存'
    return
  }
  const companyId = editingCompanyId.value
  const restoredCreate = companyId === null ? companyPendingCreate.value : null
  const payload = restoredCreate?.payload ?? companyPayload()
  if (!payload) return
  if (companyId !== null && editingCompanyRevision.value === null) {
    actionError.value = '当前公司版本信息缺失，请关闭后重新打开再编辑'
    return
  }
  const dialogVersion = companyDialogVersion
  const mutationVersion = ++companyMutationVersion
  companyBusy.value = true
  actionError.value = null
  const plannedCreate: PendingCompanyCreate | null = companyId === null
    ? restoredCreate ?? {
        path: '/api/companies',
        payload,
        idempotencyKey: crypto.randomUUID(),
        uncertain: true,
      }
    : null
  const persisted = plannedCreate === null
    || writeStoredValue(COMPANY_PENDING_CREATE_KEY, plannedCreate)
  if (plannedCreate) companyPendingCreate.value = plannedCreate
  let createdCompany: CompanyDetail | null = null
  try {
    const path = companyId === null
      ? '/api/companies'
      : `/api/companies/${companyId}`
    if (companyId === null) {
      if (!plannedCreate) return
      createdCompany = await createPlannedPostRequest<CompanyDetail>(
        plannedCreate.path,
        plannedCreate.payload,
        plannedCreate.idempotencyKey,
      ).send()
      clearCompanyPendingCreate()
    } else {
      await requestJson<CompanyDetail>(path, {
        method: 'PUT',
        body: { ...payload, expected_revision: editingCompanyRevision.value },
      })
    }
    const isCurrentDialog = dialogVersion === companyDialogVersion
    if (isCurrentDialog) {
      actionNotice.value = '公司已保存'
      companyDialogVisible.value = false
    }
    const refreshed = await loadCompanies()
    if (isCurrentDialog && createdCompany !== null) {
      detailLoadVersion += 1
      selectedDetailCompanyId.value = createdCompany.id
      detail.value = { ...createdCompany, contacts: createdCompany.contacts ?? [] }
      detailError.value = null
      detailLoading.value = false
      detailVisible.value = true
    }
    if (isCurrentDialog && !refreshed) {
      refreshWarning.value = '公司已保存，但列表刷新失败，请重新读取'
    }
  } catch (error) {
    const uncertainCreate = plannedCreate !== null && isUncertainMutation(error)
    if (plannedCreate !== null && !uncertainCreate) clearCompanyPendingCreate()
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === companyDialogVersion) {
      if (companyId !== null && isRevisionConflict(error)) {
        await refreshCompanyConflict(companyId, dialogVersion)
      } else {
        companyCreateUncertain.value = uncertainCreate
        actionError.value = uncertainCreate && !persisted
          ? `${errorMessage(error)}。浏览器无法保存本次重试凭据，请勿刷新此页。`
          : errorMessage(error)
      }
    }
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

async function refreshCompanyConflict(companyId: number, dialogVersion: number): Promise<void> {
  companyConflictRefreshRequired.value = true
  companyConflictLatest.value = null
  editingCompanyRevision.value = null
  try {
    const latest = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (dialogVersion !== companyDialogVersion || editingCompanyId.value !== companyId) return
    editingCompanyRevision.value = latest.revision
    companyConflictLatest.value = latest
    companyConflictRefreshRequired.value = false
    const summary = companies.value.find((item) => item.id === companyId)
    if (summary) Object.assign(summary, latest)
    actionError.value = '公司资料已被其他窗口修改。已显示服务器最新值，你填写的内容仍保留；核对后再次保存才会覆盖。'
  } catch (refreshError) {
    if (handleSessionError(refreshError) || dialogVersion !== companyDialogVersion) return
    actionError.value = `公司资料已变化，你填写的内容仍保留；最新资料读取失败：${errorMessage(refreshError)}`
  }
}

async function retryCompanyConflict(): Promise<void> {
  const companyId = editingCompanyId.value
  if (companyBusy.value || companyId === null) return
  const mutationVersion = ++companyMutationVersion
  companyBusy.value = true
  actionError.value = null
  try {
    await refreshCompanyConflict(companyId, companyDialogVersion)
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

function beforeCompanyClose(done: () => void): void {
  if (companyBusy.value || companyCreateUncertain.value) return
  confirmDirtyClose(companyFormFingerprint() !== companyFormBaseline, done)
}

function closeCompanyDialog(): void {
  beforeCompanyClose(() => { companyDialogVisible.value = false })
}

function abandonCompanyPendingCreate(): void {
  if (!companyCreateUncertain.value || companyBusy.value) return
  void ElMessageBox.confirm(
    '放弃后无法再用原请求安全核对创建结果；再次保存可能生成重复公司。确定继续吗？',
    '放弃结果未知的公司创建',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    clearCompanyPendingCreate()
    companyCreateUncertain.value = false
    companyFormBaseline = companyFormFingerprint()
    actionError.value = null
  }).catch(() => undefined)
}

function beforeDetailClose(done: () => void): void {
  if (!contactBusy.value) done()
}

async function loadDetail(companyId: number): Promise<boolean> {
  const version = ++detailLoadVersion
  detailLoading.value = true
  detailError.value = null
  try {
    const response = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (version === detailLoadVersion) detail.value = response
    return version === detailLoadVersion
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== detailLoadVersion) return false
    if (!isSessionError) detailError.value = errorMessage(error)
    return false
  } finally {
    if (version === detailLoadVersion) detailLoading.value = false
  }
}

async function openDetail(companyId: number): Promise<void> {
  actionError.value = null
  detail.value = null
  selectedDetailCompanyId.value = companyId
  detailVisible.value = true
  await loadDetail(companyId)
}

async function retryDetail(): Promise<void> {
  if (selectedDetailCompanyId.value === null) return
  await loadDetail(selectedDetailCompanyId.value)
}

function closeDetail(): void {
  detailLoadVersion += 1
  selectedDetailCompanyId.value = null
  detail.value = null
  detailError.value = null
  detailLoading.value = false
  actionError.value = null
}

function resetContactForm(): void {
  contactForm.name = ''
  contactForm.phone = ''
  contactForm.email = ''
  contactForm.position = ''
  contactForm.notes = ''
  contactValidationError.value = null
}

function openContactCreate(): void {
  if (contactCreateUncertain.value) {
    contactDialogVisible.value = true
    return
  }
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  actionError.value = null
  editingContactId.value = null
  editingContactRevision.value = null
  contactConflictLatest.value = null
  contactConflictRefreshRequired.value = false
  clearContactPendingCreate()
  resetContactForm()
  contactFormBaseline = contactFormFingerprint()
  contactDialogVisible.value = true
}

function openContactEdit(selected: RevisionedContact): void {
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  actionError.value = null
  editingContactId.value = selected.id
  editingContactRevision.value = selected.revision
  contactConflictLatest.value = null
  contactConflictRefreshRequired.value = false
  applyContactPayload(selected)
  contactFormBaseline = contactFormFingerprint()
  contactValidationError.value = null
  contactDialogVisible.value = true
}

function beforeContactClose(done: () => void): void {
  if (contactBusy.value || contactCreateUncertain.value) return
  confirmDirtyClose(contactFormFingerprint() !== contactFormBaseline, done)
}

function closeContactDialog(): void {
  beforeContactClose(() => { contactDialogVisible.value = false })
}

function abandonContactPendingCreate(): void {
  if (!contactCreateUncertain.value || contactBusy.value) return
  void ElMessageBox.confirm(
    '放弃后无法再用原请求安全核对创建结果；再次保存可能生成重复联系人。确定继续吗？',
    '放弃结果未知的联系人创建',
    { type: 'warning', confirmButtonText: '放弃并继续修改', cancelButtonText: '保留原请求' },
  ).then(() => {
    clearContactPendingCreate(selectedDetailCompanyId.value ?? undefined)
    contactCreateUncertain.value = false
    contactFormBaseline = contactFormFingerprint()
    actionError.value = null
  }).catch(() => undefined)
}

async function refreshDetailAndSummary(companyId: number, refreshDetail: boolean): Promise<boolean> {
  const detailRefreshed = !refreshDetail
    || selectedDetailCompanyId.value !== companyId
    || await loadDetail(companyId)
  const summaryRefreshed = await loadCompanies()
  return detailRefreshed && summaryRefreshed
}

async function saveContact(): Promise<void> {
  if (contactBusy.value) return
  if (contactConflictRefreshRequired.value) {
    actionError.value = '必须先重新读取服务器最新联系人，才能继续保存'
    return
  }
  const contactId = editingContactId.value
  const restoredCreate = contactId === null ? contactPendingCreate.value : null
  const payload = restoredCreate?.payload ?? contactPayload()
  if (!payload) return
  if (contactId !== null && editingContactRevision.value === null) {
    actionError.value = '当前联系人版本信息缺失，请关闭后重新打开再编辑'
    return
  }
  const dialogVersion = contactDialogVersion
  const mutationVersion = ++contactMutationVersion
  contactBusy.value = true
  actionError.value = null
  const companyId = restoredCreate?.companyId ?? detail.value?.id
  if (companyId === undefined) {
    contactBusy.value = false
    actionError.value = '无法确认联系人所属公司，请重新打开公司详情'
    return
  }
  const plannedCreate: PendingContactCreate | null = contactId === null
    ? restoredCreate ?? {
        companyId,
        path: `/api/companies/${companyId}/contacts`,
        payload,
        idempotencyKey: crypto.randomUUID(),
        uncertain: true,
      }
    : null
  const persisted = plannedCreate === null
    || writeStoredValue(contactPendingStorageKey(companyId), plannedCreate)
  if (plannedCreate) contactPendingCreate.value = plannedCreate
  try {
    const path = contactId === null
      ? `/api/companies/${companyId}/contacts`
      : `/api/companies/${companyId}/contacts/${contactId}`
    if (contactId === null) {
      if (!plannedCreate) return
      await createPlannedPostRequest<RevisionedContact>(
        plannedCreate.path,
        plannedCreate.payload,
        plannedCreate.idempotencyKey,
      ).send()
      clearContactPendingCreate(companyId)
    } else {
      await requestJson<RevisionedContact>(path, {
        method: 'PUT',
        body: { ...payload, expected_revision: editingContactRevision.value },
      })
    }
    const isCurrentDialog = dialogVersion === contactDialogVersion
    if (isCurrentDialog) contactDialogVisible.value = false
    const refreshed = await refreshDetailAndSummary(companyId, isCurrentDialog)
    if (isCurrentDialog) {
      actionNotice.value = '联系人已保存'
      if (!refreshed) refreshWarning.value = '联系人已保存，但列表刷新失败，请重新读取'
    }
  } catch (error) {
    const uncertainCreate = plannedCreate !== null && isUncertainMutation(error)
    if (plannedCreate !== null && !uncertainCreate) clearContactPendingCreate(companyId)
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === contactDialogVersion) {
      if (contactId !== null && isRevisionConflict(error)) {
        await refreshContactConflict(companyId, contactId, dialogVersion)
      } else {
        contactCreateUncertain.value = uncertainCreate
        actionError.value = uncertainCreate && !persisted
          ? `${errorMessage(error)}。浏览器无法保存本次重试凭据，请勿刷新此页。`
          : errorMessage(error)
      }
    }
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

async function refreshContactConflict(
  companyId: number,
  contactId: number,
  dialogVersion: number,
): Promise<void> {
  contactConflictRefreshRequired.value = true
  contactConflictLatest.value = null
  editingContactRevision.value = null
  try {
    const latestDetail = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (dialogVersion !== contactDialogVersion || editingContactId.value !== contactId) return
    detail.value = latestDetail
    const latest = latestDetail.contacts.find((item) => item.id === contactId)
    if (!latest) {
      editingContactRevision.value = null
      contactConflictLatest.value = null
      contactConflictRefreshRequired.value = false
      actionError.value = '该联系人已被其他窗口删除，你填写的内容仍保留，但不能继续覆盖。'
      return
    }
    editingContactRevision.value = latest.revision
    contactConflictLatest.value = latest
    contactConflictRefreshRequired.value = false
    actionError.value = '联系人已被其他窗口修改。已显示服务器最新值，你填写的内容仍保留；核对后再次保存才会覆盖。'
  } catch (refreshError) {
    if (handleSessionError(refreshError) || dialogVersion !== contactDialogVersion) return
    actionError.value = `联系人已变化，你填写的内容仍保留；最新资料读取失败：${errorMessage(refreshError)}`
  }
}

async function retryContactConflict(): Promise<void> {
  const companyId = detail.value?.id ?? selectedDetailCompanyId.value
  const contactId = editingContactId.value
  if (contactBusy.value || companyId === null || companyId === undefined || contactId === null) return
  const mutationVersion = ++contactMutationVersion
  contactBusy.value = true
  actionError.value = null
  try {
    await refreshContactConflict(companyId, contactId, contactDialogVersion)
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

function openCompanyDelete(company: CompanySummary): void {
  companyDeleteVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  companyDeleteTarget.value = company
  companyDeleteRefreshRequired.value = false
  companyDeleteVisible.value = true
  actionError.value = null
}

async function deleteCompany(): Promise<void> {
  if (companyBusy.value || !companyDeleteTarget.value) return
  if (companyDeleteRefreshRequired.value) {
    actionError.value = '必须先重新读取服务器最新资料，才能继续删除'
    return
  }
  const dialogVersion = companyDeleteVersion
  const mutationVersion = ++companyMutationVersion
  const companyId = companyDeleteTarget.value.id
  companyBusy.value = true
  actionError.value = null
  try {
    await requestVoid(`/api/companies/${companyId}`, {
      method: 'DELETE',
      body: { expected_revision: companyDeleteTarget.value.revision },
    })
    if (dialogVersion === companyDeleteVersion) companyDeleteVisible.value = false
    await loadCompanies()
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === companyDeleteVersion) {
      if (isRevisionConflict(error)) {
        await refreshCompanyDeleteConflict(companyId, dialogVersion)
      } else {
        actionError.value = errorMessage(error)
      }
    }
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

async function refreshCompanyDeleteConflict(companyId: number, dialogVersion: number): Promise<void> {
  companyDeleteRefreshRequired.value = true
  try {
    const latest = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (dialogVersion !== companyDeleteVersion || companyDeleteTarget.value?.id !== companyId) return
    companyDeleteTarget.value = {
      ...latest,
      contact_count: companyDeleteTarget.value.contact_count,
    }
    companyDeleteRefreshRequired.value = false
    actionError.value = '公司资料刚被其他窗口修改，已刷新全部资料和版本，请再次确认后删除。'
  } catch (refreshError) {
    if (handleSessionError(refreshError) || dialogVersion !== companyDeleteVersion) return
    actionError.value = `公司资料已变化，最新资料读取失败：${errorMessage(refreshError)}`
  }
}

async function retryCompanyDeleteConflict(): Promise<void> {
  const companyId = companyDeleteTarget.value?.id
  if (companyBusy.value || companyId === undefined) return
  const mutationVersion = ++companyMutationVersion
  companyBusy.value = true
  actionError.value = null
  try {
    await refreshCompanyDeleteConflict(companyId, companyDeleteVersion)
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

function openContactDelete(selected: RevisionedContact): void {
  contactDeleteVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  contactDeleteTarget.value = selected
  contactDeleteRefreshRequired.value = false
  contactDeleteVisible.value = true
  actionError.value = null
}

async function deleteContact(): Promise<void> {
  if (contactBusy.value || !detail.value || !contactDeleteTarget.value) return
  if (contactDeleteRefreshRequired.value) {
    actionError.value = '必须先重新读取服务器最新联系人，才能继续删除'
    return
  }
  const dialogVersion = contactDeleteVersion
  const mutationVersion = ++contactMutationVersion
  const companyId = detail.value.id
  const contactId = contactDeleteTarget.value.id
  contactBusy.value = true
  actionError.value = null
  try {
    await requestVoid(
      `/api/companies/${companyId}/contacts/${contactId}`,
      {
        method: 'DELETE',
        body: { expected_revision: contactDeleteTarget.value.revision },
      },
    )
    const isCurrentDialog = dialogVersion === contactDeleteVersion
    if (isCurrentDialog) contactDeleteVisible.value = false
    await refreshDetailAndSummary(companyId, isCurrentDialog)
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === contactDeleteVersion) {
      if (isRevisionConflict(error)) {
        await refreshContactDeleteConflict(companyId, contactId, dialogVersion)
      } else {
        actionError.value = errorMessage(error)
      }
    }
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

async function refreshContactDeleteConflict(
  companyId: number,
  contactId: number,
  dialogVersion: number,
): Promise<void> {
  contactDeleteRefreshRequired.value = true
  try {
    const latestDetail = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (dialogVersion !== contactDeleteVersion) return
    detail.value = latestDetail
    const latest = latestDetail.contacts.find((item) => item.id === contactId)
    contactDeleteTarget.value = latest ?? null
    contactDeleteRefreshRequired.value = false
    actionError.value = latest
      ? '联系人刚被其他窗口修改，已刷新全部资料和版本，请再次确认后删除。'
      : '该联系人已被其他窗口删除。'
  } catch (refreshError) {
    if (handleSessionError(refreshError) || dialogVersion !== contactDeleteVersion) return
    actionError.value = `联系人已变化，最新资料读取失败：${errorMessage(refreshError)}`
  }
}

async function retryContactDeleteConflict(): Promise<void> {
  const companyId = detail.value?.id ?? selectedDetailCompanyId.value
  const contactId = contactDeleteTarget.value?.id
  if (contactBusy.value || companyId === null || companyId === undefined || contactId === undefined) return
  const mutationVersion = ++contactMutationVersion
  contactBusy.value = true
  actionError.value = null
  try {
    await refreshContactDeleteConflict(companyId, contactId, contactDeleteVersion)
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

function beforeCompanyDeleteClose(done: () => void): void {
  if (!companyBusy.value) done()
}

function beforeContactDeleteClose(done: () => void): void {
  if (!contactBusy.value) done()
}

function restoreCompanyPendingCreate(): boolean {
  const stored = readStoredValue(COMPANY_PENDING_CREATE_KEY)
  if (stored === null) return false
  const pending = parseStoredCompanyCreate(stored)
  if (!pending) {
    removeStoredValue(COMPANY_PENDING_CREATE_KEY)
    return false
  }
  companyPendingCreate.value = pending
  companyCreateUncertain.value = true
  editingCompanyId.value = null
  editingCompanyRevision.value = null
  companyConflictLatest.value = null
  companyConflictRefreshRequired.value = false
  applyCompanyPayload(pending.payload)
  companyValidationError.value = null
  actionError.value = '检测到上次未确认结果的公司创建，请原样重试；不会生成新的请求。'
  companyDialogVisible.value = true
  return true
}

function storedContactCreateKeys(): string[] {
  try {
    return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => key?.startsWith(CONTACT_PENDING_CREATE_PREFIX) === true)
      .sort()
  } catch {
    return []
  }
}

function restoreContactPendingCreate(): PendingContactCreate | null {
  for (const key of storedContactCreateKeys()) {
    const companyIdText = key.slice(CONTACT_PENDING_CREATE_PREFIX.length)
    const companyId = Number(companyIdText)
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || String(companyId) !== companyIdText) {
      removeStoredValue(key)
      continue
    }
    const pending = parseStoredContactCreate(readStoredValue(key), companyId)
    if (!pending) {
      removeStoredValue(key)
      continue
    }
    contactPendingCreate.value = pending
    contactCreateUncertain.value = true
    editingContactId.value = null
    editingContactRevision.value = null
    contactConflictLatest.value = null
    contactConflictRefreshRequired.value = false
    applyContactPayload(pending.payload)
    contactValidationError.value = null
    selectedDetailCompanyId.value = companyId
    detailVisible.value = true
    contactDialogVisible.value = true
    actionError.value = '检测到上次未确认结果的联系人创建，请原样重试；不会生成新的请求。'
    return pending
  }
  return null
}

watch(companyDialogVisible, (visible) => {
  if (visible) return
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
})

watch(contactDialogVisible, (visible) => {
  if (visible) return
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  actionError.value = null
  contactValidationError.value = null
})

watch(companyDeleteVisible, (visible) => {
  if (visible) return
  companyDeleteVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  companyDeleteTarget.value = null
  companyDeleteRefreshRequired.value = false
})

watch(contactDeleteVisible, (visible) => {
  if (visible) return
  contactDeleteVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  contactDeleteTarget.value = null
  contactDeleteRefreshRequired.value = false
})

onMounted(async () => {
  const restoredCompany = restoreCompanyPendingCreate()
  const restoredContact = restoredCompany ? null : restoreContactPendingCreate()
  const companiesRequest = loadCompanies()
  if (restoredContact) await loadDetail(restoredContact.companyId)
  await companiesRequest
})
</script>

<template>
  <el-space class="page-stack" direction="vertical" alignment="stretch" fill :size="20">
    <section class="page-heading">
      <div>
        <h1>公司联系人</h1>
        <p>公司资料和联系人统一维护。</p>
      </div>
      <el-button data-testid="company-create-open" type="primary" size="large" @click="openCompanyCreate">
        新增公司
      </el-button>
    </section>

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-row class="list-toolbar" justify="space-between" align="middle">
          <el-text tag="strong" size="large">合作公司</el-text>
          <el-input
            data-testid="company-search"
            v-model="searchQuery"
            clearable
            placeholder="搜索公司、电话或税号"
            aria-label="搜索公司"
          />
        </el-row>
      </template>

      <el-alert
        v-if="actionError"
        data-testid="company-action-error"
        :title="actionError"
        type="error"
        show-icon
        :closable="false"
      />
      <el-alert v-if="actionNotice" :title="actionNotice" type="success" show-icon :closable="false" />
      <el-alert v-if="refreshWarning" :title="refreshWarning" type="warning" show-icon :closable="false" />

      <el-skeleton v-if="loading" data-testid="companies-loading" :rows="5" animated>
        <template #template><el-text>正在读取客户资料</el-text></template>
      </el-skeleton>
      <el-result
        v-else-if="listError"
        data-testid="companies-error"
        icon="error"
        title="客户资料读取失败"
        :sub-title="listError"
      >
        <template #extra>
          <el-button data-testid="companies-retry" type="primary" @click="loadCompanies">重新读取</el-button>
        </template>
      </el-result>
      <el-empty
        v-else-if="filteredCompanies.length === 0"
        data-testid="companies-empty"
        :description="companies.length === 0 ? '暂无客户，可以先新增公司' : '没有匹配的公司'"
      />
      <div v-else class="company-list-content">
      <div class="company-table-scroll">
      <el-table class="company-table" :data="filteredCompanies" row-key="id">
        <el-table-column prop="name" label="公司名称" min-width="180" />
        <el-table-column prop="taxpayer_id" label="税号" min-width="160">
          <template #default="scope">{{ scope.row.taxpayer_id ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="registered_phone" label="联系电话" min-width="140">
          <template #default="scope">{{ scope.row.registered_phone ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="contact_count" label="联系人" width="90" />
        <el-table-column label="操作" width="160">
          <template #default="scope">
            <el-space>
              <el-button :data-testid="`company-detail-${scope.row.id}`" :aria-label="`查看${scope.row.name}详情`" link type="primary" @click="openDetail(scope.row.id)">详情</el-button>
              <el-dropdown trigger="click">
                <el-button :data-testid="`company-more-${scope.row.id}`" :aria-label="`管理${scope.row.name}`" link>管理</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :data-testid="`company-edit-${scope.row.id}`" @click="openCompanyEdit(scope.row)">编辑</el-dropdown-item>
                    <el-dropdown-item :data-testid="`company-delete-${scope.row.id}`" divided @click="openCompanyDelete(scope.row)">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div class="company-mobile-list">
        <el-card v-for="company in filteredCompanies" :key="company.id" shadow="never" class="company-mobile-item">
          <strong>{{ company.name }}</strong>
          <span>电话：{{ company.registered_phone ?? '未录入' }}</span>
          <span>联系人：{{ company.contact_count }} 人</span>
          <div class="mobile-actions">
            <el-button :aria-label="`查看${company.name}详情`" type="primary" plain size="small" @click="openDetail(company.id)">详情</el-button>
            <el-dropdown trigger="click">
              <el-button :aria-label="`管理${company.name}`" plain size="small">管理</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="openCompanyEdit(company)">编辑</el-dropdown-item>
                  <el-dropdown-item divided @click="openCompanyDelete(company)">删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </div>
      </div>
    </el-card>

    <el-drawer
      v-model="companyDialogVisible"
      data-testid="company-form-drawer"
      :teleported="false"
      :title="editingCompanyId === null ? '新增公司' : '编辑公司'"
      size="min(92vw, 520px)"
      :before-close="beforeCompanyClose"
      :close-on-click-modal="!companyBusy"
      :close-on-press-escape="!companyBusy"
      :show-close="!companyBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert
        v-if="companyCreateUncertain"
        data-testid="company-create-uncertain"
        title="上次提交结果未知，为避免重复建档，表单已锁定。请原样重试。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-button
        v-if="companyCreateUncertain"
        data-testid="company-create-abandon"
        type="warning"
        plain
        :disabled="companyBusy"
        @click="abandonCompanyPendingCreate"
      >放弃原请求并继续修改</el-button>
      <el-alert v-if="companyValidationError" :title="companyValidationError" type="error" show-icon :closable="false" />
      <el-card v-if="companyConflictLatest" data-testid="company-conflict-latest" shadow="never">
        <template #header><el-text tag="strong">逐项核对：你的填写 / 服务器最新资料</el-text></template>
        <el-descriptions :column="1" border>
          <el-descriptions-item v-for="row in companyConflictRows" :key="row.key" :label="row.label">
            <el-space
              :data-testid="`company-conflict-field-${row.key}`"
              :class="{ 'is-different': row.different }"
              wrap
            >
              <el-text>你的填写：{{ row.draft }}</el-text>
              <el-text type="info">服务器最新：{{ row.latest }}</el-text>
              <el-tag v-if="row.different" type="warning" effect="plain">有变化</el-tag>
              <el-tag v-else type="success" effect="plain">一致</el-tag>
            </el-space>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>
      <el-button
        v-if="companyConflictRefreshRequired"
        data-testid="company-conflict-retry"
        type="warning"
        plain
        :loading="companyBusy"
        :disabled="companyBusy"
        @click="retryCompanyConflict"
      >
        重新读取最新值
      </el-button>
      <el-form label-position="top" @submit.prevent="saveCompany">
        <el-form-item label="公司名称" required><el-input data-testid="company-name" v-model="companyForm.name" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="纳税人识别号"><el-input data-testid="company-taxpayer-id" v-model="companyForm.taxpayer_id" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="注册地址"><el-input data-testid="company-address" v-model="companyForm.registered_address" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="注册电话"><el-input data-testid="company-phone" v-model="companyForm.registered_phone" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="开户行"><el-input data-testid="company-bank-name" v-model="companyForm.bank_name" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="银行账号"><el-input data-testid="company-bank-account" v-model="companyForm.bank_account" :disabled="companyFormLocked" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="company-notes" v-model="companyForm.notes" type="textarea" :disabled="companyFormLocked" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="company-cancel" :disabled="companyBusy || companyCreateUncertain" @click="closeCompanyDialog">取消</el-button>
          <el-button data-testid="company-save" type="primary" native-type="submit" :loading="companyBusy" :disabled="companyBusy || companyConflictRefreshRequired">
            {{ companyCreateUncertain ? '原样重试' : companyConflictLatest ? '确认覆盖最新资料' : '保存' }}
          </el-button>
        </div>
      </el-form>
    </el-drawer>

    <el-drawer
      v-model="detailVisible"
      data-testid="company-detail-drawer"
      :teleported="false"
      title="公司详情"
      size="min(100vw, 760px)"
      :before-close="beforeDetailClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
      @close="closeDetail"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <el-result v-else-if="detailError" data-testid="company-detail-error" icon="error" title="详情读取失败" :sub-title="detailError">
        <template #extra><el-button data-testid="company-detail-retry" type="primary" @click="retryDetail">重试</el-button></template>
      </el-result>
      <el-space
        v-else-if="detail"
        data-testid="company-detail-content"
        class="company-detail-content"
        direction="vertical"
        alignment="stretch"
        fill
        :size="16"
      >
        <el-descriptions :column="1" border>
          <el-descriptions-item label="公司名称">{{ detail.name }}</el-descriptions-item>
          <el-descriptions-item label="税号">{{ detail.taxpayer_id ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册地址">{{ detail.registered_address ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册电话">{{ detail.registered_phone ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="开户行">{{ detail.bank_name ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="银行账号">{{ detail.bank_account ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.notes ?? '无' }}</el-descriptions-item>
        </el-descriptions>
        <el-row justify="space-between" align="middle">
          <el-text tag="strong">联系人</el-text>
          <el-button data-testid="contact-create-open" type="primary" @click="openContactCreate">新增联系人</el-button>
        </el-row>
        <el-empty v-if="detail.contacts.length === 0" description="暂无联系人" />
        <div v-else class="contact-list-content">
        <div class="company-contact-table-scroll">
        <el-table data-testid="company-contact-table" class="company-contact-table" :data="detail.contacts" row-key="id">
          <el-table-column prop="name" label="姓名" min-width="110" />
          <el-table-column prop="phone" label="电话" min-width="150">
            <template #default="scope"><span :data-testid="`contact-phone-value-${scope.row.id}`" class="contact-phone-value">{{ scope.row.phone ?? '未录入' }}</span></template>
          </el-table-column>
          <el-table-column prop="email" label="邮箱" min-width="190"><template #default="scope">{{ scope.row.email ?? '未录入' }}</template></el-table-column>
          <el-table-column prop="position" label="职务" min-width="110"><template #default="scope">{{ scope.row.position ?? '未录入' }}</template></el-table-column>
          <el-table-column prop="notes" label="备注" min-width="180"><template #default="scope">{{ scope.row.notes ?? '无' }}</template></el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="scope">
              <el-button :data-testid="`contact-edit-${scope.row.id}`" :aria-label="`编辑联系人${scope.row.name}`" link @click="openContactEdit(scope.row)">编辑</el-button>
              <el-button :data-testid="`contact-delete-${scope.row.id}`" :aria-label="`删除联系人${scope.row.name}`" link type="danger" @click="openContactDelete(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        </div>
        <div class="contact-mobile-list">
          <el-card v-for="contact in detail.contacts" :key="contact.id" shadow="never" class="contact-mobile-item">
            <div><strong>{{ contact.name }}</strong><span>{{ contact.position ?? '未录入职务' }}</span></div>
            <span class="contact-phone-value">{{ contact.phone ?? '未录入电话' }}</span>
            <span>邮箱：{{ contact.email ?? '未录入' }}</span>
            <span>备注：{{ contact.notes ?? '无' }}</span>
            <div class="mobile-actions">
              <el-button :aria-label="`编辑联系人${contact.name}`" plain size="small" @click="openContactEdit(contact)">编辑</el-button>
              <el-button :aria-label="`删除联系人${contact.name}`" plain size="small" type="danger" @click="openContactDelete(contact)">删除</el-button>
            </div>
          </el-card>
        </div>
        </div>
      </el-space>
    </el-drawer>

    <el-dialog
      v-model="contactDialogVisible"
      data-testid="contact-dialog"
      :teleported="false"
      :title="editingContactId === null ? '新增联系人' : '编辑联系人'"
      width="min(92vw, 520px)"
      :before-close="beforeContactClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
    >
      <el-alert v-if="actionError" data-testid="contact-action-error" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert
        v-if="contactCreateUncertain"
        data-testid="contact-create-uncertain"
        title="上次提交结果未知，为避免重复建档，表单已锁定。请原样重试。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-button
        v-if="contactCreateUncertain"
        data-testid="contact-create-abandon"
        type="warning"
        plain
        :disabled="contactBusy"
        @click="abandonContactPendingCreate"
      >放弃原请求并继续修改</el-button>
      <el-alert v-if="contactValidationError" :title="contactValidationError" type="error" show-icon :closable="false" />
      <el-card v-if="contactConflictLatest" data-testid="contact-conflict-latest" shadow="never">
        <template #header><el-text tag="strong">逐项核对：你的填写 / 服务器最新联系人</el-text></template>
        <el-descriptions :column="1" border>
          <el-descriptions-item v-for="row in contactConflictRows" :key="row.key" :label="row.label">
            <el-space
              :data-testid="`contact-conflict-field-${row.key}`"
              :class="{ 'is-different': row.different }"
              wrap
            >
              <el-text>你的填写：{{ row.draft }}</el-text>
              <el-text type="info">服务器最新：{{ row.latest }}</el-text>
              <el-tag v-if="row.different" type="warning" effect="plain">有变化</el-tag>
              <el-tag v-else type="success" effect="plain">一致</el-tag>
            </el-space>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>
      <el-button
        v-if="contactConflictRefreshRequired"
        data-testid="contact-conflict-retry"
        type="warning"
        plain
        :loading="contactBusy"
        :disabled="contactBusy"
        @click="retryContactConflict"
      >
        重新读取最新值
      </el-button>
      <el-form label-position="top" @submit.prevent="saveContact">
        <el-form-item label="姓名" required><el-input data-testid="contact-name" v-model="contactForm.name" :disabled="contactFormLocked" /></el-form-item>
        <el-form-item label="电话"><el-input data-testid="contact-phone" v-model="contactForm.phone" :disabled="contactFormLocked" /></el-form-item>
        <el-form-item label="邮箱"><el-input data-testid="contact-email" v-model="contactForm.email" :disabled="contactFormLocked" /></el-form-item>
        <el-form-item label="职务"><el-input data-testid="contact-position" v-model="contactForm.position" :disabled="contactFormLocked" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="contact-notes" v-model="contactForm.notes" type="textarea" :disabled="contactFormLocked" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="contact-cancel" :disabled="contactBusy || contactCreateUncertain" @click="closeContactDialog">取消</el-button>
          <el-button data-testid="contact-save" type="primary" native-type="submit" :loading="contactBusy" :disabled="contactBusy || contactConflictRefreshRequired">
            {{ contactCreateUncertain ? '原样重试' : contactConflictLatest ? '确认覆盖最新资料' : '保存' }}
          </el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="companyDeleteVisible"
      data-testid="company-delete-dialog"
      :teleported="false"
      title="确认删除公司"
      width="min(92vw, 460px)"
      :before-close="beforeCompanyDeleteClose"
      :close-on-click-modal="!companyBusy"
      :close-on-press-escape="!companyBusy"
      :show-close="!companyBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert :title="`即将删除「${companyDeleteTarget?.name ?? ''}」及其联系人。`" type="warning" show-icon :closable="false" />
      <template #footer>
        <el-button :disabled="companyBusy" @click="companyDeleteVisible = false">取消</el-button>
        <el-button
          v-if="companyDeleteRefreshRequired"
          data-testid="company-delete-conflict-retry"
          type="warning"
          plain
          :loading="companyBusy"
          :disabled="companyBusy"
          @click="retryCompanyDeleteConflict"
        >
          重新读取最新值
        </el-button>
        <el-button data-testid="company-delete-confirm" type="danger" :loading="companyBusy" :disabled="companyBusy || companyDeleteRefreshRequired" @click="deleteCompany">确认删除</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="contactDeleteVisible"
      data-testid="contact-delete-dialog"
      :teleported="false"
      title="确认删除联系人"
      width="min(92vw, 460px)"
      :before-close="beforeContactDeleteClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-text>即将删除「{{ contactDeleteTarget?.name }}」。</el-text>
      <template #footer>
        <el-button :disabled="contactBusy" @click="contactDeleteVisible = false">取消</el-button>
        <el-button
          v-if="contactDeleteRefreshRequired"
          data-testid="contact-delete-conflict-retry"
          type="warning"
          plain
          :loading="contactBusy"
          :disabled="contactBusy"
          @click="retryContactDeleteConflict"
        >
          重新读取最新值
        </el-button>
        <el-button data-testid="contact-delete-confirm" type="danger" :loading="contactBusy" :disabled="contactBusy || contactDeleteRefreshRequired || !contactDeleteTarget" @click="deleteContact">确认删除</el-button>
      </template>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.list-toolbar { gap: 12px; }
.list-toolbar :deep(.el-input) { width: min(320px, 100%); }
.company-table-scroll,
.company-contact-table-scroll { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
.company-table { width: 100%; min-width: 850px; }
.company-contact-table { width: 100%; min-width: 560px; }
.company-mobile-list,
.contact-mobile-list { display: none; }
.contact-phone-value { display: inline-block; min-width: 11em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
.company-detail-content,
.company-detail-content > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
@media (max-width: 520px) {
  .company-table-scroll,
  .company-contact-table-scroll { display: none; }
  .company-mobile-list,
  .contact-mobile-list { display: grid; gap: 10px; }
  .company-mobile-item :deep(.el-card__body),
  .contact-mobile-item :deep(.el-card__body) { display: grid; gap: 8px; padding: 14px; }
  .company-mobile-item span,
  .contact-mobile-item span { color: var(--sunyu-muted); }
  .contact-mobile-item > :deep(.el-card__body > div:first-child) { display: flex; justify-content: space-between; gap: 12px; }
  .mobile-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .contact-mobile-item .mobile-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mobile-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
