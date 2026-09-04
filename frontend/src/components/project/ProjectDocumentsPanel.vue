<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { computed, inject, onBeforeUnmount, reactive, ref, shallowRef, triggerRef, watch } from 'vue'
import { routeLocationKey, routerKey } from 'vue-router'

import DragUploadField from '../common/DragUploadField.vue'
import { ApiError } from '../../api'
import type { DocumentDetail, DocumentSummary } from '../../domain/contracts'
import { formatChineseDateTime } from '../../domain/dates'
import { managedDocumentFilename, traceableDocumentFilename } from '../../domain/document-filenames'
import {
  clearPendingWrite,
  defaultProjectDocumentsPendingOwner,
  getPendingWrite,
  projectDocumentsPendingKey,
  setPendingWrite,
} from '../../pendingWriteRegistry'
import {
  createHttpProjectOperatingRepository,
  type DocumentArchiveFilter,
  type DocumentCreateInput,
  type DocumentListItem,
  type DocumentVersionInput,
  type ProjectOperatingRepository,
} from '../../repositories/project-operating.live'
import ProjectDocumentPreview from './ProjectDocumentPreview.vue'

const props = withDefaults(defineProps<{
  projectCode: string
  repository?: ProjectOperatingRepository
  readonly?: boolean
}>(), {
  readonly: false,
})
const emit = defineEmits<{ changed: [] }>()

const fallbackRepository = createHttpProjectOperatingRepository()
const repository = computed(() => props.repository ?? fallbackRepository)
const pendingOwner = ref<object>(props.repository ?? defaultProjectDocumentsPendingOwner)
const route = inject(routeLocationKey, null)
const router = inject(routerKey, null)
const documents = ref<DocumentListItem[]>([])
const loading = ref(true)
const refreshing = ref(false)
const hasLoadedDocuments = ref(false)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const refreshWarning = ref<string | null>(null)
const notice = ref('文档文件保存在当前项目的独立目录中。')
const busy = ref(false)
const createVisible = ref(false)
const minutesVisible = ref(false)
const historyVisible = ref(false)
const editVisible = ref(false)
const versionVisible = ref(false)
const archiveVisible = ref(false)
const selectedDocumentId = ref<number | null>(null)
const validationError = ref<string | null>(null)
const selectedCreateFile = ref<File | null>(null)
const selectedVersionFile = ref<File | null>(null)
const minutesMode = ref<'create' | 'version'>('create')
const minutesTitle = ref('')
const minutesContent = ref('')
const historyDetail = ref<DocumentDetail | null>(null)
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
const historyProjectCode = ref<string | null>(null)
const previewDocumentId = ref<number | null>(null)
const localPreviewVersionId = ref<number | null>(null)
const documentTotal = ref(0)
const documentPage = ref(1)
const documentPageSize = ref(20)
const searchInput = ref('')
const categoryFilter = ref('')
const archiveFilter = ref<DocumentArchiveFilter>('active')
const appliedSearch = ref('')
const appliedCategory = ref('')
const appliedArchive = ref<DocumentArchiveFilter>('active')
const versionCount = computed(() => documents.value.reduce(
  (total, document) => total + document.latest_version_number,
  0,
))
const ledgerSummary = computed(() => (
  documentTotal.value === documents.value.length
    ? `${documentTotal.value} 份资料 · ${versionCount.value} 个历史版本。资料数量不代表审批完成或项目进度。`
    : `共 ${documentTotal.value} 份资料 · 当前页 ${documents.value.length} 份 / ${versionCount.value} 个版本。资料数量不代表审批完成或项目进度。`
))
let loadVersion = 0
let minutesMutationGeneration = 0
let minutesMutationActive = false
let fileMutationGeneration = 0
let fileMutationActive = false
let historyGeneration = 0
let historyDownloadActive = false
let downloadGeneration = 0
let downloadActive = false
let mounted = true
let editBaseline = ''

interface MinutesMutationContext {
  generation: number
  projectCode: string
  repository: ProjectOperatingRepository
}

interface FileMutationContext {
  generation: number
  projectCode: string
  repository: ProjectOperatingRepository
}

interface HistoryContext {
  generation: number
  projectCode: string
  documentId: number
  repository: ProjectOperatingRepository
}

interface DownloadContext {
  generation: number
  loadGeneration: number
  projectCode: string
  documentId: number
  repository: ProjectOperatingRepository
}

interface PendingMinutesCreateSubmission {
  kind: 'create'
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  input: DocumentCreateInput
  content: string
  inFlight: boolean
}

interface PendingMinutesVersionSubmission {
  kind: 'version'
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  documentId: number
  documentTitle: string
  input: DocumentVersionInput
  content: string
  inFlight: boolean
}

type PendingMinutesSubmission = PendingMinutesCreateSubmission | PendingMinutesVersionSubmission

interface PendingDocumentCreateSubmission {
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  input: DocumentCreateInput
  inFlight: boolean
}

interface PendingDocumentVersionSubmission {
  owner: object
  key: string
  projectCode: string
  repository: ProjectOperatingRepository
  documentId: number
  documentTitle: string
  input: DocumentVersionInput
  inFlight: boolean
}

const pendingMinutesSubmission = shallowRef<PendingMinutesSubmission | null>(null)
const pendingDocumentCreateSubmission = shallowRef<PendingDocumentCreateSubmission | null>(null)
const pendingDocumentVersionSubmission = shallowRef<PendingDocumentVersionSubmission | null>(null)
const currentDocumentCreateSubmission = computed(() => getPendingWrite<PendingDocumentCreateSubmission>(
  pendingOwner.value,
  projectDocumentsPendingKey('create', props.projectCode),
))
const currentDocumentVersionSubmission = computed(() => getPendingWrite<PendingDocumentVersionSubmission>(
  pendingOwner.value,
  projectDocumentsPendingKey('version', props.projectCode),
))
const currentMinutesCreateSubmission = computed(() => getPendingWrite<PendingMinutesSubmission>(
  pendingOwner.value,
  projectDocumentsPendingKey('minutes-create', props.projectCode),
))
const currentMinutesVersionSubmission = computed(() => getPendingWrite<PendingMinutesSubmission>(
  pendingOwner.value,
  projectDocumentsPendingKey('minutes-version', props.projectCode),
))
const currentMinutesSubmission = computed(() => pendingMinutesSubmission.value?.kind === minutesMode.value
  ? pendingMinutesSubmission.value
  : null)
const recoverableDocumentCreateSubmission = computed(() => {
  const pending = pendingDocumentCreateSubmission.value
  return pending
    && !pending.inFlight
    && pending.projectCode === props.projectCode
    && pending.owner === pendingOwner.value
    ? pending
    : null
})
const recoverableDocumentVersionSubmission = computed(() => {
  const pending = pendingDocumentVersionSubmission.value
  return pending
    && !pending.inFlight
    && pending.projectCode === props.projectCode
    && pending.owner === pendingOwner.value
    && pending.documentId === selectedDocumentId.value
    ? pending
    : null
})
const recoverableMinutesSubmission = computed(() => {
  const pending = pendingMinutesSubmission.value
  if (
    !pending
    || pending.inFlight
    || pending.projectCode !== props.projectCode
    || pending.owner !== pendingOwner.value
    || pending.kind !== minutesMode.value
  ) return null
  if (pending.kind === 'version' && pending.documentId !== selectedDocumentId.value) return null
  return pending
})

function storePendingSubmission<T extends { owner: object; key: string }>(pending: T): T {
  setPendingWrite(pending.owner, pending.key, pending)
  return pending
}

function releasePendingSubmission<T extends { owner: object; key: string }>(pending: T): void {
  clearPendingWrite(pending.owner, pending.key, pending)
  if (Object.is(pendingDocumentCreateSubmission.value, pending)) pendingDocumentCreateSubmission.value = null
  if (Object.is(pendingDocumentVersionSubmission.value, pending)) pendingDocumentVersionSubmission.value = null
  if (Object.is(pendingMinutesSubmission.value, pending)) pendingMinutesSubmission.value = null
}

const categories = [
  'planning_minutes',
  'site_survey',
  'quotation',
  'technical_agreement',
  'contract',
  'mechanical_design',
  'electrical_design',
  'procurement_list',
  'procurement_contract',
  'mechanical_signoff',
  'electrical_signoff',
  'construction',
  'commissioning',
  'acceptance',
  'invoice',
  'warranty',
  'after_sales',
  'other',
] as const

const categoryLabels: Record<(typeof categories)[number], string> = {
  planning_minutes: '项目策划纪要',
  site_survey: '现场勘查',
  quotation: '报价资料',
  technical_agreement: '技术协议',
  contract: '项目合同',
  mechanical_design: '机械设计',
  electrical_design: '电气设计',
  procurement_list: '采购清单',
  procurement_contract: '采购合同',
  mechanical_signoff: '机械会签',
  electrical_signoff: '电气会签',
  construction: '施工资料',
  commissioning: '调试资料',
  acceptance: '验收资料',
  invoice: '发票资料',
  warranty: '质保资料',
  after_sales: '售后资料',
  other: '其他',
}

function categoryLabel(category: string): string {
  return categoryLabels[category as keyof typeof categoryLabels] ?? category
}

const createForm = reactive({ category: 'other', title: '', notes: '' })
const editForm = reactive({ category: 'other', title: '', notes: '' })
const versionNotes = ref('')
const archiveReason = ref('')
const previewVersionId = computed(() => {
  if (!route || route.name !== 'project-document') return localPreviewVersionId.value
  const raw = route.query.version
  const versionId = typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(versionId) && versionId > 0 ? versionId : null
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '文档操作失败'
}

async function loadDocuments(page = documentPage.value): Promise<void> {
  const version = ++loadVersion
  const firstLoad = !hasLoadedDocuments.value
  const query = {
    page,
    page_size: documentPageSize.value,
    search: searchInput.value.trim(),
    category: categoryFilter.value,
    archived: archiveFilter.value,
  } as const
  loading.value = firstLoad
  refreshing.value = !firstLoad
  if (firstLoad) loadError.value = null
  try {
    const projectCode = props.projectCode
    const activeRepository = repository.value
    const listing = await activeRepository.listDocuments(projectCode, query)
    if (version === loadVersion) {
      documents.value = listing.items
      documentTotal.value = listing.total
      documentPage.value = listing.page
      documentPageSize.value = listing.page_size
      appliedSearch.value = query.search
      appliedCategory.value = query.category
      appliedArchive.value = query.archived
      hasLoadedDocuments.value = true
      loadError.value = null
      refreshWarning.value = null
    }
  } catch (error) {
    if (version === loadVersion) {
      if (hasLoadedDocuments.value) {
        refreshWarning.value = `${errorMessage(error)}；仍显示上一次成功读取的资料。`
      } else {
        loadError.value = errorMessage(error)
      }
    }
  } finally {
    if (version === loadVersion) {
      loading.value = false
      refreshing.value = false
    }
  }
}

function applyFilters(): void {
  void loadDocuments(1)
}

function resetFilters(): void {
  searchInput.value = ''
  categoryFilter.value = ''
  archiveFilter.value = 'active'
  void loadDocuments(1)
}

interface HighlightPart {
  text: string
  matched: boolean
}

function highlightParts(value: string): HighlightPart[] {
  const needle = appliedSearch.value.trim()
  if (!needle) return [{ text: value, matched: false }]
  const lowerValue = value.toLocaleLowerCase()
  const lowerNeedle = needle.toLocaleLowerCase()
  const parts: HighlightPart[] = []
  let cursor = 0
  let position = lowerValue.indexOf(lowerNeedle)
  while (position >= 0) {
    if (position > cursor) {
      parts.push({ text: value.slice(cursor, position), matched: false })
    }
    const end = position + needle.length
    parts.push({ text: value.slice(position, end), matched: true })
    cursor = end
    position = lowerValue.indexOf(lowerNeedle, cursor)
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), matched: false })
  return parts.length > 0 ? parts : [{ text: value, matched: false }]
}

function insertCreatedDocument(document: DocumentDetail, textContent = ''): void {
  if (appliedArchive.value === 'archived') return
  if (appliedCategory.value && appliedCategory.value !== document.category) return
  const needle = appliedSearch.value.toLocaleLowerCase()
  const searchable = [
    document.title,
    document.notes ?? '',
    textContent,
    ...document.versions.flatMap((version) => [
      version.managed_filename ?? '',
      version.original_filename,
      version.notes ?? '',
    ]),
  ].join('\n').toLocaleLowerCase()
  if (needle && !searchable.includes(needle)) return
  documentTotal.value += 1
  if (documentPage.value !== 1) return
  documents.value = [toSummary(document), ...documents.value]
    .slice(0, documentPageSize.value)
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function confirmDraftClose(dirty: boolean, done: () => void): void {
  if (busy.value) return
  if (!dirty) {
    done()
    return
  }
  void ElMessageBox.confirm(
    '关闭后未保存的内容或已选择文件会丢失，确定关闭吗？',
    '放弃未保存内容',
    {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '继续填写',
    },
  ).then(() => done()).catch(() => undefined)
}

function isCreateDirty(): boolean {
  return createForm.category !== 'other'
    || createForm.title !== ''
    || createForm.notes !== ''
    || selectedCreateFile.value !== null
}

function resetCreateDraft(): void {
  Object.assign(createForm, { category: 'other', title: '', notes: '' })
  selectedCreateFile.value = null
  validationError.value = null
}

function discardDocumentCreateSubmission(pending: PendingDocumentCreateSubmission): boolean {
  const discarded = pending.repository.discardCreateDocument(pending.projectCode, pending.input)
  if (discarded) releasePendingSubmission(pending)
  return discarded
}

function abandonPendingDocumentCreateSubmission(): void {
  const pending = recoverableDocumentCreateSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后不能再使用原请求安全重试，确定继续修改资料吗？',
    '放弃结果未知的资料上传',
    {
      type: 'warning',
      confirmButtonText: '放弃并继续修改',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (discardDocumentCreateSubmission(pending)) {
      validationError.value = null
      return
    }
    validationError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function requestCreateClose(done: () => void): void {
  const pending = pendingDocumentCreateSubmission.value
  if (!pending) {
    confirmDraftClose(isCreateDirty(), () => {
      resetCreateDraft()
      done()
    })
    return
  }
  void ElMessageBox.confirm(
    '本次资料上传结果未知。放弃后不能再使用原请求安全重试，确定关闭吗？',
    '放弃结果未知的资料上传',
    {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (!discardDocumentCreateSubmission(pending)) {
      validationError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
      return
    }
    resetCreateDraft()
    done()
  }).catch(() => undefined)
}

function beforeCreateClose(done: () => void): void {
  if (busy.value) return
  requestCreateClose(done)
}

function cancelCreate(): void {
  if (busy.value) return
  requestCreateClose(() => { createVisible.value = false })
}

function isMinutesDirty(): boolean {
  return minutesContent.value !== ''
    || (minutesMode.value === 'create' && minutesTitle.value !== '')
}

function resetMinutesDraft(): void {
  minutesTitle.value = ''
  minutesContent.value = ''
  selectedDocumentId.value = null
  validationError.value = null
}

function requestMinutesClose(done: () => void): void {
  const pending = currentMinutesSubmission.value
  if (!pending) {
    confirmDraftClose(isMinutesDirty(), () => {
      resetMinutesDraft()
      done()
    })
    return
  }
  void ElMessageBox.confirm(
    '本次保存结果未知。放弃后不能再用原请求安全重试，确定关闭吗？',
    '放弃结果未知的纪要',
    {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (!discardMinutesSubmission(pending)) {
      validationError.value = '原请求仍在处理中，暂时不能放弃'
      return
    }
    resetMinutesDraft()
    done()
  }).catch(() => undefined)
}

function beforeMinutesClose(done: () => void): void {
  if (busy.value) return
  requestMinutesClose(done)
}

function cancelMinutes(): void {
  if (busy.value) return
  requestMinutesClose(() => { minutesVisible.value = false })
}

function editFingerprint(): string {
  return JSON.stringify([editForm.category, editForm.title, editForm.notes])
}

function resetEditDraft(): void {
  selectedDocumentId.value = null
  validationError.value = null
}

function beforeEditClose(done: () => void): void {
  confirmDraftClose(editFingerprint() !== editBaseline, () => {
    resetEditDraft()
    done()
  })
}

function cancelEdit(): void {
  confirmDraftClose(editFingerprint() !== editBaseline, () => {
    resetEditDraft()
    editVisible.value = false
  })
}

function isVersionDirty(): boolean {
  return selectedVersionFile.value !== null || versionNotes.value !== ''
}

function resetVersionDraft(): void {
  selectedDocumentId.value = null
  selectedVersionFile.value = null
  versionNotes.value = ''
  validationError.value = null
}

function discardDocumentVersionSubmission(pending: PendingDocumentVersionSubmission): boolean {
  const discarded = pending.repository.discardAddDocumentVersion(
    pending.projectCode,
    pending.documentId,
    pending.input,
  )
  if (discarded) releasePendingSubmission(pending)
  return discarded
}

function abandonPendingDocumentVersionSubmission(): void {
  const pending = recoverableDocumentVersionSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后不能再使用原请求安全重试，确定继续修改版本吗？',
    '放弃结果未知的版本上传',
    {
      type: 'warning',
      confirmButtonText: '放弃并继续修改',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (discardDocumentVersionSubmission(pending)) {
      validationError.value = null
      return
    }
    validationError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
  }).catch(() => undefined)
}

function requestVersionClose(done: () => void): void {
  const pending = pendingDocumentVersionSubmission.value
  if (!pending) {
    confirmDraftClose(isVersionDirty(), () => {
      resetVersionDraft()
      done()
    })
    return
  }
  void ElMessageBox.confirm(
    '本次版本上传结果未知。放弃后不能再使用原请求安全重试，确定关闭吗？',
    '放弃结果未知的版本上传',
    {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (!discardDocumentVersionSubmission(pending)) {
      validationError.value = '原请求暂时无法放弃，已继续保留；请原样重试'
      return
    }
    resetVersionDraft()
    done()
  }).catch(() => undefined)
}

function beforeVersionClose(done: () => void): void {
  if (busy.value) return
  requestVersionClose(done)
}

function cancelVersion(): void {
  if (busy.value) return
  requestVersionClose(() => { versionVisible.value = false })
}

function isArchiveDirty(): boolean {
  return archiveReason.value !== ''
}

function resetArchiveDraft(): void {
  selectedDocumentId.value = null
  archiveReason.value = ''
  validationError.value = null
}

function beforeArchiveClose(done: () => void): void {
  confirmDraftClose(isArchiveDirty(), () => {
    resetArchiveDraft()
    done()
  })
}

function cancelArchive(): void {
  confirmDraftClose(isArchiveDirty(), () => {
    resetArchiveDraft()
    archiveVisible.value = false
  })
}

function openCreate(): void {
  if (props.readonly) return
  resetCreateDraft()
  createVisible.value = true
}

function openCreateMinutes(): void {
  if (props.readonly) return
  minutesMode.value = 'create'
  selectedDocumentId.value = null
  minutesTitle.value = ''
  minutesContent.value = ''
  validationError.value = null
  minutesVisible.value = true
}

function routedProjectCode(): string | null {
  const projectCode = route?.params.projectCode
  return typeof projectCode === 'string' ? projectCode : null
}

function routedDocumentId(): number | null {
  if (
    !route
    || route.name !== 'project-document'
    || routedProjectCode() !== props.projectCode
  ) return null
  const raw = route.params.documentId
  const documentId = typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(documentId) && documentId > 0 ? documentId : null
}

function synchronizePreviewRoute(): void {
  previewDocumentId.value = routedDocumentId()
  if (previewDocumentId.value === null) {
    localPreviewVersionId.value = null
  }
}

function openPreview(document: DocumentSummary): void {
  if (router) {
    void router.push({
      name: 'project-document',
      params: { projectCode: props.projectCode, documentId: document.id },
    })
    return
  }
  previewDocumentId.value = document.id
  localPreviewVersionId.value = null
}

function navigatePreview(documentId: number, versionId: number | null): void {
  if (router) {
    void router.push({
      name: 'project-document',
      params: { projectCode: props.projectCode, documentId },
      query: versionId === null ? {} : { version: String(versionId) },
    })
    return
  }
  previewDocumentId.value = documentId
  localPreviewVersionId.value = versionId
}

function resolvePreviewVersion(versionId: number): void {
  localPreviewVersionId.value = versionId
  if (!router || previewDocumentId.value === null) return
  void router.replace({
    name: 'project-document',
    params: { projectCode: props.projectCode, documentId: previewDocumentId.value },
    query: { version: String(versionId) },
  })
}

function closePreview(): void {
  previewDocumentId.value = null
  localPreviewVersionId.value = null
  if (router && route?.name === 'project-document') {
    void router.replace({ name: 'project-documents', params: { projectCode: props.projectCode } })
  }
}

function openMinutesVersion(document: DocumentSummary): void {
  if (props.readonly) return
  minutesMode.value = 'version'
  selectedDocumentId.value = document.id
  minutesTitle.value = document.title
  minutesContent.value = ''
  validationError.value = null
  minutesVisible.value = true
}

function startFileMutation(): FileMutationContext {
  fileMutationActive = true
  return {
    generation: ++fileMutationGeneration,
    projectCode: props.projectCode,
    repository: repository.value,
  }
}

function isCurrentFileMutation(context: FileMutationContext): boolean {
  return mounted
    && context.generation === fileMutationGeneration
    && context.projectCode === props.projectCode
    && context.repository === repository.value
}

function startMinutesMutation(): MinutesMutationContext {
  minutesMutationActive = true
  return {
    generation: ++minutesMutationGeneration,
    projectCode: props.projectCode,
    repository: repository.value,
  }
}

function isCurrentMinutesMutation(context: MinutesMutationContext): boolean {
  return context.generation === minutesMutationGeneration
    && context.projectCode === props.projectCode
    && context.repository === repository.value
}

function minutesFile(content: string): File {
  return new File([content], 'planning-minutes.txt', { type: 'text/plain' })
}

function isDefinitiveSubmissionFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function discardMinutesSubmission(pending: PendingMinutesSubmission): boolean {
  const discarded = pending.kind === 'create'
    ? pending.repository.discardCreateDocument(pending.projectCode, pending.input)
    : pending.repository.discardAddDocumentVersion(
      pending.projectCode,
      pending.documentId,
      pending.input,
    )
  if (discarded) releasePendingSubmission(pending)
  return discarded
}

function abandonPendingMinutesSubmission(): void {
  const pending = recoverableMinutesSubmission.value
  if (!pending) return
  void ElMessageBox.confirm(
    '放弃后不能再使用原请求安全重试，确定继续修改纪要吗？',
    '放弃结果未知的纪要',
    {
      type: 'warning',
      confirmButtonText: '放弃并继续修改',
      cancelButtonText: '保留原请求',
    },
  ).then(() => {
    if (discardMinutesSubmission(pending)) {
      validationError.value = null
      return
    }
    validationError.value = '原请求仍在处理中，暂时不能放弃'
  }).catch(() => undefined)
}

function prepareMinutesSubmission(): PendingMinutesSubmission | null {
  const recoverable = recoverableMinutesSubmission.value
  if (recoverable) return recoverable
  const mode = minutesMode.value
  const title = minutesTitle.value.trim()
  const content = minutesContent.value.trim()
  const document = mode === 'version'
    ? documents.value.find((item) => item.id === selectedDocumentId.value)
    : undefined
  if (!content || (mode === 'create' && !title)) {
    validationError.value = mode === 'create'
      ? '请填写纪要标题和内容'
      : '请填写本版纪要内容'
    return null
  }
  if (mode === 'version' && !document) {
    validationError.value = '要追加的纪要已不存在'
    return null
  }
  const common = {
    owner: pendingOwner.value,
    key: projectDocumentsPendingKey(
      mode === 'create' ? 'minutes-create' : 'minutes-version',
      props.projectCode,
    ),
    projectCode: props.projectCode,
    repository: repository.value,
    content,
    inFlight: true,
  }
  return mode === 'create'
    ? {
        ...common,
        kind: 'create',
        input: { category: 'planning_minutes', title, notes: null, file: minutesFile(content) },
      }
    : {
        ...common,
        kind: 'version',
        documentId: document!.id,
        documentTitle: document!.title,
        input: { notes: null, expected_revision: document!.revision, file: minutesFile(content) },
      }
}

function finishMinutesSubmission(pending: PendingMinutesSubmission): void {
  pending.inFlight = false
  releasePendingSubmission(pending)
}

async function executeMinutesSubmission(
  pending: PendingMinutesSubmission,
  context: MinutesMutationContext,
): Promise<void> {
  if (pending.kind === 'create') {
    const created = await pending.repository.createDocument(pending.projectCode, pending.input)
    finishMinutesSubmission(pending)
    if (!isCurrentMinutesMutation(context)) return
    insertCreatedDocument(created, pending.content)
    notice.value = `已保存 ${created.title} V${created.latest_version_number}。`
    return
  }
  const added = await pending.repository.addDocumentVersion(
    pending.projectCode,
    pending.documentId,
    pending.input,
  )
  finishMinutesSubmission(pending)
  if (!isCurrentMinutesMutation(context)) return
  notice.value = `已保存 ${pending.documentTitle} V${added.version_number}。`
  try {
    const refreshed = await context.repository.getDocument(context.projectCode, pending.documentId)
    if (!isCurrentMinutesMutation(context)) return
    replaceDocument(refreshed)
  } catch {
    if (isCurrentMinutesMutation(context)) {
      refreshWarning.value = '已保存文字纪要，但刷新失败，请刷新页面。'
    }
  }
}

function handleMinutesSubmissionFailure(
  pending: PendingMinutesSubmission,
  context: MinutesMutationContext,
  error: unknown,
): void {
  pending.inFlight = false
  if (isDefinitiveSubmissionFailure(error)) {
    releasePendingSubmission(pending)
  } else {
    storePendingSubmission(pending)
    triggerRef(pendingMinutesSubmission)
  }
  if (isCurrentMinutesMutation(context)) validationError.value = errorMessage(error)
}

async function saveMinutes(): Promise<void> {
  if (props.readonly || busy.value) return
  const pending = prepareMinutesSubmission()
  if (!pending) return
  const context = startMinutesMutation()
  pending.inFlight = true
  pendingMinutesSubmission.value = pending
  storePendingSubmission(pending)
  busy.value = true
  validationError.value = null
  actionError.value = null
  refreshWarning.value = null
  try {
    await executeMinutesSubmission(pending, context)
    if (!isCurrentMinutesMutation(context)) return
    minutesVisible.value = false
    minutesContent.value = ''
    if (pending.kind === 'create') await loadDocuments(1)
    if (!isCurrentMinutesMutation(context)) return
    emit('changed')
  } catch (error) {
    handleMinutesSubmissionFailure(pending, context, error)
  } finally {
    if (isCurrentMinutesMutation(context)) {
      minutesMutationActive = false
      busy.value = false
    }
  }
}

async function openHistory(documentId: number): Promise<void> {
  const context: HistoryContext = {
    generation: ++historyGeneration,
    projectCode: props.projectCode,
    documentId,
    repository: repository.value,
  }
  selectedDocumentId.value = documentId
  historyProjectCode.value = context.projectCode
  historyDetail.value = null
  historyError.value = null
  historyLoading.value = true
  historyVisible.value = true
  try {
    const detail = await context.repository.getDocument(context.projectCode, context.documentId)
    if (isCurrentHistory(context)) historyDetail.value = detail
  } catch (error) {
    if (isCurrentHistory(context)) historyError.value = errorMessage(error)
  } finally {
    if (isCurrentHistory(context)) historyLoading.value = false
  }
}

function isCurrentHistory(context: HistoryContext): boolean {
  return context.generation === historyGeneration
    && context.projectCode === props.projectCode
    && context.projectCode === historyProjectCode.value
    && context.documentId === selectedDocumentId.value
    && context.repository === repository.value
}

function startDownload(documentId: number): DownloadContext {
  downloadActive = true
  return {
    generation: ++downloadGeneration,
    loadGeneration: loadVersion,
    projectCode: props.projectCode,
    documentId,
    repository: repository.value,
  }
}

function ownsDownload(context: DownloadContext): boolean {
  return mounted
    && context.generation === downloadGeneration
    && context.projectCode === props.projectCode
    && context.repository === repository.value
}

function isCurrentDownload(context: DownloadContext): boolean {
  return ownsDownload(context) && context.loadGeneration === loadVersion
}

async function downloadHistoryVersion(version: DocumentDetail['versions'][number]): Promise<void> {
  const document = historyDetail.value
  const projectCode = historyProjectCode.value
  if (!document || !projectCode || projectCode !== props.projectCode) return
  const context: HistoryContext = {
    generation: historyGeneration,
    projectCode,
    documentId: document.id,
    repository: repository.value,
  }
  const downloadContext = startDownload(document.id)
  historyDownloadActive = true
  busy.value = true
  actionError.value = null
  try {
    const file = await context.repository.downloadDocumentVersion(
      context.projectCode,
      context.documentId,
      version.id,
    )
    if (!isCurrentHistory(context) || !isCurrentDownload(downloadContext)) return
    const url = URL.createObjectURL(file)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = managedDocumentFilename(version)
    anchor.click()
    URL.revokeObjectURL(url)
    notice.value = `已下载 ${managedDocumentFilename(version)}。`
  } catch (error) {
    if (isCurrentHistory(context) && isCurrentDownload(downloadContext)) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (isCurrentHistory(context) && ownsDownload(downloadContext)) {
      historyDownloadActive = false
      downloadActive = false
      busy.value = false
    }
  }
}

function openEdit(document: DocumentSummary): void {
  if (props.readonly) return
  selectedDocumentId.value = document.id
  editForm.category = document.category
  editForm.title = document.title
  editForm.notes = document.notes ?? ''
  editBaseline = editFingerprint()
  validationError.value = null
  editVisible.value = true
}

async function saveEdit(): Promise<void> {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  const title = editForm.title.trim()
  if (!document || !title) {
    validationError.value = '请填写文档标题'
    return
  }
  busy.value = true
  validationError.value = null
  actionError.value = null
  try {
    const updated = await repository.value.updateDocument(props.projectCode, document.id, {
      title,
      notes: nullable(editForm.notes),
      expected_revision: document.revision,
    })
    replaceDocument(updated)
    editVisible.value = false
    notice.value = '文档信息已保存。'
    await loadDocuments(documentPage.value)
    emit('changed')
  } catch (error) {
    validationError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function saveCreate(): Promise<void> {
  if (props.readonly || busy.value) return
  let pending = recoverableDocumentCreateSubmission.value
  if (!pending) {
    const title = createForm.title.trim()
    const file = selectedCreateFile.value
    if (!title || !file) {
      validationError.value = '请填写标题并选择文件'
      return
    }
    pending = {
      owner: pendingOwner.value,
      key: projectDocumentsPendingKey('create', props.projectCode),
      projectCode: props.projectCode,
      repository: repository.value,
      input: {
        category: createForm.category,
        title,
        notes: nullable(createForm.notes),
        file,
      },
      inFlight: false,
    }
    pendingDocumentCreateSubmission.value = pending
    storePendingSubmission(pending)
  }
  const context = startFileMutation()
  pending.inFlight = true
  storePendingSubmission(pending)
  triggerRef(pendingDocumentCreateSubmission)
  busy.value = true
  validationError.value = null
  actionError.value = null
  try {
    const created = await pending.repository.createDocument(pending.projectCode, pending.input)
    pending.inFlight = false
    releasePendingSubmission(pending)
    if (!isCurrentFileMutation(context)) return
    insertCreatedDocument(created)
    createVisible.value = false
    selectedCreateFile.value = null
    Object.assign(createForm, { category: 'other', title: '', notes: '' })
    notice.value = `已上传 ${created.title} V${created.latest_version_number}。`
    await loadDocuments(1)
    if (isCurrentFileMutation(context)) emit('changed')
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveSubmissionFailure(error)) {
      releasePendingSubmission(pending)
    } else {
      storePendingSubmission(pending)
      triggerRef(pendingDocumentCreateSubmission)
    }
    if (isCurrentFileMutation(context)) validationError.value = errorMessage(error)
  } finally {
    if (isCurrentFileMutation(context)) {
      fileMutationActive = false
      busy.value = false
    }
  }
}

function openVersion(documentId: number): void {
  if (props.readonly) return
  selectedDocumentId.value = documentId
  selectedVersionFile.value = null
  versionNotes.value = ''
  validationError.value = null
  versionVisible.value = true
}

async function saveVersion(): Promise<void> {
  if (props.readonly || busy.value) return
  let pending = recoverableDocumentVersionSubmission.value
  if (!pending) {
    const document = documents.value.find((item) => item.id === selectedDocumentId.value)
    const file = selectedVersionFile.value
    if (!document || !file) {
      validationError.value = '请选择要追加的版本文件'
      return
    }
    pending = {
      owner: pendingOwner.value,
      key: projectDocumentsPendingKey('version', props.projectCode),
      projectCode: props.projectCode,
      repository: repository.value,
      documentId: document.id,
      documentTitle: document.title,
      input: {
        notes: nullable(versionNotes.value),
        expected_revision: document.revision,
        file,
      },
      inFlight: false,
    }
    pendingDocumentVersionSubmission.value = pending
    storePendingSubmission(pending)
  }
  const context = startFileMutation()
  pending.inFlight = true
  storePendingSubmission(pending)
  triggerRef(pendingDocumentVersionSubmission)
  busy.value = true
  validationError.value = null
  actionError.value = null
  refreshWarning.value = null
  try {
    const added = await pending.repository.addDocumentVersion(
      pending.projectCode,
      pending.documentId,
      pending.input,
    )
    pending.inFlight = false
    releasePendingSubmission(pending)
    if (!isCurrentFileMutation(context)) return
    versionVisible.value = false
    selectedDocumentId.value = null
    selectedVersionFile.value = null
    versionNotes.value = ''
    notice.value = `已追加 ${managedDocumentFilename(added)}（V${added.version_number}）。`
    try {
      const refreshed = await pending.repository.getDocument(pending.projectCode, pending.documentId)
      if (isCurrentFileMutation(context)) replaceDocument(refreshed)
    } catch {
      if (isCurrentFileMutation(context)) refreshWarning.value = '已保存，但刷新失败，请刷新页面。'
    }
    if (isCurrentFileMutation(context)) emit('changed')
  } catch (error) {
    pending.inFlight = false
    if (isDefinitiveSubmissionFailure(error)) {
      releasePendingSubmission(pending)
    } else {
      storePendingSubmission(pending)
      triggerRef(pendingDocumentVersionSubmission)
    }
    if (isCurrentFileMutation(context)) validationError.value = errorMessage(error)
  } finally {
    if (isCurrentFileMutation(context)) {
      fileMutationActive = false
      busy.value = false
    }
  }
}

async function showDownload(document: DocumentSummary): Promise<void> {
  const context = startDownload(document.id)
  busy.value = true
  actionError.value = null
  try {
    const detail = await context.repository.getDocument(context.projectCode, context.documentId)
    if (!isCurrentDownload(context)) return
    const version = [...detail.versions].sort((left, right) => right.version_number - left.version_number)[0]
    if (!version) throw new Error('当前文档没有可下载版本')
    const file = await context.repository.downloadDocumentVersion(
      context.projectCode,
      context.documentId,
      version.id,
    )
    if (!isCurrentDownload(context)) return
    const url = URL.createObjectURL(file)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = managedDocumentFilename(version)
    anchor.click()
    URL.revokeObjectURL(url)
    notice.value = `已下载 ${managedDocumentFilename(version)}。`
  } catch (error) {
    if (isCurrentDownload(context)) actionError.value = errorMessage(error)
  } finally {
    if (ownsDownload(context)) {
      downloadActive = false
      busy.value = false
    }
  }
}

function openArchive(documentId: number): void {
  if (props.readonly) return
  selectedDocumentId.value = documentId
  archiveReason.value = ''
  validationError.value = null
  archiveVisible.value = true
}

async function saveArchive(): Promise<void> {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  if (!document || !archiveReason.value.trim()) {
    validationError.value = '请填写归档原因'
    return
  }
  busy.value = true
  actionError.value = null
  try {
    const archived = await repository.value.archiveDocument(props.projectCode, document.id, {
      reason: archiveReason.value.trim(),
      expected_revision: document.revision,
    })
    replaceDocument(archived)
    if (appliedArchive.value === 'active') {
      documents.value = documents.value.filter((item) => item.id !== archived.id)
      documentTotal.value = Math.max(0, documentTotal.value - 1)
    }
    archiveVisible.value = false
    notice.value = '文档已归档，版本历史和磁盘文件仍然保留。'
    const lastPage = Math.max(1, Math.ceil(documentTotal.value / documentPageSize.value))
    await loadDocuments(Math.min(documentPage.value, lastPage))
    emit('changed')
  } catch (error) {
    validationError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

function toSummary(document: DocumentDetail): DocumentSummary {
  const { versions: _versions, ...summary } = document
  return summary
}

function replaceDocument(document: DocumentDetail): void {
  const index = documents.value.findIndex((item) => item.id === document.id)
  if (index >= 0) documents.value.splice(index, 1, toSummary(document))
}

function restorePendingSubmissionForCurrentProject(): void {
  const documentCreate = currentDocumentCreateSubmission.value
  const documentVersion = currentDocumentVersionSubmission.value
  const minutesCreate = currentMinutesCreateSubmission.value
  const minutesVersion = currentMinutesVersionSubmission.value
  pendingDocumentCreateSubmission.value = documentCreate
  pendingDocumentVersionSubmission.value = documentVersion
  pendingMinutesSubmission.value = minutesCreate ?? minutesVersion

  if (documentCreate) {
    Object.assign(createForm, {
      category: documentCreate.input.category,
      title: documentCreate.input.title,
      notes: documentCreate.input.notes ?? '',
    })
    selectedCreateFile.value = documentCreate.input.file
    createVisible.value = true
    return
  }
  if (documentVersion) {
    selectedDocumentId.value = documentVersion.documentId
    selectedVersionFile.value = documentVersion.input.file
    versionNotes.value = documentVersion.input.notes ?? ''
    versionVisible.value = true
    return
  }
  const minutes = minutesCreate ?? minutesVersion
  if (!minutes) return
  minutesMode.value = minutes.kind
  minutesTitle.value = minutes.kind === 'create' ? minutes.input.title : minutes.documentTitle
  minutesContent.value = minutes.content
  selectedDocumentId.value = minutes.kind === 'version' ? minutes.documentId : null
  minutesVisible.value = true
}

watch([() => props.projectCode, repository], () => {
  loadVersion += 1
  minutesMutationGeneration += 1
  fileMutationGeneration += 1
  historyGeneration += 1
  downloadGeneration += 1
  pendingOwner.value = props.repository ?? defaultProjectDocumentsPendingOwner
  if (minutesMutationActive) {
    minutesMutationActive = false
    busy.value = false
  }
  if (fileMutationActive) {
    fileMutationActive = false
    busy.value = false
  }
  if (historyDownloadActive) {
    historyDownloadActive = false
    busy.value = false
  }
  if (downloadActive) {
    downloadActive = false
    busy.value = false
  }
  createVisible.value = false
  minutesVisible.value = false
  historyVisible.value = false
  historyProjectCode.value = null
  historyDetail.value = null
  historyLoading.value = false
  historyError.value = null
  editVisible.value = false
  versionVisible.value = false
  archiveVisible.value = false
  synchronizePreviewRoute()
  localPreviewVersionId.value = null
  actionError.value = null
  refreshWarning.value = null
  validationError.value = null
  notice.value = '文档文件保存在当前项目的独立目录中。'
  documents.value = []
  documentTotal.value = 0
  documentPage.value = 1
  documentPageSize.value = 20
  searchInput.value = ''
  categoryFilter.value = ''
  archiveFilter.value = 'active'
  appliedSearch.value = ''
  appliedCategory.value = ''
  appliedArchive.value = 'active'
  hasLoadedDocuments.value = false
  loading.value = true
  refreshing.value = false
  restorePendingSubmissionForCurrentProject()
  void loadDocuments(1)
}, { immediate: true })

watch(() => route?.fullPath, () => {
  if (!route) return
  synchronizePreviewRoute()
})

onBeforeUnmount(() => {
  mounted = false
  loadVersion += 1
  minutesMutationGeneration += 1
  fileMutationGeneration += 1
  historyGeneration += 1
  downloadGeneration += 1
})
</script>

<template>
  <el-space
    data-testid="project-documents-panel"
    class="project-panel-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="16"
  >
    <el-row justify="space-between" align="middle">
      <el-text data-testid="document-live-notice" type="info">{{ notice }}</el-text>
      <el-tag v-if="readonly" type="info" effect="plain">项目已归档，仅供查看</el-tag>
    </el-row>
    <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
    <el-alert
      v-if="refreshWarning"
      data-testid="document-refresh-warning"
      :title="refreshWarning"
      type="warning"
      :closable="false"
    />

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-row justify="space-between" align="middle">
          <div>
            <el-text tag="strong" size="large">项目资料台账</el-text>
            <p data-testid="document-ledger-summary" class="section-note">
              {{ ledgerSummary }}
            </p>
            <p class="section-note">归档只停止继续使用，不删除磁盘文件或版本历史。</p>
          </div>
          <el-space v-if="!readonly">
            <el-button data-testid="document-minutes-create-open" :disabled="busy" @click="openCreateMinutes">录入文字纪要</el-button>
            <el-button data-testid="document-create-open" type="primary" :disabled="busy" @click="openCreate">新建并上传首版</el-button>
          </el-space>
        </el-row>
      </template>
      <el-form
        data-testid="document-filters"
        inline
        class="document-filter-bar"
        @submit.prevent="applyFilters"
      >
        <el-form-item label="关键词">
          <el-input
            v-model="searchInput"
            data-testid="document-search-input"
            clearable
            placeholder="标题、备注、文件名或纪要正文"
            @keyup.enter="applyFilters"
          />
        </el-form-item>
        <el-form-item label="类别">
          <el-select
            v-model="categoryFilter"
            data-testid="document-category-filter"
            placeholder="全部类别"
            clearable
          >
            <el-option label="全部类别" value="" />
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="archiveFilter" data-testid="document-archive-filter">
            <el-option label="使用中" value="active" />
            <el-option label="已归档" value="archived" />
            <el-option label="全部" value="all" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button
            data-testid="document-search-submit"
            type="primary"
            native-type="submit"
            :loading="refreshing"
          >查询</el-button>
          <el-button data-testid="document-filter-reset" :disabled="refreshing" @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-result v-else-if="loadError" data-testid="document-load-error" icon="error" title="文档台账读取失败" :sub-title="loadError">
        <template #extra><el-button data-testid="document-load-retry" type="primary" @click="loadDocuments(1)">重新读取</el-button></template>
      </el-result>
      <el-empty v-else-if="documents.length === 0" description="暂无文档" />
      <el-table v-else v-loading="refreshing" class="document-table-view" :data="documents" row-key="id">
        <el-table-column label="类别" min-width="150"><template #default="scope">{{ categoryLabel(scope.row.category) }}</template></el-table-column>
        <el-table-column label="标题" min-width="240">
          <template #default="scope">
            <div class="document-title-cell">
              <strong>
                <template v-for="(part, index) in highlightParts(scope.row.title)" :key="index">
                  <mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
                </template>
              </strong>
              <small
                v-if="scope.row.search_excerpt"
                :data-testid="`document-search-excerpt-${scope.row.id}`"
              >
                <template v-for="(part, index) in highlightParts(scope.row.search_excerpt)" :key="index">
                  <mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
                </template>
              </small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最新版本" width="100">
          <template #default="scope">V{{ scope.row.latest_version_number }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag :data-testid="`document-status-${scope.row.id}`" :type="scope.row.archived_at ? 'info' : 'success'">{{ scope.row.archived_at ? '已归档' : '使用中' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="180"><template #default="scope">{{ formatChineseDateTime(scope.row.updated_at) }}</template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-space wrap :data-testid="`document-row-${scope.row.id}`">
              <el-button
                :data-testid="`document-preview-open-${scope.row.id}`"
                link
                type="primary"
                :aria-label="`预览${scope.row.title}`"
                :disabled="busy"
                @click="openPreview(scope.row)"
              >预览</el-button>
              <el-dropdown :disabled="busy" trigger="click">
                <el-button
                  :data-testid="`document-actions-${scope.row.id}`"
                  link
                  :aria-label="`打开${scope.row.title}的资料操作`"
                  :disabled="busy"
                >资料操作</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :data-testid="`document-history-open-${scope.row.id}`" @click="openHistory(scope.row.id)">版本历史</el-dropdown-item>
                    <el-dropdown-item :data-testid="`document-download-${scope.row.id}`" @click="showDownload(scope.row)">下载最新版</el-dropdown-item>
                    <template v-if="!readonly && !scope.row.archived_at">
                      <el-dropdown-item
                        v-if="scope.row.category === 'planning_minutes'"
                        :data-testid="`document-minutes-version-open-${scope.row.id}`"
                        @click="openMinutesVersion(scope.row)"
                      >追加文字版</el-dropdown-item>
                      <el-dropdown-item :data-testid="`document-edit-open-${scope.row.id}`" @click="openEdit(scope.row)">编辑信息</el-dropdown-item>
                      <el-dropdown-item :data-testid="`document-version-open-${scope.row.id}`" @click="openVersion(scope.row.id)">追加文件版本</el-dropdown-item>
                      <el-dropdown-item divided :data-testid="`document-archive-open-${scope.row.id}`" @click="openArchive(scope.row.id)">归档资料</el-dropdown-item>
                    </template>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
      <section
        v-if="!loading && !loadError && documents.length > 0"
        data-testid="document-card-list"
        class="document-card-list"
        aria-label="项目资料列表"
      >
        <el-card
          v-for="document in documents"
          :key="document.id"
          class="document-mobile-card"
          shadow="never"
        >
          <template #header>
            <div class="document-mobile-card__header">
              <div class="document-title-cell">
                <strong>
                  <template v-for="(part, index) in highlightParts(document.title)" :key="index">
                    <mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
                  </template>
                </strong>
                <small>{{ categoryLabel(document.category) }} · V{{ document.latest_version_number }}</small>
              </div>
              <el-tag :type="document.archived_at ? 'info' : 'success'">
                {{ document.archived_at ? '已归档' : '使用中' }}
              </el-tag>
            </div>
          </template>
          <p
            v-if="document.search_excerpt"
            class="document-mobile-card__excerpt"
            :data-testid="`document-mobile-search-excerpt-${document.id}`"
          >
            <template v-for="(part, index) in highlightParts(document.search_excerpt)" :key="index">
              <mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
            </template>
          </p>
          <el-text type="info" size="small">更新于 {{ formatChineseDateTime(document.updated_at) }}</el-text>
          <div class="document-mobile-card__actions">
            <el-button
              :data-testid="`document-mobile-preview-open-${document.id}`"
              type="primary"
              :aria-label="`预览${document.title}`"
              :disabled="busy"
              @click="openPreview(document)"
            >预览</el-button>
            <el-dropdown :disabled="busy" trigger="click">
              <el-button
                :data-testid="`document-mobile-actions-${document.id}`"
                :aria-label="`打开${document.title}的资料操作`"
                :disabled="busy"
              >资料操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="openHistory(document.id)">版本历史</el-dropdown-item>
                  <el-dropdown-item @click="showDownload(document)">下载最新版</el-dropdown-item>
                  <template v-if="!readonly && !document.archived_at">
                    <el-dropdown-item
                      v-if="document.category === 'planning_minutes'"
                      @click="openMinutesVersion(document)"
                    >追加文字版</el-dropdown-item>
                    <el-dropdown-item @click="openEdit(document)">编辑信息</el-dropdown-item>
                    <el-dropdown-item @click="openVersion(document.id)">追加文件版本</el-dropdown-item>
                    <el-dropdown-item divided @click="openArchive(document.id)">归档资料</el-dropdown-item>
                  </template>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </section>
      <footer v-if="documentTotal > documentPageSize" class="document-pagination">
        <el-pagination
          data-testid="document-pagination"
          layout="prev, pager, next, total"
          :current-page="documentPage"
          :page-size="documentPageSize"
          :total="documentTotal"
          :disabled="refreshing"
          @current-change="loadDocuments"
        />
      </footer>
    </el-card>

    <el-dialog v-model="createVisible" title="新建逻辑文档" :teleported="false" :before-close="beforeCreateClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" width="min(92vw, 560px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <div v-if="pendingDocumentCreateSubmission" class="pending-retry-panel">
        <el-alert
          data-testid="document-create-uncertain"
          :title="pendingDocumentCreateSubmission.inFlight ? '原资料上传仍在处理中，原内容和文件已保留。' : '上次上传结果未知，原项目、资料信息和文件已锁定。请原样重试；如需修改，先明确放弃原请求。'"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="recoverableDocumentCreateSubmission"
          data-testid="document-create-abandon-pending"
          :disabled="busy"
          @click="abandonPendingDocumentCreateSubmission"
        >放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" @submit.prevent="saveCreate">
        <el-form-item label="类别" required>
          <el-select data-testid="document-create-category" v-model="createForm.category" :disabled="busy || Boolean(pendingDocumentCreateSubmission)">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-create-title" v-model="createForm.title" :disabled="busy || Boolean(pendingDocumentCreateSubmission)" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="document-create-notes" v-model="createForm.notes" type="textarea" :disabled="busy || Boolean(pendingDocumentCreateSubmission)" /></el-form-item>
        <el-form-item label="文件" required>
          <DragUploadField
            v-model="selectedCreateFile"
            test-id="document-create-dropzone"
            input-test-id="document-create-file"
            title="拖入项目文件，或点击选择"
            hint="支持图片、PDF、Word、Excel、CAD 和压缩包等项目资料"
            :busy="busy || Boolean(pendingDocumentCreateSubmission)"
          />
        </el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="document-create-cancel" :disabled="busy || Boolean(pendingDocumentCreateSubmission?.inFlight)" @click="cancelCreate">取消</el-button>
          <el-button data-testid="document-create-save" type="primary" native-type="submit" :loading="busy || Boolean(pendingDocumentCreateSubmission?.inFlight)" :disabled="busy || Boolean(pendingDocumentCreateSubmission?.inFlight)">{{ recoverableDocumentCreateSubmission ? '原样重试' : pendingDocumentCreateSubmission?.inFlight ? '等待原请求' : '上传首版' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="historyVisible" title="文档版本历史" :teleported="false" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" width="min(94vw, 780px)">
      <el-skeleton v-if="historyLoading" :rows="4" animated />
      <el-result v-else-if="historyError" icon="error" title="版本历史读取失败" :sub-title="historyError" />
      <el-empty v-else-if="!historyDetail || historyDetail.versions.length === 0" description="暂无版本" />
      <el-table v-else :data="[...historyDetail.versions].sort((left, right) => right.version_number - left.version_number)" row-key="id">
        <el-table-column label="版本" width="90">
          <template #default="scope"><strong>V{{ scope.row.version_number }}</strong></template>
        </el-table-column>
        <el-table-column label="文件名" min-width="260"><template #default="scope">{{ traceableDocumentFilename(scope.row) }}</template></el-table-column>
        <el-table-column label="保存时间" min-width="180"><template #default="scope">{{ formatChineseDateTime(scope.row.created_at) }}</template></el-table-column>
        <el-table-column prop="notes" label="版本说明" min-width="160">
          <template #default="scope">{{ scope.row.notes ?? '无' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="scope">
            <div :data-testid="`document-history-version-${scope.row.id}`">
              <el-button
                :data-testid="`document-history-download-${scope.row.id}`"
                link
                type="primary"
                :disabled="busy"
                @click="downloadHistoryVersion(scope.row)"
              >下载</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog
      v-model="minutesVisible"
      :title="minutesMode === 'create' ? '录入文字会议纪要' : '追加文字纪要版本'"
      :teleported="false"
      :before-close="beforeMinutesClose"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      width="min(94vw, 720px)"
    >
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <div v-if="currentMinutesSubmission" class="pending-retry-panel">
        <el-alert
          data-testid="document-minutes-uncertain"
          :title="currentMinutesSubmission.inFlight ? '原纪要请求仍在处理中，原内容已保留。' : '上次保存结果未知，原纪要内容已锁定。请原样重试；如需修改，先明确放弃原请求。'"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="recoverableMinutesSubmission"
          data-testid="document-minutes-abandon-pending"
          :disabled="busy"
          @click="abandonPendingMinutesSubmission"
        >放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" @submit.prevent="saveMinutes">
        <el-form-item v-if="minutesMode === 'create'" label="纪要标题" required>
          <el-input
            v-model="minutesTitle"
            data-testid="document-minutes-title"
            :disabled="Boolean(currentMinutesSubmission)"
          />
        </el-form-item>
        <el-form-item v-else label="纪要标题">
          <el-input v-model="minutesTitle" disabled />
        </el-form-item>
        <el-form-item label="本版纪要内容" required>
          <el-input
            v-model="minutesContent"
            data-testid="document-minutes-content"
            type="textarea"
            :disabled="Boolean(currentMinutesSubmission)"
            :autosize="{ minRows: 10, maxRows: 20 }"
            placeholder="直接在这里记录会议内容，每次保存都会作为独立版本保留"
          />
        </el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="document-minutes-cancel" :disabled="busy || Boolean(currentMinutesSubmission?.inFlight)" @click="cancelMinutes">取消</el-button>
          <el-button data-testid="document-minutes-save" type="primary" native-type="submit" :loading="busy || Boolean(currentMinutesSubmission?.inFlight)" :disabled="Boolean(currentMinutesSubmission?.inFlight)">
            {{ recoverableMinutesSubmission ? '原样重试' : currentMinutesSubmission?.inFlight ? '等待原请求' : minutesMode === 'create' ? '保存首版' : '保存新版本' }}
          </el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑文档信息" :teleported="false" :before-close="beforeEditClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" width="min(92vw, 540px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveEdit">
        <el-form-item label="类别" required>
          <el-select v-model="editForm.category" disabled style="width: 100%">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-edit-title" v-model="editForm.title" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="document-edit-notes" v-model="editForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="document-edit-cancel" :disabled="busy" @click="cancelEdit">取消</el-button>
          <el-button data-testid="document-edit-save" type="primary" native-type="submit" :loading="busy">保存信息</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="versionVisible" title="追加文档版本" :teleported="false" :before-close="beforeVersionClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" width="min(92vw, 520px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <div v-if="pendingDocumentVersionSubmission" class="pending-retry-panel">
        <el-alert
          data-testid="document-version-uncertain"
          :title="pendingDocumentVersionSubmission.inFlight ? '原版本上传仍在处理中，原内容和文件已保留。' : '上次版本上传结果未知，原项目、文档、版本信息和文件已锁定。请原样重试；如需修改，先明确放弃原请求。'"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="recoverableDocumentVersionSubmission"
          data-testid="document-version-abandon-pending"
          :disabled="busy"
          @click="abandonPendingDocumentVersionSubmission"
        >放弃原请求并继续修改</el-button>
      </div>
      <el-form label-position="top" @submit.prevent="saveVersion">
        <el-form-item label="文件" required>
          <DragUploadField
            v-model="selectedVersionFile"
            test-id="document-version-dropzone"
            input-test-id="document-version-file"
            title="拖入新版本，或点击选择"
            hint="当前文件不会被覆盖，新文件将作为下一版本保存"
            :busy="busy || Boolean(pendingDocumentVersionSubmission)"
          />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="versionNotes" data-testid="document-version-notes" type="textarea" :disabled="busy || Boolean(pendingDocumentVersionSubmission)" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="document-version-cancel" :disabled="busy || Boolean(pendingDocumentVersionSubmission?.inFlight)" @click="cancelVersion">取消</el-button>
          <el-button data-testid="document-version-save" type="primary" native-type="submit" :loading="busy || Boolean(pendingDocumentVersionSubmission?.inFlight)" :disabled="busy || Boolean(pendingDocumentVersionSubmission?.inFlight)">{{ recoverableDocumentVersionSubmission ? '原样重试' : pendingDocumentVersionSubmission?.inFlight ? '等待原请求' : '上传新版本' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="archiveVisible" title="归档逻辑文档" :teleported="false" :before-close="beforeArchiveClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" width="min(92vw, 500px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveArchive">
        <el-form-item label="归档原因" required><el-input data-testid="document-archive-reason" v-model="archiveReason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="document-archive-cancel" :disabled="busy" @click="cancelArchive">取消</el-button>
          <el-button data-testid="document-archive-save" type="danger" native-type="submit" :loading="busy">确认归档</el-button>
        </div>
      </el-form>
    </el-dialog>

    <ProjectDocumentPreview
      v-if="previewDocumentId !== null"
      :project-code="projectCode"
      :document-id="previewDocumentId"
      :version-id="previewVersionId"
      :documents="documents"
      :repository="repository"
      @close="closePreview"
      @navigate="navigatePreview"
      @resolved-version="resolvePreviewVersion"
    />
  </el-space>
</template>

<style scoped>
.document-filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(160px, 220px) minmax(140px, 180px) auto;
  gap: 12px;
  align-items: end;
  margin-bottom: 12px;
}
.document-filter-bar :deep(.el-form-item) { margin: 0; }
.document-filter-bar :deep(.el-input),
.document-filter-bar :deep(.el-select) { width: 100%; }
.document-title-cell { display: grid; gap: 5px; }
.document-title-cell small { color: var(--sunyu-muted); line-height: 1.5; }
.document-title-cell mark {
  padding: 0 2px;
  color: inherit;
  background: var(--el-color-warning-light-7);
  border-radius: 2px;
}
.document-card-list { display: none; }
.document-mobile-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.document-mobile-card__excerpt { margin: 0 0 10px; color: var(--sunyu-muted); line-height: 1.55; }
.document-mobile-card__excerpt mark {
  padding: 0 2px;
  color: inherit;
  background: var(--el-color-warning-light-7);
  border-radius: 2px;
}
.document-mobile-card__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
.document-mobile-card__actions :deep(.el-dropdown),
.document-mobile-card__actions :deep(.el-button) { width: 100%; }
.document-pagination { display: flex; justify-content: flex-end; padding-top: 16px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; }
.pending-retry-panel { display: grid; gap: 10px; margin-bottom: 12px; }
.pending-retry-panel :deep(.el-button) { justify-self: start; margin-left: 0; }
@media (max-width: 900px) {
  .document-filter-bar { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 720px) {
  .document-table-view { display: none; }
  .document-card-list { display: grid; gap: 12px; }
}
@media (max-width: 560px) {
  .document-filter-bar { grid-template-columns: 1fr; }
}
</style>
