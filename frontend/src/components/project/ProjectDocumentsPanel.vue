<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import type { DocumentDetail, DocumentSummary } from '../../domain/contracts'
import {
  createHttpProjectOperatingRepository,
  type ProjectOperatingRepository,
} from '../../repositories/project-operating.live'

const props = defineProps<{
  projectCode: string
  repository?: ProjectOperatingRepository
}>()

const repository = props.repository ?? createHttpProjectOperatingRepository()
const documents = ref<DocumentSummary[]>([])
const loading = ref(true)
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
const documentCount = computed(() => documents.value.length)
const versionCount = computed(() => documents.value.reduce(
  (total, document) => total + document.latest_version_number,
  0,
))
let loadVersion = 0
let minutesMutationGeneration = 0
let minutesMutationActive = false
let historyGeneration = 0
let historyDownloadActive = false

interface MinutesMutationContext {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '文档操作失败'
}

async function loadDocuments(): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  loadError.value = null
  try {
    const listing = await repository.listDocuments(props.projectCode)
    if (version === loadVersion) {
      documents.value = listing.items
      refreshWarning.value = null
    }
  } catch (error) {
    if (version === loadVersion) loadError.value = errorMessage(error)
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function openCreate(): void {
  createForm.category = 'other'
  createForm.title = ''
  createForm.notes = ''
  selectedCreateFile.value = null
  validationError.value = null
  createVisible.value = true
}

function openCreateMinutes(): void {
  minutesMode.value = 'create'
  selectedDocumentId.value = null
  minutesTitle.value = ''
  minutesContent.value = ''
  validationError.value = null
  minutesVisible.value = true
}

function openMinutesVersion(document: DocumentSummary): void {
  minutesMode.value = 'version'
  selectedDocumentId.value = document.id
  minutesTitle.value = document.title
  minutesContent.value = ''
  validationError.value = null
  minutesVisible.value = true
}

function startMinutesMutation(): MinutesMutationContext {
  minutesMutationActive = true
  return {
    generation: ++minutesMutationGeneration,
    projectCode: props.projectCode,
    repository,
  }
}

function isCurrentMinutesMutation(context: MinutesMutationContext): boolean {
  return context.generation === minutesMutationGeneration
    && context.projectCode === props.projectCode
    && context.repository === repository
}

function minutesFile(content: string): File {
  return new File([content], 'planning-minutes.txt', { type: 'text/plain' })
}

async function saveMinutes(): Promise<void> {
  const mode = minutesMode.value
  const title = minutesTitle.value.trim()
  const content = minutesContent.value.trim()
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  if (!content || (mode === 'create' && !title)) {
    validationError.value = mode === 'create'
      ? '请填写纪要标题和内容'
      : '请填写本版纪要内容'
    return
  }
  if (mode === 'version' && !document) {
    validationError.value = '要追加的纪要已不存在'
    return
  }
  const context = startMinutesMutation()
  const file = minutesFile(content)
  busy.value = true
  actionError.value = null
  refreshWarning.value = null
  try {
    if (mode === 'create') {
      const created = await context.repository.createDocument(context.projectCode, {
        category: 'planning_minutes',
        title,
        notes: null,
        file,
      })
      if (!isCurrentMinutesMutation(context)) return
      documents.value = [toSummary(created), ...documents.value]
      notice.value = `已保存 ${created.title} V${created.latest_version_number}。`
    } else {
      const current = document as DocumentSummary
      const added = await context.repository.addDocumentVersion(context.projectCode, current.id, {
        notes: null,
        expected_revision: current.revision,
        file,
      })
      if (!isCurrentMinutesMutation(context)) return
      notice.value = `已保存 ${current.title} V${added.version_number}。`
      try {
        const refreshed = await context.repository.getDocument(context.projectCode, current.id)
        if (!isCurrentMinutesMutation(context)) return
        replaceDocument(refreshed)
      } catch {
        if (isCurrentMinutesMutation(context)) {
          refreshWarning.value = '已保存文字纪要，但刷新失败，请刷新页面。'
        }
      }
    }
    if (!isCurrentMinutesMutation(context)) return
    minutesVisible.value = false
    minutesContent.value = ''
  } catch (error) {
    if (isCurrentMinutesMutation(context)) validationError.value = errorMessage(error)
  } finally {
    if (isCurrentMinutesMutation(context)) {
      minutesMutationActive = false
      busy.value = false
    }
  }
}

function selectCreateFile(event: Event): void {
  selectedCreateFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function openHistory(documentId: number): Promise<void> {
  const context: HistoryContext = {
    generation: ++historyGeneration,
    projectCode: props.projectCode,
    documentId,
    repository,
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
    && context.repository === repository
}

async function downloadHistoryVersion(version: DocumentDetail['versions'][number]): Promise<void> {
  const document = historyDetail.value
  const projectCode = historyProjectCode.value
  if (!document || !projectCode || projectCode !== props.projectCode) return
  const context: HistoryContext = {
    generation: historyGeneration,
    projectCode,
    documentId: document.id,
    repository,
  }
  historyDownloadActive = true
  busy.value = true
  actionError.value = null
  try {
    const file = await context.repository.downloadDocumentVersion(
      context.projectCode,
      context.documentId,
      version.id,
    )
    if (!isCurrentHistory(context)) return
    const url = URL.createObjectURL(file)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = version.original_filename
    anchor.click()
    URL.revokeObjectURL(url)
    notice.value = `已下载 ${version.original_filename}。`
  } catch (error) {
    if (isCurrentHistory(context)) actionError.value = errorMessage(error)
  } finally {
    if (isCurrentHistory(context)) {
      historyDownloadActive = false
      busy.value = false
    }
  }
}

function openEdit(document: DocumentSummary): void {
  selectedDocumentId.value = document.id
  editForm.category = document.category
  editForm.title = document.title
  editForm.notes = document.notes ?? ''
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
    const updated = await repository.updateDocument(props.projectCode, document.id, {
      title,
      notes: nullable(editForm.notes),
      expected_revision: document.revision,
    })
    replaceDocument(updated)
    editVisible.value = false
    notice.value = '文档信息已保存。'
  } catch (error) {
    validationError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function saveCreate(): Promise<void> {
  const title = createForm.title.trim()
  if (!title || !selectedCreateFile.value) {
    validationError.value = '请填写标题并选择文件'
    return
  }
  busy.value = true
  actionError.value = null
  try {
    const created = await repository.createDocument(props.projectCode, {
      category: createForm.category,
      title,
      notes: nullable(createForm.notes),
      file: selectedCreateFile.value,
    })
    documents.value = [toSummary(created), ...documents.value]
    createVisible.value = false
    selectedCreateFile.value = null
    Object.assign(createForm, { category: 'other', title: '', notes: '' })
    notice.value = `已上传 ${created.title} V${created.latest_version_number}。`
  } catch (error) {
    validationError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

function openVersion(documentId: number): void {
  selectedDocumentId.value = documentId
  selectedVersionFile.value = null
  versionNotes.value = ''
  validationError.value = null
  versionVisible.value = true
}

function selectVersionFile(event: Event): void {
  selectedVersionFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function saveVersion(): Promise<void> {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  if (!document || !selectedVersionFile.value) {
    validationError.value = '请选择要追加的版本文件'
    return
  }
  busy.value = true
  actionError.value = null
  refreshWarning.value = null
  try {
    const added = await repository.addDocumentVersion(props.projectCode, document.id, {
      notes: nullable(versionNotes.value),
      expected_revision: document.revision,
      file: selectedVersionFile.value,
    })
    versionVisible.value = false
    selectedDocumentId.value = null
    selectedVersionFile.value = null
    versionNotes.value = ''
    notice.value = `已追加 ${added.original_filename}（V${added.version_number}）。`
    try {
      const refreshed = await repository.getDocument(props.projectCode, document.id)
      replaceDocument(refreshed)
    } catch {
      refreshWarning.value = '已保存，但刷新失败，请刷新页面。'
    }
  } catch (error) {
    validationError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function showDownload(document: DocumentSummary): Promise<void> {
  busy.value = true
  actionError.value = null
  try {
    const detail = await repository.getDocument(props.projectCode, document.id)
    const version = [...detail.versions].sort((left, right) => right.version_number - left.version_number)[0]
    if (!version) throw new Error('当前文档没有可下载版本')
    const file = await repository.downloadDocumentVersion(
      props.projectCode,
      document.id,
      version.id,
    )
    const url = URL.createObjectURL(file)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = version.original_filename
    anchor.click()
    URL.revokeObjectURL(url)
    notice.value = `已下载 ${version.original_filename}。`
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

function openArchive(documentId: number): void {
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
    const archived = await repository.archiveDocument(props.projectCode, document.id, {
      reason: archiveReason.value.trim(),
      expected_revision: document.revision,
    })
    replaceDocument(archived)
    archiveVisible.value = false
    notice.value = '文档已归档，版本历史和磁盘文件仍然保留。'
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

watch(() => props.projectCode, () => {
  minutesMutationGeneration += 1
  historyGeneration += 1
  if (minutesMutationActive) {
    minutesMutationActive = false
    busy.value = false
  }
  if (historyDownloadActive) {
    historyDownloadActive = false
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
  actionError.value = null
  refreshWarning.value = null
  validationError.value = null
  notice.value = '文档文件保存在当前项目的独立目录中。'
  void loadDocuments()
}, { immediate: true })
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
      <el-tag type="success" effect="plain">真实后端</el-tag>
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
              {{ documentCount }} 份资料 · {{ versionCount }} 个历史版本。资料数量不代表审批完成或项目进度。
            </p>
            <p class="section-note">归档只停止继续使用，不删除磁盘文件或版本历史。</p>
          </div>
          <el-space>
            <el-button data-testid="document-minutes-create-open" :disabled="busy" @click="openCreateMinutes">录入文字纪要</el-button>
            <el-button data-testid="document-create-open" type="primary" :disabled="busy" @click="openCreate">新建并上传首版</el-button>
          </el-space>
        </el-row>
      </template>
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-result v-else-if="loadError" data-testid="document-load-error" icon="error" title="文档台账读取失败" :sub-title="loadError">
        <template #extra><el-button data-testid="document-load-retry" type="primary" @click="loadDocuments">重新读取</el-button></template>
      </el-result>
      <el-empty v-else-if="documents.length === 0" description="暂无文档" />
      <el-table v-else :data="documents" row-key="id">
        <el-table-column label="类别" min-width="150"><template #default="scope">{{ categoryLabel(scope.row.category) }}</template></el-table-column>
        <el-table-column prop="title" label="标题" min-width="190" />
        <el-table-column label="最新版本" width="100">
          <template #default="scope">V{{ scope.row.latest_version_number }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag :type="scope.row.archived_at ? 'info' : 'success'">{{ scope.row.archived_at ? '已归档' : '使用中' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" min-width="180" />
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="scope">
            <el-space wrap :data-testid="`document-row-${scope.row.id}`">
              <el-tag type="info">V{{ scope.row.latest_version_number }}</el-tag>
              <el-button
                :data-testid="`document-history-open-${scope.row.id}`"
                link
                :disabled="busy"
                @click="openHistory(scope.row.id)"
              >版本历史</el-button>
              <el-button :data-testid="`document-download-${scope.row.id}`" link :disabled="busy" @click="showDownload(scope.row)">下载</el-button>
              <el-button
                v-if="!scope.row.archived_at && scope.row.category === 'planning_minutes'"
                :data-testid="`document-minutes-version-open-${scope.row.id}`"
                link
                type="primary"
                @click="openMinutesVersion(scope.row)"
              >追加文字版</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-edit-open-${scope.row.id}`"
                link
                @click="openEdit(scope.row)"
              >编辑信息</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-version-open-${scope.row.id}`"
                link
                type="primary"
                @click="openVersion(scope.row.id)"
              >追加版本</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-archive-open-${scope.row.id}`"
                link
                type="danger"
                @click="openArchive(scope.row.id)"
              >归档</el-button>
              <span v-else>已归档</span>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="createVisible" title="新建逻辑文档" :teleported="false" width="min(92vw, 560px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveCreate">
        <el-form-item label="类别" required>
          <el-select v-model="createForm.category">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-create-title" v-model="createForm.title" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="createForm.notes" type="textarea" /></el-form-item>
        <el-form-item label="文件" required><input data-testid="document-create-file" type="file" @change="selectCreateFile" /></el-form-item>
        <el-button data-testid="document-create-save" type="primary" native-type="submit" :loading="busy">上传首版</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="historyVisible" title="文档版本历史" :teleported="false" width="min(94vw, 780px)">
      <el-skeleton v-if="historyLoading" :rows="4" animated />
      <el-result v-else-if="historyError" icon="error" title="版本历史读取失败" :sub-title="historyError" />
      <el-empty v-else-if="!historyDetail || historyDetail.versions.length === 0" description="暂无版本" />
      <el-table v-else :data="[...historyDetail.versions].sort((left, right) => right.version_number - left.version_number)" row-key="id">
        <el-table-column label="版本" width="90">
          <template #default="scope"><strong>V{{ scope.row.version_number }}</strong></template>
        </el-table-column>
        <el-table-column prop="original_filename" label="文件名" min-width="220" />
        <el-table-column prop="created_at" label="保存时间" min-width="180" />
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
      width="min(94vw, 720px)"
    >
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveMinutes">
        <el-form-item v-if="minutesMode === 'create'" label="纪要标题" required>
          <el-input v-model="minutesTitle" data-testid="document-minutes-title" />
        </el-form-item>
        <el-form-item v-else label="纪要标题">
          <el-input v-model="minutesTitle" disabled />
        </el-form-item>
        <el-form-item label="本版纪要内容" required>
          <el-input
            v-model="minutesContent"
            data-testid="document-minutes-content"
            type="textarea"
            :autosize="{ minRows: 10, maxRows: 20 }"
            placeholder="直接在这里记录会议内容，每次保存都会作为独立版本保留"
          />
        </el-form-item>
        <el-button data-testid="document-minutes-save" type="primary" native-type="submit" :loading="busy">
          {{ minutesMode === 'create' ? '保存首版' : '保存新版本' }}
        </el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑文档信息" :teleported="false" width="min(92vw, 540px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveEdit">
        <el-form-item label="类别" required>
          <el-select v-model="editForm.category" disabled style="width: 100%">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-edit-title" v-model="editForm.title" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="document-edit-notes" v-model="editForm.notes" type="textarea" /></el-form-item>
        <el-button data-testid="document-edit-save" type="primary" native-type="submit" :loading="busy">保存信息</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="versionVisible" title="追加文档版本" :teleported="false" width="min(92vw, 520px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveVersion">
        <el-form-item label="文件" required><input data-testid="document-version-file" type="file" @change="selectVersionFile" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="versionNotes" type="textarea" /></el-form-item>
        <el-button data-testid="document-version-save" type="primary" native-type="submit" :loading="busy">上传新版本</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="archiveVisible" title="归档逻辑文档" :teleported="false" width="min(92vw, 500px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveArchive">
        <el-form-item label="归档原因" required><el-input data-testid="document-archive-reason" v-model="archiveReason" type="textarea" /></el-form-item>
        <el-button data-testid="document-archive-save" type="danger" native-type="submit" :loading="busy">确认归档</el-button>
      </el-form>
    </el-dialog>
  </el-space>
</template>
